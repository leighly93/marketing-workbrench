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
    if (k === chars.length - 1 || !PUNCT_RE.test(ch)) return;
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
