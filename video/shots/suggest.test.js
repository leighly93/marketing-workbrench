'use strict';

const { suggestCells } = require('./suggest');

const matcherReturning = (pick) => ({ findNamedRow: () => null, findCell: () => pick });
const ctx = (pick) => ({ imgs: [{ file: 'a.png', width: 100, height: 200, page: 'revenue' }], origPhrase: () => '旁白', matcher: matcherReturning(pick) });

describe('suggestCells', () => {
  test.each([
    ['你標過的位置（同型頁面已標 2 次）', '記憶庫（你標過的同型頁面）'],
    ['台積電（整列）', '旁白點名的那一列'],
    ['健鼎（框股名）', '頁面標題（找不到更具體目標時的退路）'],
    ['-3.77%', '圖上的漲跌幅'],
    ['98.22', '圖上的數字'],
    ['月營收表', '規則庫的區域定義'],
  ])('從框到的字反推是哪條規則：%s → %s', (cellText, why) => {
    const [out] = suggestCells([{ src: 'a.png', startCharIdx: 5, endCharIdx: 2 }], ctx({ cell: { x: 1, y: 2, w: 3, h: 4 }, cellText }));
    expect(out).toMatchObject({ src: 'a.png', startCharIdx: 2, endCharIdx: 5, phrase: '旁白', why, imageWidth: 100, page: 'revenue' });
  });

  test('系統也找不到目標；沒有分析資料的圖', () => {
    const [none, missing] = suggestCells([{ src: 'a.png', startCharIdx: 0, endCharIdx: 1 }, { src: 'x.png', startCharIdx: 0, endCharIdx: 1 }], ctx(null));
    expect(none).toMatchObject({ cell: null, why: '系統也找不到可框的目標（會整張顯示）' });
    expect(missing.why).toMatch(/沒有分析資料/);
  });

  test('輸入不是陣列就回空陣列', () => {
    expect(suggestCells(/** @type {any} */ ({}), ctx(null))).toEqual([]);
  });
});
