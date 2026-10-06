'use strict';

const { whisperCharsOf, align, mapScriptToWords } = require('./align');

const W = (word, start, end) => ({ word, start, end });

describe('whisperCharsOf', () => {
  test('攤平所有 word、去掉空白與標點，每個字記住所屬 word', () => {
    const a = W('今天，', 0, 1);
    const b = W(' 大漲%', 1, 2);
    const chars = whisperCharsOf({ segments: [{ start: 0, end: 2, words: [a, b] }, { start: 2, end: 3 }] });
    expect(chars.map((c) => c.char).join('')).toBe('今天大漲');
    expect(chars[0].wordRef).toBe(a);
    expect(chars[3].wordRef).toBe(b);
  });
});

describe('align', () => {
  const types = (a, b) => align(a, b).map((p) => p.type);

  test('完全相同全部 match', () => {
    expect(types('台股大漲', '台股大漲')).toEqual(['match', 'match', 'match', 'match']);
  });

  test('聽錯一個字是 sub，索引仍一一對應', () => {
    const pairs = align('台機電', '台積電');
    expect(pairs.map((p) => p.type)).toEqual(['match', 'sub', 'match']);
    expect(pairs.map((p) => [p.ai, p.bi])).toEqual([[0, 0], [1, 1], [2, 2]]);
  });

  test('whisper 多聽的字是 whisperExtra，漏聽的稿件字是 scriptExtra', () => {
    expect(types('今天天氣', '今天氣')).toContain('whisperExtra');
    const missing = align('今天', '今天下午');
    expect(missing.filter((p) => p.type === 'scriptExtra').map((p) => p.bi)).toEqual([2, 3]);
  });

  test('空字串', () => {
    expect(align('', '')).toEqual([]);
    expect(types('', '甲乙')).toEqual(['scriptExtra', 'scriptExtra']);
  });
});

describe('mapScriptToWords', () => {
  test('match 與 sub 指到 word，沒對到的是 null', () => {
    const w = W('今天', 0, 1);
    const chars = [{ char: '今', wordRef: w }, { char: '天', wordRef: w }];
    const map = mapScriptToWords(align('今天', '今天好'), chars, 3);
    expect(map).toEqual([w, w, null]);
  });
});
