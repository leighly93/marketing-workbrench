'use strict';

const { fillMissedGaps, attachToNeighbors, MIN_GAP_CHARS, MIN_SEC_PER_CHAR } = require('./gap-fill');

const W = (word, start, end) => ({ word, start, end });
const chars = (text) => [...text].map((char) => ({ char }));

describe('fillMissedGaps', () => {
  test('中間漏聽一段且時間夠放：按字數攤平，合成 word 插在前一顆 word 後面', () => {
    const before = W('開頭', 0, 1);
    const after = W('結尾', 6, 7);
    const subs = { segments: [{ start: 0, end: 7, words: [before, after] }] };
    const text = '開頭' + '一二三四五六七八九十' + '結尾';
    const map = [before, before, ...new Array(10).fill(null), after, after];
    const { filledGaps, skippedGaps } = fillMissedGaps({ scriptCharToWord: map, scriptChars: chars(text), subs, audioEnd: 10 });

    expect(skippedGaps).toEqual([]);
    expect(filledGaps).toEqual([{ from: 1, to: 6, chars: 10, secPerChar: 0.5, text: '一二三四五六七八九十' }]);
    const words = subs.segments[0].words;
    expect(words.map((w) => w.word)).toEqual(['開頭', ...'一二三四五六七八九十', '結尾']);
    expect(words[1]).toMatchObject({ start: 1, end: 1.5, probability: 0, filled: true });
    expect(map.every(Boolean)).toBe(true);
  });

  test('結尾漏聽：攤到講者影片結束（audioEnd）', () => {
    const only = W('第一', 0, 1);
    const subs = { segments: [{ start: 0, end: 1, words: [only] }] };
    const map = [only, only, ...new Array(10).fill(null)];
    const { filledGaps } = fillMissedGaps({ scriptCharToWord: map, scriptChars: chars('第一' + '一二三四五六七八九十'), subs, audioEnd: 6 });
    expect(filledGaps[0]).toMatchObject({ from: 1, to: 6, secPerChar: 0.5 });
  });

  test('開頭漏聽：合成 word 放在第一段的最前面', () => {
    const first = W('最後', 5, 6);
    const subs = { segments: [{ start: 5, end: 6, words: [first] }] };
    const map = [...new Array(10).fill(null), first, first];
    fillMissedGaps({ scriptCharToWord: map, scriptChars: chars('一二三四五六七八九十最後'), subs, audioEnd: 6 });
    expect(subs.segments[0].words[0]).toMatchObject({ word: '一', start: 0, end: 0.5 });
  });

  test(`少於 ${MIN_GAP_CHARS} 個字的小洞不碰（例如被濾掉的 %），也不算補不起來`, () => {
    const a = W('甲', 0, 1);
    const subs = { segments: [{ start: 0, end: 9, words: [a] }] };
    const map = [a, null, null];
    const result = fillMissedGaps({ scriptCharToWord: map, scriptChars: chars('甲乙丙'), subs, audioEnd: 9 });
    expect(result).toEqual({ filledGaps: [], skippedGaps: [] });
    expect(map).toEqual([a, null, null]);
  });

  test(`空白不夠放（每字少於 ${MIN_SEC_PER_CHAR} 秒）就不補，回報給時間軸檢查`, () => {
    const a = W('甲', 0, 1);
    const b = W('乙', 1.5, 2);
    const subs = { segments: [{ start: 0, end: 2, words: [a, b] }] };
    const map = [a, ...new Array(10).fill(null), b];
    const { filledGaps, skippedGaps } = fillMissedGaps({ scriptCharToWord: map, scriptChars: chars('甲' + '一二三四五六七八九十' + '乙'), subs, audioEnd: 2 });
    expect(filledGaps).toEqual([]);
    expect(skippedGaps).toEqual([{ from: 1, to: 1.5, chars: 10, secPerChar: 0.05 }]);
    expect(subs.segments[0].words).toHaveLength(2);
  });
});

describe('attachToNeighbors', () => {
  test('向前找最近的 word，最前面沒有就向後找', () => {
    const a = W('甲', 0, 1);
    const b = W('乙', 1, 2);
    const map = [null, a, null, null, b];
    attachToNeighbors(map);
    expect(map).toEqual([a, a, a, a, b]);
  });
});
