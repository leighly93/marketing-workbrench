// 配圖計畫頁：計畫列、縮圖、重點詞區塊與預覽。

import { pickMoreShots, rangeText } from './annotations.js';
import { arrowSVG, arrowShaftPx, hasArrow } from './arrows.js';
import { $, api, el, fmt } from './dom.js';
import { approve, openEditor } from './editor.js';
import { drawEmph, saveEmph } from './emphasis.js';
import { motionBox } from './motion.js';
import { pinPage } from './say.js';
import { S } from './state.js';

export function planCard(job) {
  const pv = job.planView;
  // 舊工作的 planView 是功能上線前算的，沒有 editable 欄位 → 只有明確 false 才擋
  if (pv.editable === false)
    return el('div', { class: 'card' }, el('h2', {}, '配圖計畫'),
      el('div', { class: 'note' }, '這個版型還不支援線上調整。請看下方執行記錄裡的判定清單。'),
      el('div', { style: 'margin-top:16px' },
        el('button', { class: 'go', onclick: () => approve(job, []) }, '確認，開始出片')));

  const c = el('div', { class: 'card' },
    el('h2', {}, '配圖計畫　—　點預覽圖可以改，也可以自己加一段'),
    // ⚠️ 這幾段 note 一定要用 `html:` —— el() 的 kids 是走 createTextNode 的，
    //    當成字串子節點傳進去的話 <b>／<br> 會原樣印在畫面上給同事看（實際發生過）。
    el('div', { class: 'note', html:
      'AI 排的只是起點。<b>點左邊的預覽圖</b>就能拖框、改範圍、換圖。<br>'
      + '表格下面「<b>全部截圖</b>」會一直列出你上傳的每一張，看得出哪張用了、哪張還沒；'
      + '<b>點一下就加一段用那張</b>，同一張可以用很多次、各自標不同區塊。<br>'
      + (pv.kind === 'focus'
        ? '三大法人的「<b>顯示區域</b>」就是要捲到畫面上的那一段，「<b>黃框</b>」是要框起來的那一格；'
          + '兩個都不畫就是整張蓋滿。<br>'
        : '')
      + '你改的每一筆都會被記下來，之後拿來修規則 —— 讓你越改越少。' }));

  S.UNITS = pv.units || [];   // 點一下選整句用
  S.CHARS = pv.chars || [];   // 逐字拖選用
  // 這支已經標過的重點詞（伺服器從 src/emphasis.generated.json 讀出來的）
  S.EMPH = (pv.emphasis || [])
    .filter((m) => Number.isInteger(m.startCharIdx) && Number.isInteger(m.endCharIdx))
    .map((m) => ({ startCharIdx: m.startCharIdx, endCharIdx: m.endCharIdx }));
  // 自動列身上才有真的秒數（人工列是「秒數出片時算」）。拿它們回推一個字大約幾秒，
  // 「裁完剩下的會不會不到 1.4 秒」才講得出秒數。算不出來就維持 null，提示只講字數。
  {
    let sec = 0, n = 0;
    for (const r of pv.rows || []) {
      if (typeof r.start !== 'number' || typeof r.end !== 'number') continue;
      if (typeof r.startCharIdx !== 'number' || typeof r.endCharIdx !== 'number') continue;
      const chars = Math.abs(r.endCharIdx - r.startCharIdx) + 1;
      if (chars < 2 || r.end <= r.start) continue;
      sec += r.end - r.start; n += chars;
    }
    S.CHAR_SEC = n >= 8 ? sec / n : null;
  }

  S.edits = {};
  let addSeq = 0;
  for (const r of pv.rows) {
    S.edits[r.i] = { i: r.i, src: r.src, deleted: false,
      cell: r.cell || null, region: r.region || null, arrow: r.arrow || null,
      start: r.start, end: r.end, _manual: false,
      startCharIdx: r.startCharIdx, endCharIdx: r.endCharIdx,
      imgW: r.imageWidth, imgH: r.imageHeight,
      _autoPhrase: r.phrase || '', _autoCellText: r.cellText || '' };
  }

  // 「標注遲到」的救援。手動標記存下去的時間如果晚於 auto-shot 讀檔的那一刻，
  // 那筆標注就進不了計畫，畫面上會變成「我標的那張圖不見了」
  //（2026-08-21 使用者回報：標了第一、第二張，配圖計畫只剩第一張）。
  // 伺服器把沒進計畫的標注放在 pendingAnnots，這裡當成「已經填好的人工段」補回來，
  // 使用者不用重標；不想要的話按「刪除」就好。
  const late = pv.pendingAnnots || [];
  for (const a of late) {
    const key = 'a' + (addSeq++);
    S.edits[key] = { i: key, _added: true, _manual: true, _late: true, deleted: false,
      src: a.src, cell: a.cell || null, region: a.region || null, arrow: a.arrow || null,
      startCharIdx: a.startCharIdx, endCharIdx: a.endCharIdx,
      imgW: a.imgW || null, imgH: a.imgH || null };
  }
  if (late.length)
    c.append(el('div', { class: 'warn', style: 'margin-top:14px', html:
      `⚠️ 有 <b>${late.length}</b> 筆你在「手動標記」標的段落沒被自動計畫吃到`
      + '（計畫算完之後才存的）。<b>已經幫你補進下面的表格</b>，標成「標注補回」—— '
      + '請確認範圍和框對不對，不要的話按「刪除」。' }));

  const tb = el('tbody');
  const t = el('table', { class: 'plan' }, el('thead', {}, el('tr', {},
    el('th', {}, '預覽（點我編輯）'), el('th', {}, '這段旁白'), el('th', {}, '設定'), el('th', {}, ''))), tb);
  const gallery = el('div', { style: 'margin-top:20px;padding-top:16px;border-top:1px solid var(--line)' });

  function buildRow(key) {
    const e = S.edits[key];
    const tr = el('tr');
    if (e.deleted) tr.classList.add('del');
    const cellTd = el('td'), infoTd = el('td'), setTd = el('td');
    const paint = () => {
      const done = () => { paint(); drawUnused(); };
      cellTd.replaceChildren(preview(job, e, () =>
        openEditor(job, pv, { i: key,
          phrase: e._late ? '你標注的一段　' + e.src : (e._added ? '新增的一段' : e._autoPhrase) }, done)));
      const ranged = e.startCharIdx != null;
      infoTd.replaceChildren(
        el('div', { class: 'ph' }, ranged ? rangeText(e) : (e._added ? '（還沒設定範圍）' : (e._autoPhrase || '—'))),
        el('div', { class: 'sec' }, (e._manual || e._added)
          ? '（範圍已設，秒數出片時算）'
          : `${fmt(e.start)} – ${fmt(e.end)}　共 ${(e.end - e.start).toFixed(1)} 秒`),
        el('div', { class: 'sec', style: e._late ? 'color:#c98a00;font-weight:600' : '' },
          e._late ? '標注補回（自動計畫沒吃到）'
            : (e._added ? '人工新增' : (e._manual ? '人工調整過' : '自動：' + (e._autoCellText || '—')))));
      setTd.replaceChildren(
        el('div', { class: 'sec' }, e.src || '（未選圖）'),
        el('div', { class: 'sec' }, [e.region ? '顯示區域' : null, e.cell ? '黃框' : null,
          hasArrow(e.arrow) ? '箭頭' : null].filter(Boolean).join('＋') || '整張顯示'));
    };
    paint();
    tr.append(cellTd, infoTd, setTd,
      el('td', {}, el('button', { class: 'ghost danger', onclick: () => {
        if (e._added) { delete S.edits[key]; renderTable(); }
        else { e.deleted = !e.deleted; tr.classList.toggle('del', e.deleted); drawUnused(); }
      } }, e._added ? '刪除' : '不要這段')));
    return tr;
  }

  function renderTable() {
    const keys = Object.keys(S.edits).sort((a, b) =>
      (S.edits[a].startCharIdx ?? 1e9) - (S.edits[b].startCharIdx ?? 1e9));
    // 自動計畫有可能一段都排不出來（沒有手動標注、也沒有 (shot:) 標記時很常見）。
    // 空表格看起來像壞掉／像圖都不見了 —— 講清楚並指向下面的截圖牆。
    tb.replaceChildren(...(keys.length ? keys.map(buildRow)
      : [el('tr', {}, el('td', { colspan: 4, class: 'empty', style: 'padding:26px 0' },
          pv.images.length
            ? '這支還沒有任何配圖 —— 從下面的「全部截圖」點一張開始加。'
            : '這支還沒有任何配圖，也還沒有截圖 —— 先用下面的「＋ 上傳截圖」傳幾張。'))]));
    drawUnused();
    // 改了某一段的出現範圍之後，重點詞那一區的藍底線要跟著更新
    //（不然「哪裡已經有圖」會停在剛進頁面的那一刻，愈改愈不準）。
    drawEmph();
  }

  function addSeg(src) {
    // ⚠️ 2026-09-11：原本最後一層退路是 src:''，前台跟著去抓 /api/jobs/<id>/file/
    //    （檔名空的）→ 伺服器解成資料夾 → EISDIR → **整台掛掉**，同事全部連不進來。
    //    只有「一張截圖都沒傳」的工作會走到那層，所以本機測不出來（自己永遠先傳圖）。
    //    隔壁 addAnnot 早就有同一道守門，這裡補上。伺服器端也擋了，兩層都要有。
    const use = src || pv.images[0];
    if (!use) return alert('這支工作沒有上傳截圖，沒有東西可以加 —— 請先上傳截圖。');
    const key = 'a' + (addSeq++);
    S.edits[key] = { i: key, _added: true, _manual: true, deleted: false,
      src: use, cell: null, region: null, arrow: null,
      startCharIdx: null, endCharIdx: null, imgW: null, imgH: null };
    renderTable();
    openEditor(job, pv, { i: key, phrase: '新增的一段' }, () => renderTable());
  }

  // 上傳的每一張截圖都一直列在表格下方，點一下就加一段用那張。
  // 同一張圖可以點很多次 → 出現很多次、各自標不同區塊
  //（2026-08-18 使用者：同一張圖會用多次、標不同區塊）。
  // ⚠️ 這裡要列「全部」不是「沒用到的」—— 使用者要靠它記住哪張用了、哪張還沒
  //（2026-08-21）。以前是表格上方一排檔名文字按鈕，沒有縮圖、又在上面，看不到。
  function drawUnused() {
    const count = {};
    Object.values(S.edits).filter((e) => !e.deleted).forEach((e) => { count[e.src] = (count[e.src] || 0) + 1; });
    // 沒有截圖就沒有東西可以配 → 藏掉「＋ 加一段」，只留上傳。
    // ⚠️ 2026-09-11：以前這裡是 `if (!pv.images.length) return gallery.replaceChildren();`，
    //    整塊清空連上傳按鈕一起沒了，但底下的「＋ 加一段」還在 —— 同事看得到那顆、
    //    卻沒有任何地方可以傳圖，按下去還把整台伺服器打死（空檔名 → 目錄 → EISDIR）。
    //    現在反過來：沒圖時只出現上傳，傳了圖才出現「＋ 加一段」。
    addSegBtn.hidden = !pv.images.length;
    // 待確認階段也能補圖（2026-09-01 使用者：「讓待確認階段還能補圖」）。
    // ⚠️ 上傳完**只重畫這面縮圖牆**，絕對不要走 loadJob() —— 那會重建 `edits`，
    //    把你剛剛拉的框、加的段全部丟掉（而且完全沒有提示）。
    const upload = el('button', { class: 'ghost tiny', onclick: () => pickMoreShots(job, (added) => {
      for (const n of added) if (!pv.images.includes(n)) pv.images.push(n);
      drawUnused();
      const box = $('#planUpMsg');
      if (box) {
        box.textContent = added.length ? `已加入 ${added.join('、')}，點縮圖就能用它加一段` : '';
        setTimeout(() => { if ($('#planUpMsg')) $('#planUpMsg').textContent = ''; }, 6000);
      }
    }) }, pv.images.length ? '＋ 上傳更多截圖' : '＋ 上傳截圖');
    const upMsg = el('span', { id: 'planUpMsg', style: 'font-size:12.5px;color:var(--dim)' });
    if (!pv.images.length) {
      return gallery.replaceChildren(
        el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
          el('div', { style: 'font-size:13.5px' },
            '這支工作還沒有任何截圖 —— 先傳幾張，才能把旁白配到畫面上。'),
          upload, upMsg));
    }
    const used = pv.images.filter((n) => count[n]).length;
    gallery.replaceChildren(
      el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
        el('div', { style: 'font-size:12.5px;color:var(--dim)' },
          `全部截圖 ${pv.images.length} 張，已經用了 ${used} 張　—　`
          + '點一下就加一段用它；同一張可以點多次、各自標不同區塊。'),
        upload, upMsg),
      el('div', { class: 'shots' }, ...shotFigures(job, pv.images, count, pv.pages, addSeg)));
  }

  // 先建好再 renderTable() —— drawUnused() 會依「有沒有截圖」決定要不要藏它，
  // 而 renderTable() 結尾就會呼叫 drawUnused()，順序反了會抓到 undefined。
  const addSegBtn = el('button', { class: 'ghost', onclick: () => addSeg() }, '＋ 加一段');
  renderTable();
  c.append(t, gallery);

  // ⚠️ 重點詞要排在「確認，開始出片」**上面**（2026-09-17 使用者回報）。
  //    原本擺在按鈕下面，人滑到按鈕就以為到底了，一按就跳去「排隊等出片」那張卡片，
  //    整個功能等於看不到。按鈕永遠是這張卡片的最後一個東西。
  c.append(emphasisBox(job, () => Object.values(S.edits || {})));
  // 動態小影片：同樣排在「確認，開始出片」上面。在這一頁改的話，doRender 之前會重算。
  c.append(motionBox(job, () => Object.values(S.edits || {})));

  c.append(el('div', { style: 'margin-top:20px;display:flex;gap:12px;align-items:center' },
    addSegBtn,
    el('button', { class: 'go', onclick: () => approve(job, Object.values(S.edits)) }, '確認，開始出片')));
  return c;
}

