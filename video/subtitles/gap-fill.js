// @ts-check
'use strict';

/**
 * whisper 漏聽一整段 → 依稿件字數把那段空白攤平（2026-09-18 使用者定案：「時間可能差個零點幾秒、但片子出得來」）。
 *
 * 補得起來的原因：字幕文字 100% 來自稿件，whisper 只負責時間。漏聽時我們手上有 ①那段空白的起訖時間、
 * ②稿件缺的是哪幾個字；中文語速穩定，按字數均分的誤差在零點幾秒。
 *
 * ⚠️ 只補「沒聽到」，不補「聽錯位置」：空白不夠放（每字低於 MIN_SEC_PER_CHAR）就不補，
 *    留給鄰居 fallback，讓時間軸檢查照常擋下來（那是 whisper 時間軸整體歪掉）。
 */

/** 攤平後每字至少要有這麼久，否則不算救回來（閃過的字幕沒有意義）。 */
const MIN_SEC_PER_CHAR = 0.1;
/**
 * 幾個字以上才算「漏聽一段」。小洞維持鄰居 fallback：PUNCT_RE 會把「%」濾掉，每支稿件的「38%」都會
 * 產生 1 個字的洞；沒有這條門檻，正常影片的斷句也會被改掉。8 的由來：時間軸檢查 A 判準是
 * 「連續 15 個字擠在 1 秒內」，洞要接近那個規模才會真的擋片；8 個字以上掛同一顆 word 人眼也看得出來。
 */
const MIN_GAP_CHARS = 8;

/**
 * @typedef {import('./align').Word} Word
 * @typedef {import('./align').Subtitles} Subtitles
 * @typedef {{ from: number, to: number, chars: number, secPerChar: number, text?: string }} Gap
 */

/**
 * 找出稿件裡連續沒對到的段落，能攤平的就造合成 word 插回字幕。會修改 scriptCharToWord 與 subs。
 * @param {{ scriptCharToWord: Array<Word | null>, scriptChars: Array<{ char: string }>, subs: Subtitles, audioEnd: number }} input
 * @returns {{ filledGaps: Gap[], skippedGaps: Gap[] }}
 */
function fillMissedGaps({ scriptCharToWord, scriptChars, subs, audioEnd }) {
  const text = scriptChars.map((c) => c.char).join('');
  /** @type {Map<Word | null, Word[]>} prevWord（null＝整份最前面）→ 要接在它後面的合成 word */
  const insertAfter = new Map();
  /** @type {Gap[]} */ const filledGaps = [];
  /** @type {Gap[]} */ const skippedGaps = [];

  for (let i = 0; i < scriptChars.length;) {
    if (scriptCharToWord[i]) { i++; continue; }
    let j = i;
    while (j < scriptChars.length && !scriptCharToWord[j]) j++;
    const prevWord = i > 0 ? scriptCharToWord[i - 1] : null;
    const nextWord = j < scriptChars.length ? scriptCharToWord[j] : null;
    const from = prevWord ? prevWord.end : 0;
    const to = nextWord ? nextWord.start : audioEnd;
    const n = j - i;
    const span = to - from;
    const perChar = span / n;
    if (n < MIN_GAP_CHARS) {
      // 小洞不碰，走鄰居 fallback；也不算「補不起來的漏聽」。
    } else if (span > 0 && perChar >= MIN_SEC_PER_CHAR) {
      /** @type {Word[]} */
      const made = [];
      for (let k = 0; k < n; k++) {
        const w = {
          word: scriptChars[i + k].char,
          start: Number((from + perChar * k).toFixed(3)),
          end: Number((from + perChar * (k + 1)).toFixed(3)),
          probability: 0, // 0＝不是 whisper 聽出來的，是按字數補的
          filled: true,
        };
        made.push(w);
        scriptCharToWord[i + k] = w;
      }
      insertAfter.set(prevWord, (insertAfter.get(prevWord) || []).concat(made));
      filledGaps.push({ from: Number(from.toFixed(2)), to: Number(to.toFixed(2)), chars: n, secPerChar: Number(perChar.toFixed(3)),
        text: text.slice(i, j) });
    } else {
      skippedGaps.push({ from: Number(from.toFixed(2)), to: Number(to.toFixed(2)), chars: n, secPerChar: Number(perChar.toFixed(3)) });
    }
    i = j;
  }

  // 合成 word 插回 segment。只動 words，不碰 seg.start／seg.end：渲染端只看攤平的 words，
  // 而時間軸檢查 B 判準要的正是 whisper 自報的原始區間。
  if (insertAfter.size) {
    for (const seg of subs.segments) {
      if (!seg.words) continue;
      /** @type {Word[]} */
      const rebuilt = [];
      for (const w of seg.words) {
        rebuilt.push(w);
        const add = insertAfter.get(w);
        if (add) rebuilt.push(...add);
      }
      seg.words = rebuilt;
    }
    const head = insertAfter.get(null);
    if (head) {
      const first = subs.segments.find((s) => Array.isArray(s.words));
      if (first && first.words) first.words.unshift(...head);
    }
  }
  return { filledGaps, skippedGaps };
}

/**
 * 還沒對到 word 的稿件字，掛給最近的鄰居（向前優先，否則向後）。不丟字。
 * @param {Array<Word | null>} scriptCharToWord
 */
function attachToNeighbors(scriptCharToWord) {
  for (let i = 0; i < scriptCharToWord.length; i++) {
    if (scriptCharToWord[i]) continue;
    for (let j = i - 1; j >= 0; j--) {
      if (scriptCharToWord[j]) { scriptCharToWord[i] = scriptCharToWord[j]; break; }
    }
    if (!scriptCharToWord[i]) {
      for (let j = i + 1; j < scriptCharToWord.length; j++) {
        if (scriptCharToWord[j]) { scriptCharToWord[i] = scriptCharToWord[j]; break; }
      }
    }
  }
}

module.exports = { fillMissedGaps, attachToNeighbors, MIN_SEC_PER_CHAR, MIN_GAP_CHARS };
