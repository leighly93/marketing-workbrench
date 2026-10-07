// 字幕重點詞：純邏輯（合併、取消、覆蓋範圍）。畫面在 components/EmphasisBox.vue。

export const inPreview = (p, i) => !!p && i >= p.lo && i <= p.hi;

/** 這個字有沒有被標成重點 */
export function isEmph(list, i) {
  return list.some((m) => i >= m.startCharIdx && i <= m.endCharIdx);
}

/**
 * 加一段（跟相鄰的合併），或整段取消（點到已標的地方就是取消）。回傳新的清單，不改傳入的。
 * 跟伺服器 writeEmphasis／normalizeEmphasis 同一條合併規則 ——
 * 兩邊規則不一樣的話，「已標 N 處」在送出前後會跳號（實測過）。
 */
export function toggleEmph(list, lo, hi) {
  if (lo > hi) [lo, hi] = [hi, lo];
  // 取消只看「真的壓到」—— 用相鄰判斷的話，點旁邊一個沒標的字會把隔壁整段刪掉。
  const hit = list.filter((m) => !(m.endCharIdx < lo || m.startCharIdx > hi));
  if (hit.length && lo === hi) {
    // 單點擊在已標的字上 → 移除整段（整段拿掉比切成兩半直覺）
    return list.filter((m) => !hit.includes(m));
  }
  const near = list.filter((m) => !(m.endCharIdx < lo - 1 || m.startCharIdx > hi + 1));
  let a = lo, b = hi;
  for (const m of near) { a = Math.min(a, m.startCharIdx); b = Math.max(b, m.endCharIdx); }
  const out = list.filter((m) => !near.includes(m));
  out.push({ startCharIdx: a, endCharIdx: b });
  out.sort((x, y) => x.startCharIdx - y.startCharIdx);
  return out;
}

/**
 * 這些字元被哪一段配圖用到了（藍底線的來源）。
 * ⚠️ 來源由呼叫端給，不要在這裡猜 —— 三個階段手上有的東西不一樣：
 *    計畫頁是 `edits`（含還沒送出的修改）、標注頁是 ANNOTS、排隊階段只剩 planView.rows。
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

/** 伺服器回來的 marks 只留整數範圍。 */
export function cleanMarks(marks) {
  return (marks || [])
    .filter((m) => Number.isInteger(m.startCharIdx) && Number.isInteger(m.endCharIdx))
    .map((m) => ({ startCharIdx: m.startCharIdx, endCharIdx: m.endCharIdx }));
}

/** 把字元範圍還原成文字，給列表顯示 */
export function rangeText(chars, a) {
  if (!a || a.startCharIdx == null || !chars.length) return '（未指定範圍）';
  const lo = Math.min(a.startCharIdx, a.endCharIdx), hi = Math.max(a.startCharIdx, a.endCharIdx);
  const t = chars.filter((c) => c.i >= lo && c.i <= hi).map((c) => c.c).join('');
  return t || '（找不到這一段）';
}

/**
 * 自動列身上才有真的秒數（人工列是「秒數出片時算」）。拿它們回推一個字大約幾秒，
 * 「裁完剩下的會不會不到 1.4 秒」才講得出秒數。算不出來就 null，提示只講字數。
 */
export function charSecOf(rows) {
  let sec = 0, n = 0;
  for (const r of rows || []) {
    if (typeof r.start !== 'number' || typeof r.end !== 'number') continue;
    if (typeof r.startCharIdx !== 'number' || typeof r.endCharIdx !== 'number') continue;
    const chars = Math.abs(r.endCharIdx - r.startCharIdx) + 1;
    if (chars < 2 || r.end <= r.start) continue;
    sec += r.end - r.start; n += chars;
  }
  return n >= 8 ? sec / n : null;
}
