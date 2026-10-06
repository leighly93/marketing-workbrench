// @ts-nocheck —— 原樣搬過來，型別之後逐步補
'use strict';

/**
 * 稿件 → 配圖要用的單位（純函式）。
 *   clauses   子句：句號、逗號、頓號等都切；配圖逐子句判定
 *   sentences 句子：依句號聚合子句，前台標注頁以句子編號存（舊格式）
 *   units     子句清單＋清洗後字元索引，前台「拉範圍」用
 *   chars     逐字清單，前台拖選文字用
 *   marks     稿件裡手寫的 (shot:)／(imageN) 標記（人決定的段落，自動判定不碰）
 * 座標系一律是「發音替換後、清洗過」的字元索引（跟字幕時間軸同一套）；要讀內容一律取原稿的字。
 */
const { getBodyWithVoiceMap, cleanBodyWithIndex } = require('../pipeline/script-utils');

/** @param {string} raw script.txt 全文 */
function analyzeScript(raw) {
  // ⚠️ body 是「發音替換後」的字串，只拿來當**座標系**用（字元索引、(shot:) 標記位置、
  //    斷句位置都必須跟字幕時間軸同一套）。凡是要「讀內容」的地方一律走 origSlice()／origPhrase()
  //    拿原稿的字 —— 共用發音詞庫裡有一堆股名與產業詞（萬海→one海、DRAM→滴RAM、NAND→name的），
  //    判定吃到替換後的字就比不到圖上的目標，而且是靜默失效：圖照配，只是配錯或配不到。
  //    （2026-09-11 使用者指出：「auto-shot 的配圖判定應該要吃原腳本才對」）
  const { body, origSlice, origChars } = getBodyWithVoiceMap(raw);
  const cleaned = cleanBodyWithIndex(body);
  const map = new Map();
  cleaned.forEach((c, i) => map.set(c.origIdx, i));
  /**
   * 清洗後字元索引 [lo, hi] → 原稿的那段字（同樣清洗過：去標記、去標點、去空白）。
   * 刻意再呼叫一次 cleanBodyWithIndex 而不是自己過濾 —— 清洗規則只能有一份。
   */
  function origPhrase(lo, hi) {
    const a0 = (cleaned[lo] || {}).origIdx;
    const b0 = (cleaned[hi] || {}).origIdx;
    if (a0 == null || b0 == null) return '';
    return cleanBodyWithIndex(origSlice(a0, b0 + 1)).map((c) => c.char).join('');
  }
  function toCleaned(a, b) {
    let s = -1, e = -1;
    for (let i = a; i < b; i++) {
      const ci = map.get(i);
      if (ci === undefined) continue;
      if (s < 0) s = ci;
      e = ci;
    }
    return s < 0 ? null : { startCharIdx: s, endCharIdx: e };
  }

  // ── 手寫標記優先（兩種都認）──
  // 使用者要保留原本的手動方式，所以自動配圖絕不覆蓋人工標記的段落：
  //   (shot:名稱)…(shot:名稱)    大盤小報／焦點股用的全螢幕截圖標記
  //   (imageN[:位置,大小])…(imageN)  投廣模板用的子母畫面 overlay 標記
  // 兩者標到的區間都視為「已由人決定」，自動只補其餘沒標的段落。
  const manual = [];
  for (const m of body.matchAll(/\(shot:([^():]+)(?::([^)]*))?\)([\s\S]*?)\(shot:\1\)/gi)) {
    const cs = m.index + m[0].indexOf(m[3]);
    const r = toCleaned(cs, cs + m[3].length);
    if (r) manual.push({ src: m[1] + '.png', ...r, _manual: true });
  }
  for (const m of body.matchAll(/\((image\d+)(?::[^)]*)?\)([\s\S]*?)\(\1(?::[^)]*)?\)/gi)) {
    const cs = m.index + m[0].indexOf(m[2]);
    const r = toCleaned(cs, cs + m[2].length);
    if (r) manual.push({ src: m[1] + '.png', ...r, _manual: true, _overlay: true });
  }

  // ── 切「子句」──（逗號也切）
  // 一段話常連講三個數字：「營收98.22億元，月增22.74%、年增56.55%」。
  // 只切到段落層級的話，黃框會卡在第一個數字不動（2026-08-12 使用者回報）。
  const clauses = [];
  {
    // blk = 主題段落（以「空行」分隔）。同一主題可能跨好幾行，例如金居那段：
    //   金居則是籌碼訊號值得關注。/ 融資連9日增加…。/ HVLP4高頻銅箔…。
    // 圖要在整個主題段落內持續顯示，到空行才收掉（使用者要求「講完那段就消失」）。
    let st = 0, sid = 0, blk = 0;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      // 段落只拿來當參考，不當判準 —— 真正的界線是「句子」，見下方主迴圈。
      //（2026-08-17 我一度改成「換行就換段」來救圖黏太久，被使用者指出方向錯了：
      //   「不能看段行啊！是要看句子判讀」。段落結構會因為貼上方式不同而消失，
      //   句子不會。已撤回。）
      if (ch === '\n' && /^[ \t]*\n/.test(body.slice(i + 1))) blk++;
      if (/[。！？\n，、；：]/.test(ch)) {
        // 切點（st/i）照替換後算，text 給原稿的字 —— 兩者長度可能不同（NAND→name的 差一個字），
        // 所以「有沒有東西」的門檻仍看替換後那段，切法才跟以前完全一樣。
        const t = body.slice(st, i + 1);
        if (t.trim().length > 1)
          clauses.push({ text: origSlice(st, i + 1), start: st, end: i + 1, sid, blk, u: clauses.length });
        st = i + 1;
        if (/[。！？\n]/.test(ch)) sid++;
      }
    }
    if (body.slice(st).trim().length > 1)
      clauses.push({ text: origSlice(st, body.length), start: st, end: body.length, sid, blk, u: clauses.length });
  }

  // ── 句子清單（--sentences）──
  // 由上面的 clauses 依 sid 聚合而成，所以「前台看到的句子」跟「配圖用的句子」
  // 一定是同一套切法。標注頁存的是 sentence 編號，下面就靠這個編號還原字元範圍。
  const SENTENCES = [];
  for (const c of clauses) {
    const cur = SENTENCES[c.sid];
    if (!cur) SENTENCES[c.sid] = { i: c.sid, text: c.text, start: c.start, end: c.end };
    else { cur.text += c.text; cur.end = c.end; }
  }
  const sentenceList = SENTENCES
    .filter(Boolean)
    .map((x) => ({ i: x.i, text: x.text.replace(/\s+/g, '').replace(/\(shot:[^)]*\)/gi, ''), start: x.start, end: x.end }))
    .filter((x) => x.text.length > 1);

  // 子句清單：比句子細，讓前台可以「從這裡拉到那裡」選一個範圍
  //（2026-08-17 使用者：給我選擇的句子太不靈活了，要像訂房網站選日期一樣拉範圍）
  // ⚠️ 用拆分前的子句索引 c.u。--sentences 模式沒有圖片資料、不會做列舉拆分，
  // 用陣列位置當索引兩邊就會對不上。
  const unitList = clauses.map((c) => {
    // 一併算出「清洗後的字元索引」——伺服器只要照 from/to 取頭尾就好，
    // 不必自己重做一套字元對位（那會是第二份實作、遲早漂走）。
    const r = toCleaned(c.start, c.end);
    return {
      i: c.u,
      sid: c.sid,
      text: c.text.replace(/\(shot:[^)]*\)/gi, '').replace(/\s+/g, ''),
      start: c.start,
      end: c.end,
      startCharIdx: r ? r.startCharIdx : null,
      endCharIdx: r ? r.endCharIdx : null,
    };
  }).filter((u) => u.text.length > 0);

  // chars = 逐字清單（清洗後的字元索引）。
  // 前台讓人用滑鼠「拖選文字」來指定範圍，存的就是這裡的 i ——
  // 中間不再經過「子句」這層轉換，也才能處理「一句話要配兩張圖」
  //（例：友達群創雙漲停。是一個子句，卻要分給兩張截圖）。
  // b=1 表示這個字後面是標點或換行，前台用來排版斷行。
  // c 給**原稿的字**（2026-09-11 使用者定案：替換後的字只送 TTS，其他地方都不用）。
  // i 仍是替換後的字元索引 —— 那是整條產線共用的座標（字幕時間軸也是這一套），不能動。
  // 規則讓字數變多的地方（NAND→name的）會有幾格是空字串：畫面上不顯示、索引照舊存在，
  // 前台照 i 存範圍所以不受影響（見 script-utils 的 origChars 說明）。
  const oc = origChars(cleaned);
  const chars = cleaned.map((c, i) => ({ i, c: oc[i], b: c.breakAfter ? 1 : 0, p: c.paraBreak ? 1 : 0 }));

  return { body, cleaned, origSlice, origPhrase, toCleaned, marks: manual, clauses, sentenceList, unitList, chars };
}

module.exports = { analyzeScript };
