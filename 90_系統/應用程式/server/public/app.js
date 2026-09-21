
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

// ── 箭頭（2026-09-16）────────────────────────────────────────────
// ⚠️ 色票要跟成品端一致：src/ShotFocus.tsx 的 SHOT_FOCUS.arrow.palette。改這裡就要改那裡。
const ARROW_COLORS = ['#FF3B30', '#00C853', '#2E9BFF', '#FF9500', '#FFFFFF', '#1A1A1A'];
const ARROW_DEFAULT = ARROW_COLORS[0];
/** 短到這個長度以下（佔圖片短邊的比例）就當誤點 —— 箭頭是線段，不能沿用框那組 w/h 門檻。 */
const ARROW_MIN_RATIO = 0.04;
// 成品端的尺寸（畫面 px，直式畫布 1080×1920）。⚠️ 要跟 src/ShotFocus.tsx 的 SHOT_FOCUS.arrow
// 與各 composition 的 safeTop/safeBottom 一致；改那邊就要改這裡，不然預覽又會跟成品對不起來。
const ARROW_CANVAS_W = 1080, ARROW_CANVAS_H = 1920;
const ARROW_SAFE_H = 1120;                 // safeBottom 1430 − safeTop 310
const ARROW_SHAFT = 11, ARROW_HEAD_RATIO = 30 / 11, ARROW_HEAD_W_RATIO = 38 / 11;
const ARROW_ROUND_RATIO = 3 / 11;          // headRound ÷ width（箭鏃圓角）
const ARROW_COVER_KEEP = 0.75;             // SHOT_FOCUS.wholePageCoverKeep

/**
 * 「這張圖在成品裡會被放多大」——回傳圖片在畫布上的顯示寬（畫面 px）。
 *
 * 為什麼需要它：成品的線寬是**固定的畫面 px**（跟截圖解析度無關，見 SHOT_FOCUS.arrow），
 * 而預覽是把原圖縮到幾百 px 來畫。不換算的話，同一支箭頭在編輯器裡看起來比成品粗好幾倍
 * （2026-09-16 使用者回報「成品的箭頭跟圈選的時候不一樣」）。
 *
 * ⚠️ 這是**近似**：照渲染端的三條擺放規則走（圈了 region 就放大到安全框、沒圈就看
 *    coverKeep 門檻決定滿版或整張縮進去），但安全框高度用直式的固定值，
 *    也不處理橫式的左右分割。預覽只要粗細看起來對，不需要像素級一致。
 */
function arrowShownWidth(natW, natH, region) {
  if (!(natW > 0) || !(natH > 0)) return ARROW_CANVAS_W;
  if (region && region.w > 0 && region.h > 0) {
    return natW * Math.min(ARROW_CANVAS_W / region.w, ARROW_SAFE_H / region.h);
  }
  const ar = natW / natH, boxAr = ARROW_CANVAS_W / ARROW_CANVAS_H;
  const keep = Math.min(ar, boxAr) / Math.max(ar, boxAr);
  return keep >= ARROW_COVER_KEEP
    ? natW * Math.max(ARROW_CANVAS_W / natW, ARROW_CANVAS_H / natH)   // 滿版
    : natW * Math.min(ARROW_CANVAS_W / natW, ARROW_SAFE_H / natH);    // 整張縮進安全框
}

/**
 * 在一個 position:relative 的容器上疊一支箭頭（SVG）。座標是**容器內的 px**，換算由呼叫端負責。
 *
 * 形狀跟成品（ShotFocus.tsx）同一套：桿子＋三角箭鏃＋半透明黑描邊。
 * 但**尺寸不是成品尺寸** —— 成品的線寬是畫布 px、跟截圖解析度無關，預覽只能按容器寬度抓個
 * 看得清楚的比例。預覽是用來確認「位置、方向、顏色」，不是用來量粗細的。
 */
function arrowSVG(w, h, x1, y1, x2, y2, color, shaft) {
  const NS = 'http://www.w3.org/2000/svg';
  // shaft＝呼叫端算好的線寬（見 arrowShaftPx）。沒給就退回舊的「容器寬 2.2%」。
  const lw = Math.max(1.5, shaft || w * 0.022);
  const len = Math.hypot(x2 - x1, y2 - y1);
  // 箭鏃相對線寬的比例跟成品同一組（ShotFocus.tsx：線寬 11、headLen 30、headWidth 38）
  const k = Math.min(1, len / (lw * ARROW_HEAD_RATIO * 1.6));   // 太短的箭頭不要讓箭鏃吃掉整支
  const hl = lw * ARROW_HEAD_RATIO * k;
  const hw = lw * ARROW_HEAD_W_RATIO * k;
  const ang = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
  // 純色一層，不描邊也不加陰影（成品同一條規則，見 ShotFocus.tsx 的 SHOT_FOCUS.arrow）。
  // 箭鏃的 stroke 跟 fill 同色，只是拿來把角磨圓。
  const paint = (c) =>
    `<line x1="0" y1="0" x2="${(len - hl + 1).toFixed(1)}" y2="0" stroke="${c}"`
    + ` stroke-width="${lw.toFixed(1)}" stroke-linecap="round"/>`
    + `<polygon points="${len.toFixed(1)},0 ${(len - hl).toFixed(1)},${(-hw / 2).toFixed(1)}`
    + ` ${(len - hl).toFixed(1)},${(hw / 2).toFixed(1)}" fill="${c}" stroke="${c}"`
    + ` stroke-width="${(lw * ARROW_ROUND_RATIO * 2 * k).toFixed(1)}" stroke-linejoin="round"/>`;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'bx arrow');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.style.cssText = `left:0;top:0;width:${w}px;height:${h}px`;
  svg.innerHTML = `<g transform="translate(${x1.toFixed(1)} ${y1.toFixed(1)}) rotate(${ang.toFixed(2)})">`
    + paint(color || ARROW_DEFAULT)
    + '</g>';
  return svg;
}

/**
 * 成品的線寬（8 畫面 px）換算成預覽上要畫幾 px。
 * displayW＝這張圖在預覽裡的顯示寬，natW/natH＝原圖尺寸，region＝有沒有圈顯示區域。
 */
function arrowShaftPx(displayW, natW, natH, region) {
  return displayW * ARROW_SHAFT / arrowShownWidth(natW, natH, region);
}

/** 箭頭是不是有效（有兩個端點、長度不是 0）。存進去的一律是原圖像素座標。 */
function hasArrow(a) {
  return !!(a && Number.isFinite(a.x1) && Number.isFinite(a.y1)
    && Number.isFinite(a.x2) && Number.isFinite(a.y2)
    && Math.hypot(a.x2 - a.x1, a.y2 - a.y1) > 0);
}
const STATUS_TEXT = { draft:'建立中', queued:'排隊中', preparing:'準備中', review:'待確認',
  approved:'等待出片', rendering:'出片中', done:'完成', failed:'失敗', cancelled:'已取消',
  // 伺服器重開前就開始跑的工作。run.js 是 detached 的，會自己跑完。
  detached:'背景執行中', 'detached-done':'已在背景跑完' };

/**
 * 狀態文字。draft 平常是「建立中」（上傳檔案那一瞬間），但重新出片複製出來的工作
 * 也停在 draft，而且會一直停在那裡等人確認 —— 顯示「建立中」會讓人以為系統還在忙。
 */
function statusText(j) {
  if (j.status === 'draft' && j.redoOf) return '等你確認';
  return STATUS_TEXT[j.status] || j.status;
}

// tpl 的初始值只是「還沒收到 /api/health 之前」的暫時值；boot2() 收到 TPLS 之後
// 會把它校正成「可選清單的第一個」（2026-08-31 使用者要求：焦點股日報移到最後，預設改成第一個）。
let TPLS = {}, BRANDS = [], ADMIN = false, brand = null, tpl = null, view = 'new', openJob = null;

// 配音語氣（2026-09-14）：[值, 按鈕文字]。**值要跟 server/index.js 的 EMOTIONS 白名單一字不差**，
// 由 90_系統/測試/配音語氣.test.js 綁住 —— 這裡多塞一個 whisper 之類的值，
// 不是「多一個選項」，是讓選到的人整支出片直接失敗（speech-2.8 不支援，API 回 2013）。
// 第一個是預設。
const EMOTIONS = [['fluent', '流暢'], ['happy', '開心']];
let emotion = EMOTIONS[0][0];

// 出片卡片裡兩組並排的小選項各自的說明（2026-09-14）。
// 講者影片那組操作的是 #skipGenerate 這個藏起來的 checkbox —— 它仍然是狀態來源。
const EMOTION_TIP = '講漲勢、好消息用「開心」；重挫、壞消息用「流暢」（平穩）。'
  + '<b>不選擇預設就是流暢。</b>';
