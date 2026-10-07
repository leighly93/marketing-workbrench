// 腳本逐字選取（點子句／拖曳範圍）。

import { $, el } from './dom.js';
import { S } from './state.js';

// ── 逐字選取 ──────────────────────────────


/**
 * 「這個編輯器以外的段落，各自佔了哪些字」—— 逐字底線與「會蓋掉誰」共用這一支。
 * ⚠️ 兩個入口（手動標記的 ANNOTS／配圖計畫的 edits）一定要共用它。各寫一份的話兩邊會漂走，
 *    這專案已經被「同一套規則兩份實作」咬過好幾次（見 shot-memory.js、findCellIn 的註解）。
 * mine ＝同一張圖的其他段（畫虛線）；auto ＝自動排的那一列（它被人工段裁掉走的是另一條規則，
 * 所以提示的講法不一樣，見 drawRangeText）。
 */
export function usedRanges() {
  if (!S.edCtx) return [];
  const out = [];
  const push = (src, lo, hi, auto) => {
    if (typeof lo !== 'number' || typeof hi !== 'number') return;
    out.push({ src: src || '（未選圖）', lo: Math.min(lo, hi), hi: Math.max(lo, hi),
      mine: !!src && src === S.edCtx.src, auto: !!auto });
  };
  if (S.edCtx.mode === 'annot') {
    S.ANNOTS.forEach((a, k) => { if (k !== S.edCtx.k) push(a.src, a.startCharIdx, a.endCharIdx, false); });
  } else {
    Object.keys(S.edits).forEach((k) => {
      const e = S.edits[k];
      if (e === S.edCtx.e || e.deleted) return;
      push(e.src, e.startCharIdx, e.endCharIdx, !(e._manual || e._added || e._late));
    });
  }
  return out;
}

/** 同一個字被幾段佔到時算最後那一段的 —— 跟 resolveManualOverlaps() 的「後標的為主」同方向 */
export function ownerOf(used, i) {
  let own = null;
  for (const u of used) if (i >= u.lo && i <= u.hi) own = u;
  return own;
}

/** 1.4 秒（MIN_SHOT_SEC）大約是幾個字 —— 算不出秒數時用 8 個字當保守值 */
export function shortChars() {
  return S.CHAR_SEC ? Math.max(2, Math.ceil(1.4 / S.CHAR_SEC)) : 8;
}

export function drawRange() {
  const wrap = $('#edRange');
  if (!wrap) return;
  if (!S.CHARS.length) return wrap.replaceChildren(el('span', {}, '（腳本還在讀…）'));
  const a = S.edCtx.from, b = S.edCtx.to;
  const lo = a == null ? -1 : Math.min(a, b), hi = a == null ? -2 : Math.max(a, b);
  const used = usedRanges();
  const nodes = [];
  S.CHARS.forEach((c) => {
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
 * 「後標的為主」本來就是既有規則（`video/pipeline/script-utils.js` 的 `resolveManualOverlaps()`，
 * 2026-08-25 定案），但它是出片時才算、結果只寫在執行記錄的一行 log —— 同事在標的當下看不到，
 * 所以會發生「這張圖我明明標了，成品裡卻整張不見」。這裡只是把同一套區間相減先講出來。
 * ⚠️ 用 el() 一格一格 append，不要拼 innerHTML —— src 是同事上傳的檔名（見雷區：`html:` 與 XSS）。
 * ⚠️ 自動列走的是另一條規則（人工蓋自動 → 裁掉，被吃光時尾巴交給最後一個人工段接手，
 *    2026-08-18 定案），沒有「太短就丟掉」這回事，所以講法要分開，不要對它報假警。
 */
export function drawRangeText(lo, hi, used) {
  const box = $('#edRangeText');
  if (!box) return;
  if (lo < 0) return box.replaceChildren(el('div', {},
    '點一下選整句，或按住拖曳選任意範圍。再點一次取消。'));
  const txt = S.CHARS.filter((c) => c.i >= lo && c.i <= hi).map((c) => c.c).join('');
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
    const secs = S.CHAR_SEC ? `，約 ${(left * S.CHAR_SEC).toFixed(1)} 秒` : '';
    kids.push(el('div', { class: left < short ? 'ovr bad' : 'ovr' },
      `會蓋到 ${who}（${u.lo}–${u.hi}）→ 裁成 ${where}`
      + `（共 ${left} 個字${secs}）`
      + (left < short ? '，不到 1.4 秒 → 出片時會被丟掉，那一段也不會出現' : '')));
  });
  box.replaceChildren(...kids);
}

/** 這個字屬於哪個子句（點一下就選整句用的） */
export function clauseAt(i) {
  return S.UNITS.find((u) => u.startCharIdx != null && i >= u.startCharIdx && i <= u.endCharIdx);
}

{
  const idxOf = (t) => (t && t.dataset && t.dataset.i != null ? +t.dataset.i : null);
  let dragging = false, moved = false, anchor = null;
  const wrap = () => $('#edRange');
  document.addEventListener('mousedown', (ev) => {
    const w = wrap();
    if (!S.edCtx || !w || !w.contains(ev.target)) return;
    const i = idxOf(ev.target);
    if (i == null) return;
    dragging = true; moved = false; anchor = i;
    ev.preventDefault();
  });
  document.addEventListener('mousemove', (ev) => {
    if (!dragging || !S.edCtx) return;
    const i = idxOf(ev.target);
    if (i == null) return;
    if (i !== anchor) moved = true;
    S.edCtx.from = anchor; S.edCtx.to = i;
    drawRange();
  });
  document.addEventListener('mouseup', (ev) => {
    if (!dragging || !S.edCtx) return;
    dragging = false;
    if (moved) return;                     // 拖曳過 → 範圍已經在 mousemove 設好
    const i = anchor;
    const lo = S.edCtx.from == null ? -1 : Math.min(S.edCtx.from, S.edCtx.to);
    const hi = S.edCtx.from == null ? -2 : Math.max(S.edCtx.from, S.edCtx.to);
    const cl = clauseAt(i);
    if (i >= lo && i <= hi) { S.edCtx.from = null; S.edCtx.to = null; }   // 點已選中的 → 取消
    else if (cl) { S.edCtx.from = cl.startCharIdx; S.edCtx.to = cl.endCharIdx; }
    else { S.edCtx.from = i; S.edCtx.to = i; }
    drawRange();
  });
}


