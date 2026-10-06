// @ts-check
'use strict';

/**
 * 字幕文字的替換（反向發音替換與 subtitles-replacements 共用）。
 * @typedef {import('./align').Word} Word
 * @typedef {import('./align').Subtitles} Subtitles
 */
const { segmentText } = require('./rebuild-words');

/**
 * 在一串 word 上把 from 換成 to，命中可以跨多顆 word：
 *   ① 保留第一顆 word 中匹配前的字、最後一顆 word 中匹配後的字
 *   ② 替換字串依字數平均分配到承載匹配的 word（保留時間，避免整段擠到第一顆 word 的小時段）
 * @param {Word[]} words 會被直接修改
 * @param {string} from
 * @param {string} to
 */
function applyCrossWordReplace(words, from, to) {
  if (!from) return;
  let combined = '';
  /** @type {Array<{ wordIdx: number, charIdx: number }>} */
  const charMap = [];
  for (let wi = 0; wi < words.length; wi++) {
    const t = words[wi].word.replace(/^\s+/, '');
    for (let ci = 0; ci < t.length; ci++) {
      combined += t[ci];
      charMap.push({ wordIdx: wi, charIdx: ci });
    }
  }
  let searchFrom = 0;
  while (true) {
    const idx = combined.indexOf(from, searchFrom);
    if (idx < 0) break;
    const end = idx + from.length;
    const firstWordIdx = charMap[idx].wordIdx;
    const lastWordIdx = charMap[end - 1].wordIdx;
    if (firstWordIdx === lastWordIdx) {
      words[firstWordIdx].word = words[firstWordIdx].word.split(from).join(to);
    } else {
      const firstWordCharIdx = charMap[idx].charIdx;
      const lastWordCharIdx = charMap[end - 1].charIdx;
      const firstWordOriginal = words[firstWordIdx].word.replace(/^\s+/, '');
      const lastWordOriginal = words[lastWordIdx].word.replace(/^\s+/, '');
      const firstWordLeading = (words[firstWordIdx].word.match(/^\s+/) || [''])[0];
      const lastWordLeading = (words[lastWordIdx].word.match(/^\s+/) || [''])[0];
      const beforeMatch = firstWordOriginal.slice(0, firstWordCharIdx);
      const afterMatch = lastWordOriginal.slice(lastWordCharIdx + 1);

      // 如果 beforeMatch 不是空（firstWord 開頭有非匹配字），讓 beforeMatch 獨佔 firstWord：
      // 這樣斷句點落在 firstWord 之後的話，beforeMatch 跟替換字串就會被分到不同 phrase。
      // 反之亦然：afterMatch 不空 → lastWord 結尾的 afterMatch 留著、replacement 不擠進去。
      // 替換字串只分配到「真正承載 match 的 word」(recipientStart..recipientEnd)。
      const recipientStart = beforeMatch ? firstWordIdx + 1 : firstWordIdx;
      const recipientEnd = afterMatch ? lastWordIdx - 1 : lastWordIdx;

      if (beforeMatch) words[firstWordIdx].word = firstWordLeading + beforeMatch;
      if (afterMatch) words[lastWordIdx].word = lastWordLeading + afterMatch;

      const recipientCount = recipientEnd - recipientStart + 1;
      if (recipientCount >= 1) {
        const toLen = to.length;
        for (let i = 0; i < recipientCount; i++) {
          const wi = recipientStart + i;
          const sliceStart = Math.floor((i * toLen) / recipientCount);
          const sliceEnd = Math.floor(((i + 1) * toLen) / recipientCount);
          const piece = to.slice(sliceStart, sliceEnd);
          // recipient 範圍內如果剛好是 firstWord 或 lastWord，要保留它原本要保留的部分
          let pre = '';
          let post = '';
          let leading;
          if (wi === firstWordIdx) {
            leading = firstWordLeading;
            pre = beforeMatch;
          } else if (wi === lastWordIdx) {
            leading = lastWordLeading;
            post = afterMatch;
          } else {
            leading = (words[wi].word.match(/^\s+/) || [''])[0];
          }
          words[wi].word = leading + pre + piece + post;
        }
      } else {
        // recipient 範圍空（before 跟 after 把所有 word 都佔了）— 沒地方放 replacement
        // 為了不丟字，把整段 replacement 塞回 lastWord 開頭（壓在 afterMatch 之前）
        words[lastWordIdx].word = lastWordLeading + to + afterMatch;
      }
    }
    combined = combined.slice(0, idx) + to + combined.slice(end);
    const newChars = to.split('').map(() => ({ wordIdx: firstWordIdx, charIdx: 0 }));
    charMap.splice(idx, from.length, ...newChars);
    searchFrom = idx + to.length;
  }
}

/**
 * 對每一段字幕套用一組規則（依陣列順序），並重算 seg.text。
 * @param {Subtitles} subs
 * @param {Array<{ from: string, to: string }>} rules
 */
function applyRules(subs, rules) {
  for (const seg of subs.segments) {
    if (!seg.words) continue;
    for (const rule of rules) applyCrossWordReplace(seg.words, rule.from, rule.to);
    seg.text = segmentText(seg.words);
  }
}

/**
 * 反向發音替換：把送 TTS 用的唸法還原成稿件原字（例：「百分之四點三九」→「4.39%」）。
 * 只還原這支稿件真的換到的規則（2026-09-30：共用詞庫有寫反的條目時，沒用到的規則會把正確的字改錯），
 * 而且長的先做（短的先做會拆掉長規則的產出，2026-08-19）。
 * @param {Subtitles} subs
 * @param {Array<{ from: string, to: string }>} usedRules 發音替換規則（from＝稿件原字、to＝送 TTS 的唸法）
 */
function restoreVoiceRules(subs, usedRules) {
  const reversed = [...usedRules]
    .sort((a, b) => (b.to || '').length - (a.to || '').length)
    .map((r) => ({ from: r.to, to: r.from }));
  applyRules(subs, reversed);
}

module.exports = { applyCrossWordReplace, applyRules, restoreVoiceRules };
