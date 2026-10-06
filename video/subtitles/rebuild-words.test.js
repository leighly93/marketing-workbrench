'use strict';

const { rewriteWords, splitAtBreaks, markBreaksAndTimes } = require('./rebuild-words');

const W = (word, start, end) => ({ word, start, end });

/** 稿件字：body 裡每個非空白字元一個，breakAt 是要斷句的字（在它之後換幕）。 */
function scriptCharsOf(body, breakAt = []) {
  const out = [];
  [...body].forEach((char, origIdx) => {
    if (/\s/.test(char)) return;
    out.push({ char, origIdx, ...(breakAt.includes(out.length) ? { breakAfter: true } : {}) });
  });
  return out;
}

describe('rewriteWords', () => {
  test('word 文字改成對到的稿件字，回報改了哪些', () => {
    const a = W('台機', 0, 1);
    const b = W('電', 1, 2);
    const subs = { segments: [{ start: 0, end: 2, words: [a, b] }] };
    const scriptChars = scriptCharsOf('台積電');
    const { reports } = rewriteWords({ subs, scriptChars, scriptCharToWord: [a, a, b], body: '台積電' });
    expect(subs.segments[0].words.map((w) => w.word)).toEqual(['台積', '電']);
    expect(subs.segments[0].text).toBe('台積電');
    expect(reports).toEqual([{ time: '0.00s', from: '台機', to: '台積' }]);
  });

  test('leading 空白只在稿件原文真的有空白時保留（whisper 自己加的拿掉）', () => {
    const a = W('世', 0, 1);
    const b = W(' 芯', 1, 2);
    const c = W(' KY', 2, 3);
    const subs = { segments: [{ start: 0, end: 3, words: [a, b, c] }] };
    const body = '世芯 KY';
    const scriptChars = scriptCharsOf(body);
    rewriteWords({ subs, scriptChars, scriptCharToWord: [a, b, c, c], body });
    expect(subs.segments[0].words.map((w) => w.word)).toEqual(['世', '芯', ' KY']);
  });
});

describe('splitAtBreaks', () => {
  test('斷句點在 word 中間就切開，時間依字數內插', () => {
    const w = W('來世', 1, 2);
    const subs = { segments: [{ start: 1, end: 2, words: [w] }] };
    const scriptChars = scriptCharsOf('來世', [0]);
    const map = [w, w];
    const cuts = splitAtBreaks({ subs, scriptChars, scriptCharToWord: map, wordToScriptIdx: new Map([[w, [0, 1]]]) });
    expect(cuts).toBe(1);
    expect(subs.segments[0].words).toEqual([
      { word: '來', start: 1, end: 1.5 },
      { word: '世', start: 1.5, end: 2 },
    ]);
    expect(map[0]).toBe(subs.segments[0].words[0]);
    expect(map[1]).toBe(subs.segments[0].words[1]);
  });

  test('斷句點在 word 最後一個字就不動', () => {
    const w = W('帶上來', 0, 1);
    const subs = { segments: [{ start: 0, end: 1, words: [w] }] };
    const cuts = splitAtBreaks({ subs, scriptChars: scriptCharsOf('帶上來', [2]), scriptCharToWord: [w, w, w], wordToScriptIdx: new Map([[w, [0, 1, 2]]]) });
    expect(cuts).toBe(0);
    expect(subs.segments[0].words[0]).toBe(w);
  });
});

describe('markBreaksAndTimes', () => {
  test('換幕標在 word 上，並輸出換幕時間、逐字時間與稿件字', () => {
    const a = W('今天', 0, 1);
    const b = W('收盤', 1, 2.5);
    const subs = { segments: [{ start: 0, end: 2.5, words: [a, b] }] };
    markBreaksAndTimes({ subs, scriptChars: scriptCharsOf('今天收盤', [1]), scriptCharToWord: [a, a, b, b] });
    expect(a.breakAfter).toBe(true);
    expect(b.breakAfter).toBeUndefined();
    expect(subs._scriptBreaks).toEqual([1]);
    expect(subs._scriptCharTimes).toEqual([{ start: 0, end: 1 }, { start: 0, end: 1 }, { start: 1, end: 2.5 }, { start: 1, end: 2.5 }]);
    expect(subs._scriptText).toBe('今天收盤');
  });
});
