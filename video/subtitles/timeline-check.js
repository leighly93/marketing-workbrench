// @ts-check
'use strict';

/*
 * 出片前健全性檢查：字幕時間軸有沒有整條壞掉。
 *
 * 為什麼要有這一關（2026-09-16 實際出片事故）：
 *   whisper 是分 30 秒 window 解碼的，偶爾會在 window 邊界把某句話的結束時間報得離譜
 *   （實例：24.72 秒那句只有 22 個字，卻被報成撐到 36.56 秒），之後整條時間軸往後偏 8 秒，
 *   音檔時間用完時稿件還剩一大段沒有時間可放。
 *   鄰居 fallback（gap-fill.js 的 attachToNeighbors，「附給時間上最近的 whisper word」）是為了不丟字，
 *   但遇到這種情況就變成：結尾 49 個字全部掛到同一顆 word（0.19 秒）。
 *   成品是「字幕上到一半就不動了，最後一瞬間整段閃過」—— 而整條 pipeline 一聲不吭照樣出片，
 *   只能靠人盯著看才發現。所以這裡寧可停下來，也不要讓壞掉的片流出去。
 *
 * 2026-09-18 之後這一關的角色變成「分流的後半段」：
 *   ・whisper **沒聽到**一段（時間軸其餘是準的）→ gap-fill.js 已經按稿件字數把空白攤平，
 *     那些字有了合理時間，A 判準自然就不會觸發 → 放行，片子出得來。
 *   ・whisper **聽錯位置**（時間軸整體歪掉）→ gap-fill.js 補不動（空白根本不夠放），
 *     或雖然補了但補太多（C 判準）→ 照樣擋在這裡。
 *   換句話說：能用稿件算回來的就算回來，只有真的算不回來才停線。
 *
 * ⚠️ 判準只抓「一定是壞的」，寧可漏抓也不要誤擋：正常影片離這幾條線都很遠
 *    （實測正常那支：最多 7 個字共用一顆 word、最長 segment 0.19 秒/字）。
 */

/** @typedef {import('./align').Subtitles} Subtitles */
const { PUNCT_RE } = require('./align');

/** 補洞字數佔全稿的上限；超過表示這份轉錄整體不可信（C 判準）。 */
const MAX_FILL_RATIO = 0.25;
const PUNCT_ALL_RE = new RegExp(PUNCT_RE.source, 'g');

/**
 * @param {Subtitles} subs 已對齊、帶 _scriptCharTimes 與 _filledGaps 的字幕
 * @param {string} cleanScriptText 稿件字（跟 _scriptCharTimes 一一對應）
 * @returns {string[]} 問題描述；空陣列＝通過
 */
function detectTimelineFailure(subs, cleanScriptText) {
  /** @type {string[]} */
  const problems = [];
  const times = /** @type {Array<{ start: number, end: number }>} */ (subs._scriptCharTimes);

  // A. 症狀：一堆字擠在極短的時間內 → 觀眾根本看不到，或最後一瞬間全部閃過。
  //    正常講話 15 個字至少要 2 秒以上；擠在 1 秒內只有「沒有時間可放，全部堆到同一顆 word」一種可能。
  const RUN = 15;
  const SPAN = 1.0;
  for (let i = 0; i + RUN <= times.length; i++) {
    if (times[i + RUN - 1].end - times[i].start >= SPAN) continue;
    let j = i + RUN;
    // 往後把整團吃完。用「平均每字幾秒」延伸（跟上面的門檻同一個：SPAN / RUN），
    // 不要用「距離團塊起點 SPAN 秒」硬切 —— 那會把 64 個字的一團截成 50 個，
    // 訊息還會因此說成「第 240～289 個字」而不是「最後 64 個字」。
    while (j < times.length && (times[j].end - times[i].start) / (j - i + 1) < SPAN / RUN) j++;
    const n = j - i;
    const span = times[j - 1].end - times[i].start;
    // 這一團不一定在結尾（whisper 中間漏聽一整段也會這樣），措辭要跟著位置走，
    // 不能一律說「最後」—— 講錯位置會害人往錯的地方找。
    const where = j >= times.length ? `最後 ${n} 個字` : `第 ${i + 1}～${j} 個字（共 ${n} 個）`;
    const before = cleanScriptText.slice(Math.max(0, i - 12), i);
    problems.push(
      `${where}「${cleanScriptText.slice(i, i + 12)}…」全部擠在 `
      + `${times[i].start.toFixed(2)}～${times[j - 1].end.toFixed(2)} 秒（只有 ${span.toFixed(2)} 秒）內。\n`
      + `     觀眾會看到字幕${before ? `停在「${before}」之後就不動` : '從頭就跟不上語音'}，`
      + `這一段會在一瞬間全部閃過。`
    );
    break; // 報第一團就夠，後面通常是同一個原因
  }

  // B. 根因：whisper 自己報的 segment 時長對不上它的字數。
  //    這是「window 邊界把結束時間報過頭」的直接指紋，比 A 更早、更能指出壞在第幾秒。
  //    ⚠️ 字數一定要用 `_whisperChars`（補洞之前記下的 whisper 原始字數），
  //    不能用 seg.text —— 重組字詞時已經把補出來的字寫進 seg.text 了，拿它算會讓分母變大、
  //    把這條判準洗掉。B 問的是「whisper 自己聽到的字撐不撐得住它自己報的時長」。
  for (const seg of subs.segments) {
    const n = Number.isFinite(seg._whisperChars)
      ? seg._whisperChars
      : (seg.text || '').replace(PUNCT_ALL_RE, '').length;
    const dur = seg.end - seg.start;
    if (!n || dur <= 6 || dur / n <= 0.4) continue;
    problems.push(
      `whisper 把 ${seg.start.toFixed(2)} 秒那句的結束時間報成 ${seg.end.toFixed(2)} 秒 —— `
      + `那句只有 ${n} 個字卻佔了 ${dur.toFixed(1)} 秒（每字 ${(dur / n).toFixed(2)} 秒，正常約 0.15）。\n`
      + `     從這裡開始整條字幕會落後語音，後面的字被往後擠。`
    );
    break;
  }

  // C. 補的洞太多 → 這份轉錄整體不可信，不要用「攤平」把它蓋過去。
  //    補洞的前提是「whisper 只是漏聽一小段，其餘時間軸是準的」—— 我們靠兩端那兩顆真 word
  //    把空白夾出來。漏掉的比例一大，那個前提就不成立了（夾出來的區間本身可能就是歪的），
  //    再攤平只是把「看不出來的錯」做得更像對的。寧可停在這裡交回給人。
  const filledGaps = /** @type {Array<{ chars: number }>} */ (subs._filledGaps || []);
  const filledChars = filledGaps.reduce((s, g) => s + g.chars, 0);
  if (filledChars > cleanScriptText.length * MAX_FILL_RATIO) {
    const pct = ((filledChars / cleanScriptText.length) * 100).toFixed(0);
    problems.push(
      `whisper 這次漏聽了 ${filledChars} 個字（佔整篇 ${pct}%，共 ${filledGaps.length} 段）—— `
      + `超過可以用稿件補回來的上限（${(MAX_FILL_RATIO * 100).toFixed(0)}%）。\n`
      + `     漏這麼多表示整條時間軸都不可信，補出來的時間會是猜的，不是差零點幾秒的問題。`
    );
  }
  return problems;
}

module.exports = { detectTimelineFailure, MAX_FILL_RATIO };
