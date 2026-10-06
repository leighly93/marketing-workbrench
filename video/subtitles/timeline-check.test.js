'use strict';

const { detectTimelineFailure, MAX_FILL_RATIO } = require('./timeline-check');

/** 每個字 perChar 秒的正常時間軸。 */
const even = (n, perChar = 0.2, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ start: from + i * perChar, end: from + (i + 1) * perChar }));

const subsOf = (times, segments = [{ start: 0, end: 4, text: '甲'.repeat(20), _whisperChars: 20 }], filled = []) =>
  ({ segments, _scriptCharTimes: times, _filledGaps: filled });

describe('detectTimelineFailure', () => {
  test('正常的時間軸通過', () => {
    expect(detectTimelineFailure(subsOf(even(20)), '甲'.repeat(20))).toEqual([]);
  });

  test('A：結尾一大團字擠在 1 秒內 → 說「最後 N 個字」', () => {
    const times = [...even(20), ...even(30, 0.01, 4)];
    const [problem] = detectTimelineFailure(subsOf(times), '甲'.repeat(20) + '乙'.repeat(30));
    expect(problem).toMatch(/^最後 3\d 個字/);
    expect(problem).toMatch(/停在「甲+」之後就不動/);
  });

  test('A：擠成一團在中間時要講對位置；從第一個字就擠在一起時不印空的「停在「」之後」', () => {
    const middle = [...even(10), ...even(20, 0.01, 2), ...even(10, 0.2, 2.5)];
    expect(detectTimelineFailure(subsOf(middle), '字'.repeat(40))[0]).toMatch(/^第 \d+～\d+ 個字（共 \d+ 個）/);
    const head = [...even(20, 0.01), ...even(10, 0.2, 1)];
    expect(detectTimelineFailure(subsOf(head), '字'.repeat(30))[0]).toMatch(/從頭就跟不上語音/);
  });

  test('B：whisper 自報的 segment 時長對不上字數（看補洞前記下的字數）', () => {
    const segments = [{ start: 24.72, end: 36.56, text: '補洞後變很多字'.repeat(10), _whisperChars: 22 }];
    const [problem] = detectTimelineFailure(subsOf(even(22), segments), '甲'.repeat(22));
    expect(problem).toMatch(/24\.72 秒那句的結束時間報成 36\.56 秒/);
    expect(problem).toMatch(/只有 22 個字/);
  });

  test(`C：補洞超過全稿 ${MAX_FILL_RATIO * 100}% 就不信任這份轉錄`, () => {
    const filled = [{ chars: 6 }, { chars: 5 }];
    const [problem] = detectTimelineFailure(subsOf(even(40), undefined, filled), '甲'.repeat(40));
    expect(problem).toMatch(/漏聽了 11 個字（佔整篇 28%，共 2 段）/);
    expect(detectTimelineFailure(subsOf(even(40), undefined, [{ chars: 10 }]), '甲'.repeat(40))).toEqual([]);
  });
});
