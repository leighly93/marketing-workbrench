'use strict';

const { parseShots, findShotSrc, titleFromScript, headerDateOf } = require('./parse-shots');

const script = (body, { voice = '', title = '標題' } = {}) => `${voice}\n===\n${title}\n===\n${body}\n`;

describe('parseShots', () => {
  test('(shot:名稱) 換成字元索引與錨點，錨點取原稿前後 3 字', () => {
    const { shots, skipped } = parseShots(script('開場白。(shot:大盤)今天台股大漲三百點(shot:大盤)收尾。'));
    expect(skipped).toEqual([]);
    expect(shots).toHaveLength(1);
    expect(shots[0]).toMatchObject({ src: '大盤.png', startAnchor: '今天台', endAnchor: '三百點', _phrase: '今天台股大漲三百點' });
    expect(shots[0].endCharIdx - shots[0].startCharIdx + 1).toBe('今天台股大漲三百點'.length);
  });

  test('多個標記依出現順序，大小寫不分', () => {
    const { shots } = parseShots(script('(SHOT:a)第一段(shot:a)，(shot:b)第二段(Shot:b)'));
    expect(shots.map((s) => s._phrase)).toEqual(['第一段', '第二段']);
    expect(shots[1].startCharIdx).toBeGreaterThan(shots[0].endCharIdx);
  });

  test('發音替換只影響座標系，顯示的字取原稿', () => {
    const { shots } = parseShots(script('(shot:x)台積電上漲(shot:x)', { voice: '台積電→台基電' }));
    expect(shots[0]._phrase).toBe('台積電上漲');
  });

  test('標記裡只有空白就跳過並回報', () => {
    const { shots, skipped } = parseShots(script('(shot:空)   (shot:空)正文'));
    expect(shots).toEqual([]);
    expect(skipped).toEqual(['空']);
  });

  test('截圖副檔名依 public/ 實際存在的檔案決定', () => {
    expect(findShotSrc('a', (f) => f === 'a.jpg')).toBe('a.jpg');
    expect(findShotSrc('a', (f) => f === 'a')).toBe('a');
    expect(findShotSrc('a', () => false)).toBe('a.png');
  });
});

describe('titleFromScript', () => {
  test('標準 3 段與多打一個空 === 的 4 段都抓得到標題', () => {
    expect(titleFromScript('詞庫\n===\n今日標題\n===\n內文')).toBe('今日標題');
    expect(titleFromScript('詞庫\n===\n\n===\n今日標題\n===\n內文')).toBe('今日標題');
  });
  test('沒有標題段回空字串', () => {
    expect(titleFromScript('只有內文')).toBe('');
  });
});

describe('headerDateOf', () => {
  test('以台北時間算 MMDD（UTC 深夜已是台北隔天）', () => {
    expect(headerDateOf(new Date('2026-10-06T17:00:00Z'))).toBe('1007');
    expect(headerDateOf(new Date('2026-01-05T03:00:00Z'))).toBe('0105');
  });
});
