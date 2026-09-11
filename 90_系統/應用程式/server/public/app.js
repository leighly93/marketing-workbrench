
const $ = (s) => document.querySelector(s);
const el = (t, a = {}, ...kids) => {
  const n = document.createElement(t);
  for (const [k, v] of Object.entries(a)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
  }
  kids.flat().forEach((c) => n.append(c && c.nodeType ? c : document.createTextNode(c ?? '')));
  return n;
};
// 管理者暗號：從網址列的 ?k=... 拿，然後**每一支 API 都要帶上**。
// （之前的 ?admin=1 從來沒生效過，就是因為 fetch('/api/xxx') 沒把 query 帶過去，
//   伺服器那邊看到的 URL 根本沒有那個參數。）
const ADMIN_KEY = new URLSearchParams(location.search).get('k') || '';
const withKey = (u) => (ADMIN_KEY ? u + (u.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(ADMIN_KEY) : u);
const api = async (u, o) => {
  const r = await fetch(withKey(u), o);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    // ⚠️ 回應內容要一起帶上去。伺服器有些 400 不是「錯誤」而是「提醒」（例如加詞庫的軟擋，
    //    會多回 `short: true` / `clash: [...]`），呼叫端得看得到那些欄位才知道可以帶 force 重送。
    //    2026-08-21 踩過：只丟 message 出去，呼叫端只能比對中文字串，提醒文案一改功能就壞。
    const e = new Error(j.error || ('HTTP ' + r.status));
    e.status = r.status;
    e.data = j;
    throw e;
  }
  return j;
};
const fmt = (s) => (s == null ? '—' : s.toFixed(1) + 's');
const STATUS_TEXT = { draft:'建立中', queued:'排隊中', preparing:'準備中', review:'待確認',
  approved:'等待出片', rendering:'出片中', done:'完成', failed:'失敗', cancelled:'已取消',
  // 伺服器重開前就開始跑的工作。run.js 是 detached 的，會自己跑完。
  detached:'背景執行中', 'detached-done':'已在背景跑完' };

// tpl 的初始值只是「還沒收到 /api/health 之前」的暫時值；boot2() 收到 TPLS 之後
// 會把它校正成「可選清單的第一個」（2026-08-31 使用者要求：焦點股日報移到最後，預設改成第一個）。
let TPLS = {}, BRANDS = [], ADMIN = false, brand = null, tpl = null, view = 'new', openJob = null;
// 這個分頁載入 index.html 時，伺服器上那個檔案的時間戳（第一次 poll 記起來，之後比對）
let webSeen = null;

// ── 標題 ──────────────────────────────────
// 四個版型的標題限制差很多（見 server/index.js 的 TEMPLATES.title 註解）：
//   焦點股／投廣 一行；大盤／三大法人／盤中焦點 兩行、而且兩行顏色不同。
// 原本做的是「自動斷行＋預覽」，但斷在哪其實是編輯決定，不該讓系統猜
//（2026-08-13 使用者：「我覺得這邊不用預覽」）。
// 改成直接給對應數量的輸入框 —— 打什麼就是什麼，輸入框本身就是預覽。
let titleVals = ['', ''];
function titleCfg() {
  return (TPLS[tpl] && TPLS[tpl].title) || { lines: 2, per: 12, where: '' };
}
function titleLines() {
  return titleVals.slice(0, titleCfg().lines).map((v) => v.trim()).filter(Boolean);
}
function drawTitle() {
  const cfg = titleCfg();
  const wrap = $('#titleLines');
  const rows = [];
  for (let i = 0; i < cfg.lines; i++) {
    // 會換行的模板（焦點股／大盤／三大法人）：字數只是「參考」，可以超過 —— 超過只是自動換行、字級不變。
    // 只有不能換行的投廣模板（cfg.wrap === false）才用 maxlength 硬擋，因為上方 bar 沒換行空間。
    //（2026-08-17 使用者：除投廣外，字數限制只是參考，為什麼不能輸入超過。）
    if (!cfg.wrap) titleVals[i] = (titleVals[i] || '').slice(0, cfg.per);
    const cnt = el('span', { class: 'cnt' });
    const inp = el('input', {
      type: 'text', value: titleVals[i] || '',
      ...(cfg.wrap ? {} : { maxlength: cfg.per }),
      placeholder: cfg.lines === 1 ? '' : (i === 0 ? '第一行' : '第二行'),
      oninput: (e) => { titleVals[i] = e.target.value; paint(); },
    });
    const paint = () => {
      const n = (titleVals[i] || '').trim().length;
      const over = cfg.wrap && n > cfg.per;
      cnt.textContent = n ? n + '/' + cfg.per + (over ? '・會換行' : '') : '';
      cnt.classList.toggle('over', over);
    };
    paint();
    rows.push(el('div', { class: 'tline' }, inp, cnt));
  }
  wrap.replaceChildren(...rows);
  $('#twhere').textContent = cfg.where;
}

// ── 導覽 ──
document.querySelectorAll('nav button').forEach((b) =>
  b.onclick = () => { openJob = null; go(b.dataset.v); });
function go(v) {
  if (v !== 'job') jobSig = null;   // 換頁／換工作要重畫
  view = v;
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  for (const id of ['new', 'list', 'job', 'say', 'fix']) $('#v-' + id).hidden = (id !== v);
  if (v === 'list') loadJobs();
  if (v === 'fix') loadFix();
  if (v === 'say') loadSay();
  if (v === 'job') loadJob();
}

// 強制解鎖（只有管理者點得動）
$('#status').onclick = async () => {
  if (!ADMIN || !$('#status').textContent.includes('佔用')) return;
  if (!confirm('強制刪掉 .run.lock？\n\n只有在確定沒有任何 run.js 在跑的時候才做，'
    + '否則兩個流程會同時寫 public/，兩支影片都會壞掉。')) return;
  await api('/api/unlock', { method: 'POST' });
  poll();
};

$('#lb').onclick = () => ($('#lb').style.display = 'none');
function zoom(src) { $('#lbimg').src = src; $('#lb').style.display = 'flex'; }

// ── 截圖欄位 ──────────────────────────────
// 預設三格＋一個「再新增」。比一個大拖曳區清楚：一眼看得出放了幾張、順序是什麼。
let slots = [null, null, null];
let pickingSlot = -1;

$('#picker').onchange = (e) => {
  const f = e.target.files[0];
  if (f && pickingSlot >= 0) slots[pickingSlot] = f;
  e.target.value = '';
  drawSlots();
};

function setSlotFile(i, f) {
  if (!f) return;
  if (!/^image\//.test(f.type)) {
    // 原本是靜靜忽略 —— 使用者把 mp4 拖進來會以為壞掉（2026-08-13 回報）
    alert(/^video\//.test(f.type)
      ? '這幾格是放 APP 截圖的。\n\n講者影片預設由系統自己生成，不用上傳；\n真的要用現成的影片，請展開下面的「進階」→ 勾「用現成的講者影片」。'
      : `「${f.name}」不是圖片檔，這幾格只能放 png / jpg 截圖。`);
    return;
  }
  slots[i] = f;
  drawSlots();
}

function drawSlots() {
  const wrap = $('#slots');
  const nodes = slots.map((f, i) => {
    const s = el('div', {
      class: 'slot' + (f ? ' filled' : ''),
      onclick: () => { pickingSlot = i; $('#picker').click(); },
      ondragover: (e) => { e.preventDefault(); s.classList.add('hot'); },
      ondragleave: () => s.classList.remove('hot'),
      ondrop: (e) => { e.preventDefault(); s.classList.remove('hot'); setSlotFile(i, e.dataTransfer.files[0]); },
    });
    if (f) {
      s.append(
        el('img', { src: URL.createObjectURL(f), alt: '' }),
        el('button', { class: 'x', title: '刪掉這張',
          onclick: (e) => { e.stopPropagation(); slots.splice(i, 1); if (slots.length < 3) slots.push(null); drawSlots(); } }, '✕'),
        el('div', { class: 'tag' }, el('b', {}, '截圖 ' + (i + 1))));
    } else {
      s.append(el('div', { class: 'n' }, '截圖 ' + (i + 1)), el('div', { class: 'h' }, '點擊或拖曳'));
    }
    return s;
  });
  nodes.push(el('div', {
    class: 'slot add',
    onclick: () => { slots.push(null); drawSlots(); },
    title: '再新增一張',
  }, '＋'));
  wrap.replaceChildren(...nodes);
}

