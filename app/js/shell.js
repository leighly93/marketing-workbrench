// 外框：導覽、燈箱、啟動（版型清單）與輪詢伺服器狀態。

import { $, api, el } from './dom.js';
import { loadFix } from './fix.js';
import { drawEmotion, drawHeygenMode, drawSlots, drawTitle, drawVoiceRows } from './form.js';
import { loadJob } from './job-detail.js';
import { loadJobs } from './jobs-list.js';
import { loadSay } from './say.js';
import { S } from './state.js';

// ── 導覽 ──
document.querySelectorAll('nav button').forEach((b) =>
  b.onclick = () => { S.openJob = null; go(b.dataset.v); });
export function go(v) {
  if (v !== 'job') S.jobSig = null;   // 換頁／換工作要重畫
  S.view = v;
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  for (const id of ['new', 'list', 'job', 'say', 'fix']) $('#v-' + id).hidden = (id !== v);
  if (v === 'list') loadJobs();
  if (v === 'fix') loadFix();
  if (v === 'say') loadSay();
  if (v === 'job') loadJob();
}

// 強制解鎖（只有管理者點得動）
$('#status').onclick = async () => {
  if (!S.ADMIN || !$('#status').textContent.includes('佔用')) return;
  if (!confirm('強制刪掉 .run.lock？\n\n只有在確定沒有任何 run.js 在跑的時候才做，'
    + '否則兩個流程會同時寫 public/，兩支影片都會壞掉。')) return;
  await api('/api/unlock', { method: 'POST' });
  poll();
};

$('#lb').onclick = () => ($('#lb').style.display = 'none');
export function zoom(src) { $('#lbimg').src = src; $('#lb').style.display = 'flex'; }


// ── 版型 ──
export async function boot() {
  const h = await api('/api/health');
  S.TPLS = h.templates;
  // 修正紀錄只給管理者（本機連進來的人）看。
  // ⚠️ 2026-08-21：「進階」整塊已經沒有了 —— 裡面唯一的「用現成的講者影片」開放給所有人
  //    （那是唯一不花點數的出片路徑，鎖起來等於逼同事每試一次就燒點數）。
  //    所以這裡不再有 `$('#advBox').hidden = !ADMIN`，別再加回來。
  S.ADMIN = !!h.admin;
  $('#navFix').hidden = !S.ADMIN;
  // hidden 的版型整個不畫出來、disabled 的變灰不給點（2026-08-20：投廣模板先從清單拿掉）。
  // TPLS 仍然收到全部版型 —— 工作列表要靠它顯示舊工作的版型名稱。
  const pickable = Object.entries(S.TPLS).filter(([, t]) => !t.hidden);
  $('#tpl').replaceChildren(...pickable.map(([k, t]) =>
    el('div', {
      'data-k': k,
      class: (k === S.tpl ? 'on' : '') + (t.disabled ? ' off' : ''),
      title: t.disabled ? '暫時關閉' : '',
      onclick: t.disabled ? null : () => { S.tpl = k; boot2(); },
    }, t.label)));
  // 萬一預設選到被關閉／隱藏的版型，跳到第一個可用的
  // 2026-08-31：預設選中＝可選清單的第一個（順序由 server/index.js 的 TEMPLATES 宣告順序決定）。
  // tpl 還是 null（第一次載入）或指到被關掉／隱藏的版型時都走這條。
  if (!S.tpl || !S.TPLS[S.tpl] || S.TPLS[S.tpl].disabled || S.TPLS[S.tpl].hidden) {
    const ok = pickable.find(([, t]) => !t.disabled);
    if (ok) S.tpl = ok[0];
  }
  boot2();
  drawSlots();
  drawVoiceRows();
  poll();
  setInterval(poll, 3000);
}
export function boot2() {
  document.querySelectorAll('#tpl div').forEach((d) =>
    d.classList.toggle('on', d.dataset.k === S.tpl));   // 用 data-k 對，不能用順序（清單會過濾）
  // 版型配色（2026-09-11）：CSS 用 #v-new[data-tpl=…] 覆寫 --accent 那組變數，
  // 1～5 的卡片外框、選中的版型、開始出片按鈕會一起換色，避免選錯版型（使用者要求）。
  // 放這裡是因為 boot2() 是**唯一**每次換版型都會跑的地方（onclick 與 boot() 都收斂到它）。
  $('#v-new').dataset.tpl = S.tpl || '';
  // 2026-08-31：tpl 的初始值改成 null（預設＝清單第一個），所以這裡不能再假設它一定指到一個版型
  // ——「全部版型都被關掉」時 tpl 會留在 null，下面幾行直接 .flags 會整頁掛掉。
  const cur = S.TPLS[S.tpl] || {};
  // 2026-09-22：投廣套框版勾選框（with-ad）與品牌選擇（起漲K線／籌碼K線）隨著
  // 焦點股日報、投廣模板一起移除 —— 現存三個版型都沒有這兩個旗標。
  drawHeygenMode();
  drawEmotion();
  drawTitle();   // 換版型 → 標題行數／字數限制不同
}



export async function poll() {
  try {
    const h = await api('/api/health');
    const s = $('#status');
    // 檔案比伺服器啟動時間新 → 一定是改完忘了重開
    $('#stale').style.display = h.codeChangedAt > h.startedAt ? 'block' : 'none';
    // 誰在看，決定第二句講什麼。用 h.admin 不用全域 ADMIN —— poll() 有可能比 boot() 先跑完。
    $('#staleAdmin').hidden = !h.admin;
    $('#staleOther').hidden = !!h.admin;
    $('#mockMode').hidden = !h.mock;
    // 這個分頁是什麼時候載入 index.html 的？之後檔案又被改過 → 畫面是舊的，要重新整理。
    // ⚠️ 這跟上面那條是**兩件不同的事**：伺服器重開了、網頁檔案也換了，但已經開著的
    //    分頁不會自己重載（輪詢只打 API，不會重抓 index.html）。使用者兩次都卡在這裡。
    if (h.webBuiltAt) {
      if (S.webSeen == null) S.webSeen = h.webBuiltAt;
      else if (h.webBuiltAt !== S.webSeen) $('#reload').style.display = 'flex';
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
      s.style.cursor = S.ADMIN ? 'pointer' : 'default';
    } else { s.className = 'pill'; s.textContent = '○ 閒置'; s.title = ''; s.style.cursor = 'default'; }
  } catch (_) {
    const s = $('#status'); s.className = 'pill bad'; s.textContent = '✕ 主機離線';
  }
  if (S.view === 'list') loadJobs();
  if (S.view === 'job' && S.openJob) loadJob();
}

