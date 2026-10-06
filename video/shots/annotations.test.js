'use strict';

const { annotationsToManual } = require('./annotations');

const ctx = (imgs = []) => ({
  imgs,
  unitList: [{ i: 0, start: 0, end: 5 }, { i: 1, start: 5, end: 10 }],
  sentenceList: [{ i: 3, start: 10, end: 20 }],
  toCleaned: (a, b) => ({ startCharIdx: a, endCharIdx: b - 1 }),
  origPhrase: (lo, hi) => `字${lo}-${hi}`,
});

describe('annotationsToManual', () => {
  test('新格式：字元索引（顛倒也行），帶黃框就有 cell，用標注自己量的尺寸', () => {
    const [m] = annotationsToManual([{ src: 'a.png', startCharIdx: 9, endCharIdx: 4, cell: { x: 1, y: 2, w: 3, h: 4 }, imgW: 800, imgH: 1600 }], ctx());
    expect(m).toMatchObject({ src: 'a.png', startCharIdx: 4, endCharIdx: 9, phrase: '字4-9', cell: { x: 1, y: 2, w: 3, h: 4 },
      cellText: '人工黃框', imageWidth: 800, imageHeight: 1600, _manual: true, _annotated: true });
    expect(m.wholePage).toBeUndefined();
  });

  test('沒框也沒顯示區域 → 整張顯示；箭頭要四個有限數字且長度不為 0', () => {
    const [ok, zero, bad] = annotationsToManual([
      { src: 'a.png', startCharIdx: 0, endCharIdx: 1, arrow: { x1: 0, y1: 0, x2: 3, y2: 4 } },
      { src: 'a.png', startCharIdx: 0, endCharIdx: 1, arrow: { x1: 1, y1: 1, x2: 1, y2: 1 } },
      { src: 'a.png', startCharIdx: 0, endCharIdx: 1, arrow: { x1: 0, y1: 'x', x2: 3, y2: 4 } },
    ], ctx());
    expect(ok).toMatchObject({ wholePage: true, arrow: { x2: 3 } });
    expect(zero.arrow).toBeUndefined();
    expect(bad.arrow).toBeUndefined();
  });

  test('舊格式：子句範圍（from/to）與整句（sentence）', () => {
    const [byUnit, bySentence] = annotationsToManual([
      { src: 'a.png', from: 1, to: 0 },
      { src: 'b.png', sentence: 3, region: { x: 0, y: 0, w: 10, h: 10 } },
    ], ctx());
    expect(byUnit).toMatchObject({ startCharIdx: 0, endCharIdx: 9, wholePage: true });
    expect(bySentence).toMatchObject({ startCharIdx: 10, endCharIdx: 19, region: { w: 10 } });
  });

  test('沒有 src、或範圍找不到的標注略過', () => {
    expect(annotationsToManual([{ startCharIdx: 0, endCharIdx: 1 }, { src: 'a.png', sentence: 99 }, { src: 'a.png', from: 7, to: 8 }], ctx())).toEqual([]);
  });

  test('有分析資料的圖帶上頁型', () => {
    const [m] = annotationsToManual([{ src: 'a.png', startCharIdx: 0, endCharIdx: 1 }], ctx([{ file: 'a.png', page: 'revenue', width: 1206, height: 2622 }]));
    expect(m).toMatchObject({ page: 'revenue', imageWidth: 1206, imageHeight: 2622 });
  });
});
