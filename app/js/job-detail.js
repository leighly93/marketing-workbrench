// 單筆工作頁：狀態、成品、取消／重新出片與發音回報。

import { annotCard } from './annotations.js';
import { $, api, el } from './dom.js';
import { motionBox } from './motion.js';
import { emphasisBox, loadEmph, planCard } from './plan.js';
import { addDictRuleConfirming } from './say.js';
import { go } from './shell.js';
import { S } from './state.js';
import { statusText } from './status.js';

// ── 詳情 ──


export async function loadJob() {
  const { job } = await api('/api/jobs/' + S.openJob);
  S.lastJob = job.id;
  const { text } = await api(`/api/jobs/${S.openJob}/log`);
  const box = $('#v-job');
  // 詳情頁每 3 秒輪詢一次。以前不管有沒有變都整塊 replaceChildren，
  // <video> 被重新建立就會重新載入 → 影片一直閃（2026-08-17 使用者回報）。
  // 內容沒變就什麼都不做；工作跑完後特徵不再變動，畫面自然就穩住。
  //
  // ⚠️ 版面特徵**不能**包含執行記錄的長度（2026-08-21 使用者回報：「時不時會跳動一下畫面，
  //    我滑到下方他就跳動一下又回到上方，很像是一直在重新整理」）。run.js 跑的時候記錄一直在長，
  //    等於每 3 秒把整頁重建一次 —— 圖片全部重新載入（版面塌一下再撐回來，捲軸就被彈回上面）、
  //    標注列表重畫、配圖計畫的 `edits` 也被重置。記錄變長是**唯一**不需要重畫版面的變化，
  //    所以拉出來就地換掉那個 <pre> 就好。
  // ⚠️ **不要**把 files 數量加進來（試過，會出事）。待確認階段補上傳一張圖 → 特徵變了 →
  //    整頁重畫 → planCard() 把 `edits` 整個重建 → 同事拉到一半的框、加到一半的段全部無聲消失。
  //    「補上傳之後畫面要更新」改成由上傳那支自己決定：準備階段整頁重載（那時沒有 edits 要保護），
  //    待確認階段只重畫縮圖牆（見 uploadMoreShots 的 onDone）。
  const sig = [job.id, job.status, (job.outputs || []).length, job.error || ''].join('|');
  const logText = text || '（還沒有輸出）';
  if (sig === S.jobSig && box.childElementCount) {
    const cur = box.querySelector('pre.log');
    if (cur && cur.textContent !== logText) {
      const atBottom = cur.scrollTop + cur.clientHeight >= cur.scrollHeight - 40;
      cur.textContent = logText;
      if (atBottom) cur.scrollTop = cur.scrollHeight;
    }
    return;
  }
  // 框選編輯器開著的時候絕對不能重畫 —— `planCard()` 會把 `edits` 整個重建，
  // 使用者按「完成」時寫回去的是已經被丟掉的那一份（改了等於沒改，而且毫無提示）。
  // 不更新 jobSig，所以編輯器一關、下一次輪詢就會補畫。
  if ($('#ed').style.display === 'flex') return;
  S.jobSig = sig;
  const keep = box.querySelector('pre.log');
  const scrolled = keep ? keep.scrollTop + keep.clientHeight >= keep.scrollHeight - 40 : true;

  const head = el('div', { class: 'card' },
    el('div', { style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap' },
      // ⚠️ fallback 是必要的：2026-09-22 移除三大法人等版型後，那些舊工作的 template
      //    在 TPLS 裡查不到。沒有 fallback 的話這裡會顯示成「undefined　標題」。
      el('h2', { style: 'margin:0' }, ((S.TPLS[job.template] || {}).label || job.template || '已移除的版型') + '　' + (job.title || '').replace(/\n/g, ' ')),
      el('span', { class: 'st ' + job.status },
        statusText(job) + (job.queuePosition > 0 ? `（前面還有 ${job.queuePosition} 支）` : '')),
      el('span', { style: 'flex:1' }),
      // ⚠️ 取消鈕放在**頁首**，不是埋在最下面的執行記錄裡（2026-09-17 使用者要求
      //    「一進到下一頁就要一直顯示」）。以前要捲到整頁最底才看得到，而且正在跑的
      //    工作根本不畫它 —— 人卡在 HeyGen 十幾分鐘只能乾等。
      cancelBtn(job),
      el('button', { class: 'ghost', onclick: () => { S.openJob = null; go('list'); } }, '← 回列表')),
    el('div', { style: 'color:var(--dim);font-size:13px;margin-top:8px' },
      `${job.owner}・${new Date(job.createdAt).toLocaleString('zh-TW', { hour12: false })}`
      + (job.mock ? '・🧪 模擬模式產生（假配音、假講者，不能發布）' : '')),
    // 2026-08-18 使用者要求：出片中不用守在畫面前等 render log 跑完
    job.status === 'rendering'
      ? el('div', { class: 'note', style: 'margin-top:14px' },
          '可以晚點再到『工作列表』查看生成完成的影片～')
      : '',
    job.error ? el('div', { class: 'note', style: 'margin-top:14px;background:#fdecec;border-color:#f2c9c9;color:#8b2020' }, job.error) : '');

  const parts = [head];

  if (job.status === 'detached' || job.status === 'detached-done') {
    parts.push(el('div', { class: 'card' },
      el('h2', {}, job.status === 'detached' ? '這支正在背景跑' : '這支已經在背景跑完'),
      el('div', { class: 'note', html:
        (job.status === 'detached'
          ? '伺服器在它跑到一半時重開過。它沒有被殺掉，會自己跑完 —— <b>HeyGen 點數不會浪費</b>。<br><br>'
          : '它已經跑完了，但伺服器當時已經重開，所以沒有接回前台流程。<br><br>')
        + '<b>怎麼零成本接回：</b><br>'
        + '講者影片留在專案的 <code>public/heygen.mp4</code>。<br>'
        + '重新建立一次工作 → 展開「進階」→ 勾「<b>用現成的講者影片</b>」→ 選那支 mp4。<br>'
        + '這樣不會再呼叫 HeyGen，一毛錢都不用花。' })));
  }

  // ⚠️ 2026-09-18 起「重新出片」直接排進佇列，不會再產生 draft 的工作（見 index.js 的 redo 端點）。
  //    這張卡片留著只為了**那之前就已經停在 draft 的舊工作**，不然它們會沒有出口、永遠送不出去。
  //    確定手上沒有那種工作之後，這一行連同 redoConfirmCard() 都可以拿掉。
  if (job.status === 'draft' && job.redoOf) parts.push(redoConfirmCard(job));

  // 還在準備 → 配圖計畫算不出來，但按鈕先畫出來（反灰）讓人知道要等什麼、等完按哪裡
  // （2026-09-18 使用者要求）。沒有這張卡的話，這段時間畫面上只有標注與執行記錄，
  // 看不出「等一下會停在哪一關」。
  if (['queued', 'preparing', 'detached'].includes(job.status)) parts.push(planPendingCard(job));

  // HeyGen 生成／準備中的時候就可以先標注 —— 不用乾等
  //（2026-08-17 使用者：「等heygen生成時我順便手動標示」）
  // draft 也開：那些 2026-09-18 之前停在 draft 的舊工作還要靠它改標注。
  if (['draft', 'queued', 'preparing', 'detached'].includes(job.status)) parts.push(annotCard(job));

  // 排隊等出片 → 還來得及反悔（2026-08-19 使用者要求的「反悔鍵」）。
  // 一旦 status 轉成 rendering 就退不回來了，那時只能取消重跑。
  if (job.status === 'approved') {
    const card = el('div', { class: 'card' },
      el('h2', {}, '排隊等出片'),
      el('div', { class: 'note', html:
        (job.approvedBy === '（自動出片）'
          ? '你設定了「標好了，直接出片」，所以準備一跑完就自動排進出片佇列。<br>' : '')
        + '還沒開始出片，現在退回去還可以改配圖／標注。<b>開始出片之後就退不回來了</b>。<br>'
        + '下面的<b>字幕重點詞還可以直接改</b>，不用退回 —— 真的開始出片才會定案。' }),
      el('div', { style: 'margin-top:14px' },
        el('button', { class: 'ghost', onclick: async () => {
          try {
            await api(`/api/jobs/${job.id}/unapprove`, { method: 'POST' });
            S.jobSig = null;
            loadJob();
          } catch (e) { alert('退不回來：' + e.message); }
        } }, '↩ 退回確認')));
    // 還沒真的 render，重點詞仍然進得了這支成品（伺服器的 EMPHASIS_EDITABLE 同一條界線）。
    // 藍底線看已確認的計畫；「直接出片」那條路沒有計畫頁，就退回看手動標注。
    card.append(emphasisBox(job, () => (job.planView && job.planView.rows) || S.ANNOTS));
    card.append(motionBox(job, () => (job.planView && job.planView.rows) || S.ANNOTS));
    if (S.emphLoadedFor !== job.id) {
      S.emphLoadedFor = job.id;
      S.CHARS = []; S.EMPH = [];
      loadEmph(job, () => {
        const box = $('.emph');
        if (box && S.EMPH.length) box.open = true;
      });
    }
    parts.push(card);
  }

  if (job.status === 'review' && job.planView) parts.push(planCard(job));

  if (job.status === 'done' && job.pruned) {
    parts.push(el('div', { class: 'card' }, el('h2', {}, '成品'),
      el('div', { class: 'note' }, '這筆歷史工作曾被清理，部分檔案可能缺失；已有的工作紀錄會繼續保留。')));
  } else if (job.status === 'done' && job.outputs) {
    const grid = el('div', { class: 'outs' });
    for (const o of job.outputs) {
      grid.append(el('figure', {},
        el('video', { controls: 'controls', src: `/api/jobs/${job.id}/file/${o.name}` }),
        el('figcaption', {},
          el('b', {}, o.name),
          el('span', {}, (o.size / 1048576).toFixed(1) + ' MB'),
          el('a', { class: 'ghost', href: `/api/jobs/${job.id}/file/${o.name}?dl=1`,
            style: 'text-decoration:none' }, '下載'))));
    }
    const card = el('div', { class: 'card' }, el('h2', {}, '成品'), grid);
    // 動態素材：貼進影片裡的那幾段，單獨留一份可以下載（2026-09-21 使用者要的）。
    // ⚠️ 檔名是 motion1_…_portrait.mp4，跟成品的 output-dapan.mp4 不一樣 ——
    //    網址一定要 encodeURIComponent，不然「／」之類的字會把路徑切斷。
    if (job.motionClips && job.motionClips.length) {
      const mg = el('div', { class: 'outs' });
      for (const m of job.motionClips) {
        const href = `/api/jobs/${job.id}/file/${encodeURIComponent(m.name)}`;
        mg.append(el('figure', {},
          el('video', { controls: 'controls', src: href }),
          el('figcaption', {},
            el('b', {}, m.name),
            el('span', {}, (m.size / 1048576).toFixed(1) + ' MB'),
            el('a', { class: 'ghost', href: href + '?dl=1', style: 'text-decoration:none' }, '下載'))));
      }
      card.append(
        el('div', { style: 'margin-top:20px;font-weight:600;font-size:14px' }, '動態素材'),
        el('div', { class: 'note', style: 'margin:4px 0 10px' },
          '這幾段已經貼進上面的影片裡了，這裡另外留一份。要自己重剪、或這支影片其他地方要重做時可以直接拿。'),
        mg);
    }
    if (job.archived && job.archived.length)
      card.append(el('div', { style: 'margin-top:16px;font-size:12.5px;color:var(--dim)' },
        '也存進成品庫了（不會自動清）：　' + job.archived.join('　/　')));
    parts.push(card);
    parts.push(pronounceReportCard(job));
  }

  if (['done', 'failed'].includes(job.status)) parts.push(redoCard(job));

  // 取消鈕已經移到頁首了，這裡不要再放一顆 —— 同一頁兩個一樣的紅字按鈕只會讓人不確定
  // 哪個才是真的（而且下面這顆本來就常常在捲軸外面）。
  const logCard = el('div', { class: 'card' },
    el('h2', { style: 'margin:0 0 12px' }, '執行記錄'),
    el('pre', { class: 'log' }, logText));
  parts.push(logCard);

  box.replaceChildren(...parts);
  const pre = logCard.querySelector('pre');
  if (scrolled) pre.scrollTop = pre.scrollHeight;
}

/**
 * 取消工作（2026-09-17 使用者要求「一進到下一頁就要一直顯示」）。
 *
 * 以前只給 draft／queued／review／failed／approved／detached-done 這幾個狀態，而且埋在
 * 頁面最下面的執行記錄裡。實際踩到的情況是：HeyGen 卡在 processing 十幾分鐘，那支是
 * preparing —— 名單裡沒有它，畫面上連按鈕都沒有，人只能乾等。現在一律顯示。
 *
 * 已經結束的（done／failed）不給取消：那不是「停下來」，是要清掉，走列表的刪除。
 * 已經是 cancelled 的就不用再按一次了。
 */
export function cancelBtn(job) {
  if (['done', 'failed', 'cancelled'].includes(job.status)) return '';
  // 正在跑的要講清楚代價 —— 錢是呼叫當下就扣的，停掉不會退。
  const running = ['preparing', 'rendering', 'detached'].includes(job.status);
  const ask = running
    ? '這支正在跑，取消會直接停掉它。\n\n'
      + '⚠️ HeyGen／MiniMax 已經扣掉的點數不會退回，而且製作快照會被清掉（不能再「重新出片」）。\n\n'
      + '確定要停？'
    : '確定取消這支工作？';
  return el('button', { class: 'ghost danger', onclick: async (ev) => {
    if (!confirm(ask)) return;
    ev.target.disabled = true;
    try {
      await api(`/api/jobs/${job.id}/cancel`, { method: 'POST' });
      S.jobSig = null;
      loadJob();
    } catch (e) {
      ev.target.disabled = false;
      alert('取消失敗：' + e.message);
    }
  } }, running ? '⛔ 停止這支' : '取消工作');
}

/**
 * 「重新出片」卡片 —— 用同一份稿件、截圖、標注、講者影片再跑一次。
 *
 * 2026-09-16 那天字幕時間軸壞掉，同事只能重貼稿件、重傳截圖、**重畫一次顯示範圍與黃框**，
 * 重畫的結果還跟原本不一樣。那些東西工作資料夾裡全都留著，沒道理要人重做一次。
 */
export function redoCard(job) {
  const busyMsg = el('span', { style: 'margin-left:12px;font-size:12.5px;color:var(--dim)' });
  return el('div', { class: 'card' },
    el('h2', {}, '重新出片'),
    el('div', { class: 'note', html:
      '用<b>完全一樣</b>的稿件、截圖、標注（顯示範圍／黃框／箭頭）與講者影片再跑一次。<br>'
      + '<b>不會重新呼叫 HeyGen 或 MiniMax，不扣點數。</b><br><br>'
      + '按下去<b>直接開始準備</b>（分析截圖、轉字幕、排配圖計畫），跑完會<b>停在「配圖計畫」</b>'
      + '等你 —— 到那裡再拖框、改範圍、換圖、加減段、標重點詞，確認了才真的出片。<br>'
      + '<b>稿件不能改</b> —— 標注是照字元位置對到稿件的，改一個字後面的框就會跑掉。'
      + '要改稿請重新建立一支工作。' }),
    el('div', { style: 'margin-top:14px' },
      el('button', { class: 'ghost', onclick: async (e) => {
        const btn = e.target;
        btn.disabled = true;
        busyMsg.textContent = '複製中…';
        try {
          const r = await api(`/api/jobs/${job.id}/redo`, { method: 'POST' });
          S.openJob = r.job.id;
          S.jobSig = null;
          go('job');
        } catch (err) {
          busyMsg.textContent = '';
          btn.disabled = false;
          alert('重新出片失敗：' + err.message);
        }
      } }, '♻ 重新出片'),
      busyMsg));
}

/** 重新出片複製完的確認關卡（新工作停在 draft，按了才真的排進佇列）。 */
export function redoConfirmCard(job) {
  const msg = el('span', { style: 'margin-left:12px;font-size:12.5px;color:var(--dim)' });
  return el('div', { class: 'card' },
    el('h2', {}, '確認後開始出片'),
    el('div', { class: 'note', html:
      `稿件、截圖、標注與講者影片都從工作 <code>${job.redoOf}</code> 帶過來了，`
      + '<b>還沒開始跑</b>。<br>'
      + '下面的標注就是原本那一份 —— 看一下框還在不在、要不要微調，好了就按開始。<br>'
      + '這支不會重新呼叫 HeyGen／MiniMax，<b>不扣點數</b>。' }),
    el('div', { style: 'margin-top:14px' },
      el('button', { onclick: async (e) => {
        const btn = e.target;
        btn.disabled = true;
        msg.textContent = '送出中…';
        try {
          await api(`/api/jobs/${job.id}/submit`, { method: 'POST' });
          S.jobSig = null;
          loadJob();
        } catch (err) {
          msg.textContent = '';
          btn.disabled = false;
          alert('送不出去：' + err.message);
        }
      } }, '✓ 確認，開始出片'),
      msg));
}

/**
 * 準備中的「配圖計畫」佔位卡（2026-09-18 使用者要求）。
 *
 * 為什麼要有：配圖計畫得先分析截圖版面、把配音轉成字幕，才知道哪句話在第幾秒、
 * 圖要配在哪裡 —— 所以這段時間它算不出來，畫面上只有標注與執行記錄。
 * 使用者不知道還要等多久、等完要按哪裡（「22 秒有點久，在幹嘛？」）。
 * 所以先把同一顆按鈕畫在同一個位置、反灰，旁邊講清楚在跑什麼、算完會停在這一關。
 *
 * ⚠️ 按鈕的文字與 class 要跟 planCard 那顆**一模一樣** —— 這張卡片的作用就是
 *    「等一下真正的按鈕會長在這裡」，長得不一樣就失去意義了。
 */
export function planPendingCard(job) {
  const queued = job.status === 'queued';
  // 用現成講者影片（重新出片都是）就沒有 HeyGen 那 3～5 分鐘，只剩分析截圖與轉字幕。
  const steps = job.skipGenerate
    ? '分析截圖版面 → 轉字幕 → 排配圖計畫'
    : '生成講者影片 → 分析截圖版面 → 轉字幕 → 排配圖計畫';
  return el('div', { class: 'card' },
    el('h2', {}, '配圖計畫'),
    el('div', { class: 'note', html:
      (queued ? '⏳ <b>排隊中</b> —— 前面還有工作在跑，輪到它就會開始。<br>'
              : '⏳ <b>正在準備</b>…<br>')
      + `要跑完「${steps}」才知道哪句話在第幾秒、圖該配在哪裡，所以計畫現在還看不到。<br>`
      + '算完<b>會停在這一關等你</b>：這張卡片會列出計畫（可以拖框、改範圍、換圖、加減段、'
      + '標重點詞），下面這顆按鈕也會亮起來。' }),
    el('div', { style: 'margin-top:14px' },
      el('button', { class: 'go', disabled: true }, '確認，開始出片'),
      el('span', { style: 'margin-left:12px;font-size:12.5px;color:var(--dim)' },
        '還在跑，算完才能按')));
}

/**
 * 「發音回報」卡片，接在「成品」後面。
 *
 * 這裡以前是「唸法檢查」—— 系統比對 Whisper 聽寫稿自己猜哪個字唸錯了。2026-08-27 拿掉：
 * 判得不準（兩份字幕會整段錯開、拼音又被英數字擠掉一格），而且同事也看得到那批錯的建議，
 * 會照著回報 → 管理者要一筆一筆駁回。**影片本來就會被人聽過一遍，耳朵才是準的。**
 *
 * 所以留下來的只有舊卡片唯一真正有用的部分：**入口的位置**。回報表單就放在剛看完成品的地方，
 * 不用再跑去「跟我說」那一頁重打一次、也不用記剛剛是第幾秒（秒數一鍵帶入）。
 * 下半部是「這支套用了哪幾條發音規則」—— 那是查表、不會出錯，聽到還是錯就知道規則沒生效。
 */
export function pronounceReportCard(job) {
  const rows = el('div');
  const add = () => rows.append(reportRow(job));

  const c = el('div', { class: 'card' },
    el('h2', {}, '發音回報　—　聽到唸錯的字寫在這裡'),
    el('div', { class: 'note', html:
      '影片放出來聽，哪個字唸錯了就填在這裡。'
      + (S.ADMIN ? '按下去直接進共用詞庫，之後每支影片自動套用。'
               : '送出後管理者會收到，收錄之後每支影片都會自動用對的唸法。') + '<br>'
      + '<b>「該怎麼寫」請填同音字或數字唸法</b>（例：收斂→<b>收練</b>、櫃買→<b>貴買</b>、'
      + '2330→<b>二三三零</b>），不要填注音 —— AI 不一定吃得懂注音。<br>'
      + '<b>聲調不對也算</b>（例如「跌」唸成一聲、「期貨」的期唸成一聲）。'
      + '秒數可以不填，填了我才知道去聽哪一段。' }),
    rows,
    el('div', { style: 'margin-top:14px' },
      el('button', { class: 'ghost', onclick: add }, '＋ 再加一則')),
    appliedRulesBox(job));

  add();
  return c;
}

/** 一列 ＝ 一個唸錯的詞。秒數按一下就帶目前播放位置，不用自己記 */
export function reportRow(job) {
  const box = el('div', { class: 'say2' });
  const word = el('input', { placeholder: '唸錯的詞（例：收斂）' });
  const to = el('input', { placeholder: '該怎麼寫（同音字）' });
  const sec = el('input', { class: 'sec', placeholder: '秒數' });
  const msg = el('span', { class: 'ok' });
  const videoEl = () => {
    const v = $('#v-job');
    return v ? v.querySelector('video') : null;
  };
  box.append(
    word, to, sec,
    el('button', { class: 'ghost', onclick: () => {
      const v = videoEl();
      if (!v) return alert('這支還沒有可以播的成品');
      sec.value = v.currentTime.toFixed(1);
    } }, '⏱ 用現在的播放位置'),
    el('button', { class: 'ghost', onclick: () => {
      const v = videoEl(), t = parseFloat(sec.value);
      if (!v || !isFinite(t)) return;
      v.currentTime = Math.max(0, t - 1.5);
      v.play();
    } }, '▶ 再聽一次'),
    el('button', { class: 'go', onclick: async (ev) => {
      const from = word.value.trim(), t = to.value.trim();
      if (!from || !t) return alert('兩格都要填：唸錯的詞、該怎麼寫');
      if (from === t) return alert('「該怎麼寫」要填不一樣的字（同音、但 AI 唸得對的寫法）');
      const at = parseFloat(sec.value);
      ev.currentTarget.disabled = true;
      try {
        await savePronounce(job, from, t,
          '人工聽出來的' + (isFinite(at) ? `（第 ${at.toFixed(1)} 秒）` : ''));
        msg.textContent = S.ADMIN ? '✅ 已加進共用詞庫' : '✅ 已回報，等管理者收錄';
        word.disabled = to.disabled = sec.disabled = true;
      } catch (e) {
        ev.currentTarget.disabled = false;
        alert(e.message);
      }
    } }, S.ADMIN ? '加進共用詞庫' : '送出'),
    msg);
  return box;
}

/**
 * 「這支套用了哪幾條發音規則」。
 *
 * ⚠️ 顯示的是 job.voiceRules.hit ＝ **真的打中內文**的規則，不是整本詞庫（詞庫幾十條，
 *    全列出來等於沒列）。伺服器在建立工作時就算好了（voiceRuleHits()）。
 * ⚠️ 功能上線前建立的舊工作沒有 hit 這個欄位 —— 那不是「沒套到」，是「不知道」，
 *    所以整塊不畫（用 hit == null 判斷，不要用 falsy：空陣列是有意義的「這支真的沒套到」）。
 * ⚠️ 規則的文字是同事打的，一律用 el() 的文字節點，不要拼 html:（見雷區：`html:` 與 XSS）。
 */
export function appliedRulesBox(job) {
  const hit = (job.voiceRules || {}).hit;
  if (hit == null) return '';

  const head = el('div', { style: 'font-size:13px;color:var(--dim);margin-bottom:6px' },
    hit.length
      ? `這支送 AI 配音前，先套了這 ${hit.length} 條發音規則 —— 這些字聽起來還是錯的話，代表規則沒生效，換一種寫法再回報一次。`
      : '這支沒有套到任何發音規則。聽到唸錯的字都是新的，直接回報就好。');

  const list = el('div', { class: 'rules' });
  for (const r of hit) {
    list.append(el('span', { class: 'rule' },
      r.from, ' → ', el('b', {}, r.to),
      r.times > 1 ? ` ×${r.times}` : '',
      el('i', {}, r.src === 'own' ? '本支自己填的' : '共用詞庫')));
  }

  return el('div', { style: 'margin-top:18px;border-top:1px solid var(--line);padding-top:14px' },
    head, hit.length ? list : '');
}

/** 管理者直接進共用詞庫；同事則送一筆「跟我說」的唸法回報，由管理者收錄 */
export async function savePronounce(job, from, to, why) {
  if (S.ADMIN) {
    // 軟擋（兩個字／規則重疊）問一次就帶 force 重送；硬擋（單字）照原樣丟出去。
    // ⚠️ 這裡原本是「任何錯誤都問一次要不要硬加」—— 單字是硬擋、force 也繞不過，
    //    等於問完還是失敗。判斷交給 addDictRuleConfirming()（看回傳欄位，不比對中文）。
    if (!(await addDictRuleConfirming({ from, to, why, by: $('#owner').value || job.owner })))
      throw new Error('已取消');
    return;
  }
  await api('/api/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'pronounce', word: from, suggest: to, why,
      by: $('#owner').value || job.owner, job: job.id }),
  });
}