/**
 * 截圖縮圖牆（2026-09-17 抽成共用）。配圖計畫頁與手動標記頁用同一份。
 *
 * ⚠️ 以前只長在配圖計畫頁，所以準備中只能一張一張點縮圖，看不出哪張用了幾次、
 *    系統把它認成什麼頁 —— 跟字幕重點詞同一類問題（功能只開在一頁上）。
 *
 * count：每張圖被用了幾次（計畫頁數 edits、標注頁數 ANNOTS）。
 * pages：系統判定的頁型；計畫頁來自 planView.pages，標注頁走 /api/jobs/:id/pages。
 * onPick：點一下要做什麼（計畫頁＝加一段 addSeg，標注頁＝加一個標注 addAnnot）。
 */
export function shotFigures(job, images, count, pages, onPick) {
  return (images || []).map((n) => {
    const c = (count || {})[n] || 0;
    // 2026-09-07 系統判定的頁型（來自 app-images.generated.json）。
    // 認不出來（unknown）或只認得出「是個股頁但不知道哪個 tab」（stock-other）→ 給一顆 📌，
    // 按了只存指紋與截圖、不命名；之後 `node video/shots/page-pins.js` 批次分群命名（使用者定案：不要當場手打）。
    const pg = (pages || {})[n] || {};
    const unknown = !pg.page || pg.page === 'unknown' || pg.page === 'stock-other';
    const fig = el('figure', { class: c ? 'used' : '', title: `點一下＝用 ${n} 加一段`,
      onclick: () => onPick(n) },
      el('img', { src: `/api/jobs/${job.id}/file/${n}`, alt: '' }),
      el('div', { class: 'tag' }, c ? `已用 ${c} 次` : '還沒用'),
      el('div', { class: 'pg' + (unknown ? ' unk' : ''), title: '系統判定的頁型' }, pg.pageLabel || '未知頁面'),
      el('div', { class: 'nm' }, n));
    // 2026-09-07 使用者定案：📌 只給管理者（本機連進來的人）看；同事那邊只看到頁型標籤、沒有按鈕。
    if (unknown && S.ADMIN) fig.append(el('button', { class: 'pin', title: '記下這種頁：系統認不出來，先存指紋與截圖，之後批次命名',
      onclick: (ev) => { ev.stopPropagation(); pinPage(n, fig); } }, '📌'));
    return fig;
  });
}
/**
 * 字幕重點詞區塊（2026-09-17）。**共用** —— 準備中、待確認、排隊等出片都要有這一塊。
 *
 * ⚠️ 只開在配圖計畫頁是不夠的（使用者回報兩次）：
 *      ① 勾「標好了，直接出片」的工作根本不經過計畫頁
 *      ② 按完「確認，開始出片」就換成另一張卡片，想補標只能退回
 *    標注頁才是大家實際待的地方，所以三個階段一律給同一塊。
 *
 * 收合起來不佔版面（使用者：「希望這功能可以收合」）；已經標過就預設展開，
 * 不然「已標 N 處」藏在收合列裡，看起來跟沒標一樣。
 *
 * covered：回傳「哪些段落佔了哪些字」的陣列，用來畫藍底線。各階段來源不同，見 charsCoveredBy()。
 */
