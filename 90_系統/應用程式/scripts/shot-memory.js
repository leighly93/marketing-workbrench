/**
 * 「你教過的東西」記憶庫 —— 90_系統/資料/shot-memory.json。
 *
 * 由來（2026-08-21 使用者要求）：「這次標給你看，下次你會記得又遇到同樣這頁，
 * 要標一樣位置。」修正紀錄（90_系統/資料/corrections.jsonl）只是給人看的日記，
 * 出片流程一行都沒讀它；這一份才是真的會被 auto-shot.js 回頭讀進去的。
 *
 * 記兩種東西：
 *   codeNames  代號 ↔ 股名。官方簡稱表（90_系統/資料/stock-names.json）打底，這裡是你的覆寫 ——
 *              口語講法跟官方簡稱不一樣（或官方表還沒收錄）時，你標一次就記住。
 *   pages      同一種版面「框在哪」。存**比例座標**（除以圖寬高），換機型、換解析度都對得上。
 *
 * ⚠️ memKeyOf() 與 mergeRuns() 是前台（server 寫入）與 auto-shot（讀取）共用的。
 *    兩邊各寫一份遲早會漂走 —— 所以放在這個模組，兩邊都 require 它。
 */
const fs = require('fs');
const path = require('path');
const { dataPath } = require('../../paths');

const FILE = (root) => dataPath(root, 'shot-memory.json');

/**
 * 怎麼算「同一種頁面」。
 * 認得出頁型就用頁型（最泛化：換股票、換日期都算同一種）；
 * 認不出來（unknown）就退成「是不是個股頁 × 長寬比」—— 實測個股 K 線頁彼此的
 * OCR 相似度 0.33~0.43、對其他頁型 ≤0.09，這個粗分類分得開。
 * 長寬比放進鍵裡，是因為不同機型的版面配置本來就不一樣，不該共用同一個框。
 */
function memKeyOf(img) {
  if (!img) return null;
  const w = img.width || img.imgW, h = img.height || img.imgH;
  if (!w || !h) return null;
  const shape = (w / h).toFixed(2);
  if (img.page && img.page !== 'unknown') return `${img.page}@${shape}`;
  return `unknown-${img.stockCode ? 'stock' : 'other'}@${shape}`;
}

/**
 * 把同一列、水平相鄰的 OCR 字框合併成「詞」。
 * tesseract 會把「南亞科」拆成「南亞」+「科」、「加權指數」拆成四個單字框，
 * 不合併就永遠比對不到旁白（2026-08-21 實測：7 張截圖全部因此配不到句子）。
 * 分行用「垂直重疊比例」不是「中心點距離」—— 分頁籤那種又寬又扁的框（實測「電子」
 * 的框寬 226px 橫跨整條頁籤列）會把中心點判斷帶歪，把上下兩列黏成一列。
 */
function mergeRuns(words) {
  const ws = (words || []).filter((w) => w.t && w.h > 0).slice()
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const w of ws) {
    const ln = lines.find((L) => {
      const ov = Math.min(L.y + L.h, w.y + w.h) - Math.max(L.y, w.y);
      return ov > Math.min(L.h, w.h) * 0.6 && Math.max(L.h, w.h) / Math.min(L.h, w.h) < 2.2;
    });
    if (ln) {
      const bottom = Math.max(ln.y + ln.h, w.y + w.h);
      ln.items.push(w); ln.y = Math.min(ln.y, w.y); ln.h = bottom - ln.y;
    } else lines.push({ y: w.y, h: w.h, items: [w] });
  }
  const runs = [];
  for (const L of lines) {
    L.items.sort((a, b) => a.x - b.x);
    let cur = null;
    for (const w of L.items) {
      const charW = w.w / Math.max(1, [...w.t].length);
      const gap = cur ? w.x - (cur.x + cur.w) : Infinity;
      if (cur && gap <= charW * 0.8 && gap > -charW) {
        const bottom = Math.max(cur.y + cur.h, w.y + w.h);
        cur.t += w.t;
        cur.w = Math.max(cur.x + cur.w, w.x + w.w) - cur.x;
        cur.y = Math.min(cur.y, w.y); cur.h = bottom - cur.y;
        cur.c = Math.min(cur.c, w.c);
        cur.parts.push(w);
      } else {
        if (cur) runs.push(cur);
        cur = { t: w.t, x: w.x, y: w.y, w: w.w, h: w.h, c: w.c, parts: [w] };
      }
    }
    if (cur) runs.push(cur);
  }
  return runs;
}

