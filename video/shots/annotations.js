// @ts-nocheck —— 原樣搬過來，型別之後逐步補
'use strict';

/**
 * 前台標注頁的人工標注（public/annotations.json 的 shots）→ 配圖計畫的人工段落（純函式）。
 * 跟稿件手寫的 (shot:) 標記同一個地位：被標到的句子，自動判定完全不碰。
 * 標注多帶了「框在哪」「顯示區域」「箭頭」，手寫標記做不到這些。
 */
const { pickImageSize } = require('./image-size');

/**
 * @param {any[]} ann annotations.json 的 shots
 * @param {{ imgs: any[], unitList: any[], sentenceList: any[], toCleaned: Function, origPhrase: Function }} ctx
 * @returns {any[]} 人工段落（_manual、_annotated）
 */
function annotationsToManual(ann, { imgs, unitList, sentenceList, toCleaned, origPhrase }) {
  const manual = [];
  /**
   * 標注帶來的箭頭（2026-09-16）：兩個端點都要是數字、長度不能是 0。
   * ⚠️ 只有箭頭、沒框沒區域的標注仍舊是 `wholePage: true`（圖片擺法不變）——
   *    渲染端 src/ShotFocus.tsx 對「wholePage ＋ 有箭頭」的段落特別放行。
   */
  const arrowOf = (a) => (a && a.arrow
    && [a.arrow.x1, a.arrow.y1, a.arrow.x2, a.arrow.y2]
      .every((n) => typeof n === 'number' && Number.isFinite(n))
    && Math.hypot(a.arrow.x2 - a.arrow.x1, a.arrow.y2 - a.arrow.y1) > 0 ? a.arrow : null);
  for (const a of ann) {
    if (!a.src) continue;
    // 範圍：新格式用 from/to 指子句範圍；舊格式 sentence 指整句（往後相容）
    // 新格式：直接給清洗後的字元索引（前台拖選文字得到的），最精準
    if (typeof a.startCharIdx === 'number' && typeof a.endCharIdx === 'number') {
      const img0 = imgs.find((m) => m.file === a.src) || {};
      const size0 = pickImageSize(img0, a);
      const hasCell0 = a.cell && a.cell.w > 0;
      const hasRegion0 = a.region && a.region.w > 0;
      manual.push({
        src: a.src,
        startCharIdx: Math.min(a.startCharIdx, a.endCharIdx),
        endCharIdx: Math.max(a.startCharIdx, a.endCharIdx),
        phrase: origPhrase(Math.min(a.startCharIdx, a.endCharIdx),
          Math.max(a.startCharIdx, a.endCharIdx)),
        _manual: true, _annotated: true,
        // ⚠️ imageWidth/Height 一定要有值，否則 ShotFocus.tsx 會退成「整張顯示」——
        //    使用者圈的框靜默失效。工作送出後才補上傳的截圖沒進 app-images.generated.json
        //    （那支分析是在 doPrepare 一開頭跟 HeyGen 平行跑的），所以退到標注自己
        //    量到的原圖尺寸（前台存的是 img.naturalWidth/Height）。2026-09-01
        // ⚠️ 2026-09-14：補上傳的圖照 shot<N> 命名，很容易跟**上一支工作**的同名圖撞名 ——
        //    那時 img0 查得到，尺寸卻是別張圖的，框會整塊位移＋縮放（使用者回報「8月營收／
        //    大戶狂賣／散戶 顯示區域框錯」）。標注自帶的尺寸必定屬於這支工作，一律優先。
        page: size0.stale ? undefined : img0.page,
        imageWidth: size0.width,
        imageHeight: size0.height,
        ...(hasCell0 ? { cell: a.cell, cellText: '人工黃框', isColumn: false } : {}),
        ...(hasRegion0 ? { region: a.region } : {}),
        ...(arrowOf(a) ? { arrow: arrowOf(a) } : {}),
        ...(!hasCell0 && !hasRegion0 ? { wholePage: true } : {}),
      });
      continue;
    }
    // 舊格式：子句範圍 / 整句
    let bodyStart, bodyEnd;
    if (typeof a.from === 'number' && typeof a.to === 'number') {
      const u0 = unitList.find((u) => u.i === Math.min(a.from, a.to));
      const u1 = unitList.find((u) => u.i === Math.max(a.from, a.to));
      if (!u0 || !u1) continue;
      bodyStart = u0.start; bodyEnd = u1.end;
    } else {
      const sent = sentenceList.find((x) => x.i === a.sentence);
      if (!sent) continue;
      bodyStart = sent.start; bodyEnd = sent.end;
    }
    const r = toCleaned(bodyStart, bodyEnd);
    if (!r) continue;
    const img = imgs.find((m) => m.file === a.src) || {};
    const size = pickImageSize(img, a);
    const hasCell = a.cell && a.cell.w > 0;
    const hasRegion = a.region && a.region.w > 0;
    manual.push({
      src: a.src,
      ...r,
      _manual: true,
      _annotated: true,
      page: size.stale ? undefined : img.page,
      // 同上：沒被分析過的圖退到標注自帶的尺寸（2026-09-01）；
      // 撞到舊工作同名分析時也以標注為準（2026-09-14，見上一段說明）
      imageWidth: size.width,
      imageHeight: size.height,
      // ⚠️ cell（黃框）與 region（顯示區域）是兩件事，可以各自存在或都不存在。
      // 都沒給 → wholePage，整張顯示。
      ...(hasCell ? { cell: a.cell, cellText: '人工黃框', isColumn: false } : {}),
      ...(hasRegion ? { region: a.region } : {}),
      ...(arrowOf(a) ? { arrow: arrowOf(a) } : {}),
      ...(!hasCell && !hasRegion ? { wholePage: true } : {}),
    });
  }
  return manual;
}

module.exports = { annotationsToManual };
