// @ts-check
'use strict';

/**
 * 配圖判定用的全域知識：規則庫的頁面關鍵字、股票代號↔簡稱、你教過的記憶。
 * 讀檔交給呼叫端（auto-shot.js）；這裡只把資料整理成判定要用的形狀。
 */

// 頁面類型 → 旁白裡可能出現的字眼。
// ⚠️ 單一來源：直接由規則庫 video/shots/app-locators.json 的 regions 推導，
// 不再另外維護一份。（2026-08-12 踩到：兩份清單沒同步，改了規則庫卻沒生效。）
/** @param {Record<string, Array<{ keywords?: string[] }>>} regions */
function buildPageKeywords(regions) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const [page, list] of Object.entries(regions || {})) {
    const set = new Set();
    for (const rg of list) (rg.keywords || []).forEach((k) => set.add(k));
    out[page] = [...set];
  }
  return out;
}

/**
 * 股名表＝官方簡稱（storage/data/stock-names.json）＋你標過的口語寫法（記憶庫 codeNames，優先）。
 * 官方簡稱清單拿來判斷「旁白這幾個字是不是一檔股票」—— 一定要用這份表，不可以拿圖上任意文字去比對：
 * 圖上一定找得到「電子」「討論」這種介面字，會讓每張圖都命中（2026-08-17 的老教訓）。
 * @param {Record<string, string>} stockNames
 * @param {Record<string, string>} memoryCodeNames
 */
function buildStockNames(stockNames, memoryCodeNames) {
  const codeName = { ...stockNames, ...memoryCodeNames };
  const list = [...new Set(Object.values(codeName))]
    .filter((n) => n && n.length >= 2)
    .sort((a, b) => b.length - a.length);
  return { codeName, list };
}

/**
 * 個股頁的股名補齊（OCR 讀得到代號、股名常被切碎）＋指數頁的口語別名（「加權指數」也要被「加權」命中）。
 * 直接修改圖片資料。
 * @param {any[]} imgs app-images.generated.json 的 images
 * @param {Record<string, string>} codeName
 */
function enrichImages(imgs, codeName) {
  for (const im of imgs) {
    if (im.stockCode && codeName[im.stockCode]) {
      const nm = codeName[im.stockCode];
      if (!im.stockName) { im.stockName = nm; im._nameFromCode = true; }
      else if (im.stockName !== nm)
        im.stockNameAlts = [...new Set([...(im.stockNameAlts || []), nm])];
    }
    if (im.stockName && /指數$/.test(im.stockName) && im.stockName.length > 3)
      im.stockNameAlts = [...new Set([...(im.stockNameAlts || []), im.stockName.replace(/指數$/, '')])];
  }
}

module.exports = { buildPageKeywords, buildStockNames, enrichImages };