function read(root) {
  try {
    const m = JSON.parse(fs.readFileSync(FILE(root), 'utf-8'));
    return { codeNames: m.codeNames || {}, pages: m.pages || {}, pagesMulti: m.pagesMulti || {} };
  } catch (_) { return { codeNames: {}, pages: {}, pagesMulti: {} }; }
}

/**
 * 把這一支影片的人工標注學進來。
 *
 * @param root  專案根目錄
 * @param items [{ src, cell, region, imgW, imgH, phrase }]  人工框過的段落（比例換算前的原圖像素）
 * @param imgs  src/app-images.generated.json 的 images（拿 page / stockCode / 尺寸）
 * @param at    ISO 時間字串
 * @returns     { learnedPages: [...], learnedNames: {...} } 給執行記錄印出來用
 */
function learn(root, items, imgs, at) {
  const mem = read(root);
  // 官方簡稱表（npm run stocks 抓的）。已經有的代號不自動覆蓋。
  let official = {};
  try { official = JSON.parse(fs.readFileSync(dataPath(root, 'stock-names.json'), 'utf-8')); } catch (_) {}
  const byFile = {};
  for (const im of imgs || []) byFile[im.file] = im;
  const learnedPages = [];
  const learnedNames = {};

  for (const it of items || []) {
    const im = byFile[it.src];
    if (!im) continue;
    const W = im.width || it.imgW, H = im.height || it.imgH;
    if (!W || !H) continue;

    // ① 代號 ↔ 股名：這一段旁白點名的股票，就是這張圖那個代號的股票。
    //    ⚠️ 學錯一筆，之後每一支影片都會配錯圖，所以要**兩邊都對得上**才學：
    //      (a) 名字出現在旁白開頭（「南亞科大漲逾7%」的股名在最前面）
    //      (b) 這個名字真的印在這張圖上（合併字框後比對）
    //    只用 (a) 的話「南亞科大漲逾7%」會學成「南亞科大」—— 第一版就是這樣錯的。
    //    官方簡稱表已經有的代號一律不覆蓋，避免自動猜的東西蓋掉正確答案。
    if (im.stockCode && it.phrase && !official[im.stockCode] && !mem.codeNames[im.stockCode]) {
      const ocr = mergeRuns(im.words).map((r) => r.t).join('\u0000');
      const head = (it.phrase.match(/^[一-鿿]{2,4}/) || [])[0] || '';
      for (let len = head.length; len >= 2; len--) {
        const nm = head.slice(0, len);
        if (!ocr.includes(nm)) continue;
        mem.codeNames[im.stockCode] = nm;
        learnedNames[im.stockCode] = nm;
        break;
      }
    }

    // ② 這一種頁面「框在哪」。存比例座標。
    if (!it.cell || !(it.cell.w > 0)) continue;
    const key = memKeyOf({ ...im, imgW: W, imgH: H });
    if (!key) continue;
    const F = (b) => (b && b.w > 0
      ? { x: +(b.x / W).toFixed(4), y: +(b.y / H).toFixed(4), w: +(b.w / W).toFixed(4), h: +(b.h / H).toFixed(4) }
      : null);
    const prev = mem.pages[key];
    mem.pages[key] = {
      cell: F(it.cell),
      region: F(it.region),
      label: (it.phrase || '').slice(0, 10) || (prev && prev.label) || '你標過的位置',
      at,
      n: (prev && prev.n ? prev.n : 0) + 1,
    };
    // 2026-09-03 多筆歷史（pagesMulti）：上面 pages[key] 是「覆寫」，教 14 次只剩最後 1 個框 ——
    // 同一種頁面講「櫃買也漲1.6%」和「加權漲214點」該框不同地方，一個框裝不下。
    // 這裡永遠追加（純資料，不影響 v1 讀取端）；auto-shot 端 SHOT_MEMORY=multi 才會拿它來挑框。
    // 同一個框（比例座標四捨五入後相同）合併成一筆、把旁白句累積進 phrases，才知道「這個框是講哪些話時用的」。
    if (!mem.pagesMulti) mem.pagesMulti = {};
    const cellF = F(it.cell), regionF = F(it.region);
    const list = (mem.pagesMulti[key] = mem.pagesMulti[key] || []);
    const same = (a, b) => a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
    let hit = list.find((e) => same(e.cell, cellF));
    if (!hit) { hit = { cell: cellF, region: regionF, phrases: [], hits: 0, at }; list.push(hit); }
    if (it.phrase && !hit.phrases.includes(it.phrase)) hit.phrases.push(it.phrase);
    if (hit.phrases.length > 12) hit.phrases = hit.phrases.slice(-12);
    hit.hits += 1; hit.at = at; if (regionF) hit.region = regionF;
    if (list.length > 40) list.splice(0, list.length - 40);   // 每個頁型最多留 40 個不同的框
    learnedPages.push(key);
  }

  if (!learnedPages.length && !Object.keys(learnedNames).length) return { learnedPages, learnedNames };
  fs.mkdirSync(path.dirname(FILE(root)), { recursive: true });
  fs.writeFileSync(FILE(root), JSON.stringify(mem, null, 2) + '\n');
  return { learnedPages: [...new Set(learnedPages)], learnedNames };
}