// ── 進階：現成講者影片 ──
let heygenFile = null;
$('#skipGenerate').onchange = (e) => {
  $('#heygenSlot').style.display = e.target.checked ? 'block' : 'none';
  $('#costWarn').hidden = e.target.checked;   // 用現成影片不呼叫 HeyGen，不扣點數
};
function setHeygen(f) {
  if (!f) return;
  // accept 有時擋不住（有些系統 mp4 的 MIME 是空的），所以副檔名也認
  if (!/^video\//.test(f.type) && !/\.(mp4|mov|m4v)$/i.test(f.name))
    return alert(`「${f.name}」看起來不是影片檔。`);
  heygenFile = f;
  $('#vdrop').classList.add('ok');
  $('#heygenName').textContent = `${f.name}　${(f.size / 1048576).toFixed(1)} MB　（點這裡可換掉）`;
}
$('#vdrop').onclick = () => $('#heygenPicker').click();
['dragover', 'dragleave', 'drop'].forEach((ev) =>
  $('#vdrop').addEventListener(ev, (e) => {
    e.preventDefault();
    $('#vdrop').classList.toggle('hot', ev === 'dragover');
    if (ev === 'drop') setHeygen(e.dataTransfer.files[0]);
  }));
$('#heygenPicker').onchange = (e) => { setHeygen(e.target.files[0]); e.target.value = ''; };

// ── 版型 ──
async function boot() {
  const h = await api('/api/health');
  TPLS = h.templates;
  BRANDS = h.brands || [];
  // 修正紀錄只給管理者（本機連進來的人）看。
  // ⚠️ 2026-08-21：「進階」整塊已經沒有了 —— 裡面唯一的「用現成的講者影片」開放給所有人
  //    （那是唯一不花點數的出片路徑，鎖起來等於逼同事每試一次就燒點數）。
  //    所以這裡不再有 `$('#advBox').hidden = !ADMIN`，別再加回來。
  ADMIN = !!h.admin;
  $('#navFix').hidden = !ADMIN;
  // hidden 的版型整個不畫出來、disabled 的變灰不給點（2026-08-20：投廣模板先從清單拿掉）。
  // TPLS 仍然收到全部版型 —— 工作列表要靠它顯示舊工作的版型名稱。
  const pickable = Object.entries(TPLS).filter(([, t]) => !t.hidden);
  $('#tpl').replaceChildren(...pickable.map(([k, t]) =>
    el('div', {
      'data-k': k,
      class: (k === tpl ? 'on' : '') + (t.disabled ? ' off' : ''),
      title: t.disabled ? '暫時關閉' : '',
      onclick: t.disabled ? null : () => { tpl = k; boot2(); },
    }, t.label)));
  // 萬一預設選到被關閉／隱藏的版型，跳到第一個可用的
  // 2026-08-31：預設選中＝可選清單的第一個（順序由 server/index.js 的 TEMPLATES 宣告順序決定）。
  // tpl 還是 null（第一次載入）或指到被關掉／隱藏的版型時都走這條。
  if (!tpl || !TPLS[tpl] || TPLS[tpl].disabled || TPLS[tpl].hidden) {
    const ok = pickable.find(([, t]) => !t.disabled);
    if (ok) tpl = ok[0];
  }
  boot2();
  drawSlots();
  poll();
  setInterval(poll, 3000);
}
function boot2() {
  document.querySelectorAll('#tpl div').forEach((d) =>
    d.classList.toggle('on', d.dataset.k === tpl));   // 用 data-k 對，不能用順序（清單會過濾）
  // 版型配色（2026-09-11）：CSS 用 #v-new[data-tpl=…] 覆寫 --accent 那組變數，
  // 1～5 的卡片外框、選中的版型、開始出片按鈕會一起換色，避免選錯版型（使用者要求）。
  // 放這裡是因為 boot2() 是**唯一**每次換版型都會跑的地方（onclick 與 boot() 都收斂到它）。
  $('#v-new').dataset.tpl = tpl || '';
  // 2026-08-31：tpl 的初始值改成 null（預設＝清單第一個），所以這裡不能再假設它一定指到一個版型
  // ——「全部版型都被關掉」時 tpl 會留在 null，下面幾行直接 .flags 會整頁掛掉。
  const cur = TPLS[tpl] || {};
  $('#wrapWithAd').style.display = (cur.flags || []).includes('with-ad') ? 'flex' : 'none';
  // 投廣模板要再選品牌（起漲K線／籌碼K線）—— 外框、logo、片尾、BGM 都不一樣
  const showBrands = !!cur.brands && BRANDS.length > 0;
  $('#brands').style.display = showBrands ? 'flex' : 'none';
  if (showBrands) {
    if (!BRANDS.includes(brand)) brand = BRANDS[0];
    $('#brands').replaceChildren(...BRANDS.map((b) =>
      el('div', { class: b === brand ? 'on' : '', onclick: () => { brand = b; boot2(); } }, b)));
  } else brand = null;
  drawTitle();   // 換版型 → 標題行數／字數限制不同
}

async function poll() {
  try {
    const h = await api('/api/health');
    const s = $('#status');
    // 檔案比伺服器啟動時間新 → 一定是改完忘了重開
    $('#stale').style.display = h.codeChangedAt > h.startedAt ? 'block' : 'none';
    // 誰在看，決定第二句講什麼。用 h.admin 不用全域 ADMIN —— poll() 有可能比 boot() 先跑完。
    $('#staleAdmin').hidden = !h.admin;
    $('#staleOther').hidden = !!h.admin;
    // 這個分頁是什麼時候載入 index.html 的？之後檔案又被改過 → 畫面是舊的，要重新整理。
    // ⚠️ 這跟上面那條是**兩件不同的事**：伺服器重開了、網頁檔案也換了，但已經開著的
    //    分頁不會自己重載（輪詢只打 API，不會重抓 index.html）。使用者兩次都卡在這裡。
    if (h.webBuiltAt) {
      if (webSeen == null) webSeen = h.webBuiltAt;
      else if (h.webBuiltAt !== webSeen) $('#reload').style.display = 'flex';
    }
    // 磁碟用量只給管理者看。成品累積得很快（大盤一支就 138MB），要看得到才會有感
    if (h.admin && h.diskMB != null) {
      $('#disk').hidden = false;
      $('#disk').textContent = `💾 ${h.diskMB} MB`;
      $('#disk').title = '工作紀錄佔用空間；影片、稿件與素材會持續保留。';
    } else $('#disk').hidden = true;
    // ⚠️ 順序：busy 要先判斷。run.js 一跑就會建立 .run.lock，
    // 先看 locked 的話「每支影片跑的時候」都會顯示「被鎖住」，正常狀況長得像出事
    //（2026-08-17 使用者回報）。
    if (h.busy) { s.className = 'pill run'; s.textContent = '● 出片中'; }
    else if (h.externalLock) {
      s.className = 'pill bad';
      s.textContent = `⚠️ 工作區被佔用${h.lockAgeMin != null ? '（' + h.lockAgeMin + ' 分鐘）' : ''}`;
      s.title = '有其他流程在用工作區（可能是終端機在跑 run.js，或上次沒清乾淨）。'
        + '新工作會排隊等，不會失敗。點一下可以強制解鎖。';
      s.style.cursor = ADMIN ? 'pointer' : 'default';
    } else { s.className = 'pill'; s.textContent = '○ 閒置'; s.title = ''; s.style.cursor = 'default'; }
  } catch (_) {
    const s = $('#status'); s.className = 'pill bad'; s.textContent = '✕ 主機離線';
  }
  if (view === 'list') loadJobs();
  if (view === 'job' && openJob) loadJob();
}

// ── 送出 ──
$('#submit').onclick = async () => {
  const btn = $('#submit');
  const imgs = slots.filter(Boolean);
  const lines = titleLines();
  if (!$('#body').value.trim()) return alert('腳本是空的');
  if ($('#skipGenerate').checked && !heygenFile) return alert('勾了「用現成的講者影片」，請選擇 heygen.mp4');

  // 勾了「用現成的講者影片」不呼叫 HeyGen、不扣點數，就不用問
  if (!$('#skipGenerate').checked &&
      !confirm('確定要開始出片嗎？\n\n按下確定會馬上呼叫 HeyGen 生成講者影片，點數當下就扣掉，之後取消或重出都退不回來。\n\n請先確認腳本、標題、截圖都是最新的。')) return;

  btn.disabled = true;
  try {
    btn.textContent = '建立工作…';
    const { job } = await api('/api/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: tpl, owner: $('#owner').value,
        title: lines.join('\n'), body: $('#body').value, voice: $('#voice').value,
        // noSpeed 的勾選框 2026-08-19 拿掉了（加速已經改在 HeyGen 生成端做，正常出片不會重複）。
        // run.js 的 --no-speed 旗標還在，要用就在終端機下。
        skipGenerate: $('#skipGenerate').checked,
        withAd: $('#withAd').checked, autoApprove: false, brand,
      }),
    });
    const ups = imgs.map((f, i) => ({ f, name: 'shot' + (i + 1) + (/\.jpe?g$/i.test(f.name) ? '.jpg' : '.png') }));
    if (heygenFile) ups.push({ f: heygenFile, name: 'heygen.mp4' });
    for (let i = 0; i < ups.length; i++) {
      const mb = (ups[i].f.size / 1048576).toFixed(1);
      btn.textContent = `上傳 ${i + 1}/${ups.length}（${mb} MB）…`;
      // ⚠️ 一定要檢查結果。原本沒檢查 → 上傳失敗畫面照樣往下走，
      //    最後才丟一個看不懂的錯（2026-08-13）。
      const r = await fetch(withKey(`/api/jobs/${job.id}/upload?name=${ups[i].name}`),
        { method: 'POST', body: ups[i].f });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(`上傳「${ups[i].f.name}」失敗（${r.status}）${j.error ? '：' + j.error : ''}`);
      }
    }
    btn.textContent = '送出…';
    await api(`/api/jobs/${job.id}/submit`, { method: 'POST' });
    slots = [null, null, null]; heygenFile = null;
    $('#vdrop').classList.remove('ok');
    $('#heygenName').textContent = '支援 .mp4（會被存成 heygen.mp4）';
    $('#body').value = ''; titleVals = ['', ''];
    drawSlots(); drawTitle();
    openJob = job.id; go('job');
  } catch (e) { alert('出錯了：' + e.message); }
  btn.disabled = false; btn.textContent = '開始出片';
};

// ── 列表 ──
async function loadJobs() {
  const { jobs } = await api('/api/jobs');
  if (!jobs.length) return $('#jobs').replaceChildren(el('div', { class: 'empty' }, '還沒有任何工作'));
  const t = el('table', {}, el('thead', {}, el('tr', {},
    el('th', {}, '建立時間'), el('th', {}, '版型'), el('th', {}, '標題'),
    el('th', {}, '建立者'), el('th', {}, '狀態'),
    // 來源 IP 與刪除鈕都只有管理者看得到。IP 連資料本身都不會送到同事的瀏覽器
    //（伺服器端 publicJob 就剝掉了），這裡的判斷只是「不要畫一欄空的」。
    ADMIN ? el('th', {}, '來源 IP') : '',
    ADMIN ? el('th', {}, '') : '')));
  const tb = el('tbody');
  for (const j of jobs) {
    let st = STATUS_TEXT[j.status] || j.status;
    if (j.queuePosition > 0) st += `（前面還有 ${j.queuePosition} 支）`;
    tb.append(el('tr', { class: 'jobrow' },
      el('td', { onclick: () => { openJob = j.id; go('job'); } }, new Date(j.createdAt).toLocaleString('zh-TW', { hour12: false }).slice(5)),
      el('td', { onclick: () => { openJob = j.id; go('job'); } }, (TPLS[j.template] || {}).label || j.template),
      el('td', { onclick: () => { openJob = j.id; go('job'); } }, (j.title || '—').replace(/\n/g, ' ')),
      el('td', { onclick: () => { openJob = j.id; go('job'); } }, j.owner),
      el('td', { onclick: () => { openJob = j.id; go('job'); } }, el('span', { class: 'st ' + j.status }, st)),
      // 2026-08-21 之前建立的工作沒記過 IP，補不回來 → 顯示「—」
      ADMIN ? el('td', {
        style: 'font-variant-numeric:tabular-nums;color:#8a94a6;font-size:13px',
        onclick: () => { openJob = j.id; go('job'); },
      }, j.ip || '—') : '',
      // 刪除鈕：只有本機（管理者）看得到、按得動。正在跑的工作不給刪。
      ADMIN ? el('td', {}, el('button', {
        class: 'ghost danger', title: '刪除這筆工作',
        style: 'padding:3px 9px;font-size:13px',
        onclick: async (ev) => {
          ev.stopPropagation();
          if (['preparing', 'rendering'].includes(j.status)) return alert('正在跑的工作不能刪，等它結束或先取消。');
          if (!confirm('刪除這筆工作紀錄與上傳的素材？\n\n（出好的影片已存在「成品」資料夾，不會被刪。）')) return;
          try { await api(`/api/jobs/${j.id}`, { method: 'DELETE' }); loadJobs(); }
          catch (e) { alert('刪除失敗：' + e.message); }
        },
      }, '🗑')) : ''));
  }
  t.append(tb);
  $('#jobs').replaceChildren(t);
}

