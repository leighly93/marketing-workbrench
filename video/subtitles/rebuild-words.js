// @ts-check
'use strict';

/**
 * 依對齊結果重組每顆 whisper word 的文字，並產生渲染端要的斷幕與逐字時間。
 *
 * @typedef {import('./align').Word} Word
 * @typedef {import('./align').Subtitles} Subtitles
 * @typedef {{ char: string, origIdx: number, breakAfter?: boolean }} ScriptChar
 */

/** @param {Word[]} words */
const segmentText = (words) => words.map((w) => w.word.replace(/^\s+/, '')).join('');

/**
 * 每顆 word 的文字改成對到它的稿件字；leading 空白也以稿件為準
 * （whisper 在停頓處會自己加空白 →「世 芯-KY」，2026-09-01 使用者回報）。
 * @param {{ subs: Subtitles, scriptChars: ScriptChar[], scriptCharToWord: Array<Word | null>, body: string }} input
 *   body：發音替換後、清洗前的內文（稿件的空白在清洗時就丟了，要回頭查原文）
 * @returns {{ reports: Array<{ time: string, from: string, to: string }>, wordToScriptIdx: Map<Word, number[]> }}
 */
function rewriteWords({ subs, scriptChars, scriptCharToWord, body }) {
  /** @type {Map<Word, number[]>} */
  const wordToScriptIdx = new Map();
  scriptChars.forEach((_, i) => {
    const w = scriptCharToWord[i];
    if (!w) return;
    if (!wordToScriptIdx.has(w)) wordToScriptIdx.set(w, []);
    /** @type {number[]} */ (wordToScriptIdx.get(w)).push(i);
  });
  /** @param {Word} w */
  const hasSpaceBefore = (w) => {
    const idxs = wordToScriptIdx.get(w) || [];
    if (idxs.length === 0) return false;
    const o = scriptChars[idxs[0]].origIdx;
    return o > 0 && /[ \t]/.test(body[o - 1]);
  };

  const reports = [];
  for (const seg of subs.segments) {
    if (!seg.words) continue;
    for (const w of seg.words) {
      const original = w.word.replace(/\s/g, '');
      const corrected = (wordToScriptIdx.get(w) || []).map((i) => scriptChars[i].char).join('');
      if (corrected !== original) reports.push({ time: w.start.toFixed(2) + 's', from: original, to: corrected });
      w.word = (hasSpaceBefore(w) ? ' ' : '') + corrected;
    }
    seg.text = segmentText(seg.words);
  }
  return { reports, wordToScriptIdx };
}

/**
 * 斷句點落在 whisper word 中間 → 依斷點把 word 切開（時間依字數線性內插），
 * 讓斷幕永遠落在 word 邊界（例：「來世」被黏成一顆，斷幕就會把「世芯-KY」切開，2026-09-01）。
 * 會更新 scriptCharToWord 指向切出來的新 word。
 * @param {{ subs: Subtitles, scriptChars: ScriptChar[], scriptCharToWord: Array<Word | null>, wordToScriptIdx: Map<Word, number[]> }} input
 * @returns {number} 切了幾刀
 */
function splitAtBreaks({ subs, scriptChars, scriptCharToWord, wordToScriptIdx }) {
  let cuts = 0;
  for (const seg of subs.segments) {
    if (!seg.words) continue;
    /** @type {Word[]} */
    const rebuilt = [];
    for (const w of seg.words) {
      const idxs = wordToScriptIdx.get(w) || [];
      const cutAfter = [];
      for (let k = 0; k < idxs.length - 1; k++) {
        if (scriptChars[idxs[k]].breakAfter) cutAfter.push(k);
      }
      if (cutAfter.length === 0) { rebuilt.push(w); continue; }
      cuts += cutAfter.length;
      const leading = (w.word.match(/^\s+/) || [''])[0];
      const dur = w.end - w.start;
      const total = idxs.length;
      const bounds = [-1, ...cutAfter, total - 1];
      for (let b = 0; b < bounds.length - 1; b++) {
        const from = bounds[b] + 1;
        const to = bounds[b + 1];
        const piece = {
          ...w,
          word: (b === 0 ? leading : '') + idxs.slice(from, to + 1).map((i) => scriptChars[i].char).join(''),
          start: Number((w.start + (dur * from) / total).toFixed(3)),
          end: Number((w.start + (dur * (to + 1)) / total).toFixed(3)),
        };
        for (let k = from; k <= to; k++) scriptCharToWord[idxs[k]] = piece;
        rebuilt.push(piece);
      }
    }
    seg.words = rebuilt;
    seg.text = segmentText(seg.words);
  }
  return cuts;
}

/**
 * 渲染端用的欄位：
 *   word.breakAfter   這顆之後換幕（2026-09-15 起直接標在 word 上，不再讓渲染端用時間猜）
 *   _scriptBreaks     相容舊渲染路徑的換幕時間
 *   _scriptCharTimes  每個稿件字的時間（給錨點與配圖用）
 *   _scriptText       同一份稿件字（跟 _scriptCharTimes 一一對應）
 * @param {{ subs: Subtitles, scriptChars: ScriptChar[], scriptCharToWord: Array<Word | null> }} input
 */
function markBreaksAndTimes({ subs, scriptChars, scriptCharToWord }) {
  const breakSet = new Set();
  scriptChars.forEach((c, i) => {
    const w = scriptCharToWord[i];
    if (!c.breakAfter || !w) return;
    w.breakAfter = true;
    breakSet.add(Number(w.end.toFixed(3)));
  });
  subs._scriptBreaks = [...breakSet].sort((a, b) => a - b);
  subs._scriptCharTimes = scriptChars.map((_, i) => {
    const w = scriptCharToWord[i];
    return w ? { start: w.start, end: w.end } : { start: 0, end: 0 };
  });
  subs._scriptText = scriptChars.map((c) => c.char).join('');
}

module.exports = { rewriteWords, splitAtBreaks, markBreaksAndTimes, segmentText };