export function emphasisBox(job, covered) {
  S.EMPH_JOB = job;
  S.EMPH_COVERED = covered || (() => []);
  const box = el('details', { class: 'emph' },
    el('summary', {},
      '字幕重點詞（選填）　',
      el('span', { id: 'emphCount', class: 'sec' }, '尚未標記'),
      el('span', { id: 'emphSaved', class: 'sec', style: 'margin-left:10px' }, '')),
    el('div', { class: 'tip' },
      '在下面的腳本上拖選要強調的詞 —— 成品裡那幾個字會放大變黃，同一句其餘維持白字一般大小。'
      + '點一下已標的地方就取消。改了就會自動存，不用按任何按鈕。'),
    el('div', { class: 'tip' },
      '字底下有藍線＝那一段已經有配圖；沒有線的地方畫面上只有講者。'),
    el('div', { class: 'range', id: 'emphRange' }),
    el('div', { style: 'margin-top:8px' },
      el('button', { class: 'ghost tiny', id: 'emphClear',
        onclick: () => { S.EMPH = []; drawEmph(); saveEmph(); } }, '全部清除')));
  if (S.EMPH.length) box.open = true;
  // DOM 要等呼叫端 append 之後才找得到，所以繞一圈再畫。
  setTimeout(drawEmph, 0);
  return box;
}

