// 字幕重點詞：選取、合併、存檔與畫面。

import { $, api, el } from './dom.js';
import { S } from './state.js';

// ── 字幕重點詞（2026-09-17）─────────────────


export const inPreview = (p, i) => !!p && i >= p.lo && i <= p.hi;

/** 這個字有沒有被標成重點 */
export function isEmph(i) {
  return S.EMPH.some((m) => i >= m.startCharIdx && i <= m.endCharIdx);
}

/** 加一段（跟相鄰的合併），或整段取消（點到已標的地方就是取消） */
export function toggleEmph(lo, hi) {
  if (lo > hi) [lo, hi] = [hi, lo];
  // 取消只看「真的壓到」—— 用相鄰判斷的話，點旁邊一個沒標的字會把隔壁整段刪掉。
  const hit = S.EMPH.filter((m) => !(m.endCharIdx < lo || m.startCharIdx > hi));
  if (hit.length && lo === hi) {
    // 單點擊在已標的字上 → 移除整段（整段拿掉比切成兩半直覺）
    S.EMPH = S.EMPH.filter((m) => !hit.includes(m));
    return;
  }
  // 新增時**連相鄰的一起併**，跟伺服器 writeEmphasis 同一條規則 ——
  // 兩邊規則不一樣的話，「已標 N 處」在送出前後會跳號（實測過）。
  const near = S.EMPH.filter((m) => !(m.endCharIdx < lo - 1 || m.startCharIdx > hi + 1));
  let a = lo, b = hi;
  for (const m of near) { a = Math.min(a, m.startCharIdx); b = Math.max(b, m.endCharIdx); }
  S.EMPH = S.EMPH.filter((m) => !near.includes(m));
  S.EMPH.push({ startCharIdx: a, endCharIdx: b });
  S.EMPH.sort((x, y) => x.startCharIdx - y.startCharIdx);
}

/**
 * 這些字元被哪一段配圖用到了（藍底線的來源）。跟編輯器的 usedRanges 不同：這裡看全部的段。
 * ⚠️ 來源由呼叫端給，不要在這裡猜 —— 三個階段手上有的東西不一樣：
 *    計畫頁是 `edits`（含還沒送出的修改）、標注頁是 ANNOTS、排隊階段只剩 planView.rows。
 *    以前這裡寫死讀 `edits`，換到別的階段就會拿到上一支工作的殘留。
 */
export function charsCoveredBy(list) {
  const set = new Set();
  for (const e of list || []) {
    if (!e || e.deleted) continue;
    const a = e.startCharIdx, b = e.endCharIdx;
    if (typeof a !== 'number' || typeof b !== 'number') continue;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(i);
  }
  return set;
}




/**
 * 存重點詞。跟標注一樣是「改了就存」，不再只靠按「確認，開始出片」那一下 ——
 * 準備中與排隊階段根本沒有那顆按鈕可以按。
 * ⚠️ 連續拖選會連續觸發，用序號擋掉亂序回來的舊回應（慢的那筆覆蓋快的那筆＝數字跳回去）。
 */
export async function saveEmph() {
  if (!S.EMPH_JOB) return;
  const seq = ++S.emphSaveSeq;
  const note = $('#emphSaved');
  try {
    const r = await api(`/api/jobs/${S.EMPH_JOB.id}/emphasis`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marks: S.EMPH }),
    });
    if (seq !== S.emphSaveSeq) return;
    if (note) note.textContent = r.count ? `已存 ${r.count} 處` : '已清除';
  } catch (e) {
    if (seq !== S.emphSaveSeq) return;
    if (note) note.textContent = '存不進去：' + e.message;
  }
}

export function drawEmph() {
  const wrap = $('#emphRange');
  if (!wrap) return;
  if (!S.CHARS.length) return wrap.replaceChildren(el('span', {}, '（腳本還在讀…）'));
  const covered = charsCoveredBy(S.EMPH_COVERED());
  const nodes = [];
  S.CHARS.forEach((c) => {
    const cls = [];
    if (covered.has(c.i)) cls.push('used');          // 藍底線＝這裡已經有圖
    if (inPreview(S.EMPH_PREVIEW, c.i)) cls.push('sel');  // 藍底＝正在拖、還沒放手
    else if (isEmph(c.i)) cls.push('emph');          // 黃＝標成重點詞
    if (c.b) cls.push('br');
    nodes.push(el('i', { 'data-e': c.i, class: cls.join(' ') }, c.c));
    if (c.p) nodes.push(el('br', { class: 'para' }));
  });
  wrap.replaceChildren(...nodes);
  const n = $('#emphCount');
  if (n) n.textContent = S.EMPH.length ? `已標 ${S.EMPH.length} 處` : '尚未標記';
  const btn = $('#emphClear');
  if (btn) { btn.disabled = !S.EMPH.length; btn.style.opacity = S.EMPH.length ? 1 : 0.35; }
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
    S.EMPH_PREVIEW = { lo: i, hi: i };     // 點下去就上色，不等放手
    drawEmph();
    ev.preventDefault();
  });
  document.addEventListener('mousemove', (ev) => {
    if (!dragging) return;
    const i = idxOf(ev.target);
    if (i == null || i === last) return;              // 同一格不重畫
    last = i;
    S.EMPH_PREVIEW = { lo: Math.min(anchor, i), hi: Math.max(anchor, i) };
    drawEmph();
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    S.EMPH_PREVIEW = null;                 // 預覽讓位給下面真正套用的結果
    toggleEmph(anchor, last);
    drawEmph();
    saveEmph();
  });
}

