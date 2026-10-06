'use strict';

const shotMemory = require('./shot-memory');
const { createMatcher } = require('./matcher');
const { buildPageKeywords, buildStockNames, enrichImages } = require('./context');

const word = (t, x, y, w = 80, h = 40, c = 90) => ({ t, x, y, w, h, c });
const REGIONS = {
  revenue: [{ name: '月營收表', keywords: ['營收', '月增'], anchor: '月營收' }],
  margin: [{ name: '融資餘額', keywords: ['融資', '餘額'], anchor: '融資', rows: 3 }],
  market: [{ name: '加權指數磚', keywords: ['加權'], box: [0.1, 0.1, 0.5, 0.2] }],
};

function matcherWith({ stockNames = {}, memory = { codeNames: {}, pages: {}, pagesMulti: {} }, memoryMode } = {}) {
  const { list } = buildStockNames(stockNames, memory.codeNames);
  return createMatcher({ regions: REGIONS, pageKeywords: buildPageKeywords(REGIONS), stockNameList: list, memory, memoryMode, shotMemory });
}

describe('countFromText', () => {
  const { countFromText } = matcherWith();
  test.each([
    ['融資連9日增加', 9], ['連續三個月成長', 3], ['連兩日', 2], ['連十二週', 12], ['連二十日', 12], ['今天上漲', 0],
  ])('%s → %i', (text, n) => expect(countFromText(text)).toBe(n));
});

describe('nameMatch', () => {
  const { nameMatch } = matcherWith();
  test('精確命中候選寫法（含去掉左邊雜字的版本）', () => {
    expect(nameMatch('友達今天漲停', { stockName: '性友達', stockNameAlts: ['友達'] })).toBe('友達');
  });
  test('3 個字以上容許差 1 字；2 個字不放寬（群創／群益只差一字）', () => {
    expect(nameMatch('華邦電大漲', { stockName: '華邦雷' })).toBe('華邦電');
    expect(nameMatch('群益上漲', { stockName: '群創' })).toBeNull();
  });
});

describe('findCell 選框優先順序', () => {
  const img = (page, words, extra = {}) => ({ file: 'a.png', page, width: 1000, height: 2000, words, ...extra });

  test('⓪ 旁白的概數百分比 → 圖上同號、最接近的漲跌幅', () => {
    const { findCell } = matcherWith();
    const cell = findCell('聯發科跌近4%', img('focus-list', [word('-3.77%', 700, 500), word('+3.9%', 700, 600)]), null);
    expect(cell.cellText).toBe('-3.77%');
  });

  test('① 數字：容差 1.5%，千分位要整個吃進來', () => {
    const { findCell } = matcherWith();
    expect(findCell('營收98.22億', img('x', [word('98.2', 300, 300)]), null).cellText).toBe('98.2');
    expect(findCell('收在45,518點', img('x', [word('45518', 300, 300), word('45', 10, 10)]), null).cellText).toBe('45518');
  });

  test('② 規則庫區域：沒數字時框整欄，列數照旁白講的「連N日」', () => {
    const { findCell } = matcherWith();
    const words = [word('融資', 60, 1000), word('1,234', 60, 1080), word('1,200', 60, 1160), word('1,180', 60, 1240), word('1,100', 60, 1320)];
    const cell = findCell('融資連兩日增加', img('margin', words), null);
    expect(cell).toMatchObject({ region: '融資餘額', isColumn: true });
    expect(cell.cell.y + cell.cell.h).toBe(1160 + 40);
  });

  test('② box 型區域用比例座標', () => {
    const { findCell } = matcherWith();
    expect(findCell('加權上漲', img('market', []), null).cell).toEqual({ x: 100, y: 200, w: 400, h: 200 });
  });

  test('②b 記憶庫：其他規則都沒命中時，沿用同型頁面標過的位置（比例座標換回像素）', () => {
    const page = img('chip-daily', [], { stockCode: '2408' });
    const key = shotMemory.memKeyOf(page);
    const { findCell } = matcherWith({ memory: { codeNames: {}, pages: { [key]: { cell: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 }, n: 2 } }, pagesMulti: {} } });
    expect(findCell('主力今天動作不大', page, null)).toMatchObject({ cell: { x: 100, y: 400, w: 300, h: 200 }, _fromMemory: true });
  });

  test('③ 找不到具體目標就框頁面標題；④ 都沒有就 null（整張顯示）', () => {
    const { findCell } = matcherWith();
    expect(findCell('隨便講講', img('x', [], { topic: 'PCB', topicBox: { x: 100, y: 100, w: 200, h: 40 } }), null).region).toBe('title');
    expect(findCell('隨便講講', img('x', []), null)).toBeNull();
  });
});

describe('scoreImage', () => {
  test('股名 10 分、代號 6 分、關鍵字每個 3 分', () => {
    const { scoreImage } = matcherWith();
    const image = { page: 'revenue', stockName: '健鼎', stockCode: '3044', words: [] };
    const { sc, why } = scoreImage('健鼎3044營收月增', image);
    expect(sc).toBe(10 + 6 + 3 * 2);
    expect(why[0]).toBe('股名健鼎');
  });

  test('旁白點名的股票在排行榜的某一列：+8，並回傳那一列', () => {
    const { scoreImage } = matcherWith({ stockNames: { 2330: '台積電' } });
    const image = { page: 'focus-list', words: [word('台積電', 60, 560)] };
    const { sc, row } = scoreImage('台積電上漲', image);
    expect(sc).toBeGreaterThanOrEqual(8);
    expect(row.name).toBe('台積電');
  });
});

describe('enrichImages', () => {
  test('股名用代號補齊；指數頁加上去掉「指數」的口語別名', () => {
    const imgs = [{ stockCode: '2408' }, { stockName: '加權指數' }, { stockCode: '2330', stockName: '台積' }];
    enrichImages(imgs, { 2408: '南亞科', 2330: '台積電' });
    expect(imgs[0]).toMatchObject({ stockName: '南亞科', _nameFromCode: true });
    expect(imgs[1].stockNameAlts).toEqual(['加權']);
    expect(imgs[2].stockNameAlts).toEqual(['台積電']);
  });
});
