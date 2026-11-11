/**
 * 大盤小報明體字幕的兩條自動規則（2026-11-11 使用者確認「都照建議做」）。
 * 純函式，不碰 React / Remotion，測試在 90_系統/測試/明體字幕規則.test.js。
 *
 * ① 重點詞顏色（台股慣例）：重點詞本身＋前 4 字、後 2 字裡
 *    有上漲字眼 → 紅；有下跌字眼 → 綠；兩種都有或都沒有 → 金。
 *    判錯時寧可退回金色，不要標成相反的顏色。
 * ② 金色底線：整支最多 6 句；有數字的重點詞優先，同級照時間先後；
 *    兩條底線的句首至少隔 8 秒（使用者嫌底線「出現太多次」）。
 */

export type SerifTone = 'gold' | 'red' | 'green';

export const UP_WORDS = ['漲', '增', '買超'];
export const DOWN_WORDS = ['跌', '減', '賣超', '虧'];
const BEFORE = 4;
const AFTER = 2;

/** `text` 裡 [start, end) 這段重點詞該用什麼顏色 */
export function toneFor(text: string, start: number, end: number): SerifTone {
  const win = text.slice(Math.max(0, start - BEFORE), Math.min(text.length, end + AFTER));
  const up = UP_WORDS.some((w) => win.includes(w));
  const down = DOWN_WORDS.some((w) => win.includes(w));
  if (up && !down) return 'red';
  if (down && !up) return 'green';
  return 'gold';
}

export const UNDERLINE_MAX = 6;
export const UNDERLINE_GAP_SEC = 8;

/**
 * 挑出要畫底線的句子（回傳 phrases 的索引）。
 * `hl` 是那一句被標成重點詞的文字（沒有就是空陣列）。
 */
export function pickUnderlines(
  phrases: { start: number; hl: string[] }[],
  max = UNDERLINE_MAX,
  gapSec = UNDERLINE_GAP_SEC,
): Set<number> {
  const candidates = phrases
    .map((p, i) => ({ i, start: p.start, digit: p.hl.some((t) => /\d/.test(t)) }))
    .filter((c) => phrases[c.i].hl.length > 0)
    .sort((a, b) => (a.digit === b.digit ? a.start - b.start : a.digit ? -1 : 1));
  const picked: { i: number; start: number }[] = [];
  for (const c of candidates) {
    if (picked.length >= max) break;
    if (picked.some((p) => Math.abs(p.start - c.start) < gapSec)) continue;
    picked.push(c);
  }
  return new Set(picked.map((p) => p.i));
}
