// @ts-nocheck —— 原樣搬過來，型別之後逐步補
'use strict';

// ── --suggest-cells：只回答「這一句、這張圖，系統原本會框哪裡」 ─────────────
// 2026-08-26 使用者定案：「我故意不畫黃框就是不要，不要幫我加上去；最終影片顯示要照人手工框的，
// 自動的部分一樣要做但是要記錄到修正紀錄裡。」成品的框改成一律照人工畫的
//（server/index.js 的 applyPlanEdits() 不再補框），「系統原本會怎麼圈」就由這個模式算給
// 修正紀錄看。跟 2026-08-25「人工沒標就不要出現、自動判定只進修正紀錄」是同一條規則，
// 只是層級從「段落」下到「框」。
// 伺服器用 spawn 一次 auto-shot.js --suggest-cells 來問（跟對照組 --no-annots 同一個模式：spawn、寫檔、讀檔），
// 這樣讀到的是 auto-shot 同一套全域知識，而且記憶庫是「還沒學這一支」的版本。
// 挑框規則只有 matcher.js 一份實作，這裡與排計畫共用。
// 輸入檔：[{ src, startCharIdx, endCharIdx }, ...]
// 輸出檔：同樣的筆數，附上系統會框的位置、框到什麼字、以及是哪一條規則命中的。

/**
 * @param {Array<{ src: string, startCharIdx: number, endCharIdx: number }>} want
 * @param {{ imgs: any[], origPhrase: Function, matcher: { findCell: Function, findNamedRow: Function } }} ctx
 */
function suggestCells(want, { imgs, origPhrase, matcher }) {
  const { findCell, findNamedRow } = matcher;
  // 是哪一條規則命中的 —— 從 cellText 反推（findCell 的每一條分支都給了不同的字樣）。
  // 刻意不在 findCell 裡加欄位：那個回傳物件會被展開進計畫檔，多一個欄位就會改變出片內容。
  const ruleOf = (t) => (!t ? '規則庫的區域定義'
    : /你標過的位置/.test(t) ? '記憶庫（你標過的同型頁面）'
    : /（整列）$/.test(t) ? '旁白點名的那一列'
    : /（框股名）|（頁面標題→滑動）/.test(t) ? '頁面標題（找不到更具體目標時的退路）'
    : /%/.test(t) ? '圖上的漲跌幅'
    : /^[\d,.]+$/.test(t) ? '圖上的數字'
    : '規則庫的區域定義');
  const out = (Array.isArray(want) ? want : []).map((q) => {
    const lo = Math.min(q.startCharIdx, q.endCharIdx), hi = Math.max(q.startCharIdx, q.endCharIdx);
    const text = origPhrase(lo, hi);
    const img = imgs.find((m) => m.file === q.src);
    if (!img) return { src: q.src, startCharIdx: lo, endCharIdx: hi, phrase: text,
      cell: null, cellText: null, why: '這張圖沒有分析資料（沒跑過 analyze:app-images？）' };
    const pick = findCell(text, img, findNamedRow(text, img));
    return {
      src: q.src, startCharIdx: lo, endCharIdx: hi, phrase: text,
      cell: pick && pick.cell ? pick.cell : null,
      cellText: pick ? (pick.cellText || null) : null,
      isColumn: !!(pick && pick.isColumn),
      why: pick && pick.cell ? ruleOf(pick.cellText) : '系統也找不到可框的目標（會整張顯示）',
      imageWidth: img.width, imageHeight: img.height, page: img.page,
    };
  });
  return out;
}

module.exports = { suggestCells };
