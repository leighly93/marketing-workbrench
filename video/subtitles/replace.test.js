'use strict';

const { applyCrossWordReplace, applyRules, restoreVoiceRules } = require('./replace');

const words = (...texts) => texts.map((word, i) => ({ word, start: i, end: i + 1 }));
const textOf = (ws) => ws.map((w) => w.word);

describe('applyCrossWordReplace', () => {
  test('同一顆 word 內直接替換', () => {
    const ws = words('台基電', '上漲');
    applyCrossWordReplace(ws, '台基電', '台積電');
    expect(textOf(ws)).toEqual(['台積電', '上漲']);
  });

  test('跨 word 命中：替換字依字數分給承載匹配的 word，時間不動', () => {
    const ws = words('百分', '之四', '點三九');
    applyCrossWordReplace(ws, '百分之四點三九', '4.39%');
    expect(textOf(ws).join('')).toBe('4.39%');
    expect(ws.map((w) => w.start)).toEqual([0, 1, 2]);
    expect(ws.every((w) => w.word.length > 0)).toBe(true);
  });

  test('匹配前後的字留在原本的 word，不跟替換字擠在一起', () => {
    const ws = words('漲幅百分', '之四點三九的')
    applyCrossWordReplace(ws, '百分之四點三九', '4.39%');
    expect(textOf(ws)).toEqual(['漲幅', '4.39%的']);
  });

  test('保留 leading 空白；找不到或 from 為空就不動', () => {
    const ws = words(' 台基電');
    applyCrossWordReplace(ws, '台基電', '台積電');
    expect(textOf(ws)).toEqual([' 台積電']);
    applyCrossWordReplace(ws, '', 'x');
    applyCrossWordReplace(ws, '不存在', 'x');
    expect(textOf(ws)).toEqual([' 台積電']);
  });

  test('同一串裡多處命中都會換', () => {
    const ws = words('KY', '和', 'KY');
    applyCrossWordReplace(ws, 'KY', '-KY');
    expect(textOf(ws)).toEqual(['-KY', '和', '-KY']);
  });
});

describe('applyRules／restoreVoiceRules', () => {
  test('applyRules 依序套用並重算 seg.text', () => {
    const subs = { segments: [{ start: 0, end: 2, words: words('台基電', '漲') }, { start: 2, end: 3 }] };
    applyRules(subs, [{ from: '台基電', to: '台積電' }]);
    expect(subs.segments[0].text).toBe('台積電漲');
  });

  test('反向發音替換：長的唸法先還原，短規則不會拆掉長規則的產出', () => {
    const subs = { segments: [{ start: 0, end: 3, words: words('漲幅百分之', '四點三九') }] };
    restoreVoiceRules(subs, [
      { from: '4.39', to: '四點三九' },
      { from: '4.39%', to: '百分之四點三九' },
    ]);
    expect(subs.segments[0].text).toBe('漲幅4.39%');
  });
});