const EMOTION_TIP_OFF = '用現成的講者影片不會重新配音 —— 這支的語氣就是那支影片原本的。';
const HEYGEN_MODES = [
  [false, '重新生成', '會呼叫 HeyGen 生成一支新的講者影片。'],
  [true, '用現成的', '不呼叫 HeyGen、<b>不扣點數</b> —— 拿一支之前的講者影片重跑就好。'],
];
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
// 送出按鈕帶版型名（2026-09-14 使用者：同事會按錯版型）。
// 按鈕本來就已經是版型色（button.go 吃 --accent，盤中焦點是橘的），加上名字變成
// 顏色＋文字雙重提示，而且是在**手指按下去的那一刻**看到，比多一層彈窗有用。
// ⚠️ 送出過程會把文字換成「建立工作…／上傳 1/3…」，失敗時要用這支還原，不能寫死「開始出片」。
function submitLabel() {
  // 上傳中斷過就直接講「繼續」—— 同事最怕的是「剛剛已經按過了，再按一次會不會變成兩支」。
  // 檔案全上去、掛在最後那一步 /submit 的情況也要有話講 —— 按鈕寫「開始出片」
  // 卻不跳確認視窗（續傳不再問一次）會讓人以為按錯了。
  if (pending && pending.sig === formSig()) {
    const left = pending.total - pending.done.length;
    return left > 0 ? `繼續上傳剩下的 ${left} 個檔案` : '繼續送出這支工作';
  }
  const t = (TPLS[tpl] || {}).label;
  return t ? `開始出片：${t}` : '開始出片';
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
  // 標題前面掛版型名（「大盤小報標題」）—— 同事會在選錯版型的情況下把標題打完，
  // 這裡多兩個字就多一次自我檢查。drawTitle() 每次換版型都會跑（boot2 呼叫）。
  $('#titleLabel').textContent = ((TPLS[tpl] || {}).label || '影片') + '標題';
  $('#submit').textContent = submitLabel();
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
  fillSlotsFrom(pickingSlot, [...e.target.files]);
  e.target.value = '';   // 選同一個檔第二次也要能觸發
};

/**
 * 這個檔能不能放進截圖格。
 * ⚠️ 不要只認 f.type —— HEIC 在有些系統給的是空字串，而伺服器其實吃得下
 *    （ensureUsableImage 會把 webp／heic／gif／bmp／tiff 自動轉成 png）。
 *    判斷跟事後補圖那支（uploadMoreShots）刻意用同一套，三個入口不要各有各的標準。
 */
function isShotFile(f) {
  return /^image\//.test(f.type) || /\.(png|jpe?g|webp|heic|heif|gif|bmp|tiff?)$/i.test(f.name);
}

