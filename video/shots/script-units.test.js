'use strict';

const { analyzeScript } = require('./script-units');

const script = (body, voice = '') => `${voice}\n===\n標題\n===\n${body}`;

describe('analyzeScript', () => {
  test('子句依標點切（逗號也切），句子依句號聚合', () => {
    const s = analyzeScript(script('營收創新高，月增兩成。法人買超。'));
    expect(s.clauses.map((c) => c.text)).toEqual(['營收創新高，', '月增兩成。', '法人買超。']);
    // 內文開頭的換行也算一次斷句，所以編號從 1 開始；重點是同一句的子句共用編號
    expect(s.clauses.map((c) => c.sid)).toEqual([1, 1, 2]);
    expect(s.sentenceList.map((x) => x.text)).toEqual(['營收創新高，月增兩成。', '法人買超。']);
  });

  test('units 帶清洗後的字元索引，頭尾跟逐字清單一致', () => {
    const s = analyzeScript(script('今天大漲，明天再看。'));
    const [first, second] = s.unitList;
    expect(first).toMatchObject({ i: 0, startCharIdx: 0 });
    expect(second.sid).toBe(first.sid);
    expect(second.startCharIdx).toBe(first.endCharIdx + 1);
    expect(s.chars.map((c) => c.c).join('')).toBe('今天大漲明天再看');
    expect(s.chars[3].b).toBe(1); // 「漲」後面是逗號
  });

  test('手寫 (shot:)／(imageN) 標記記為人工段落', () => {
    const s = analyzeScript(script('(shot:k線)台股反彈(shot:k線)，(image2)外資買超(image2)。'));
    expect(s.marks).toEqual([
      expect.objectContaining({ src: 'k線.png', _manual: true }),
      expect.objectContaining({ src: 'image2.png', _manual: true, _overlay: true }),
    ]);
    expect(s.origPhrase(s.marks[0].startCharIdx, s.marks[0].endCharIdx)).toBe('台股反彈');
  });

  test('判定吃原稿的字，不吃發音替換後的字', () => {
    const s = analyzeScript(script('萬海大漲。', '萬海→one海'));
    expect(s.clauses[0].text).toBe('萬海大漲。');
  });
});