/**
 * 重點詞與腳本字元讀進來（標注頁／排隊階段用；計畫頁的 planView 本來就帶了這兩份）。
 * 讀完才畫 —— CHARS 是空的話 drawEmph() 只會顯示「腳本還在讀…」。
 */
export function loadEmph(job, after) {
  Promise.all([
    S.CHARS.length ? Promise.resolve(null) : api(`/api/jobs/${job.id}/sentences`).catch(() => null),
    api(`/api/jobs/${job.id}/emphasis`).catch(() => ({ marks: [] })),
  ]).then(([sv, ev]) => {
    if (sv) { S.UNITS = sv.units || S.UNITS; S.CHARS = sv.chars || S.CHARS; }
    S.EMPH = (ev.marks || [])
      .filter((m) => Number.isInteger(m.startCharIdx) && Number.isInteger(m.endCharIdx))
      .map((m) => ({ startCharIdx: m.startCharIdx, endCharIdx: m.endCharIdx }));
    if (after) after();
    drawEmph();
  });
}

/** 一列的預覽：原圖 ＋ 用比例畫上去的黃框（改完立刻反映，不用等伺服器重畫） */
export function preview(job, e, onclick) {
  const box = el('div', { class: 'prev' + (e._manual ? ' man' : ''), onclick });
  box.append(el('img', { src: `/api/jobs/${job.id}/file/${e.src}`, alt: '' }));
  const put = (r, cls) => {
    if (!r || !(r.w > 0) || !e.imgW || !e.imgH) return;
    box.append(el('div', { class: cls, style:
      `left:${(r.x / e.imgW) * 100}%;top:${(r.y / e.imgH) * 100}%;`
      + `width:${(r.w / e.imgW) * 100}%;height:${(r.h / e.imgH) * 100}%` }));
  };
  put(e.region, 'bx region');
  put(e.cell, 'bx');
  // 箭頭（2026-09-16）。伺服器的 ffmpeg 縮圖畫不出箭頭（drawbox 只能畫軸對齊矩形），
  // 這一份是前台自己疊的 SVG —— 計畫頁看到的箭頭全部來自這裡。
  // ⚠️ 縮圖是固定 120px 寬（.prev），高度要照原圖比例算，不能拿 offsetHeight（圖可能還沒載入）。
  if (hasArrow(e.arrow) && e.imgW && e.imgH) {
    const w = 120, h = (w * e.imgH) / e.imgW;
    const k = w / e.imgW;
    box.append(arrowSVG(w, h, e.arrow.x1 * k, e.arrow.y1 * k, e.arrow.x2 * k, e.arrow.y2 * k,
      e.arrow.color, arrowShaftPx(w, e.imgW, e.imgH, e.region)));
  }
  // 沒有框就什麼線都不要畫 —— 以前這裡畫一個包住整張圖的黃框當「整張顯示」的標示，
  // 結果被當成真的黃框，而且看不出怎麼刪（2026-08-17 使用者回報）。
  const empty = !e.region && !e.cell && !hasArrow(e.arrow);
  box.append(el('div', { class: 'hint' },
    empty ? '整張顯示・點我編輯' : (e._manual ? '已手動調整' : '點我編輯')));
  return box;
}