// 從第 start 格開始往後填：第一張蓋掉 start 那格，其餘往後找空格，沒空格就長一格。
// 點擊選檔（一次可以選好幾張）與拖曳都走這支。
// ⚠️ 以前 #picker 那條是直接 `slots[i] = f`，完全沒有檢查，檢查只寫在拖曳那條：
//    選到 mp4 沒人擋，要等送出、建完工作、上傳被伺服器退件（400）才看得到一句看不懂的錯，
//    而且留下一支卡在「建立中」的工作（2026-09-14）。
function fillSlotsFrom(start, files) {
  if (start < 0 || !files.length) return;
  const bad = files.filter((f) => !isShotFile(f));
  let i = start;
  for (const f of files.filter(isShotFile)) {
    if (i >= slots.length) slots.push(null);
    slots[i] = f;
    do { i += 1; } while (i < slots.length && slots[i]);
  }
  drawSlots();
  // 一次選十張、其中三張不是圖片的話，彈三次視窗比不提醒還煩 —— 併成一則。
  if (bad.length) {
    const vid = bad.find((f) => /^video\//.test(f.type) || /\.(mp4|mov|m4v)$/i.test(f.name));
    alert(vid
      // 原本是靜靜忽略 —— 使用者把 mp4 拖進來會以為壞掉（2026-08-13 回報）
      ? '這幾格是放 APP 截圖的。\n\n講者影片預設由系統自己生成，不用上傳。'
      : `「${bad[0].name}」不是圖片檔，這幾格只能放截圖（png、jpg、heic 都可以）。`
        + (bad.length > 1 ? `\n\n另外還有 ${bad.length - 1} 個檔也一樣，都沒有放進去。` : ''));
  }
}

function drawSlots() {
  const wrap = $('#slots');
  const nodes = slots.map((f, i) => {
    const s = el('div', {
      class: 'slot' + (f ? ' filled' : ''),
      onclick: () => { pickingSlot = i; $('#picker').click(); },
      ondragover: (e) => { e.preventDefault(); s.classList.add('hot'); },
      ondragleave: () => s.classList.remove('hot'),
      ondrop: (e) => { e.preventDefault(); s.classList.remove('hot'); fillSlotsFrom(i, [...e.dataTransfer.files]); },
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
  // 換了圖就不是上次那支工作了 —— 按鈕要當場從「繼續上傳剩下的…」變回「開始出片」。
  // （submitLabel() 自己會比對表單特徵，這裡只是給它一次重算的機會。）
  if (pending) $('#submit').textContent = submitLabel();
}

// ── 唸法（發音替換）──────────────────────
// 以前是一個 textarea，要自己打「原文→唸法」。同事常打成半形 -> 或忘了打箭頭，
// 那一行就會被伺服器的 parseVoiceLines() **靜默丟掉** —— 填了、沒生效、也沒人講，
// 下次他就不填了（2026-09-14 使用者：「一個大空格自己填其實有點奇怪」）。
// 改成左右兩格、箭頭由程式組，版面跟「跟我說」那頁的回報表單共用 .sayrow。
// 送出的還是同一串「原文→唸法」文字，伺服器端一行都沒動。
let voiceRows = [{ from: '', to: '' }];

function drawVoiceRows() {
  const wrap = $('#voiceRows');
  wrap.replaceChildren(...voiceRows.map((r, i) => {
    // 欄位標題只畫在第一列 —— 每列都掛一次會把整張卡片撐成一面標籤牆
    const cell = (key, label, ph) => el('div', {},
      i === 0 ? el('label', {}, label) : '',
      el('input', { type: 'text', value: r[key], placeholder: ph,
        oninput: (e) => { r[key] = e.target.value; syncVoice(); markVoiceDupes(); } }));
    // ✕ 只有兩列以上才出現：只剩一列時還能刪，畫面會整個空掉，同事會以為功能不見了
    const x = voiceRows.length > 1
      ? el('button', { class: 'ghost vx', title: '刪掉這一條',
          onclick: () => { voiceRows.splice(i, 1); drawVoiceRows(); syncVoice(); } }, '✕')
      : '';
    return el('div', { class: 'sayrow' },
      cell('from', '預想會唸錯的詞', '收斂'), cell('to', '建議怎麼寫', '收練'), x);
  }));
  markVoiceDupes();
}

$('#voiceAdd').onclick = () => {
  voiceRows.push({ from: '', to: '' });
  drawVoiceRows();
  const last = $('#voiceRows').lastElementChild;
  if (last) last.querySelector('input').focus();
};

// 這幾格組出來的字串就是送出去的 body.voice。#voice 那個 textarea 還在（hidden），
// 只是改由這裡寫 —— POST 與續傳的表單特徵都讀它，不用各自再認識一次 voiceRows。
function syncVoice() {
  $('#voice').value = voiceRows
    .filter((r) => r.from.trim() && r.to.trim())
    .map((r) => `${r.from.trim()}→${r.to.trim()}`).join('\n');
  // 唸法也算在表單特徵裡：改了就不該再接續上一支（submitLabel 自己會重算）
  if (pending) $('#submit').textContent = submitLabel();
}

// 同一個原文填兩次，只有第一條會生效（伺服器是照順序做字串取代，先套先贏）——
// 當場把後面那條標紅，不要等到送出才講。
function markVoiceDupes() {
  const seen = new Set();
  const rows = [...$('#voiceRows').children];
  voiceRows.forEach((r, i) => {
    const from = r.from.trim();
    if (rows[i]) rows[i].classList.toggle('dup', !!from && seen.has(from));
    if (from) seen.add(from);
  });
}

/**
 * 送出前檢查。回傳第一個問題（字串）或 null。
 * 擋的都是「填了卻不會生效」的寫法 —— 以前這些全部被靜默丟掉，這正是要消滅的那件事。
 * 整列空白不算問題：預設就有一列，多數工作不填。
 */
function voiceProblem() {
  const seen = new Map();
  for (let i = 0; i < voiceRows.length; i++) {
    const from = voiceRows[i].from.trim();
    const to = voiceRows[i].to.trim();
    const at = `第 ${i + 1} 條唸法`;
    if (!from && !to) continue;
    if (!from) return `${at}只填了右邊。左邊要填腳本裡原本的那個詞。`;
    if (!to) return `${at}只填了「${from}」。右邊要填怎麼寫它才唸得對（例如「收練」）。`;
    if (/[→\n]/.test(from + to) || (from + to).includes('->'))
      return `${at}裡不用自己打箭頭 —— 左右兩格各填一個詞就好。`;
    if (from.startsWith('#')) return `${at}的「${from}」以 # 開頭，那在腳本裡是註解的意思，整條不會生效。`;
    if (from === to) return `${at}左右兩格一模一樣（${from}），這樣等於沒有改。`;
    if (seen.has(from)) return `${at}的「${from}」跟第 ${seen.get(from)} 條重複了。`
      + '同一個詞只有前面那條會生效，請刪掉一條。';
    seen.set(from, i + 1);
  }
  return null;
}

// ── 進階：現成講者影片 ──
let heygenFile = null;
$('#skipGenerate').onchange = (e) => {
  $('#heygenSlot').style.display = e.target.checked ? 'block' : 'none';
  $('#costWarn').hidden = e.target.checked;   // 用現成影片不呼叫 HeyGen，不扣點數
  // 用現成影片＝不重新配音 → 語氣那組變灰（drawEmotion 自己讀 #skipGenerate）
  drawHeygenMode();
  drawEmotion();
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
  drawVoiceRows();
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
  drawHeygenMode();
  drawEmotion();
  drawTitle();   // 換版型 → 標題行數／字數限制不同
}

// 出片卡片的兩組選項。樣式沿用編輯器的 .modes（等寬、選到的那顆發亮）。
// 用現成的講者影片時不會重新配音 → 語氣那組變灰不給點（.modes.off），
// 但**留在畫面上**，不是隱藏 —— 隱藏會讓整張卡片跳一下，而且看不出為什麼選項不見了。
function drawEmotion() {
  const off = $('#skipGenerate').checked;
  $('#emotion').className = 'modes' + (off ? ' off' : '');
  $('#emotionTip').innerHTML = off ? EMOTION_TIP_OFF : EMOTION_TIP;
  $('#emotion').replaceChildren(...EMOTIONS.map(([v, label]) =>
    el('div', {
      class: v === emotion ? 'on' : '',
      onclick: off ? null : () => { emotion = v; drawEmotion(); },
    }, label)));
}

function drawHeygenMode() {
  const cur = $('#skipGenerate').checked;
  $('#heygenTip').innerHTML = (HEYGEN_MODES.find(([v]) => v === cur) || [])[2] || '';
  $('#heygenMode').replaceChildren(...HEYGEN_MODES.map(([v, label]) =>
    el('div', {
      class: v === cur ? 'on' : '',
      onclick: () => {
        if (v === cur) return;
        $('#skipGenerate').checked = v;
        // 既有的 onchange 不是自動觸發的（程式改 .checked 不會發事件），要自己呼叫
        $('#skipGenerate').onchange({ target: $('#skipGenerate') });
      },
    }, label)));
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

// ── 送出 ──────────────────────────────────
// 上傳失敗後的續傳（2026-09-14）：工作是在上傳**之前**就建立的，所以第 8 張失敗時，
// 前 7 張已經在 input/ 裡、列表上多一筆卡在「建立中」（draft）的工作；再按一次「開始出片」
// 又會建一支新的、再問一次確認 —— 同事按個兩三次就是三支半成品。
// → 記住那支工作與已經傳成功的檔名，下一次只補剩下的。
// ⚠️ 能這樣重試，是因為建立階段的檔名是**固定的** shot<格號>（不是事後補圖那條的 auto=1 排號）：
//    同一格重傳就是覆蓋同名檔，不會多一張圖、也不會跳號。事後補圖那條不能照抄這個做法。
// ⚠️ 表單只要有一處不一樣就從頭建一支。腳本是建立那一刻就寫死進 input/script.txt 的，
//    不會跟著更新 —— 沿用舊工作等於把改過的腳本配到舊稿子上。
let pending = null;   // { id, sig, done: [已上傳的檔名], total }
function formSig() {
  return JSON.stringify([tpl, brand, emotion, $('#owner').value, titleLines(), $('#body').value,
    $('#voice').value, $('#skipGenerate').checked, $('#withAd').checked,
    slots.map((f) => f && [f.name, f.size, f.lastModified]),
    heygenFile && [heygenFile.name, heygenFile.size, heygenFile.lastModified]]);
}

// 續傳狀態下改腳本＝那已經是另一支影片了，按鈕要當場變回「開始出片」，
// 不然同事看到「繼續」兩個字、按下去卻建出一支新工作。
// 沒有 pending 時什麼都不算 —— 不值得為了每一次按鍵重算一遍表單特徵。
$('#body').addEventListener('input', () => { if (pending) $('#submit').textContent = submitLabel(); });

$('#submit').onclick = async () => {
  const btn = $('#submit');
  const imgs = slots.filter(Boolean);
  const lines = titleLines();
  if (!$('#body').value.trim()) return alert('腳本是空的');
  if ($('#skipGenerate').checked && !heygenFile) return alert('勾了「用現成的講者影片」，請選擇 heygen.mp4');
  const vp = voiceProblem();
  if (vp) return alert(vp);

  const sig = formSig();
  const resume = !!(pending && pending.sig === sig);
  if (pending && !resume) pending = null;   // 內容改過了 → 上次那支半成品不要了，從頭建一支

  // 續傳不再問一次：內容跟上次按下確定時**一模一樣**（sig 比對過），
  // 而且按鈕上寫的就是「繼續上傳剩下的 N 個檔案」，不是「開始出片」。
  // 勾了「用現成的講者影片」不呼叫 HeyGen、不扣點數，也不用問
  // 版型放第一行（2026-09-14 使用者：「同事會按錯」）。原生 confirm 不能粗體、不能上色、
  // 也不能置中（Chrome 一律釘在分頁上緣），能強調的只有「排在最前面」與【】。
  // 「按下確定就會扣點數」那句拿掉 —— 按鈕正上方的紅框已經整段在講同一件事，
  // 同一句話講兩次反而讓人整段略過（使用者：「這樣更簡單清楚」）。
  const tplLabel = (TPLS[tpl] || {}).label || tpl;
  const emoLabel = (EMOTIONS.find(([v]) => v === emotion) || [])[1] || emotion;
  if (!resume && !$('#skipGenerate').checked &&
      !confirm(`這支要出的是【${tplLabel}】\n配音語氣：${emoLabel}\n\n`
        + '確定要開始出片嗎？\n'
        + '送出前再確認一次：版型、腳本、標題、截圖。')) return;

  btn.disabled = true;
  try {
    let jobId;
    if (resume) jobId = pending.id;
    else {
      btn.textContent = '建立工作…';
      const { job } = await api('/api/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template: tpl, owner: $('#owner').value,
          title: lines.join('\n'), body: $('#body').value, voice: $('#voice').value,
          // noSpeed 的勾選框 2026-08-19 拿掉了（加速已經改在 HeyGen 生成端做，正常出片不會重複）。
          // run.js 的 --no-speed 旗標還在，要用就在終端機下。
          skipGenerate: $('#skipGenerate').checked,
          withAd: $('#withAd').checked, autoApprove: false, brand, emotion,
        }),
      });
      jobId = job.id;
      pending = { id: jobId, sig, done: [], total: 0 };
    }
    const ups = imgs.map((f, i) => ({ f, name: 'shot' + (i + 1) + (/\.jpe?g$/i.test(f.name) ? '.jpg' : '.png') }));
    if (heygenFile) ups.push({ f: heygenFile, name: 'heygen.mp4' });
    pending.total = ups.length;
    for (let i = 0; i < ups.length; i++) {
      if (pending.done.includes(ups[i].name)) continue;   // 上次已經傳上去的，不用再傳一遍
      const mb = (ups[i].f.size / 1048576).toFixed(1);
      btn.textContent = `上傳 ${i + 1}/${ups.length}（${mb} MB）…`;
      // ⚠️ 一定要檢查結果。原本沒檢查 → 上傳失敗畫面照樣往下走，
      //    最後才丟一個看不懂的錯（2026-08-13）。
      const r = await fetch(withKey(`/api/jobs/${jobId}/upload?name=${ups[i].name}`),
        { method: 'POST', body: ups[i].f });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        // 那支工作在伺服器上已經不見了（被刪掉）→ 續傳沒有意義，下次從頭建一支
        if (r.status === 404) pending = null;
        throw new Error(`上傳「${ups[i].f.name}」失敗（${r.status}）${j.error ? '：' + j.error : ''}`);
      }
      pending.done.push(ups[i].name);
    }
    btn.textContent = '送出…';
    await api(`/api/jobs/${jobId}/submit`, { method: 'POST' });
    pending = null;
    slots = [null, null, null]; heygenFile = null;
    $('#vdrop').classList.remove('ok');
    $('#heygenName').textContent = '支援 .mp4（會被存成 heygen.mp4）';
    $('#body').value = ''; titleVals = ['', ''];
    // 唸法跟著腳本一起清掉（2026-09-14 使用者定案）。下一支是別的稿子，
    // 留著上一支的詞很容易整批被沿用到不該用的地方；真的常出現的詞會被收進共用詞庫，
    // 之後自動套用，不必再靠同事每次手填。
    voiceRows = [{ from: '', to: '' }];
    drawSlots(); drawTitle(); drawVoiceRows(); syncVoice();
    openJob = jobId; go('job');
  } catch (e) {
    alert('出錯了：' + e.message
      + (pending && pending.done.length
        ? `\n\n已經傳上去的 ${pending.done.length} 個檔案會留著，再按一次只補剩下的。` : ''));
  }
  btn.disabled = false; btn.textContent = submitLabel();
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
    let st = statusText(j);
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
        statusText(job) + (job.queuePosition > 0 ? `（前面還有 ${job.queuePosition} 支）` : '')),
      el('span', { style: 'flex:1' }),
      // ⚠️ 取消鈕放在**頁首**，不是埋在最下面的執行記錄裡（2026-09-17 使用者要求
      //    「一進到下一頁就要一直顯示」）。以前要捲到整頁最底才看得到，而且正在跑的
      //    工作根本不畫它 —— 人卡在 HeyGen 十幾分鐘只能乾等。
      cancelBtn(job),
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
            jobSig = null;
            loadJob();
          } catch (e) { alert('退不回來：' + e.message); }
        } }, '↩ 退回確認')));
    // 還沒真的 render，重點詞仍然進得了這支成品（伺服器的 EMPHASIS_EDITABLE 同一條界線）。
    // 藍底線看已確認的計畫；「直接出片」那條路沒有計畫頁，就退回看手動標注。
    card.append(emphasisBox(job, () => (job.planView && job.planView.rows) || ANNOTS));
    card.append(motionBox(job, () => (job.planView && job.planView.rows) || ANNOTS));
    if (emphLoadedFor !== job.id) {
      emphLoadedFor = job.id;
      CHARS = []; EMPH = [];
      loadEmph(job, () => {
        const box = $('.emph');
        if (box && EMPH.length) box.open = true;
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
    // ⚠️ 檔名是中文（動態1_…_直式.mp4），跟成品的 output-dapan.mp4 不一樣 ——
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
function cancelBtn(job) {
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
      jobSig = null;
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
function redoCard(job) {
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
          openJob = r.job.id;
          jobSig = null;
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
function redoConfirmCard(job) {
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
          jobSig = null;
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
function planPendingCard(job) {
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
// 排隊等出片那張卡片自己載重點詞（那個階段沒有標注頁也沒有計畫頁可以順便帶）。
// 記住載過誰，免得每次輪詢重畫都重打一次 API、把人正在拖的選取蓋掉。
let emphLoadedFor = null;
// 系統判定的頁型。計畫頁從 planView.pages 拿，標注頁沒有 planView，走 /api/jobs/:id/pages。
let ANNOT_PAGES = {};

/**
 * 標注頁的截圖總覽（2026-09-17）。跟配圖計畫頁那面牆共用 shotFigures()，
 * 差別只在「用了幾次」數的是 ANNOTS、點一下是加標注而不是加計畫段。
 */
function drawAnnotWall(job) {
  const wrap = $('#annotWall');
  if (!wrap) return;
  const imgs = (job.files || []).filter((f) => /\.(png|jpe?g)$/i.test(f));
  if (!imgs.length) return wrap.replaceChildren();
  const count = {};
  for (const a of ANNOTS) count[a.src] = (count[a.src] || 0) + 1;
  const used = imgs.filter((n) => count[n]).length;
  wrap.replaceChildren(
    el('div', { style: 'font-size:12.5px;color:var(--dim);margin-bottom:8px' },
      `全部截圖 ${imgs.length} 張，已經用了 ${used} 張　—　`
      + '點一下就用它加一段；同一張可以點多次、各自標不同區塊。'),
    el('div', { class: 'shots' },
      ...shotFigures(job, imgs, count, ANNOT_PAGES, (n) => addAnnot(job, n))));
}

function annotCard(job) {
  const c = el('div', { class: 'card' },
    el('h2', {}, '手動標記　—　請手動標記要顯示的範圍'),
    el('div', { class: 'note', html:
      'HeyGen 生成要好幾分鐘，這段時間可以先把圖標好：<b>哪張圖配在哪一句、框哪裡</b>。<br>'
      + '每張要用的圖都請手動圈出要顯示的範圍；沒圈的截圖不會出現在影片裡。<br>'
      + '<b>標「哪一句」而不是「第幾秒」</b> —— 秒數要等語音轉完字幕才存在，系統會自己換算。<br>'
      + '圖不夠？<b>下面可以再上傳</b>；編輯器裡也有縮圖列可以直接換成別張圖。' }),
    el('div', { id: 'annotList' }),
    // 截圖總覽（2026-09-17 使用者要求，跟配圖計畫頁對齊）：看得出哪張用了幾次、
    // 系統認成什麼頁型，點一下就用那張加一段。以前這塊只長在計畫頁上。
    el('div', { id: 'annotWall', style: 'margin-top:18px' }),
    el('div', { style: 'margin-top:16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
      el('button', { class: 'ghost', onclick: () => addAnnot(job) }, '＋ 加一個標注'),
      // ⚠️ 上傳完只重畫縮圖牆與標注列，不要走 loadJob() —— 跟計畫頁同一個理由：
      //    整頁重畫會把人正在拉的框、加到一半的標注洗掉。
      el('button', { class: 'ghost', onclick: () => pickMoreShots(job, (added) => {
        job.files = job.files || [];
        for (const n of added) if (!job.files.includes(n)) job.files.push(n);
        drawAnnots(job);
      }) }, '＋ 上傳更多截圖'),
      el('span', { id: 'annotUpMsg', style: 'font-size:12.5px;color:var(--dim)' }),
      el('span', { id: 'annotSaved', style: 'font-size:12.5px;color:var(--dim)' })),
    // ⚠️ 排在 autoGoRow 上面 —— 「標好了，直接出片」按下去就進出片佇列，
    //    擺在它下面等於沒機會被看到（跟計畫頁那顆確認鍵同一個坑）。
    emphasisBox(job, () => ANNOTS),
    // 動態小影片：跟重點詞一樣排在「標好了，直接出片」上面，不然按鈕一按就看不到了。
    motionBox(job, () => ANNOTS),
    autoGoRow(job));

  if (annotJobId !== job.id) {
    annotJobId = job.id;
    ANNOTS = []; UNITS = []; CHARS = []; EMPH = []; ANNOT_PAGES = {};
    Promise.all([
      api(`/api/jobs/${job.id}/sentences`).catch(() => ({ units: [] })),
      api(`/api/jobs/${job.id}/annotations`).catch(() => ({ shots: [] })),
      api(`/api/jobs/${job.id}/emphasis`).catch(() => ({ marks: [] })),
      // 頁型：準備中還沒有 planView，所以走自己的端點（計畫頁是從 planView.pages 拿）。
      // 截圖分析跟 HeyGen 平行跑，可能比這裡晚完成 —— 讀不到就先畫「未知頁面」，
      // 下面的輪詢會再補上。
      api(`/api/jobs/${job.id}/pages`).catch(() => ({ pages: {} })),
    ]).then(([sv, av, ev, pv]) => {
      UNITS = sv.units || [];
      CHARS = sv.chars || [];
      ANNOTS = av.shots || [];
      ANNOT_PAGES = pv.pages || {};
      EMPH = (ev.marks || [])
        .filter((m) => Number.isInteger(m.startCharIdx) && Number.isInteger(m.endCharIdx))
        .map((m) => ({ startCharIdx: m.startCharIdx, endCharIdx: m.endCharIdx }));
      drawAnnots(job);
      // 標過的就展開 —— 建卡片那一刻還沒讀完，收合列上的「已標 N 處」看起來會像沒標。
      const box = $('.emph');
      if (box && EMPH.length) box.open = true;
      drawEmph();
    });
  } else setTimeout(() => { drawAnnots(job); drawEmph(); }, 0);
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
      // 箭頭：跟計畫頁的 preview() 同一套（伺服器縮圖畫不出箭頭，一律前台疊 SVG）
      if (hasArrow(a.arrow) && a.imgW && a.imgH) {
        const w = 120, h = (w * a.imgH) / a.imgW, k2 = w / a.imgW;
        box.append(arrowSVG(w, h, a.arrow.x1 * k2, a.arrow.y1 * k2,
          a.arrow.x2 * k2, a.arrow.y2 * k2, a.arrow.color,
          arrowShaftPx(w, a.imgW, a.imgH, a.region)));
      }
      const bare = !a.region && !a.cell && !hasArrow(a.arrow);
      box.append(el('div', { class: 'hint' }, bare ? '整張顯示・點我改' : '點我改'));
      return el('div', { class: 'an' }, box,
        el('div', { class: 's' },
          el('b', {}, '出現在：' + rangeText(a)),
          el('span', {}, ([a.region ? '有顯示區域' : null, a.cell ? '有黃框' : null,
            hasArrow(a.arrow) ? '有箭頭' : null]
            .filter(Boolean).join('＋') || '整張顯示'))),
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
  // 牆上的「已用 N 次」要跟著標注一起更新 —— 少了這行，點縮圖加完標注、
  // 或刪掉一段之後，次數會停在舊數字。
  drawAnnotWall(job);
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
  ANNOTS.push({ src: use, startCharIdx: null, endCharIdx: null, region: null, cell: null, arrow: null });
  drawAnnots(job);
  editAnnot(job, ANNOTS.length - 1);
}

function editAnnot(job, k) {
  const a = ANNOTS[k];
  edCtx = { job, mode: 'annot', k, drag: null, src: a.src, mode2: 'region',
    region: a.region ? { ...a.region } : null,
    cell: a.cell ? { ...a.cell } : null,
    arrow: a.arrow ? { ...a.arrow } : null,
    arrowColor: (a.arrow && a.arrow.color) || ARROW_DEFAULT,
    from: a.startCharIdx ?? null, to: a.endCharIdx ?? null };
  $('#edTitle').textContent = '標注　' + a.src;
  $('#edNote').textContent = '';
  setEdArrow(job);
  drawEdColors();
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
  // 這支已經標過的重點詞（伺服器從 src/emphasis.generated.json 讀出來的）
  EMPH = (pv.emphasis || [])
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
    CHAR_SEC = n >= 8 ? sec / n : null;
  }

  edits = {};
  let addSeq = 0;
  for (const r of pv.rows) {
    edits[r.i] = { i: r.i, src: r.src, deleted: false,
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
    edits[key] = { i: key, _added: true, _manual: true, _late: true, deleted: false,
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
        el('div', { class: 'sec' }, [e.region ? '顯示區域' : null, e.cell ? '黃框' : null,
          hasArrow(e.arrow) ? '箭頭' : null].filter(Boolean).join('＋') || '整張顯示'));
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
    edits[key] = { i: key, _added: true, _manual: true, deleted: false,
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
    Object.values(edits).filter((e) => !e.deleted).forEach((e) => { count[e.src] = (count[e.src] || 0) + 1; });
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
  c.append(emphasisBox(job, () => Object.values(edits || {})));
  // 動態小影片：同樣排在「確認，開始出片」上面。在這一頁改的話，doRender 之前會重算。
  c.append(motionBox(job, () => Object.values(edits || {})));

  c.append(el('div', { style: 'margin-top:20px;display:flex;gap:12px;align-items:center' },
    addSegBtn,
    el('button', { class: 'go', onclick: () => approve(job, Object.values(edits)) }, '確認，開始出片')));
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
function shotFigures(job, images, count, pages, onPick) {
  return (images || []).map((n) => {
    const c = (count || {})[n] || 0;
    // 2026-09-07 系統判定的頁型（來自 app-images.generated.json）。
    // 認不出來（unknown）或只認得出「是個股頁但不知道哪個 tab」（stock-other）→ 給一顆 📌，
    // 按了只存指紋與截圖、不命名；之後 `node scripts/page-pins.js` 批次分群命名（使用者定案：不要當場手打）。
    const pg = (pages || {})[n] || {};
    const unknown = !pg.page || pg.page === 'unknown' || pg.page === 'stock-other';
    const fig = el('figure', { class: c ? 'used' : '', title: `點一下＝用 ${n} 加一段`,
      onclick: () => onPick(n) },
      el('img', { src: `/api/jobs/${job.id}/file/${n}`, alt: '' }),
      el('div', { class: 'tag' }, c ? `已用 ${c} 次` : '還沒用'),
      el('div', { class: 'pg' + (unknown ? ' unk' : ''), title: '系統判定的頁型' }, pg.pageLabel || '未知頁面'),
      el('div', { class: 'nm' }, n));
    // 2026-09-07 使用者定案：📌 只給管理者（本機連進來的人）看；同事那邊只看到頁型標籤、沒有按鈕。
    if (unknown && ADMIN) fig.append(el('button', { class: 'pin', title: '記下這種頁：系統認不出來，先存指紋與截圖，之後批次命名',
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
function emphasisBox(job, covered) {
  EMPH_JOB = job;
  EMPH_COVERED = covered || (() => []);
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
        onclick: () => { EMPH = []; drawEmph(); saveEmph(); } }, '全部清除')));
  if (EMPH.length) box.open = true;
  // DOM 要等呼叫端 append 之後才找得到，所以繞一圈再畫。
  setTimeout(drawEmph, 0);
  return box;
}

/**
 * 重點詞與腳本字元讀進來（標注頁／排隊階段用；計畫頁的 planView 本來就帶了這兩份）。
 * 讀完才畫 —— CHARS 是空的話 drawEmph() 只會顯示「腳本還在讀…」。
 */
function loadEmph(job, after) {
  Promise.all([
    CHARS.length ? Promise.resolve(null) : api(`/api/jobs/${job.id}/sentences`).catch(() => null),
    api(`/api/jobs/${job.id}/emphasis`).catch(() => ({ marks: [] })),
  ]).then(([sv, ev]) => {
    if (sv) { UNITS = sv.units || UNITS; CHARS = sv.chars || CHARS; }
    EMPH = (ev.marks || [])
      .filter((m) => Number.isInteger(m.startCharIdx) && Number.isInteger(m.endCharIdx))
      .map((m) => ({ startCharIdx: m.startCharIdx, endCharIdx: m.endCharIdx }));
    if (after) after();
    drawEmph();
  });
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
  // 色票只在箭頭模式出現 —— 另外兩種的顏色是固定的（顯示區域藍虛線、黃框黃實線）
  const row = $('#edColorRow');
  if (row) row.hidden = m !== 'arrow';
}


/**
 * 箭頭只在「timeline 真的有把 arrow 交給渲染端」的版型出現。
 *
 * 哪些版型算數由伺服器的 TEMPLATES `arrow` 旗標決定（跟著 /api/health 一起送過來）。
 * ⚠️ 不擋的話就是**靜默失效**：編輯器照樣讓人畫、存得進計畫，成品卻沒有箭頭 ——
 *    2026-09-16 使用者在盤中焦點實際踩到（那次是 timeline 漏接，已補；焦點股日報、
 *    三大法人、投廣是真的還沒接）。旗標與 timeline 的對應有回歸測試（測試/配圖箭頭）。
 */
function setEdArrow(job) {
  const on = !!(TPLS[(job && job.template) || ''] || {}).arrow;
  document.querySelectorAll('#ed [data-arrow]').forEach((n) => { n.hidden = !on; });
  if (!on && edCtx) edCtx.arrow = null;
  return on;
}

/** 六色色票。選色會同時套用到已經畫好的箭頭（不用重畫一次）。 */
function drawEdColors() {
  const box = $('#edColors');
  if (!box || !edCtx) return;
  box.replaceChildren(...ARROW_COLORS.map((c) =>
    el('i', {
      style: `background:${c}`, title: c,
      class: c.toLowerCase() === String(edCtx.arrowColor).toLowerCase() ? 'on' : '',
      onclick: () => {
        edCtx.arrowColor = c;
        if (edCtx.arrow) edCtx.arrow.color = c;
        drawEdColors();
        drawEdBox();
      },
    })));
  const sw = $('#edArrowSw');
  if (sw) sw.style.background = edCtx.arrowColor || ARROW_DEFAULT;
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
  // 箭頭：同樣拿圖片在容器裡的實際位置換算（理由跟上面那段一樣，不能用百分比）。
  const hasA = hasArrow(edCtx.arrow);
  if (hasA) {
    const a = edCtx.arrow;
    const kx = iw / edCtx.natW, ky = ih / edCtx.natH;
    wrap.append(arrowSVG(
      wrap.offsetWidth, wrap.offsetHeight,
      ox + a.x1 * kx, oy + a.y1 * ky, ox + a.x2 * kx, oy + a.y2 * ky,
      a.color || edCtx.arrowColor,
      // ⚠️ 線寬要用**圖片**的顯示寬換算，不是容器寬 —— 容器會被上面那排縮圖撐寬
      //    （drawEdBox 開頭那段註解講的同一件事）。
      arrowShaftPx(iw, edCtx.natW, edCtx.natH, edCtx.region)));
  }
  const hasR = !!(edCtx.region && edCtx.region.w > 0), hasC = !!(edCtx.cell && edCtx.cell.w > 0);
  $('#edRegionState').textContent = hasR ? '已畫' : '沒有';
  $('#edCellState').textContent = hasC ? '已畫' : '沒有';
  $('#edArrowState').textContent = hasA ? '已畫' : '沒有';
  $('#edClearRegion').disabled = !hasR;
  $('#edClearCell').disabled = !hasC;
  $('#edClearArrow').disabled = !hasA;
  $('#edClearRegion').style.opacity = hasR ? 1 : 0.35;
  $('#edClearCell').style.opacity = hasC ? 1 : 0.35;
  $('#edClearArrow').style.opacity = hasA ? 1 : 0.35;
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
    // 箭頭存的也是原圖像素座標 —— 留著就會原座標畫到另一張圖上（跟框同一個坑，2026-09-16）
    edCtx.arrow = null;
    const note = $('#edNote');
    if (note) note.textContent = '（換了截圖，原本的框與箭頭已清掉 —— 請在新的圖上重畫）';
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
  if (edMode() === 'arrow') {
    // 箭頭是線段不是矩形：按下的地方是尾、放開的地方是頭（箭鏃）。
    edCtx.arrow = { x1: x0, y1: y0, x2: x1, y2: y1, color: edCtx.arrowColor || ARROW_DEFAULT };
  } else {
    edCtx[edMode()] = { x: Math.min(x0, x1), y: Math.min(y0, y1),
      w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  }
  drawEdBox();
});
window.addEventListener('mouseup', () => {
  if (!edCtx || !edCtx.drag) return;
  edCtx.drag = null;
  if (edMode() === 'arrow') {
    // 太短多半是誤點。⚠️ 不能沿用下面那組 w/h 門檻 —— 水平或垂直的箭頭一定有一軸是 0，
    //    套下去每一支畫完就消失。線段只能用長度判斷。
    const a = edCtx.arrow;
    const min = Math.min(edCtx.natW, edCtx.natH) * ARROW_MIN_RATIO;
    if (a && Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < min) edCtx.arrow = null;
    drawEdBox();
    return;
  }
  const r = edCtx[edMode()];
  // 太小多半是誤點
  if (r && (r.w < edCtx.natW * 0.02 || r.h < edCtx.natH * 0.008)) edCtx[edMode()] = null;
  drawEdBox();
});
// 框是用像素畫的 → 視窗大小一變（圖片跟著縮放）就要重畫，不然會跟圖片脫節
window.addEventListener('resize', () => { if (edCtx) drawEdBox(); });
$('#edClearRegion').onclick = () => { edCtx.region = null; drawEdBox(); };
$('#edClearCell').onclick = () => { edCtx.cell = null; drawEdBox(); };
$('#edClearArrow').onclick = () => { edCtx.arrow = null; drawEdBox(); };
$('#edCancel').onclick = () => { $('#ed').style.display = 'none'; edCtx = null; };

function openEditor(job, pv, row, done) {
  const e = edits[row.i];
  edCtx = { job, mode: 'shot', e, done, drag: null, src: e.src, mode2: 'cell',
    region: e.region ? { ...e.region } : null,
    cell: e.cell ? { ...e.cell } : null,
    arrow: e.arrow ? { ...e.arrow } : null,
    arrowColor: (e.arrow && e.arrow.color) || ARROW_DEFAULT,
    // 出現範圍用「在腳本上拖選」，不叫人填秒數
    from: e.startCharIdx ?? null, to: e.endCharIdx ?? null };
  $('#edTitle').textContent = row.phrase || '調整這一段';
  $('#edNote').textContent = '';
  setEdArrow(job);
  drawEdColors();
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
    a.arrow = hasArrow(edCtx.arrow) ? edCtx.arrow : null;
    a.imgW = edCtx.natW; a.imgH = edCtx.natH;
    const job = edCtx.job;
    $('#ed').style.display = 'none'; edCtx = null;
    drawAnnots(job); saveAnnots(job);
    return;
  }
  const { e, done } = edCtx;
  if (edCtx.from == null) return alert('還沒選範圍 —— 在下面的腳本上點一下或拖選');
  const a0 = Math.min(edCtx.from, edCtx.to), b0 = Math.max(edCtx.from, edCtx.to);
  // ⚠️ 箭頭也要進這個比對 —— 只動箭頭、沒動框的話 `_manual` 不會被標起來，
  //    applyPlanEdits() 就不會把這一段當人工段寫回去，箭頭靜默消失（2026-09-16）。
  const arrowOf = (a) => (hasArrow(a)
    ? [Math.round(a.x1), Math.round(a.y1), Math.round(a.x2), Math.round(a.y2),
      String(a.color || ARROW_DEFAULT).toLowerCase()]
    : null);
  const changed = JSON.stringify([edCtx.region, edCtx.cell, arrowOf(edCtx.arrow)])
      !== JSON.stringify([e.region, e.cell, arrowOf(e.arrow)])
    || a0 !== e.startCharIdx || b0 !== e.endCharIdx
    || edCtx.src !== e.src;
  e.region = edCtx.region; e.cell = edCtx.cell;
  e.arrow = hasArrow(edCtx.arrow) ? edCtx.arrow : null;
  e.imgW = edCtx.natW; e.imgH = edCtx.natH;
  e.startCharIdx = a0; e.endCharIdx = b0;
  e.src = edCtx.src;
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
      body: JSON.stringify({ edits: e, by: $('#owner').value, emphasis: EMPH }),
    });
    loadJob();
  } catch (err) { alert('出錯了：' + err.message); }
}

// ── 字幕重點詞（2026-09-17）─────────────────
// 在配圖計畫頁底部標，成品裡那幾個字會放大變黃（其餘維持白字一般大小）。
// 存的是**腳本字元範圍**不是文字 —— 同一個詞在句子裡可能出現兩次，存文字分不出標哪一個。
// ⚠️ 只有人工標的才算，沒有任何自動判斷（跟黃框同一條規則：系統不要自己加東西）。
let EMPH = [];

/**
 * 拖曳中的「還沒放手」範圍 —— 只影響畫面，不動 EMPH／MOTION，也不存檔。
 * 需要這個中繼變數，是因為這兩處放手時做的是**決策**而不是設定範圍
 *（toggleEmph 要判斷取消與合併、動態要判斷「點在已選範圍內＝取消」），
 * 中途套用會在拖曳途中反覆翻轉。配圖計畫沒這問題，它拖曳中改的是不落地的草稿。
 * 視覺上跟配圖計畫對齊：拖曳中藍底（.sel）、放手後才變黃底（.emph）。
 */
let EMPH_PREVIEW = null;    // {lo, hi} 或 null
let MOTION_PREVIEW = null;
const inPreview = (p, i) => !!p && i >= p.lo && i <= p.hi;

/** 這個字有沒有被標成重點 */
function isEmph(i) {
  return EMPH.some((m) => i >= m.startCharIdx && i <= m.endCharIdx);
}

/** 加一段（跟相鄰的合併），或整段取消（點到已標的地方就是取消） */
function toggleEmph(lo, hi) {
  if (lo > hi) [lo, hi] = [hi, lo];
  // 取消只看「真的壓到」—— 用相鄰判斷的話，點旁邊一個沒標的字會把隔壁整段刪掉。
  const hit = EMPH.filter((m) => !(m.endCharIdx < lo || m.startCharIdx > hi));
  if (hit.length && lo === hi) {
    // 單點擊在已標的字上 → 移除整段（整段拿掉比切成兩半直覺）
    EMPH = EMPH.filter((m) => !hit.includes(m));
    return;
  }
  // 新增時**連相鄰的一起併**，跟伺服器 writeEmphasis 同一條規則 ——
  // 兩邊規則不一樣的話，「已標 N 處」在送出前後會跳號（實測過）。
  const near = EMPH.filter((m) => !(m.endCharIdx < lo - 1 || m.startCharIdx > hi + 1));
  let a = lo, b = hi;
  for (const m of near) { a = Math.min(a, m.startCharIdx); b = Math.max(b, m.endCharIdx); }
  EMPH = EMPH.filter((m) => !near.includes(m));
  EMPH.push({ startCharIdx: a, endCharIdx: b });
  EMPH.sort((x, y) => x.startCharIdx - y.startCharIdx);
}

/**
 * 這些字元被哪一段配圖用到了（藍底線的來源）。跟編輯器的 usedRanges 不同：這裡看全部的段。
 * ⚠️ 來源由呼叫端給，不要在這裡猜 —— 三個階段手上有的東西不一樣：
 *    計畫頁是 `edits`（含還沒送出的修改）、標注頁是 ANNOTS、排隊階段只剩 planView.rows。
 *    以前這裡寫死讀 `edits`，換到別的階段就會拿到上一支工作的殘留。
 */
function charsCoveredBy(list) {
  const set = new Set();
  for (const e of list || []) {
    if (!e || e.deleted) continue;
    const a = e.startCharIdx, b = e.endCharIdx;
    if (typeof a !== 'number' || typeof b !== 'number') continue;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(i);
  }
  return set;
}

// ── 動態小影片（2026-09-18）────────────────────────────────
// 跟重點詞同一套手勢（在腳本上拖選），但**每支只有一段**：再拖一次就是取代，
// 點已選的地方就取消。使用者定案「每支預設 1 段」。
let MOTION = [];
let MOTION_JOB = null;
let MOTION_COVERED = null;   // 「哪些字已經有配圖」，畫藍底線用；各階段來源不同
let motionSaveSeq = 0;

function motionBox(job, covered) {
  // 換一支工作才重讀 —— 同一支重畫時沿用記憶體裡的，不然會把人正在打的參數洗掉
  //（跟 annotCard 的 annotJobId 判斷同一個理由）。
  const switched = !MOTION_JOB || MOTION_JOB.id !== job.id;
  MOTION_JOB = job;
  MOTION_COVERED = covered || (() => []);
  if (switched) { MOTION = []; setTimeout(() => loadMotion(job), 0); }
  const box = el('details', { class: 'emph' },
    el('summary', {},
      '動態小影片（選填）　',
      el('span', { id: 'motionCount', class: 'sec' }, '尚未指定'),
      el('span', { id: 'motionSaved', class: 'sec', style: 'margin-left:10px' }, '')),
    el('div', { class: 'tip', html:
      '在下面的腳本上拖選一段，那段畫面會換成帶動畫的文字卡 —— '
      + '卡片上的每一項會<b>跟著旁白唸到它的時間</b>依序出現。再拖一次就換一段，點已選的地方取消。' }),
    el('div', { class: 'tip', html:
      '挑「一次講三件事以上、大約 10 秒以上」的段落效果最好；'
      + '<b>沒有配圖的地方</b>（字底下沒有藍線）最適合，那裡原本畫面上只有講者。' }),
    el('div', { class: 'range', id: 'motionRange' }),
    el('div', { id: 'motionPicked', class: 'tip', style: 'margin-top:6px' }),
    el('details', { style: 'margin-top:10px' },
      el('summary', { class: 'sec' }, '進階：自己指定卡片內容'),
      el('div', { class: 'tip', html:
        '留空的話，卡片文字由 Claude 讀那段旁白自己濃縮。要自己指定就貼一份參數 JSON，例如：<br>'
        + '<code>{"template":"list","kicker":"三大法人","title":"買超|超過1165億",'
        + '"items":[{"text":"外資買超","at":"外資在買"}]}</code><br>'
        + 'template 可用 list（條列）／contrast（不是X而是Y）／quote（一句話）。'
        + '每一項的 <code>at</code> 要是旁白原文裡真的有的字串，用來算進場時間。' }),
      el('textarea', { id: 'motionSpec', rows: '6',
        style: 'width:100%;font-family:ui-monospace,Menlo,monospace;font-size:12px',
        placeholder: '留空＝交給 Claude',
        onchange: () => saveMotion(), onblur: () => saveMotion() }),
      el('div', { id: 'motionSpecMsg', class: 'tip', style: 'color:var(--warn)' })),
    el('div', { style: 'margin-top:8px' },
      el('button', { class: 'ghost tiny', id: 'motionClear',
        onclick: () => { MOTION = []; drawMotion(); saveMotion(); } }, '清除')));
  if (MOTION.length) box.open = true;
  setTimeout(drawMotion, 0);
  return box;
}

/** 讀這支工作已存的動態設定（標注頁與計畫頁都會呼叫）。 */
function loadMotion(job, after) {
  api(`/api/jobs/${job.id}/motion`).catch(() => ({ entries: [] })).then((mv) => {
    MOTION = (mv.entries || []).filter(
      (m) => Number.isInteger(m.startCharIdx) && Number.isInteger(m.endCharIdx));
    if (after) after();
    drawMotion();
  });
}

function drawMotion() {
  const wrap = $('#motionRange');
  if (!wrap) return;
  if (!CHARS.length) return wrap.replaceChildren(el('span', {}, '（腳本還在讀…）'));
  const covered = charsCoveredBy(MOTION_COVERED ? MOTION_COVERED() : []);
  const m = MOTION[0];
  const nodes = [];
  CHARS.forEach((c) => {
    const cls = [];
    if (covered.has(c.i)) cls.push('used');                                      // 藍底線＝已經有配圖
    if (inPreview(MOTION_PREVIEW, c.i)) cls.push('sel');                         // 藍底＝正在拖、還沒放手
    else if (m && c.i >= m.startCharIdx && c.i <= m.endCharIdx) cls.push('emph'); // 黃＝這段要做動態
    if (c.b) cls.push('br');
    nodes.push(el('i', { 'data-mo': c.i, class: cls.join(' ') }, c.c));
    if (c.p) nodes.push(el('br', { class: 'para' }));
  });
  wrap.replaceChildren(...nodes);

  const n = $('#motionCount');
  if (n) n.textContent = m ? `已選 ${m.endCharIdx - m.startCharIdx + 1} 個字` : '尚未指定';
  const picked = $('#motionPicked');
  if (picked) {
    if (!m) picked.textContent = '';
    else {
      const txt = CHARS.slice(m.startCharIdx, m.endCharIdx + 1).map((c) => c.c).join('');
      // 秒數只有配圖計畫那一頁算得出來（標注階段字幕還不存在）
      const sec = CHAR_SEC ? `　約 ${((m.endCharIdx - m.startCharIdx + 1) * CHAR_SEC).toFixed(1)} 秒` : '';
      // 用 textContent 不用 innerHTML —— 腳本內容是使用者打的，不做跳脫直接塞 HTML 會出事，
      // 而這個檔案沒有現成的跳脫函式，不值得為了一個粗體字自己造一個。
      picked.replaceChildren(
        el('span', {}, '這一段：'),
        el('b', {}, txt.slice(0, 60) + (txt.length > 60 ? '…' : '')),
        el('span', {}, sec));
    }
  }
  const btn = $('#motionClear');
  if (btn) { btn.disabled = !m; btn.style.opacity = m ? 1 : 0.35; }
  const spec = $('#motionSpec');
  if (spec && document.activeElement !== spec) {
    spec.value = m && m.spec ? JSON.stringify(m.spec, null, 2) : '';
  }
}

async function saveMotion() {
  if (!MOTION_JOB) return;
  // 進階參數：留空＝交給 Claude；有填就要是合法 JSON，不然擋下來並說清楚
  const ta = $('#motionSpec');
  const msg = $('#motionSpecMsg');
  if (ta && MOTION.length) {
    const raw = ta.value.trim();
    if (!raw) { delete MOTION[0].spec; if (msg) msg.textContent = ''; }
    else {
      try {
        MOTION[0].spec = JSON.parse(raw);
        if (msg) msg.textContent = '';
      } catch (e) {
        if (msg) msg.textContent = 'JSON 格式有問題，這份參數還沒存進去：' + e.message;
        return;
      }
    }
  }
  const seq = ++motionSaveSeq;
  const note = $('#motionSaved');
  try {
    const r = await api(`/api/jobs/${MOTION_JOB.id}/motion`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: MOTION }),
    });
    if (seq !== motionSaveSeq) return;
    if (note) note.textContent = r.count ? '已存' : '已清除';
  } catch (e) {
    if (seq !== motionSaveSeq) return;
    if (note) note.textContent = '存不進去：' + e.message;
  }
}

// 拖選：跟重點詞同一套手勢，差別是**只留一段**（再拖就是取代）。
{
  const idxOf = (t) => (t && t.dataset && t.dataset.mo != null ? +t.dataset.mo : null);
  let dragging = false, anchor = null, last = null;
  document.addEventListener('mousedown', (ev) => {
    const w = $('#motionRange');
    if (!w || !w.contains(ev.target)) return;
    const i = idxOf(ev.target);
    if (i == null) return;
    dragging = true; anchor = i; last = i;
    MOTION_PREVIEW = { lo: i, hi: i };   // 點下去就上色，不等放手
    drawMotion();
    ev.preventDefault();
  });
  document.addEventListener('mousemove', (ev) => {
    if (!dragging) return;
    const i = idxOf(ev.target);
    if (i == null || i === last) return;              // 同一格不重畫
    last = i;
    MOTION_PREVIEW = { lo: Math.min(anchor, i), hi: Math.max(anchor, i) };
    drawMotion();
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    MOTION_PREVIEW = null;               // 預覽讓位給下面真正套用的結果
    const lo = Math.min(anchor, last);
    const hi = Math.max(anchor, last);
    const m = MOTION[0];
    // 單點在已選範圍內＝取消；其餘一律取代（每支只有一段）
    if (m && lo === hi && lo >= m.startCharIdx && lo <= m.endCharIdx) MOTION = [];
    else MOTION = [{ ...(m && m.spec ? { spec: m.spec } : {}), startCharIdx: lo, endCharIdx: hi }];
    drawMotion();
    saveMotion();
  });
}

// 目前這一頁的重點詞區塊是掛在哪支工作上、藍底線要看誰。emphasisBox() 建的時候設定。
let EMPH_JOB = null;
let EMPH_COVERED = () => [];
let emphSaveSeq = 0;

/**
 * 存重點詞。跟標注一樣是「改了就存」，不再只靠按「確認，開始出片」那一下 ——
 * 準備中與排隊階段根本沒有那顆按鈕可以按。
 * ⚠️ 連續拖選會連續觸發，用序號擋掉亂序回來的舊回應（慢的那筆覆蓋快的那筆＝數字跳回去）。
 */
async function saveEmph() {
  if (!EMPH_JOB) return;
  const seq = ++emphSaveSeq;
  const note = $('#emphSaved');
  try {
    const r = await api(`/api/jobs/${EMPH_JOB.id}/emphasis`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marks: EMPH }),
    });
    if (seq !== emphSaveSeq) return;
    if (note) note.textContent = r.count ? `已存 ${r.count} 處` : '已清除';
  } catch (e) {
    if (seq !== emphSaveSeq) return;
    if (note) note.textContent = '存不進去：' + e.message;
  }
}

function drawEmph() {
  const wrap = $('#emphRange');
  if (!wrap) return;
  if (!CHARS.length) return wrap.replaceChildren(el('span', {}, '（腳本還在讀…）'));
  const covered = charsCoveredBy(EMPH_COVERED());
  const nodes = [];
  CHARS.forEach((c) => {
    const cls = [];
    if (covered.has(c.i)) cls.push('used');          // 藍底線＝這裡已經有圖
    if (inPreview(EMPH_PREVIEW, c.i)) cls.push('sel');  // 藍底＝正在拖、還沒放手
    else if (isEmph(c.i)) cls.push('emph');          // 黃＝標成重點詞
    if (c.b) cls.push('br');
    nodes.push(el('i', { 'data-e': c.i, class: cls.join(' ') }, c.c));
    if (c.p) nodes.push(el('br', { class: 'para' }));
  });
  wrap.replaceChildren(...nodes);
  const n = $('#emphCount');
  if (n) n.textContent = EMPH.length ? `已標 ${EMPH.length} 處` : '尚未標記';
  const btn = $('#emphClear');
  if (btn) { btn.disabled = !EMPH.length; btn.style.opacity = EMPH.length ? 1 : 0.35; }
}

// 拖選：跟上面「出現在哪一段」同一套手勢（點一下標一個字、拖曳標一段、點已標的取消）。
{
  const idxOf = (t) => (t && t.dataset && t.dataset.e != null ? +t.dataset.e : null);
  let dragging = false, anchor = null, last = null;
  document.addEventListener('mousedown', (ev) => {
    const w = $('#emphRange');
    if (!w || !w.contains(ev.target)) return;
    const i = idxOf(ev.target);
    if (i == null) return;
    dragging = true; anchor = i; last = i;
    EMPH_PREVIEW = { lo: i, hi: i };     // 點下去就上色，不等放手
    drawEmph();
    ev.preventDefault();
  });
  document.addEventListener('mousemove', (ev) => {
    if (!dragging) return;
    const i = idxOf(ev.target);
    if (i == null || i === last) return;              // 同一格不重畫
    last = i;
    EMPH_PREVIEW = { lo: Math.min(anchor, i), hi: Math.max(anchor, i) };
    drawEmph();
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    EMPH_PREVIEW = null;                 // 預覽讓位給下面真正套用的結果
    toggleEmph(anchor, last);
    drawEmph();
    saveEmph();
  });
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
      m.kind === 'pronounce' ? (m.auto ? '唸法・出片時帶上' : '唸法回報')
        : m.kind === 'page-pin' ? '📌 記下的頁' : '留言',
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
  // 箭頭：尾 → 頭，跟框一樣能換算成比例就用比例（換手機解析度也讀得懂）
  const fmtArrow = (a, sz) => !a ? null
    : '箭頭 ' + (sz
      ? `${Math.round(a.x1 / sz.w * 100)},${Math.round(a.y1 / sz.h * 100)}%`
        + `→${Math.round(a.x2 / sz.w * 100)},${Math.round(a.y2 / sz.h * 100)}%`
      : `${Math.round(a.x1)},${Math.round(a.y1)}→${Math.round(a.x2)},${Math.round(a.y2)}`)
      + (a.color ? ` ${a.color}` : '');
  for (const r of d.rows) {
    let before = r.from || '—', after = r.to || '—';
    if (r.type === '改框') {
      // region（顯示區域）與 cell（黃框）分開顯示 —— 只畫顯示區域也是有效的修正。
      // 箭頭（2026-09-16）同一格顯示；自動配圖不會產生箭頭，所以「原本」那欄一定是空的。
      const pair = (cell, region, arrow) => [
        cell ? '黃框 ' + fmtCell(cell, r.size) : null,
        region ? '區域 ' + fmtCell(region, r.size) : null,
        fmtArrow(arrow, r.size),
      ].filter(Boolean).join('　') || '整張顯示';
      before = `${r.autoCellText || ''} ${pair(r.autoCell, r.autoRegion, r.autoArrow)}`;
      after = pair(r.manualCell, r.manualRegion, r.manualArrow);
    }
    if (r.type === '改時間') { before = `${r.auto}　${r.autoPhrase || ''}`; after = `${r.manual}　${r.manualPhrase || ''}`; }
    if (r.type === '新增一段') { before = (r.autoCoveredBy || []).join('、') || '（原本沒有圖）'; after = `${r.from}　${r.manual || ''}`; }
    // 人工標記：「原本」是對照組（假裝沒人標注、讓 AI 自己排一次）的結果
    if (r.type === '人工標記') {
      const pair = (cell, region, arrow) => [
        cell ? '黃框 ' + fmtCell(cell, r.size) : null,
        region ? '區域 ' + fmtCell(region, r.size) : null,
        fmtArrow(arrow, r.size),
      ].filter(Boolean).join('　') || '整張顯示';
      // 「原本」是空的有三種：AI 真的不配圖、這一支對照組整份沒排出來、
      // 舊紀錄比對用錯欄位（focus 版型，autoKind 由伺服器補）。只有第一種能說「AI 不配圖」。
      const blank = {
        noCounterfactual: '（比不出來：這一支對照組一段都沒排，多半是頁型沒認出來）',
        legacyNoSrc: '（比不出來：舊紀錄沒記到 AI 配了哪張圖）',
      }[r.autoKind] || '（AI 本來不配圖）';
      before = r.from
        ? `${r.from}　${r.autoCellText || ''} ${pair(r.autoCell, r.autoRegion, null)}`.trim()
        : blank;
      after = `${r.to}　${pair(r.manualCell, r.manualRegion, r.manualArrow)}`;
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