// ── 詳情 ──
let edits = {};
let jobSig = null;   // 上次畫出來的內容特徵
// 最後看過的工作。點導覽列會把 openJob 清掉，但「跟我說」要記得使用者
// 是從哪一支點過來的 —— 收到「按了沒反應」時才查得到是哪一支、什麼狀態。
let lastJob = null;
async function loadJob() {
  const { job } = await api('/api/jobs/' + openJob);
  lastJob = job.id;
  const { text } = await api(`/api/jobs/${openJob}/log`);
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
  if (sig === jobSig && box.childElementCount) {
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
  jobSig = sig;
  const keep = box.querySelector('pre.log');
  const scrolled = keep ? keep.scrollTop + keep.clientHeight >= keep.scrollHeight - 40 : true;

  const head = el('div', { class: 'card' },
    el('div', { style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap' },
      el('h2', { style: 'margin:0' }, (TPLS[job.template] || {}).label + '　' + (job.title || '').replace(/\n/g, ' ')),
      el('span', { class: 'st ' + job.status },
        (STATUS_TEXT[job.status] || job.status) + (job.queuePosition > 0 ? `（前面還有 ${job.queuePosition} 支）` : '')),
      el('span', { style: 'flex:1' }),
      el('button', { class: 'ghost', onclick: () => { openJob = null; go('list'); } }, '← 回列表')),
    el('div', { style: 'color:var(--dim);font-size:13px;margin-top:8px' },
      `${job.owner}・${new Date(job.createdAt).toLocaleString('zh-TW', { hour12: false })}`),
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

  // HeyGen 生成／準備中的時候就可以先標注 —— 不用乾等
  //（2026-08-17 使用者：「等heygen生成時我順便手動標示」）
  if (['queued', 'preparing', 'detached'].includes(job.status)) parts.push(annotCard(job));

  // 排隊等出片 → 還來得及反悔（2026-08-19 使用者要求的「反悔鍵」）。
  // 一旦 status 轉成 rendering 就退不回來了，那時只能取消重跑。
  if (job.status === 'approved') {
    parts.push(el('div', { class: 'card' },
      el('h2', {}, '排隊等出片'),
      el('div', { class: 'note', html:
        (job.approvedBy === '（自動出片）'
          ? '你設定了「標好了，直接出片」，所以準備一跑完就自動排進出片佇列。<br>' : '')
        + '還沒開始出片，現在退回去還可以改配圖／標注。<b>開始出片之後就退不回來了</b>。' }),
      el('div', { style: 'margin-top:14px' },
        el('button', { class: 'ghost', onclick: async () => {
          try {
            await api(`/api/jobs/${job.id}/unapprove`, { method: 'POST' });
            jobSig = null;
            loadJob();
          } catch (e) { alert('退不回來：' + e.message); }
        } }, '↩ 退回確認'))));
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
    if (job.archived && job.archived.length)
      card.append(el('div', { style: 'margin-top:16px;font-size:12.5px;color:var(--dim)' },
        '也存進成品庫了（不會自動清）：　' + job.archived.join('　/　')));
    parts.push(card);
    parts.push(pronounceReportCard(job));
  }

  const logCard = el('div', { class: 'card' },
    el('div', { style: 'display:flex;align-items:center;margin-bottom:12px' },
      el('h2', { style: 'margin:0;flex:1' }, '執行記錄'),
      ['queued', 'review', 'failed', 'approved', 'detached-done'].includes(job.status)
        ? el('button', { class: 'ghost danger', onclick: async () => {
            if (confirm('確定取消這支工作？')) { await api(`/api/jobs/${job.id}/cancel`, { method: 'POST' }); loadJob(); }
          } }, '取消工作') : ''),
    el('pre', { class: 'log' }, logText));
  parts.push(logCard);

  box.replaceChildren(...parts);
  const pre = logCard.querySelector('pre');
  if (scrolled) pre.scrollTop = pre.scrollHeight;
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
function pronounceReportCard(job) {
  const rows = el('div');
  const add = () => rows.append(reportRow(job));

  const c = el('div', { class: 'card' },
    el('h2', {}, '發音回報　—　聽到唸錯的字寫在這裡'),
    el('div', { class: 'note', html:
      '影片放出來聽，哪個字唸錯了就填在這裡。'
      + (ADMIN ? '按下去直接進共用詞庫，之後每支影片自動套用。'
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
function reportRow(job) {
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
        msg.textContent = ADMIN ? '✅ 已加進共用詞庫' : '✅ 已回報，等管理者收錄';
        word.disabled = to.disabled = sec.disabled = true;
      } catch (e) {
        ev.currentTarget.disabled = false;
        alert(e.message);
      }
    } }, ADMIN ? '加進共用詞庫' : '送出'),
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
function appliedRulesBox(job) {
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
async function savePronounce(job, from, to, why) {
  if (ADMIN) {
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

// ── 標注（HeyGen 還在跑的時候就能做）────────
// 秒數要等語音轉字幕才有，所以這裡標的是「哪一句」。
// HeyGen 跑完後系統自己把句子換算成秒數 —— 這也是既有 (shot:) 手動標記的運作方式。
let ANNOTS = [];
let UNITS = [];        // 子句清單（拉範圍用）
let annotJobId = null;

function annotCard(job) {
  const c = el('div', { class: 'card' },
    el('h2', {}, '手動標記　—　請手動標記要顯示的範圍'),
    el('div', { class: 'note', html:
      'HeyGen 生成要好幾分鐘，這段時間可以先把圖標好：<b>哪張圖配在哪一句、框哪裡</b>。<br>'
      + '每張要用的圖都請手動圈出要顯示的範圍；沒圈的截圖不會出現在影片裡。<br>'
      + '<b>標「哪一句」而不是「第幾秒」</b> —— 秒數要等語音轉完字幕才存在，系統會自己換算。<br>'
      + '圖不夠？<b>下面可以再上傳</b>；編輯器裡也有縮圖列可以直接換成別張圖。' }),
    el('div', { id: 'annotList' }),
    el('div', { style: 'margin-top:16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
      el('button', { class: 'ghost', onclick: () => addAnnot(job) }, '＋ 加一個標注'),
      el('button', { class: 'ghost', onclick: () => pickMoreShots(job) }, '＋ 上傳更多截圖'),
      el('span', { id: 'annotUpMsg', style: 'font-size:12.5px;color:var(--dim)' }),
      el('span', { id: 'annotSaved', style: 'font-size:12.5px;color:var(--dim)' })),
    autoGoRow(job));

  if (annotJobId !== job.id) {
    annotJobId = job.id;
    ANNOTS = []; UNITS = []; CHARS = [];
    Promise.all([
      api(`/api/jobs/${job.id}/sentences`).catch(() => ({ units: [] })),
      api(`/api/jobs/${job.id}/annotations`).catch(() => ({ shots: [] })),
    ]).then(([sv, av]) => {
      UNITS = sv.units || [];
      CHARS = sv.chars || [];
      ANNOTS = av.shots || [];
      drawAnnots(job);
    });
  } else setTimeout(() => drawAnnots(job), 0);
  return c;
}

/**
 * 「標好了，直接出片」——不用守在畫面前等確認關卡（2026-08-19 使用者要求）。
 * 這只是打開 job.autoApprove，伺服器是在 HeyGen／字幕／自動配圖全部跑完的
 * 最後一刻才讀它。所以在那之前隨時可以取消、繼續改標注，都還來得及。
 * ⚠️ 反過來說：標注是那一刻被 auto-shot／auto-focus 讀走的，
 *    「準備中」變成別的狀態之後才改就吃不到了 —— 所以這張卡片只在準備階段出現。
 */
function autoGoRow(job) {
  const btn = el('button', {});
  const note = el('span', { style: 'font-size:12.5px;color:var(--dim);margin-left:12px' });
  const paint = () => {
    btn.className = job.autoApprove ? 'go' : 'ghost';
    btn.textContent = job.autoApprove ? '✓ 標好了，直接出片' : '標好了，直接出片';
    note.innerHTML = job.autoApprove
      ? 'HeyGen 一生成完就自動接著出片，你可以先去忙別的。<b>還沒開始出片前都可以點一下取消</b>。'
      : '打開的話，HeyGen 跑完就直接出片，不停下來等你確認。';
  };
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const r = await api(`/api/jobs/${job.id}/auto-approve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: !job.autoApprove }),
      });
      job.autoApprove = !!r.job.autoApprove;
      paint();
    } catch (e) { alert('設定失敗：' + e.message); }
    btn.disabled = false;
  };
  paint();
  return el('div', { style: 'margin-top:14px;padding-top:14px;border-top:1px solid var(--line)' },
    btn, note);
}

/** 把字元範圍還原成文字，給列表顯示 */
function rangeText(a) {
  if (a.startCharIdx == null || !CHARS.length) return '（未指定範圍）';
  const lo = Math.min(a.startCharIdx, a.endCharIdx), hi = Math.max(a.startCharIdx, a.endCharIdx);
  const t = CHARS.filter((c) => c.i >= lo && c.i <= hi).map((c) => c.c).join('');
  return t || '（找不到這一段）';
}

function drawAnnots(job) {
  const wrap = $('#annotList');
  if (!wrap) return;
  const imgs = (job.files || []).filter((f) => /\.(png|jpe?g)$/i.test(f));
  if (!CHARS.length) return wrap.replaceChildren(
    el('div', { style: 'color:var(--dim);font-size:13.5px;padding:14px 0' }, '正在讀腳本…'));

  // 每張圖一列，各自獨立 —— 使用者原話：「每張圖的選取都是客製化的」（2026-08-17）
  wrap.replaceChildren(...imgs.map((src) => {
    const mine = ANNOTS.map((a, k) => ({ a, k })).filter((x) => x.a.src === src);
    const rows = mine.map(({ a, k }) => {
      const box = el('div', { class: 'prev man', onclick: () => editAnnot(job, k) });
      box.append(el('img', { src: `/api/jobs/${job.id}/file/${src}`, alt: '' }));
      const put = (r, cls) => {
        if (!r || !(r.w > 0) || !a.imgW || !a.imgH) return;
        box.append(el('div', { class: cls, style:
          `left:${(r.x / a.imgW) * 100}%;top:${(r.y / a.imgH) * 100}%;`
          + `width:${(r.w / a.imgW) * 100}%;height:${(r.h / a.imgH) * 100}%` }));
      };
      put(a.region, 'bx region');
      put(a.cell, 'bx');
      box.append(el('div', { class: 'hint' },
        !a.region && !a.cell ? '整張顯示・點我改' : '點我改'));
      return el('div', { class: 'an' }, box,
        el('div', { class: 's' },
          el('b', {}, '出現在：' + rangeText(a)),
          el('span', {}, ([a.region ? '有顯示區域' : null, a.cell ? '有黃框' : null]
            .filter(Boolean).join('＋') || '整張顯示') + '　' + (a.pan ? '往下滑動' : '定格'))),
        el('button', { class: 'ghost danger', onclick: (ev) => {
          ev.stopPropagation();
          ANNOTS.splice(k, 1); saveAnnots(job); drawAnnots(job);
        } }, '刪除'));
    });

    return el('div', { style: 'border-bottom:1px solid var(--line);padding:14px 0' },
      el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:4px' },
        el('b', { style: 'font-size:13.5px' }, src),
        el('span', { style: 'flex:1' }),
        el('button', { class: 'ghost tiny', onclick: () => addAnnot(job, src) },
          mine.length ? '＋ 再加一段' : '＋ 標注這張')),
      ...(rows.length ? rows
        : [el('div', { style: 'display:flex;gap:14px;align-items:center;padding-top:6px' },
            el('div', { class: 'prev', style: 'opacity:.55',
              onclick: () => addAnnot(job, src) },
              el('img', { src: `/api/jobs/${job.id}/file/${src}`, alt: '' }),
              el('div', { class: 'hint' }, '還沒標')),
            el('span', { style: 'font-size:12.5px;color:var(--dim)' },
              '沒圈選的截圖不會出現在影片裡。'))]));
  }));
}

async function saveAnnots(job) {
  try {
    const r = await api(`/api/jobs/${job.id}/annotations`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shots: ANNOTS }),
    });
    const n = $('#annotSaved');
    if (!n) return;
    // 配圖計畫已經算完之後才存的標注，這支影片吃不到 —— 以前這裡照樣顯示「已儲存」，
    // 使用者以為標好了，到配圖計畫才發現圖不見（2026-08-21）。現在講清楚。
    if (r && r.applied === false) {
      n.style.color = 'var(--bad)';
      n.textContent = `已存 ${ANNOTS.length} 筆，但這支的配圖計畫已經算完 —— 這筆不會自動進去，請到下面的「配圖計畫」確認。`;
      return;
    }
    n.style.color = '';
    n.textContent = `已儲存 ${ANNOTS.length} 筆`;
    setTimeout(() => { if (n) n.textContent = ''; }, 2500);
  } catch (e) { alert('儲存失敗：' + e.message); }
}

// src 沒帶進來（卡片下方那顆「＋ 加一個標注」就是沒帶）→ 預設用第一張截圖。
// ⚠️ 2026-08-19 使用者回報：原本會 push 一筆 src=undefined 的標注 →
//    編輯器去抓 /api/jobs/<id>/file/undefined（404）→ 畫面一片空白；
//    標注模式又刻意清空圖片列（見 editAnnot 的註解），連換圖都換不了 → 死路。
//    列表是「依圖分組」畫的，那筆也看不到、刪不掉，存下去 auto-shot／auto-focus
//    還會在 `if (!a.src) continue` 直接跳過。
/** 這支工作目前有哪些截圖（標注編輯器的縮圖列與 addAnnot 共用同一份清單） */
function jobImages(job) {
  return (job.files || []).filter((f) => /\.(png|jpe?g)$/i.test(f));
}

// ── 事後補上傳截圖（2026-09-01）────────
// 走的是建立工作時同一支 upload handler，只是帶 auto=1 讓伺服器排下一個 shotN ——
// 前台自己算編號的話，兩個同事同時上傳就會撞名，把對方的圖蓋掉（而且舊標注還指著那個檔名）。
// onDone(新檔名陣列)：上傳完要做什麼。
//   準備階段（手動標記）不給 → 整頁重載，簡單可靠，那時沒有未存的東西要保護。
//   待確認階段（配圖計畫）一定要給 —— 整頁重載會把 `edits` 重建，同事拉到一半的框就沒了。
let morePickJob = null;
let morePickDone = null;
function pickMoreShots(job, onDone) {
  morePickJob = job;
  morePickDone = onDone || null;
  $('#morePicker').click();
}
$('#morePicker').onchange = (e) => {
  const files = [...e.target.files];
  e.target.value = '';   // 選同一個檔第二次也要能觸發
  if (morePickJob && files.length) uploadMoreShots(morePickJob, files, morePickDone);
};

async function uploadMoreShots(job, files, onDone) {
  const msg = () => $('#annotUpMsg') || $('#planUpMsg');
  const added = [];
  const bad = files.find((f) => !/^image\//.test(f.type) && !/\.(png|jpe?g|webp|heic|heif|gif|bmp|tiff?)$/i.test(f.name));
  if (bad) return alert(`「${bad.name}」不是圖片檔，這裡只能補截圖。`);
  let done = 0;
  for (const f of files) {
    if (msg()) msg().textContent = `上傳 ${done + 1}/${files.length}（${(f.size / 1048576).toFixed(1)} MB）…`;
    // 副檔名沿用建立頁的規則：不是 jpg 就叫 png。真正的格式由伺服器嗅探後修正（ensureUsableImage）
    const ext = /\.jpe?g$/i.test(f.name) ? '.jpg' : '.png';
    let r;
    try {
      r = await fetch(withKey(`/api/jobs/${job.id}/upload?auto=1&ext=${encodeURIComponent(ext)}`),
        { method: 'POST', body: f });
    } catch (err) {
      if (msg()) msg().textContent = '';
      return alert(`上傳「${f.name}」失敗：${err.message}`);
    }
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      if (msg()) msg().textContent = '';
      // 前面幾張可能已經上去了 —— 讓使用者看得到目前的狀態，不要假裝什麼都沒發生
      if (added.length && onDone) onDone(added);
      else if (added.length) { jobSig = null; loadJob(); }
      return alert(`上傳「${f.name}」失敗（${r.status}）${j.error ? '：' + j.error : ''}`);
    }
    // 檔名是伺服器排的（auto=1），一定要用它回傳的那個，前台不要自己猜
    const okBody = await r.json().catch(() => ({}));
    if (okBody.name) added.push(okBody.name);
    done += 1;
  }
  if (msg()) msg().textContent = `已上傳 ${done} 張`;
  setTimeout(() => { if (msg()) msg().textContent = ''; }, 4000);
  if (onDone) return onDone(added);
  jobSig = null;
  await loadJob();
}

function addAnnot(job, src) {
  if (!CHARS.length) return alert('腳本還在讀，等一下再試');
  // 沒帶 src（卡片下方那顆按鈕）→ 先開第一張。2026-09-01 起編輯器有縮圖列，
  // 開錯張也能當場換掉，不再是死路。
  const use = src || jobImages(job)[0];
  if (!use) return alert('這支工作沒有上傳截圖，沒有東西可以標注。');
  ANNOTS.push({ src: use, startCharIdx: null, endCharIdx: null, region: null, cell: null, pan: false });
  drawAnnots(job);
  editAnnot(job, ANNOTS.length - 1);
}

// 「往下滑動」不是每個版型都有效（三大法人沒有）。藏起來的時候順手取消勾選，
// 免得上一次開別的版型留下的勾在看不見的地方被送出去。
// ⚠️ 這裡要用 style.display 不能用 `.hidden` —— `.chk{display:flex}` 的優先度比
//    瀏覽器內建的 `[hidden]{display:none}` 高，設 hidden 完全沒有效果（實測踩到）。
function showPanRow(show) {
  $('#edPanRow').style.display = show ? '' : 'none';
  if (!show) { $('#edPan').checked = false; $('#edPanNote').textContent = ''; }
}

function editAnnot(job, k) {
  const a = ANNOTS[k];
  edCtx = { job, mode: 'annot', k, drag: null, src: a.src, mode2: 'region',
    region: a.region ? { ...a.region } : null,
    cell: a.cell ? { ...a.cell } : null,
    from: a.startCharIdx ?? null, to: a.endCharIdx ?? null };
  $('#edTitle').textContent = '標注　' + a.src;
  $('#edPan').checked = !!a.pan;
  // 標注階段還沒有 planView（那是「準備中」跑完才算的），所以用版型判斷 —— 三大法人沒有滑動
  showPanRow(job.template !== 'institution');
  setEdMode('region');
  // 縮圖列 2026-09-01 補回來（使用者：「按下去沒有出現給我全部上傳圖片的選項，導致我一直選不到我要的圖」）。
  // ⚠️ 2026-08-17 當初把它清空，是為了擋「第一張圖選好的範圍出現在第二張圖」。
  //    那個真因後來已經在別處各自修掉了，所以現在放回來是安全的：
  //      ① 換圖會清框 —— loadEdImage() 偵測到 src 變了就把 region／cell 清掉並提示（2026-08-25）
  //      ② 框不會再畫歪 —— drawEdBox() 改成像素定位，.ed-strip 也用 width:0;min-width:100%
  //         不再把 modal 撐寬（2026-08-21）
  //    這兩條任何一條被改掉，這裡就要重新評估。
  drawStrip(jobImages(job));
  loadEdImage(a.src);
  drawRange();
  $('#ed').style.display = 'flex';
}

function planCard(job) {
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

  UNITS = pv.units || [];   // 點一下選整句用
  CHARS = pv.chars || [];   // 逐字拖選用
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
    CHAR_SEC = n >= 8 ? sec / n : null;
  }

  edits = {};
  let addSeq = 0;
  for (const r of pv.rows) {
    edits[r.i] = { i: r.i, src: r.src, pan: r.pan, deleted: false,
      cell: r.cell || null, region: r.region || null, start: r.start, end: r.end, _manual: false,
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
    edits[key] = { i: key, _added: true, _manual: true, _late: true, deleted: false,
      src: a.src, pan: !!a.pan, cell: a.cell || null, region: a.region || null,
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
    const e = edits[key];
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
        // 三大法人沒有滑動／定格的概念，這一行對它是雜訊（見 showPanRow 的註解）
        pv.supportsPan === false ? '' : el('div', { class: 'sec' }, e.pan ? '往下滑動' : '定格'),
        el('div', { class: 'sec' }, [e.region ? '顯示區域' : null, e.cell ? '黃框' : null].filter(Boolean).join('＋') || '整張顯示'));
    };
    paint();
    tr.append(cellTd, infoTd, setTd,
      el('td', {}, el('button', { class: 'ghost danger', onclick: () => {
        if (e._added) { delete edits[key]; renderTable(); }
        else { e.deleted = !e.deleted; tr.classList.toggle('del', e.deleted); drawUnused(); }
      } }, e._added ? '刪除' : '不要這段')));
    return tr;
  }

  function renderTable() {
    const keys = Object.keys(edits).sort((a, b) =>
      (edits[a].startCharIdx ?? 1e9) - (edits[b].startCharIdx ?? 1e9));
    // 自動計畫有可能一段都排不出來（沒有手動標注、也沒有 (shot:) 標記時很常見）。
    // 空表格看起來像壞掉／像圖都不見了 —— 講清楚並指向下面的截圖牆。
    tb.replaceChildren(...(keys.length ? keys.map(buildRow)
      : [el('tr', {}, el('td', { colspan: 4, class: 'empty', style: 'padding:26px 0' },
          '這支還沒有任何配圖 —— 從下面的「全部截圖」點一張開始加。'))]));
    drawUnused();
  }

  function addSeg(src) {
    const key = 'a' + (addSeq++);
    edits[key] = { i: key, _added: true, _manual: true, deleted: false,
      src: src || pv.images[0] || '', pan: false, cell: null, region: null,
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
    Object.values(edits).filter((e) => !e.deleted).forEach((e) => { count[e.src] = (count[e.src] || 0) + 1; });
    if (!pv.images.length) return gallery.replaceChildren();
    const used = pv.images.filter((n) => count[n]).length;
    gallery.replaceChildren(
      el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
        el('div', { style: 'font-size:12.5px;color:var(--dim)' },
          `全部截圖 ${pv.images.length} 張，已經用了 ${used} 張　—　`
          + '點一下就加一段用它；同一張可以點多次、各自標不同區塊。'),
        // 待確認階段也能補圖（2026-09-01 使用者：「讓待確認階段還能補圖」）。
        // ⚠️ 上傳完**只重畫這面縮圖牆**，絕對不要走 loadJob() —— 那會重建 `edits`，
        //    把你剛剛拉的框、加的段全部丟掉（而且完全沒有提示）。
        el('button', { class: 'ghost tiny', onclick: () => pickMoreShots(job, (added) => {
          for (const n of added) if (!pv.images.includes(n)) pv.images.push(n);
          drawUnused();
          const box = $('#planUpMsg');
          if (box) {
            box.textContent = added.length ? `已加入 ${added.join('、')}，點縮圖就能用它加一段` : '';
            setTimeout(() => { if ($('#planUpMsg')) $('#planUpMsg').textContent = ''; }, 6000);
          }
        }) }, '＋ 上傳更多截圖'),
        el('span', { id: 'planUpMsg', style: 'font-size:12.5px;color:var(--dim)' })),
      el('div', { class: 'shots' }, ...pv.images.map((n) => {
        const c = count[n] || 0;
        // 2026-09-07 系統判定的頁型（來自 app-images.generated.json，server 放進 planView.pages）。
        // 認不出來（unknown）或只認得出「是個股頁但不知道哪個 tab」（stock-other）→ 給一顆 📌，
        // 按了只存指紋與截圖、不命名；之後 `node scripts/page-pins.js` 批次分群命名（使用者定案：不要當場手打）。
        const pg = (pv.pages || {})[n] || {};
        const unknown = !pg.page || pg.page === 'unknown' || pg.page === 'stock-other';
        const fig = el('figure', { class: c ? 'used' : '', title: `點一下＝加一段用 ${n}`,
          onclick: () => addSeg(n) },
          el('img', { src: `/api/jobs/${job.id}/file/${n}`, alt: '' }),
          el('div', { class: 'tag' }, c ? `已用 ${c} 次` : '還沒用'),
          el('div', { class: 'pg' + (unknown ? ' unk' : ''), title: '系統判定的頁型' }, pg.pageLabel || '未知頁面'),
          el('div', { class: 'nm' }, n));
        // 2026-09-07 使用者定案：📌 只給管理者（本機連進來的人）看；同事那邊只看到頁型標籤、沒有按鈕。
        if (unknown && ADMIN) fig.append(el('button', { class: 'pin', title: '記下這種頁：系統認不出來，先存指紋與截圖，之後批次命名',
          onclick: (ev) => { ev.stopPropagation(); pinPage(n, fig); } }, '📌'));
        return fig;
      })));
  }

  renderTable();
  c.append(t, gallery);
  c.append(el('div', { style: 'margin-top:20px;display:flex;gap:12px;align-items:center' },
    el('button', { class: 'ghost', onclick: () => addSeg() }, '＋ 加一段'),
    el('button', { class: 'go', onclick: () => approve(job, Object.values(edits)) }, '確認，開始出片')));
  return c;
}

/** 一列的預覽：原圖 ＋ 用比例畫上去的黃框（改完立刻反映，不用等伺服器重畫） */
function preview(job, e, onclick) {
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
  // 沒有框就什麼線都不要畫 —— 以前這裡畫一個包住整張圖的黃框當「整張顯示」的標示，
  // 結果被當成真的黃框，而且看不出怎麼刪（2026-08-17 使用者回報）。
  box.append(el('div', { class: 'hint' },
    !e.region && !e.cell ? '整張顯示・點我編輯' : (e._manual ? '已手動調整' : '點我編輯')));
  return box;
}

// ── 框選編輯器 ────────────────────────────
// 兩種框分開（2026-08-17 使用者指出的設計錯誤）：
//   顯示區域（藍虛線）= 圖要捲到哪裡，不畫線
//   黃框（黃實線）    = 要圈起來強調的地方，會壓暗周圍
// 可以只有一種、也可以兩種都有、也可以都沒有（整張顯示）。
let edCtx = null;

function edMode() { return (edCtx && edCtx.mode2) || 'region'; }
function setEdMode(m) {
  edCtx.mode2 = m;
  document.querySelectorAll('#edModes div').forEach((d) => d.classList.toggle('on', d.dataset.m === m));
}
document.querySelectorAll('#edModes div').forEach((d) =>
  d.onclick = () => { if (edCtx) setEdMode(d.dataset.m); });

function edRects() { return edCtx ? { region: edCtx.region, cell: edCtx.cell } : {}; }

function drawEdBox() {
  const wrap = $('#edImg');
  wrap.querySelectorAll('.bx').forEach((n) => n.remove());
  const img = wrap.querySelector('img');
  if (!edCtx || !edCtx.natW || !img) return;
  // ⚠️ 一定要用「圖片在容器裡的實際位置與大小」換算成像素，不能用百分比。
  //    百分比是相對 #edImg 容器算的，而容器會被上面那排縮圖撐寬 ——
  //    7 張截圖時容器 406px、圖片只有 308px，框就往右偏了 49px、寬度也多 32%，
  //    圖越多偏越多（2026-08-21 使用者回報：「點的位置沒出現黃框，跑到旁邊」）。
  //    標注模式因為把縮圖列清空了，容器剛好等於圖片，所以那邊看不出問題。
  const ox = img.offsetLeft, oy = img.offsetTop;
  const iw = img.offsetWidth, ih = img.offsetHeight;
  for (const [k, r] of Object.entries(edRects())) {
    if (!r || !(r.w > 0)) continue;
    wrap.append(el('div', { class: 'bx' + (k === 'region' ? ' region' : ''), style:
      `left:${ox + (r.x / edCtx.natW) * iw}px;top:${oy + (r.y / edCtx.natH) * ih}px;`
      + `width:${(r.w / edCtx.natW) * iw}px;height:${(r.h / edCtx.natH) * ih}px` }));
  }
  const hasR = !!(edCtx.region && edCtx.region.w > 0), hasC = !!(edCtx.cell && edCtx.cell.w > 0);
  $('#edRegionState').textContent = hasR ? '已畫' : '沒有';
  $('#edCellState').textContent = hasC ? '已畫' : '沒有';
  $('#edClearRegion').disabled = !hasR;
  $('#edClearCell').disabled = !hasC;
  $('#edClearRegion').style.opacity = hasR ? 1 : 0.35;
  $('#edClearCell').style.opacity = hasC ? 1 : 0.35;
}

function loadEdImage(src) {
  // ⚠️ 換圖一定要把框清掉（2026-08-25）。框存的是「原圖像素座標」，套到另一張圖上
  //    一定是錯的位置；而伺服器那邊 `applyPlanEdits()` 會照單全收前台送回來的框，
  //    所以在 A 圖畫的框會原座標畫到 B 圖上。開編輯器的第一次載入不算換圖。
  const swapped = !!edCtx.src && edCtx.src !== src;
  edCtx.src = src;
  if (swapped) {
    edCtx.region = null;
    edCtx.cell = null;
    const note = $('#edPanNote');
    if (note) note.textContent = '（換了截圖，原本的框已清掉 —— 請在新的圖上重新框）';
    // 「同一張圖的其他段」是虛線、別張圖是實線 —— 換了圖，這個判斷就變了，要重畫一次。
    // （開編輯器的第一次載入不算換圖，那條路本來就會在後面自己呼叫 drawRange。）
    drawRange();
  }
  // 新圖還沒載入完之前 natW/natH 是舊圖的，這時候拖框會用錯比例換算 → 先清掉，
  // 拖曳那幾支看到 natW 是空的就不動作，等 onload 補上。
  edCtx.natW = null;
  edCtx.natH = null;
  const wrap = $('#edImg');
  // 標注模式的標題就是檔名 —— 換了圖不跟著換的話，畫面會顯示你正在標另一張（2026-09-01）
  if (edCtx.mode === 'annot') $('#edTitle').textContent = '標注　' + src;
  const img = el('img', { src: `/api/jobs/${edCtx.job.id}/file/${src}`, alt: '' });
  wrap.replaceChildren(img);
  img.onload = () => { edCtx.natW = img.naturalWidth; edCtx.natH = img.naturalHeight; drawEdBox(); };
  document.querySelectorAll('#edStrip div').forEach((d) => {
    const on = d.dataset.src === src;
    d.classList.toggle('on', on);
    // 縮圖列現在是橫捲的單列 —— 選到的那張可能在可視範圍外，捲過去讓人看得到自己選了哪張
    if (on) d.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

function drawStrip(imgs) {
  $('#edStrip').replaceChildren(...imgs.map((n) =>
    el('div', { 'data-src': n, class: n === edCtx.src ? 'on' : '', title: n,
      onclick: () => loadEdImage(n) },
      el('img', { src: `/api/jobs/${edCtx.job.id}/file/${n}`, alt: '' }))));
}

// 拖曳畫框：一律換算成原圖像素座標存，換手機解析度也對
$('#edImg').addEventListener('mousedown', (ev) => {
  const img = $('#edImg').querySelector('img');
  if (!img || !edCtx) return;
  if (!edCtx.natW || !edCtx.natH) return;   // 圖還沒載入完，這時候換算比例會是錯的
  const b = img.getBoundingClientRect();
  // X 與 Y 各自算縮放比例。以前 Y 也用 X 的比例（natW/b.width），
  // 圖片等比例顯示時剛好相等看不出來，但不等比時框會上下錯位（2026-08-18）。
  const scX = edCtx.natW / b.width, scY = edCtx.natH / b.height;
  edCtx.drag = { x0: (ev.clientX - b.left) * scX, y0: (ev.clientY - b.top) * scY, b, scX, scY };
  ev.preventDefault();
});
window.addEventListener('mousemove', (ev) => {
  if (!edCtx || !edCtx.drag) return;
  const { x0, y0, b, scX, scY } = edCtx.drag;
  const x1 = Math.max(0, Math.min(edCtx.natW, (ev.clientX - b.left) * scX));
  const y1 = Math.max(0, Math.min(edCtx.natH, (ev.clientY - b.top) * scY));
  edCtx[edMode()] = { x: Math.min(x0, x1), y: Math.min(y0, y1),
    w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  drawEdBox();
});
window.addEventListener('mouseup', () => {
  if (!edCtx || !edCtx.drag) return;
  edCtx.drag = null;
  const r = edCtx[edMode()];
  // 太小多半是誤點
  if (r && (r.w < edCtx.natW * 0.02 || r.h < edCtx.natH * 0.008)) edCtx[edMode()] = null;
  // 自己拖了框 → 自動計畫留下的「往下滑動」自動退掉（想要滑動可以再勾回來）。
  // 滑動模式會讓整張圖從上往下帶過、黃框 2.4 秒後淡出，跟「我要看這一塊」互相衝突。
  if (r && edCtx.panInherited && $('#edPan').checked) {
    $('#edPan').checked = false;
    edCtx.panInherited = false;
    $('#edPanNote').textContent = '（已自動取消滑動 —— 你框了範圍。要滑動請自己勾回來）';
  }
  drawEdBox();
});
// 框是用像素畫的 → 視窗大小一變（圖片跟著縮放）就要重畫，不然會跟圖片脫節
window.addEventListener('resize', () => { if (edCtx) drawEdBox(); });
$('#edClearRegion').onclick = () => { edCtx.region = null; drawEdBox(); };
$('#edClearCell').onclick = () => { edCtx.cell = null; drawEdBox(); };
$('#edCancel').onclick = () => { $('#ed').style.display = 'none'; edCtx = null; };

function openEditor(job, pv, row, done) {
  const e = edits[row.i];
  edCtx = { job, mode: 'shot', e, done, drag: null, src: e.src, mode2: 'cell',
    region: e.region ? { ...e.region } : null,
    cell: e.cell ? { ...e.cell } : null,
    // 自動計畫可能已經幫這段勾了「往下滑動」。使用者自己拖框時要把它退掉 ——
    // 不然會出現「我沒勾卻自己滑動、而且框淡出看不見」（2026-08-18 使用者回報）。
    panInherited: !!e.pan,
    // 出現範圍用「在腳本上拖選」，不叫人填秒數
    from: e.startCharIdx ?? null, to: e.endCharIdx ?? null };
  $('#edTitle').textContent = row.phrase || '調整這一段';
  $('#edPan').checked = !!e.pan;
  $('#edPanNote').textContent = '';
  // 三大法人的聚焦是「捲到區塊帶 + 壓暗其餘」，沒有往下滑動這回事 —— 勾了完全不會有效果，
  // 所以乾脆不要畫（伺服器用 planView.supportsPan 告訴前台）。
  showPanRow(pv.supportsPan !== false);
  setEdMode('cell');
  drawStrip(pv.images);
  loadEdImage(e.src);
  drawRange();
  $('#ed').style.display = 'flex';
}

$('#edOK').onclick = () => {
  // 標注模式：存「哪一段子句範圍」，不是秒數（秒數要等語音轉字幕才存在）
  if (edCtx.mode === 'annot') {
    if (edCtx.from == null) return alert('還沒選範圍 —— 在下面的腳本上點一下或拖選');
    const a = ANNOTS[edCtx.k];
    a.src = edCtx.src;
    a.startCharIdx = Math.min(edCtx.from, edCtx.to);
    a.endCharIdx = Math.max(edCtx.from, edCtx.to);
    a.region = edCtx.region; a.cell = edCtx.cell;
    a.imgW = edCtx.natW; a.imgH = edCtx.natH;
    a.pan = $('#edPan').checked;
    const job = edCtx.job;
    $('#ed').style.display = 'none'; edCtx = null;
    drawAnnots(job); saveAnnots(job);
    return;
  }
  const { e, done } = edCtx;
  if (edCtx.from == null) return alert('還沒選範圍 —— 在下面的腳本上點一下或拖選');
  const a0 = Math.min(edCtx.from, edCtx.to), b0 = Math.max(edCtx.from, edCtx.to);
  const changed = JSON.stringify([edCtx.region, edCtx.cell]) !== JSON.stringify([e.region, e.cell])
    || a0 !== e.startCharIdx || b0 !== e.endCharIdx
    || edCtx.src !== e.src || $('#edPan').checked !== e.pan;
  e.region = edCtx.region; e.cell = edCtx.cell;
  e.imgW = edCtx.natW; e.imgH = edCtx.natH;
  e.startCharIdx = a0; e.endCharIdx = b0;
  e.src = edCtx.src; e.pan = $('#edPan').checked;
  if (changed) e._manual = true;
  $('#ed').style.display = 'none'; edCtx = null;
  done();
};

// 送出配圖計畫 → 開始出片。
// ⚠️ 2026-08-18：這個函式一度在改編輯器時被連帶刪掉，導致「確認，開始出片」
//    按下去是 ReferenceError、完全沒反應。務必保留。
async function approve(job, e) {
  try {
    await api(`/api/jobs/${job.id}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ edits: e, by: $('#owner').value }),
    });
    loadJob();
  } catch (err) { alert('出錯了：' + err.message); }
}

// ── 逐字選取 ──────────────────────────────
// 點一下 = 選中那個字所在的整個子句（快）；按住拖曳 = 選任意範圍（精準）。
// 再點一次已選中的地方 = 取消。
// 做到字級是因為「友達群創雙漲停。」是一個子句卻要配兩張圖
//（2026-08-17 使用者：「有可能真的要細分到文字」）。
let CHARS = [];

// 一個字大約幾秒 —— 只有配圖計畫那一頁算得出來（自動列身上才有 start/end 秒數）。
// 標注階段字幕還不存在、秒數也還不存在，所以那邊是 null，提示只講「剩幾個字」。
let CHAR_SEC = null;

/**
 * 「這個編輯器以外的段落，各自佔了哪些字」—— 逐字底線與「會蓋掉誰」共用這一支。
 * ⚠️ 兩個入口（手動標記的 ANNOTS／配圖計畫的 edits）一定要共用它。各寫一份的話兩邊會漂走，
 *    這專案已經被「同一套規則兩份實作」咬過好幾次（見 shot-memory.js、findCellIn 的註解）。
 * mine ＝同一張圖的其他段（畫虛線）；auto ＝自動排的那一列（它被人工段裁掉走的是另一條規則，
 * 所以提示的講法不一樣，見 drawRangeText）。
 */
function usedRanges() {
  if (!edCtx) return [];
  const out = [];
  const push = (src, lo, hi, auto) => {
    if (typeof lo !== 'number' || typeof hi !== 'number') return;
    out.push({ src: src || '（未選圖）', lo: Math.min(lo, hi), hi: Math.max(lo, hi),
      mine: !!src && src === edCtx.src, auto: !!auto });
  };
  if (edCtx.mode === 'annot') {
    ANNOTS.forEach((a, k) => { if (k !== edCtx.k) push(a.src, a.startCharIdx, a.endCharIdx, false); });
  } else {
    Object.keys(edits).forEach((k) => {
      const e = edits[k];
      if (e === edCtx.e || e.deleted) return;
      push(e.src, e.startCharIdx, e.endCharIdx, !(e._manual || e._added || e._late));
    });
  }
  return out;
}

/** 同一個字被幾段佔到時算最後那一段的 —— 跟 resolveManualOverlaps() 的「後標的為主」同方向 */
function ownerOf(used, i) {
  let own = null;
  for (const u of used) if (i >= u.lo && i <= u.hi) own = u;
  return own;
}

/** 1.4 秒（MIN_SHOT_SEC）大約是幾個字 —— 算不出秒數時用 8 個字當保守值 */
function shortChars() {
  return CHAR_SEC ? Math.max(2, Math.ceil(1.4 / CHAR_SEC)) : 8;
}

function drawRange() {
  const wrap = $('#edRange');
  if (!wrap) return;
  if (!CHARS.length) return wrap.replaceChildren(el('span', {}, '（腳本還在讀…）'));
  const a = edCtx.from, b = edCtx.to;
  const lo = a == null ? -1 : Math.min(a, b), hi = a == null ? -2 : Math.max(a, b);
  const used = usedRanges();
  const nodes = [];
  CHARS.forEach((c) => {
    const own = ownerOf(used, c.i);
    const cls = [];
    if (c.i >= lo && c.i <= hi) cls.push('sel');
    if (own) { cls.push('used'); if (own.mine) cls.push('mine'); }
    if (c.b) cls.push('br');
    nodes.push(el('i', {
      'data-i': c.i,
      class: cls.join(' '),
      title: own ? `${own.src} 已經選了這裡（${own.lo}–${own.hi}）` : null,
    }, c.c));
    // 2026-08-18 使用者：照原稿段落換行 —— p=1 的字後面塞一個真的換行
    if (c.p) nodes.push(el('br', { class: 'para' }));
  });
  wrap.replaceChildren(...nodes);
  drawRangeText(lo, hi, used);
}

/**
 * 選了什麼 ＋ 這一選會蓋掉誰。
 * 「後標的為主」本來就是既有規則（`scripts/script-utils.js` 的 `resolveManualOverlaps()`，
 * 2026-08-25 定案），但它是出片時才算、結果只寫在執行記錄的一行 log —— 同事在標的當下看不到，
 * 所以會發生「這張圖我明明標了，成品裡卻整張不見」。這裡只是把同一套區間相減先講出來。
 * ⚠️ 用 el() 一格一格 append，不要拼 innerHTML —— src 是同事上傳的檔名（見雷區：`html:` 與 XSS）。
 * ⚠️ 自動列走的是另一條規則（人工蓋自動 → 裁掉，被吃光時尾巴交給最後一個人工段接手，
 *    2026-08-18 定案），沒有「太短就丟掉」這回事，所以講法要分開，不要對它報假警。
 */
function drawRangeText(lo, hi, used) {
  const box = $('#edRangeText');
  if (!box) return;
  if (lo < 0) return box.replaceChildren(el('div', {},
    '點一下選整句，或按住拖曳選任意範圍。再點一次取消。'));
  const txt = CHARS.filter((c) => c.i >= lo && c.i <= hi).map((c) => c.c).join('');
  const kids = [el('div', {}, `選了：${txt}`)];
  const short = shortChars();
  (used || []).forEach((u) => {
    if (u.hi < lo || u.lo > hi) return;               // 沒壓到這一段
    const who = u.src + (u.mine ? '（同一張圖的另一段）' : '');
    if (u.auto) {
      kids.push(el('div', { class: 'ovr' },
        `會蓋到自動排的 ${who}（${u.lo}–${u.hi}）—— 出片時那一段會讓給你。`));
      return;
    }
    const parts = [];
    if (u.lo < lo) parts.push([u.lo, lo - 1]);
    if (u.hi > hi) parts.push([hi + 1, u.hi]);
    if (!parts.length) {
      kids.push(el('div', { class: 'ovr bad' },
        `⚠️ 會整段蓋住 ${who}（${u.lo}–${u.hi}）→ 那一段不會出現在影片裡`));
      return;
    }
    const left = parts.reduce((n, p) => n + (p[1] - p[0] + 1), 0);
    const where = parts.map((p) => `${p[0]}–${p[1]}`).join('、');
    const secs = CHAR_SEC ? `，約 ${(left * CHAR_SEC).toFixed(1)} 秒` : '';
    kids.push(el('div', { class: left < short ? 'ovr bad' : 'ovr' },
      `會蓋到 ${who}（${u.lo}–${u.hi}）→ 裁成 ${where}`
      + `（共 ${left} 個字${secs}）`
      + (left < short ? '，不到 1.4 秒 → 出片時會被丟掉，那一段也不會出現' : '')));
  });
  box.replaceChildren(...kids);
}

/** 這個字屬於哪個子句（點一下就選整句用的） */
function clauseAt(i) {
  return UNITS.find((u) => u.startCharIdx != null && i >= u.startCharIdx && i <= u.endCharIdx);
}

{
  const idxOf = (t) => (t && t.dataset && t.dataset.i != null ? +t.dataset.i : null);
  let dragging = false, moved = false, anchor = null;
  const wrap = () => $('#edRange');
  document.addEventListener('mousedown', (ev) => {
    const w = wrap();
    if (!edCtx || !w || !w.contains(ev.target)) return;
    const i = idxOf(ev.target);
    if (i == null) return;
    dragging = true; moved = false; anchor = i;
    ev.preventDefault();
  });
  document.addEventListener('mousemove', (ev) => {
    if (!dragging || !edCtx) return;
    const i = idxOf(ev.target);
    if (i == null) return;
    if (i !== anchor) moved = true;
    edCtx.from = anchor; edCtx.to = i;
    drawRange();
  });
  document.addEventListener('mouseup', (ev) => {
    if (!dragging || !edCtx) return;
    dragging = false;
    if (moved) return;                     // 拖曳過 → 範圍已經在 mousemove 設好
    const i = anchor;
    const lo = edCtx.from == null ? -1 : Math.min(edCtx.from, edCtx.to);
    const hi = edCtx.from == null ? -2 : Math.max(edCtx.from, edCtx.to);
    const cl = clauseAt(i);
    if (i >= lo && i <= hi) { edCtx.from = null; edCtx.to = null; }   // 點已選中的 → 取消
    else if (cl) { edCtx.from = cl.startCharIdx; edCtx.to = cl.endCharIdx; }
    else { edCtx.from = i; edCtx.to = i; }
    drawRange();
  });
}


// ── 跟我說 ─────────────────────────────────
// 同事回報唸錯的詞、以及任何前台問題。送出就寫進 90_系統/資料/messages.jsonl。
// 收件匣與詞庫管理只有管理者（本機）看得到。
function sayWho() { return ($('#sayOwner').value || $('#owner').value || '').trim(); }

// 「你是誰」只要填一次。兩頁的欄位互相同步，並記在 localStorage ——
// 換頁、重新整理、關掉分頁再開都不用重打（2026-08-21 使用者要求：
// 只是要回報一個唸錯的詞，卻得先跑去「建立工作」那頁填名字，很奇怪）。
const OWNER_KEY = 'mv.owner';
function syncOwner(v, from) {
  const s = (v || '').trim();
  if (from !== 'owner') $('#owner').value = s;
  if (from !== 'sayOwner') $('#sayOwner').value = s;
  try { localStorage.setItem(OWNER_KEY, s); } catch (e) { /* 隱私模式會擋，忽略 */ }
}
$('#owner').oninput = () => syncOwner($('#owner').value, 'owner');
$('#sayOwner').oninput = () => syncOwner($('#sayOwner').value, 'sayOwner');
try {
  const savedOwner = localStorage.getItem(OWNER_KEY);
  if (savedOwner) syncOwner(savedOwner);
} catch (e) { /* 同上 */ }

/** 📌 記下這種頁：走「說一件事」同一條路（/api/messages, kind=page-pin），server 端補指紋、複製截圖。 */
async function pinPage(src, fig) {
  const ok = await sendSay({ kind: 'page-pin', src }, $('#planUpMsg'), '📌 記下了，之後批次命名');
  if (ok && fig) { const b = fig.querySelector('.pin'); if (b) { b.textContent = '✓'; b.disabled = true; } }
}

async function sendSay(payload, msgEl, okText) {
  const who = sayWho();
  if (!who) return alert('上面先填一下「你是誰」，我才知道是誰回報的。');
  msgEl.textContent = '送出中…';
  try {
    await api('/api/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, by: who, job: lastJob }),
    });
    msgEl.textContent = okText;
    setTimeout(() => { msgEl.textContent = ''; }, 4000);
    if (ADMIN) loadSay();
    return true;
  } catch (e) {
    msgEl.textContent = '';
    alert('送不出去：' + e.message);
    return false;
  }
}

$('#sayWordSend').onclick = async () => {
  const word = $('#sayWord').value.trim();
  const suggest = $('#saySuggest').value.trim();
  if (!word) return alert('還沒填「唸錯的詞」');
  if (!suggest) return alert('還沒填「建議怎麼寫」—— 只說唸錯了我沒辦法改，要給我一個寫法');
  const ok = await sendSay({ kind: 'pronounce', word, suggest, why: $('#sayWhy').value.trim() },
    $('#sayWordMsg'), '收到了，謝謝！我會加進共用詞庫。');
  if (ok) { $('#sayWord').value = ''; $('#saySuggest').value = ''; $('#sayWhy').value = ''; }
};

$('#sayNoteSend').onclick = async () => {
  const text = $('#sayNote').value.trim();
  if (!text) return alert('留言是空的');
  const ok = await sendSay({ kind: 'note', text }, $('#sayNoteMsg'), '收到了，謝謝！');
  if (ok) $('#sayNote').value = '';
};

async function loadSay() {
  $('#sayInboxCard').hidden = !ADMIN;
  $('#sayDictCard').hidden = !ADMIN;
  if (!ADMIN) return;
  const [inbox, dict] = await Promise.all([
    api('/api/messages').catch(() => ({ messages: [] })),
    api('/api/pronounce').catch(() => ({ rules: [] })),
  ]);
  drawInbox(inbox.messages || []);
  drawDict(dict.rules || []);
}

function drawInbox(list) {
  const wrap = $('#sayInbox');
  if (!list.length) return wrap.replaceChildren(el('div', { class: 'empty' }, '目前沒有任何留言'));
  // 未讀在前，其餘照時間新到舊
  const sorted = [...list].sort((a, b) =>
    (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0) || (a.at < b.at ? 1 : -1));
  wrap.replaceChildren(...sorted.map((m) => {
    const meta = [
      m.by,
      new Date(m.at).toLocaleString('zh-TW', { hour12: false }).slice(5),
      m.job ? '工作 ' + m.job : null,
      m.kind === 'pronounce' ? '唸法回報' : m.kind === 'page-pin' ? '📌 記下的頁' : '留言',
    ].filter(Boolean).join('・');
    const body = m.kind === 'pronounce'
      ? el('div', { class: 'b' },
          el('div', { class: 'w' }, `${m.word}　→　${m.suggest}`),
          el('div', { class: 'm' }, (m.why ? '原因：' + m.why + '　' : '') + meta))
      : m.kind === 'page-pin'
      ? el('div', { class: 'b' },
          el('div', { class: 'w' }, `📌 ${m.src}　系統原判：${m.systemPage || '?'}` + (m.pinned ? '　已存圖' : '')),
          el('div', { class: 'm' }, ((m.fingerprint && m.fingerprint.words) ? '關鍵字：' + m.fingerprint.words.slice(0, 8).join('、') + '　' : '') + meta
            + '　→ 批次命名：node scripts/page-pins.js'))
      : el('div', { class: 'b' },
          el('div', { class: 'w' }, m.text),
          el('div', { class: 'm' }, meta));
    const acts = el('div', { style: 'display:flex;gap:8px;flex-shrink:0' });
    if (m.kind === 'pronounce' && m.status !== 'done')
      acts.append(el('button', { class: 'ghost tiny', onclick: async () => {
        const rule = { from: m.word, to: m.suggest, why: m.why || '', by: m.by, fromMessage: m.id };
        try {
          if (!(await addDictRuleConfirming(rule))) return;
          await setMsgStatus(m.id, 'done');
        } catch (e) { alert('收錄失敗：' + e.message); }
      } }, '收錄進詞庫'));
    acts.append(el('button', { class: 'ghost tiny', onclick: () => setMsgStatus(m.id, m.status === 'done' ? 'new' : 'done') },
      m.status === 'done' ? '標回未讀' : '已讀'));
    return el('div', { class: 'msg' + (m.status === 'done' ? ' done' : '') }, body, acts);
  }));
}

async function setMsgStatus(id, status) {
  try {
    await api('/api/messages/status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status }),
    });
    loadSay();
  } catch (e) { alert('更新失敗：' + e.message); }
}

// 加詞庫。伺服器有兩種「軟擋」會回 400 —— 那不是錯誤，是提醒，按確定就帶 force 再送一次：
//   ① `short: true`  → 原文只有兩個字（台股公司名大多是兩個字，這是最常用的情況）
//   ② `clash: [...]` → 跟詞庫裡現有規則重疊
// ⚠️ 判斷「這是軟擋還是真錯誤」一定要看這兩個欄位，不要比對錯誤訊息的中文。
//    2026-08-21 踩過：這裡原本寫 /有重疊/，而兩個字那則訊息裡沒有「有重疊」三個字，
//    所以兩個字的詞永遠加不進去（訊息叫人「再按一次」，但再按一次也不會帶 force）。
//    單字（一個字）是硬擋、沒有這兩個欄位，就會照原樣往外丟 —— 那是刻意的。
function isSoftBlock(e) {
  return !!(e && e.data && (e.data.short || (e.data.clash && e.data.clash.length)));
}

async function addDictRule(rule, force) {
  await api('/api/pronounce', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...rule, ...(force ? { force: true } : {}) }),
  });
}

/** 加一條規則，遇到軟擋就問一次、確定後帶 force 重送。回傳 true = 真的加進去了 */
async function addDictRuleConfirming(rule) {
  try {
    await addDictRule(rule, false);
  } catch (e) {
    if (!isSoftBlock(e)) throw e;
    if (!confirm(e.message)) return false;
    await addDictRule(rule, true);
  }
  return true;
}

$('#dictAdd').onclick = async () => {
  const from = $('#dictFrom').value.trim();
  const to = $('#dictTo').value.trim();
  if (!from || !to) return alert('原文跟唸法都要填');
  const rule = { from, to, why: $('#dictWhy').value.trim(), by: sayWho() };
  try {
    if (!(await addDictRuleConfirming(rule))) return;
    $('#dictFrom').value = ''; $('#dictTo').value = ''; $('#dictWhy').value = '';
    $('#dictMsg').textContent = '加好了';
    setTimeout(() => { $('#dictMsg').textContent = ''; }, 3000);
    loadSay();
  } catch (e) { alert(e.message); }
};

function drawDict(rules) {
  const wrap = $('#dictList');
  if (!rules.length) return wrap.replaceChildren(el('div', { class: 'empty' }, '詞庫還是空的'));
  const t = el('table', {}, el('thead', {}, el('tr', {},
    el('th', {}, '原文'), el('th', {}, '唸法'), el('th', {}, '為什麼'),
    el('th', {}, '誰加的'), el('th', {}, ''))));
  const tb = el('tbody');
  for (const r of rules) {
    tb.append(el('tr', { style: r.enabled === false ? 'opacity:.4' : '' },
      el('td', {}, r.from), el('td', {}, r.to),
      el('td', { style: 'color:var(--dim);font-size:12.5px' }, r.why || '—'),
      el('td', { style: 'color:var(--dim);font-size:12.5px' },
        [r.by || '—', (r.at || '').slice(5, 10)].filter(Boolean).join('・')),
      el('td', {}, el('button', { class: 'ghost tiny', onclick: async () => {
        try {
          await api('/api/pronounce', {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: r.from, enabled: r.enabled === false }),
          });
          loadSay();
        } catch (e) { alert('更新失敗：' + e.message); }
      } }, r.enabled === false ? '啟用' : '停用'))));
  }
  t.append(tb);
  wrap.replaceChildren(t);
}