/**
 * 從多筆歷史裡挑「這一句旁白」最像的那個框。
 * 分數 = 共有的中文雙字組數 + 3 × 共有的數字（3 位以上）。分數 < 2 視為沒有夠像的，回 null 讓呼叫端退回 pages[key]。
 * 為什麼用雙字組而不是整句比對：旁白每天換數字換股票，「櫃買也漲1.6%」跟「櫃買反彈1.34%」整句對不上，但「櫃買」對得上。
 * @returns { cell, region, phrase, hits, total } | null
 */
function pickForPhrase(pagesMulti, key, text) {
  const list = pagesMulti && key && pagesMulti[key];
  if (!list || !list.length || !text) return null;
  const cn = (t) => String(t).replace(/[^一-鿿]/g, '');
  const grams = (t) => { const g = new Set(); const c = cn(t); for (let i = 0; i + 2 <= c.length; i++) g.add(c.slice(i, i + 2)); return g; };
  // 數字用「數值」比對（1.6 與 1.60 要算同一個），至少 2 位數字（避免「7%」這種太短的亂配）
  const nums = (t) => (String(t).match(/\d[\d,]*(?:\.\d+)?/g) || []).map((n) => n.replace(/,/g, ''))
    .filter((n) => n.replace('.', '').length >= 2).map(Number).filter((v) => isFinite(v) && v > 0);
  const G = grams(text), N = nums(text), head = cn(text).slice(0, 2);
  const scoreOf = (ph) => {
    let s = 0;
    for (const g of grams(ph)) if (G.has(g)) s += 1;
    // 兩句開頭兩個字相同（「櫃買…」「加權…」「南亞科…」）→ 講的是同一個主體，額外加分
    if (head && head.length === 2 && cn(ph).slice(0, 2) === head) s += 2;
    for (const a of nums(ph)) if (N.some((b) => Math.abs(a - b) / Math.max(a, b) <= 0.02)) s += 3;
    return s;
  };
  const ranked = list.map((e) => {
    let sc = 0, bp = '';
    for (const ph of e.phrases || []) { const s = scoreOf(ph); if (s > sc) { sc = s; bp = ph; } }
    return { e, sc, bp };
  }).sort((a, b) => b.sc - a.sc);
  const top = ranked[0], second = ranked[1];
  // 門檻 2，而且要贏第二名（平手代表分不出來，寧可退回 v1 的單筆行為）
  if (!top || top.sc < 2 || (second && second.sc === top.sc)) return null;
  return { cell: top.e.cell, region: top.e.region, phrase: top.bp, hits: top.e.hits,
           total: list.reduce((a, e) => a + (e.hits || 0), 0) };
}

module.exports = { memKeyOf, mergeRuns, read, learn, pickForPhrase, FILE };
