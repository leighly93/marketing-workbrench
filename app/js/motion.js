// 動態小影片：在腳本上選一段、存檔與畫面。

import { $, api, el } from './dom.js';
import { charsCoveredBy, inPreview } from './emphasis.js';
import { S } from './state.js';

// ── 動態小影片（2026-09-18）────────────────────────────────


export function motionBox(job, covered) {
  // 換一支工作才重讀 —— 同一支重畫時沿用記憶體裡的，不然會把人正在打的參數洗掉
  //（跟 annotCard 的 annotJobId 判斷同一個理由）。
  const switched = !S.MOTION_JOB || S.MOTION_JOB.id !== job.id;
  S.MOTION_JOB = job;
  S.MOTION_COVERED = covered || (() => []);
  if (switched) { S.MOTION = []; setTimeout(() => loadMotion(job), 0); }
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
        onclick: () => { S.MOTION = []; drawMotion(); saveMotion(); } }, '清除')));
  if (S.MOTION.length) box.open = true;
  setTimeout(drawMotion, 0);
  return box;
}

/** 讀這支工作已存的動態設定（標注頁與計畫頁都會呼叫）。 */
export function loadMotion(job, after) {
  api(`/api/jobs/${job.id}/motion`).catch(() => ({ entries: [] })).then((mv) => {
    S.MOTION = (mv.entries || []).filter(
      (m) => Number.isInteger(m.startCharIdx) && Number.isInteger(m.endCharIdx));
    if (after) after();
    drawMotion();
  });
}

export function drawMotion() {
  const wrap = $('#motionRange');
  if (!wrap) return;
  if (!S.CHARS.length) return wrap.replaceChildren(el('span', {}, '（腳本還在讀…）'));
  const covered = charsCoveredBy(S.MOTION_COVERED ? S.MOTION_COVERED() : []);
  const m = S.MOTION[0];
  const nodes = [];
  S.CHARS.forEach((c) => {
    const cls = [];
    if (covered.has(c.i)) cls.push('used');                                      // 藍底線＝已經有配圖
    if (inPreview(S.MOTION_PREVIEW, c.i)) cls.push('sel');                         // 藍底＝正在拖、還沒放手
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
      const txt = S.CHARS.slice(m.startCharIdx, m.endCharIdx + 1).map((c) => c.c).join('');
      // 秒數只有配圖計畫那一頁算得出來（標注階段字幕還不存在）
      const sec = S.CHAR_SEC ? `　約 ${((m.endCharIdx - m.startCharIdx + 1) * S.CHAR_SEC).toFixed(1)} 秒` : '';
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

export async function saveMotion() {
  if (!S.MOTION_JOB) return;
  // 進階參數：留空＝交給 Claude；有填就要是合法 JSON，不然擋下來並說清楚
  const ta = $('#motionSpec');
  const msg = $('#motionSpecMsg');
  if (ta && S.MOTION.length) {
    const raw = ta.value.trim();
    if (!raw) { delete S.MOTION[0].spec; if (msg) msg.textContent = ''; }
    else {
      try {
        S.MOTION[0].spec = JSON.parse(raw);
        if (msg) msg.textContent = '';
      } catch (e) {
        if (msg) msg.textContent = 'JSON 格式有問題，這份參數還沒存進去：' + e.message;
        return;
      }
    }
  }
  const seq = ++S.motionSaveSeq;
  const note = $('#motionSaved');
  try {
    const r = await api(`/api/jobs/${S.MOTION_JOB.id}/motion`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: S.MOTION }),
    });
    if (seq !== S.motionSaveSeq) return;
    if (note) note.textContent = r.count ? '已存' : '已清除';
  } catch (e) {
    if (seq !== S.motionSaveSeq) return;
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
    S.MOTION_PREVIEW = { lo: i, hi: i };   // 點下去就上色，不等放手
    drawMotion();
    ev.preventDefault();
  });
  document.addEventListener('mousemove', (ev) => {
    if (!dragging) return;
    const i = idxOf(ev.target);
    if (i == null || i === last) return;              // 同一格不重畫
    last = i;
    S.MOTION_PREVIEW = { lo: Math.min(anchor, i), hi: Math.max(anchor, i) };
    drawMotion();
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    S.MOTION_PREVIEW = null;               // 預覽讓位給下面真正套用的結果
    const lo = Math.min(anchor, last);
    const hi = Math.max(anchor, last);
    const m = S.MOTION[0];
    // 單點在已選範圍內＝取消；其餘一律取代（每支只有一段）
    if (m && lo === hi && lo >= m.startCharIdx && lo <= m.endCharIdx) S.MOTION = [];
    else S.MOTION = [{ ...(m && m.spec ? { spec: m.spec } : {}), startCharIdx: lo, endCharIdx: hi }];
    drawMotion();
    saveMotion();
  });
}