// ── 修正紀錄 ──
async function loadFix() {
  const d = await api('/api/corrections');
  const wrap = $('#fix');
  if (!d.total) return wrap.replaceChildren(el('div', { class: 'empty' },
    '還沒有人改過任何配圖 —— 目前為止 AI 排的都被直接採用了'));
  const sum = el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;margin:18px 0' },
    ...Object.entries(d.byType).map(([k, v]) => el('span', { class: 'pill' }, `${k}　${v} 次`)));
  // 標籤統計才是「規則庫還缺什麼」的直接答案 —— 類型只說明「改了什麼」，標籤說明「為什麼」
  const tagSum = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px' },
    ...Object.entries(d.byTag || {}).sort((x, y) => y[1] - x[1])
      .map(([k, v]) => el('span', { class: 'pill' }, `${k}　${v} 次`)),
    d.noReason ? el('span', { class: 'pill', style: 'opacity:.6' }, `沒填原因　${d.noReason} 筆`) : '');
  const src = el('div', { class: 'tip', style: 'margin-bottom:14px' },
    d.logged
      ? `共 ${d.total} 筆，修正紀錄會持續保留，工作移除後也能查閱。`
      : `共 ${d.total} 筆。下次按「確認，開始出片」時會自動保存修正紀錄。`);
  const t = el('table', {}, el('thead', {}, el('tr', {},
    el('th', {}, '類型'), el('th', {}, '那一段旁白'), el('th', {}, '原本'), el('th', {}, '改成'),
    el('th', {}, 'AI 當時的判斷'), el('th', {}, '人給的原因'))));
  const tb = el('tbody');
  const fmtCell = (c, sz) => !c ? '—'
    : sz ? `${Math.round(c.x / sz.w * 100)},${Math.round(c.y / sz.h * 100)}% `
         + `${Math.round(c.w / sz.w * 100)}×${Math.round(c.h / sz.h * 100)}%`
         : `${Math.round(c.x)},${Math.round(c.y)} ${Math.round(c.w)}×${Math.round(c.h)}`;
  for (const r of d.rows) {
    let before = r.from || '—', after = r.to || '—';
    if (r.type === '改框') {
      // region（顯示區域）與 cell（黃框）分開顯示 —— 只畫顯示區域也是有效的修正
      const pair = (cell, region) => [
        cell ? '黃框 ' + fmtCell(cell, r.size) : null,
        region ? '區域 ' + fmtCell(region, r.size) : null,
      ].filter(Boolean).join('　') || '整張顯示';
      before = `${r.autoCellText || ''} ${pair(r.autoCell, r.autoRegion)}`;
      after = pair(r.manualCell, r.manualRegion);
    }
    if (r.type === '改時間') { before = `${r.auto}　${r.autoPhrase || ''}`; after = `${r.manual}　${r.manualPhrase || ''}`; }
    if (r.type === '新增一段') { before = (r.autoCoveredBy || []).join('、') || '（原本沒有圖）'; after = `${r.from}　${r.manual || ''}`; }
    // 人工標記：「原本」是對照組（假裝沒人標注、讓 AI 自己排一次）的結果
    if (r.type === '人工標記') {
      const pair = (cell, region) => [
        cell ? '黃框 ' + fmtCell(cell, r.size) : null,
        region ? '區域 ' + fmtCell(region, r.size) : null,
      ].filter(Boolean).join('　') || '整張顯示';
      before = r.from
        ? `${r.from}　${r.autoCellText || ''} ${pair(r.autoCell, r.autoRegion)}`.trim()
        : '（AI 本來不配圖）';
      after = `${r.to}　${pair(r.manualCell, r.manualRegion)}`;
    }
    const reason = [...((r.reason && r.reason.tags) || []), (r.reason && r.reason.note) || '']
      .filter(Boolean).join('／');
    // 「系統原本會怎麼圈」（2026-08-26 使用者定案：影片只吃人工的框，系統的判斷只進紀錄）。
    // 沒有這個欄位的舊紀錄不會畫這一行 —— 一律不影響既有資料的顯示。
    const sysNote = (r.systemCell || r.systemWhy)
      ? el('div', { style: 'margin-top:5px;color:#c98a00' },
          `系統原本會框「${r.systemCellText || '—'}」　${fmtCell(r.systemCell, r.size)}`
          + `（來源：${r.systemWhy || '規則判定'}）`)
      : null;
    tb.append(el('tr', {}, el('td', {}, r.type), el('td', {}, r.phrase),
      el('td', { style: 'color:var(--dim);font-size:12.5px' }, before, sysNote || ''),
      el('td', { style: 'font-size:12.5px' }, after),
      el('td', { style: 'color:var(--dim);font-size:12.5px' }, r.autoWhy || '—'),
      el('td', { style: 'font-size:12.5px;color:#c98a00' }, reason || '—')));
  }
  t.append(tb);
  wrap.replaceChildren(sum, tagSum, src, t);
}

// 版本標記：F12 開 Console 看到這行，就代表瀏覽器抓到的是最新版
console.log('%c大眾短影音出片工具 build 2026-08-21b（配圖記憶庫＋代號股名表＋漲跌幅比對＋舊分頁提示）', 'color:#1f6feb;font-weight:bold');
boot();
