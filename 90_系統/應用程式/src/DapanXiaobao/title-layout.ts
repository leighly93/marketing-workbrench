/**
 * 右側面板標題的排版（2026-11-12 使用者：「標題文字你也能放得好嗎？自動判斷第一句白色第二句黃色？」）。
 * 起因：「盤中翻紅尾盤跌掉 800 點」一行太長，瀏覽器自己換行把「點」單獨擠到第二行，顏色也跟著亂。
 *
 * 規則：
 *   1. 稿件標題段有換行 → 照換行分句（第一句白、其餘黃，配色在元件裡）。
 *   2. 只有一行且太長 → 在最靠近中間的標點後面拆成兩句；沒有標點就不拆（不在字詞中間硬切）。
 *      空白不當切點：「跌掉 800 點」的空白夾在數字旁邊，切了會把「800」跟「點」拆開。
 *   3. 每一句固定一行不換行，最長那句放不下就整組一起縮字級（不會只縮其中一句）。
 * 字寬用估的（沒有量字套件，不為這個加依賴）：中文／全形 1em、英數 0.62em、空白 0.3em。
 */

const PUNCT_RE = /[，。！？、：；,!?:;]/;

/** 第 k 個字是能切的標點：數字裡的千分位逗號、小數點不算（「2,548」「1.69」） */
function isCutPunct(chars: string[], k: number): boolean {
  const ch = chars[k];
  if (!PUNCT_RE.test(ch)) return false;
  if (/[,.:]/.test(ch) && /\d/.test(chars[k - 1] || '') && /\d/.test(chars[k + 1] || '')) return false;
  return true;
}

function charEm(ch: string): number {
  if (/\s/.test(ch)) return 0.3;
  if (/[\u0000-ÿ]/.test(ch)) return 0.62;
  return 1;
}

export function textEm(text: string): number {
  let w = 0;
  for (const ch of text) w += charEm(ch);
  return w;
}

/** 只有一行而且超過 maxEm 才拆；切在最靠近中間的標點後面 */
export function splitTitle(title: string, maxEm = 9): string[] {
  const lines = title.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length !== 1) return lines;
  const line = lines[0];
  if (textEm(line) <= maxEm) return lines;
  const chars = [...line];
  const total = textEm(line);
  let best = -1;
  let bestDist = Infinity;
  let acc = 0;
  chars.forEach((ch, k) => {
    acc += charEm(ch);
    if (k === chars.length - 1 || !isCutPunct(chars, k)) return;
    const d = Math.abs(acc - total / 2);
    if (d < bestDist) { bestDist = d; best = k; }
  });
  if (best < 0) return lines;
  // 逗號類切完就不用留在行尾；問號、驚嘆號是語氣，留著
  const a = chars.slice(0, best + 1).join('').trim().replace(/[，、：；,:;]$/, '');
  const b = chars.slice(best + 1).join('').trim();
  return a && b ? [a, b] : lines;
}

/** 最長那句塞進 maxWidthPx 的字級（不超過 baseSize）；italic 與描邊多留 8% */
export function fitTitleSize(lines: string[], maxWidthPx: number, baseSize: number): number {
  const widest = Math.max(0, ...lines.map(textEm));
  if (!widest) return baseSize;
  return Math.min(baseSize, Math.floor(maxWidthPx / (widest * 1.08)));
}

/**
 * 一句太長就在畫面上折成兩行（2026-11-12 7eov：「只差 80 點！台股收盤險守「修正線」，」17 個字，
 * 整組被縮到約 37px，使用者：「標題字太小了！放大再放大但不要太超過」）。
 * 只改「怎麼排」，不改字、不改顏色：回傳每一個畫面行與它屬於第幾句（第幾句決定白／黃）。
 * 切點：最靠近中間的標點後面（，、：；留在原句尾就去掉）；沒有標點就切在最靠近中間、不在數字或英文中間的字之間。
 * 一句最多折一次（兩行），避免碎成一字一行。
 */
const TRIM_END_RE = /[，、：；,:;]$/;
const WORDISH_RE = /[0-9A-Za-z.,%]/;

function cutOnce(line: string): [string, string] | null {
  const chars = [...line];
  const total = textEm(line);
  let best = -1;
  let bestScore = Infinity;
  let acc = 0;
  chars.forEach((ch, k) => {
    acc += charEm(ch);
    if (k === chars.length - 1) return;
    const next = chars[k + 1];
    const isPunct = isCutPunct(chars, k);
    // 不切在數字／英文中間，不讓「開括號」留在行尾、「閉括號」跑到行首
    if (!isPunct && (WORDISH_RE.test(ch) && WORDISH_RE.test(next))) return;
    if (/[「『（(]/.test(ch) || /[」』）)，。！？、：；]/.test(next)) return;
    const d = Math.abs(acc - total / 2);
    const score = isPunct ? d : d + total * 0.2; // 標點優先，除非離中間太遠
    if (score < bestScore) { bestScore = score; best = k; }
  });
  if (best < 0) return null;
  const a = chars.slice(0, best + 1).join('').trim().replace(TRIM_END_RE, '');
  const b = chars.slice(best + 1).join('').trim();
  return a && b ? [a, b] : null;
}

export function wrapTitleLines(lines: string[], maxEm: number): { text: string; group: number }[] {
  const out: { text: string; group: number }[] = [];
  lines.forEach((line, group) => {
    const clean = line.trim().replace(TRIM_END_RE, '');
    const parts = textEm(clean) > maxEm ? cutOnce(clean) : null;
    for (const t of parts || [clean]) out.push({ text: t, group });
  });
  return out;
}
