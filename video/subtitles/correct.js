// @ts-check
'use strict';

/**
 * 以稿件為真相之源重組字幕（forced alignment）。純函式：不讀寫檔、不結束程序。
 * whisper 只提供 word 層級的時間；字幕文字 100% 來自稿件（套發音替換後再還原）。
 *
 * 步驟：
 *   1. 稿件內文套發音替換、逐字清洗
 *   2. whisper 字元序列與稿件全域對齊（align.js）
 *   3. 漏聽的整段按字數攤平；剩下沒對到的掛給鄰居（gap-fill.js）
 *   4. 每顆 word 改成對到它的稿件字；斷句點落在 word 中間就切開；標出換幕與逐字時間（rebuild-words.js）
 *   5. 反向發音替換（優先）→ subtitles-replacements（fallback）（replace.js）
 *   6. 時間軸健全性檢查（timeline-check.js）
 *
 * @typedef {import('./align').Subtitles} Subtitles
 */
const { getBodyAfterVoice, getBodyWithVoiceMap, cleanBodyWithIndex } = require('../pipeline/script-utils');
const { PUNCT_RE, whisperCharsOf, align, mapScriptToWords } = require('./align');
const { fillMissedGaps, attachToNeighbors } = require('./gap-fill');
const { rewriteWords, splitAtBreaks, markBreaksAndTimes } = require('./rebuild-words');
const { restoreVoiceRules, applyRules } = require('./replace');
const { detectTimelineFailure } = require('./timeline-check');

/**
 * 結尾漏聽時可以攤到哪裡：講者影片長度；不知道就用最後一顆 word 的結束時間。
 * @param {Subtitles} subs
 * @param {unknown} [heygenDurationSec] video-meta.json 的 heygenDurationSec
 */
function audioEndOf(subs, heygenDurationSec) {
  const sec = Number(heygenDurationSec);
  if (Number.isFinite(sec) && sec > 0) return sec;
  let last = 0;
  for (const seg of subs.segments) for (const w of seg.words || []) last = Math.max(last, w.end);
  return last;
}

/**
 * @param {{ scriptRaw: string, subs: Subtitles, replacements?: Array<{ from: string, to: string }>, heygenDurationSec?: unknown }} input
 *   subs 會被直接修改；失敗時呼叫端不要寫回
 */
function correctSubtitles({ scriptRaw, subs, replacements = [], heygenDurationSec }) {
  const body = getBodyAfterVoice(scriptRaw);
  const scriptChars = cleanBodyWithIndex(body);
  const cleanScriptText = scriptChars.map((c) => c.char).join('');

  const whisperChars = whisperCharsOf(subs);
  const pairs = align(whisperChars.map((c) => c.char).join(''), cleanScriptText);
  const scriptCharToWord = mapScriptToWords(pairs, whisperChars, scriptChars.length);

  // 時間軸檢查 B 判準要的是 whisper 自己聽到的字數，必須在補洞改寫 seg.text 之前記下來。
  const punct = new RegExp(PUNCT_RE.source, 'g');
  for (const seg of subs.segments) seg._whisperChars = (seg.text || '').replace(punct, '').length;

  const { filledGaps, skippedGaps } = fillMissedGaps({
    scriptCharToWord, scriptChars, subs, audioEnd: audioEndOf(subs, heygenDurationSec),
  });
  subs._filledGaps = filledGaps;
  attachToNeighbors(scriptCharToWord);

  const { reports, wordToScriptIdx } = rewriteWords({ subs, scriptChars, scriptCharToWord, body });
  const midWordCuts = splitAtBreaks({ subs, scriptChars, scriptCharToWord, wordToScriptIdx });
  markBreaksAndTimes({ subs, scriptChars, scriptCharToWord });

  // 反向發音替換代表稿件作者的意圖，要比 subtitles-replacements（fallback）先跑：
  // fallback 先跑會把「四點三九」攔成「4.39」，讓「百分之四點三九 → 4.39%」失效。
  restoreVoiceRules(subs, getBodyWithVoiceMap(scriptRaw).usedRules);
  applyRules(subs, replacements);

  const problems = detectTimelineFailure(subs, cleanScriptText);
  return { subs, reports, problems, filledGaps, skippedGaps, midWordCuts };
}

module.exports = { correctSubtitles, audioEndOf };
