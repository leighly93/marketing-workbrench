'use strict';

const { splitEnumerations, assignShots, applyTimingRules, resolveOverlaps, MAX_SHOT_SEC } = require('./plan');

const namesOf = (img) => [img.stockName, ...(img.stockNameAlts || [])].filter(Boolean);
const times = (n, perChar = 0.2) => Array.from({ length: n }, (_, i) => ({ start: i * perChar, end: (i + 1) * perChar }));

describe('splitEnumerations', () => {
  test('一個子句點名兩檔股票就依股名位置切開，一檔一段', () => {
    const clauses = [{ text: '友達群創雙漲停。', start: 0, end: 8, sid: 0, blk: 0, u: 0 }];
    const out = splitEnumerations(clauses, [{ stockName: '友達' }, { stockName: '群創' }], namesOf);
    expect(out.map((c) => c.text)).toEqual(['友達', '群創雙漲停。']);
    expect(out[1]).toMatchObject({ start: 2, end: 8, sid: 0, u: 0 });
  });

  test('只點名一檔就不動', () => {
    const clauses = [{ text: '友達漲停。', start: 0, end: 5, sid: 0, blk: 0, u: 0 }];
    expect(splitEnumerations(clauses, [{ stockName: '友達' }], namesOf)).toEqual(clauses);
  });
});

describe('assignShots', () => {
  const clause = (text, start, sid, u = start) => ({ text, start, end: start + text.length, sid, blk: 0, u });
  const toCleaned = (a, b) => ({ startCharIdx: a, endCharIdx: b - 1 });

  test('分數達門檻才配圖；換句沒配到就回講者；人工段落不碰', () => {
    const imgs = [{ file: 'a.png', page: 'p', isStockPage: true, stockName: '健鼎' }];
    const matcher = {
      scoreImage: (text) => (text.includes('健鼎') ? { sc: 13, why: ['股名健鼎'], row: null } : { sc: 0, why: [], row: null }),
      findCell: (text) => (text.includes('營收') ? { cell: { x: 1, y: 1, w: 1, h: 1 }, cellText: '營收' } : null),
    };
    const clauses = [clause('健鼎營收大增，', 0, 0), clause('人工標的這句。', 7, 1), clause('明天再說。', 14, 2)];
    const manual = [{ startCharIdx: 7, endCharIdx: 13 }];
    const { auto, used, preview } = assignShots({ clauses, imgs, manual, toCleaned, matcher });
    expect(auto).toHaveLength(1);
    expect(auto[0]).toMatchObject({ src: 'a.png', startCharIdx: 0, endCharIdx: 6, cellText: '營收', _auto: true });
    expect([...used]).toEqual(['a.png']);
    expect(preview[1]).toMatch(/手動標記/);
    expect(preview[2]).toMatch(/講者/);
  });

  test('同一張圖、同一個框的連續子句併成一段', () => {
    const imgs = [{ file: 'a.png', page: 'p' }];
    const matcher = {
      scoreImage: () => ({ sc: 5, why: ['關鍵字'], row: null }),
      findCell: () => ({ cell: { x: 1, y: 1, w: 1, h: 1 }, cellText: '同一格' }),
    };
    const { auto } = assignShots({ clauses: [clause('甲甲，', 0, 0), clause('乙乙。', 3, 0)], imgs, manual: [], toCleaned, matcher });
    expect(auto).toHaveLength(1);
    expect(auto[0].endCharIdx).toBe(5);
  });
});

describe('applyTimingRules', () => {
  test(`一張圖最長 ${MAX_SHOT_SEC} 秒，超過就截斷`, () => {
    const auto = [{ startCharIdx: 0, endCharIdx: 99, _sid: 0 }];
    applyTimingRules(auto, times(100, 0.2));
    expect(auto[0].endCharIdx).toBe(49);
  });

  test('重分配後還是太短的段落拿掉（寧可少一張也不要閃）', () => {
    const auto = [{ startCharIdx: 0, endCharIdx: 1, _sid: 0 }, { startCharIdx: 10, endCharIdx: 30, _sid: 1 }];
    applyTimingRules(auto, times(40, 0.2));
    expect(auto).toHaveLength(1);
    expect(auto[0].startCharIdx).toBe(10);
  });

  test('沒有字幕時間就不動', () => {
    const auto = [{ startCharIdx: 0, endCharIdx: 99, _sid: 0 }];
    applyTimingRules(auto, []);
    expect(auto[0].endCharIdx).toBe(99);
  });
});

describe('resolveOverlaps', () => {
  test('人工標注重疊時後標的為主', () => {
    const manual = [
      { src: 'a.png', startCharIdx: 0, endCharIdx: 20 },
      { src: 'b.png', startCharIdx: 10, endCharIdx: 30 },
    ];
    const { items, notes } = resolveOverlaps(manual, times(40, 0.2));
    expect(notes.length).toBeGreaterThan(0);
    expect(items.find((m) => m.src === 'b.png')).toMatchObject({ startCharIdx: 10, endCharIdx: 30 });
    expect(items.find((m) => m.src === 'a.png').endCharIdx).toBeLessThan(10);
  });
});
