'use strict';

const { correctSubtitles, audioEndOf } = require('./correct');

const W = (word, start, end) => ({ word, start, end, probability: 0.9 });
const script = (body, voice = '') => `${voice}\n===\n標題\n===\n${body}`;

describe('correctSubtitles', () => {
  test('字幕文字以稿件為準，聽錯的字改回來、時間保留', () => {
    const subs = { segments: [{ start: 0, end: 3, text: '台機電漲停', words: [W('台機電', 0, 1.5), W('漲停', 1.5, 3)] }] };
    const { problems, reports } = correctSubtitles({ scriptRaw: script('台積電漲停。'), subs });
    expect(problems).toEqual([]);
    expect(subs.segments[0].text).toBe('台積電漲停');
    expect(subs.segments[0].words.map((w) => [w.start, w.end])).toEqual([[0, 1.5], [1.5, 3]]);
    expect(reports).toEqual([{ time: '0.00s', from: '台機電', to: '台積電' }]);
    expect(subs._scriptText).toBe('台積電漲停');
    expect(subs._scriptCharTimes).toHaveLength(5);
  });

  test('發音替換：送 TTS 的唸法在字幕還原成稿件原字', () => {
    const subs = { segments: [{ start: 0, end: 3, text: '台基電上漲', words: [W('台基電', 0, 1.5), W('上漲', 1.5, 3)] }] };
    correctSubtitles({ scriptRaw: script('台積電上漲', '台積電→台基電'), subs });
    expect(subs.segments[0].text).toBe('台積電上漲');
  });

  test('自訂替換規則在反向發音替換之後套用', () => {
    const subs = { segments: [{ start: 0, end: 2, text: '世芯KY', words: [W('世芯', 0, 1), W('KY', 1, 2)] }] };
    correctSubtitles({ scriptRaw: script('世芯KY'), subs, replacements: [{ from: 'KY', to: '-KY' }] });
    expect(subs.segments[0].text).toBe('世芯-KY');
  });

  test('時間軸壞掉時回報問題（呼叫端負責不寫回）', () => {
    const subs = { segments: [{ start: 0, end: 20, text: '這是', words: [W('這是', 0, 0.3)] }] };
    const { problems } = correctSubtitles({ scriptRaw: script('這是一段很長的稿件內容'.repeat(6)), subs, heygenDurationSec: 0.5 });
    expect(problems.length).toBeGreaterThan(0);
  });
});

describe('audioEndOf', () => {
  test('有講者影片長度就用它，沒有就用最後一顆 word 的結束時間', () => {
    const subs = { segments: [{ start: 0, end: 3, words: [W('甲', 0, 1), W('乙', 1, 2.5)] }, { start: 3, end: 4 }] };
    expect(audioEndOf(subs, 9)).toBe(9);
    expect(audioEndOf(subs, '9.5')).toBe(9.5);
    expect(audioEndOf(subs, undefined)).toBe(2.5);
    expect(audioEndOf(subs, -1)).toBe(2.5);
  });
});
