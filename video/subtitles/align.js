// @ts-check
'use strict';

/**
 * Whisper 字元序列 ↔ 稿件字元序列的全域對齊（Needleman-Wunsch，編輯距離）。
 * 字幕文字 100% 來自稿件；whisper 只提供時間，所以對齊結果決定「每個稿件字屬於哪顆 whisper word」。
 */

/** 對齊時忽略的標點（whisper 與稿件的標點習慣不同，留著只會製造假的不一致）。 */
const PUNCT_RE = /[，。、！？「」『』"'""''【】〔〕（）()\[\]：；,.!?:;%／/]/;

/**
 * @typedef {{ word: string, start: number, end: number, probability?: number, filled?: boolean, breakAfter?: boolean }} Word
 * @typedef {{ start: number, end: number, text?: string, words?: Word[], _whisperChars?: number }} Segment
 * @typedef {{ segments: Segment[], [key: string]: unknown }} Subtitles
 * @typedef {{ ai: number, bi: number, type: 'match' | 'sub' | 'whisperExtra' | 'scriptExtra' }} AlignPair
 */

/**
 * whisper 所有 word 攤平成字元序列（去空白與標點），每個字記住它屬於哪顆 word。
 * @param {Subtitles} subs
 * @returns {Array<{ char: string, wordRef: Word }>}
 */
function whisperCharsOf(subs) {
  const chars = [];
  for (const seg of subs.segments) {
    for (const w of seg.words || []) {
      for (const ch of w.word.replace(/\s/g, '')) {
        if (!PUNCT_RE.test(ch)) chars.push({ char: ch, wordRef: w });
      }
    }
  }
  return chars;
}

/**
 * @param {string} a whisper 文字
 * @param {string} b 稿件文字
 * @returns {AlignPair[]} 依順序排列；ai／bi 為 -1 代表該側沒有對應字
 */
function align(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1];
      else dp[i][j] = Math.min(dp[i - 1][j - 1], dp[i][j - 1], dp[i - 1][j]) + 1;
    }
  }
  /** @type {AlignPair[]} */
  const pairs = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      pairs.push({ ai: i - 1, bi: j - 1, type: 'match' });
      i--; j--;
    } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      pairs.push({ ai: i - 1, bi: j - 1, type: 'sub' });
      i--; j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      pairs.push({ ai: i - 1, bi: -1, type: 'whisperExtra' });
      i--;
    } else {
      pairs.push({ ai: -1, bi: j - 1, type: 'scriptExtra' });
      j--;
    }
  }
  return pairs.reverse();
}

/**
 * 稿件第 i 個字 → 對到的 whisper word（match／sub）；沒對到的是 null，後面的步驟再補。
 * @param {AlignPair[]} pairs
 * @param {Array<{ wordRef: Word }>} whisperChars
 * @param {number} scriptLength
 * @returns {Array<Word | null>}
 */
function mapScriptToWords(pairs, whisperChars, scriptLength) {
  /** @type {Array<Word | null>} */
  const map = new Array(scriptLength).fill(null);
  for (const p of pairs) {
    if (p.bi >= 0 && p.ai >= 0) map[p.bi] = whisperChars[p.ai].wordRef;
  }
  return map;
}

module.exports = { PUNCT_RE, whisperCharsOf, align, mapScriptToWords };
