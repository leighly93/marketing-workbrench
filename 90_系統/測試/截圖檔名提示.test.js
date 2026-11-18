'use strict';

// 截圖原始檔名＝出現位置的提示（2026-11-16）：檔名寫旁白的一小段原文，那張圖就配在那幾句。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { applicationPath } = require('../paths');

const APP = applicationPath(path.resolve(__dirname, '../..'));
const hints = require(path.join(APP, 'scripts/shot-name-hints'));
const planner = require(path.join(APP, 'scripts/shot-planner'));

const UNITS = [
  { i: 0, sid: 0, text: '今天台股大漲', startCharIdx: 0, endCharIdx: 5 },
  { i: 1, sid: 0, text: '收在41,661點', startCharIdx: 6, endCharIdx: 14 },
  { i: 2, sid: 1, text: '外資賣超816億', startCharIdx: 15, endCharIdx: 22 },
  { i: 3, sid: 1, text: '投信買超88.7億', startCharIdx: 23, endCharIdx: 31 },
  { i: 4, sid: 2, text: '聯發科大漲9.88%', startCharIdx: 32, endCharIdx: 41 },
  { i: 5, sid: 2, text: '台達電漲停', startCharIdx: 42, endCharIdx: 46 },
  { i: 6, sid: 2, text: '日月光也強彈', startCharIdx: 47, endCharIdx: 52 },
  { i: 7, sid: 3, text: '台股今天量縮', startCharIdx: 53, endCharIdx: 58 },
];

test('原文片段：標點、空白、全形、副檔名、「 (1)」都不計', () => {
  assert.deepEqual(pick(hints.hintFor('外資賣超816億.png', UNITS)), [2, 2, 'exact']);
  assert.deepEqual(pick(hints.hintFor('收在 41661 點 (1).jpg', UNITS)), [1, 1, 'exact']);
  assert.deepEqual(pick(hints.hintFor('投信買超８８．７億.PNG', UNITS)), [3, 3, 'exact']);
  // 跨兩個子句也可以（中間的逗號不算）
  assert.deepEqual(pick(hints.hintFor('台達電漲停日月光.png', UNITS)), [5, 6, 'exact']);
});

test('「頭_尾」涵蓋一段；錯一兩個字取最像的那句', () => {
  assert.deepEqual(pick(hints.hintFor('聯發科大漲_日月光也強彈.png', UNITS)), [4, 6, 'exact']);
  assert.deepEqual(pick(hints.hintFor('聯發科大漨9.88%.png', UNITS)), [4, 4, 'fuzzy']);
});

test('相機編號、螢幕截圖、shotN 不算提示；對到好幾處或對不到要講出來', () => {
  for (const n of ['1000090084.jpeg', 'IMG_2231.PNG', 'shot3.png', 'Screenshot 2026-11-16 at 10.23.45.png', '螢幕截圖 2026-11-16 上午10.23.45.png']) {
    assert.equal(hints.hintFor(n, UNITS).skip, 'not-hint', n);
  }
  assert.equal(hints.hintFor('台股.png', UNITS).skip, 'ambiguous');
  assert.equal(hints.hintFor('鴻海法說會.png', UNITS).skip, 'not-found');
  const { hints: h, notes } = hints.resolveHints({ 'shot1.png': '外資賣超816億.png', 'shot2.png': '台股.png', 'shot3.png': 'IMG_1.png' }, UNITS);
  assert.deepEqual(Object.keys(h), ['shot1.png']);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /shot2\.png.*不只一次/);
});

test('applyHints：Claude 已經配對了就照它的；配錯地方就搬到提示的句子、別張圖讓開', () => {
  const h = { file: 'shot2.png', from: 2, to: 2, name: '外資賣超816億' };
  // Claude 已經把 shot2 配在 U1～U3（包含 U2）→ 不動
  const ok = planner.applyHints([{ src: 'shot2.png', startCharIdx: 6, endCharIdx: 31, title: '法人' }], [h], UNITS);
  assert.deepEqual(ok.map((s) => [s.src, s.startCharIdx, s.endCharIdx, s.title]), [['shot2.png', 6, 31, '法人']]);
  // Claude 把 shot1 配在 U1～U3、shot2 配到 U7 → shot1 裁成 U1、U3 兩段中的前段；shot2 在 U2 新增
  const moved = planner.applyHints([
    { src: 'shot1.png', startCharIdx: 6, endCharIdx: 31, title: '加權' },
    { src: 'shot2.png', startCharIdx: 53, endCharIdx: 58, title: '法人買賣' },
  ], [h], UNITS);
  assert.deepEqual(moved.map((s) => [s.src, s.startCharIdx, s.endCharIdx, s.title]), [
    ['shot1.png', 6, 14, '加權'],
    ['shot2.png', 15, 22, '法人買賣'],
    ['shot2.png', 53, 58, '法人買賣'],
  ]);
});

function pick(h) { return [h.from, h.to, h.how]; }

test('同一段話＋結尾編號（2026-11-17「包含創意、欣興、奇鋐1／2／3」）：照編號切給每張，疊起來依序出現', () => {
  const U = [
    { i: 0, sid: 0, text: '其中44檔連續兩天跌停，', startCharIdx: 0, endCharIdx: 10 },
    { i: 1, sid: 0, text: '包含創意、', startCharIdx: 11, endCharIdx: 15 },
    { i: 2, sid: 0, text: '欣興、', startCharIdx: 16, endCharIdx: 18 },
    { i: 3, sid: 0, text: '奇鋐。', startCharIdx: 19, endCharIdx: 21 },
  ];
  const { hints: h, notes } = hints.resolveHints({
    'shot2.jpg': '包含創意、欣興、奇鋐3.jpg', 'shot3.jpg': '包含創意、欣興、奇鋐1.jpg', 'shot4.jpg': '包含創意、欣興、奇鋐2.jpg',
  }, U);
  assert.deepEqual(notes, []);
  // 去掉編號後是原文 → exact；編號就是出場順序，不是 shotN 的順序
  assert.deepEqual([h['shot3.jpg'].from, h['shot4.jpg'].from, h['shot2.jpg'].from], [1, 2, 3]);
  assert.equal(h['shot3.jpg'].how, 'exact');
  assert.deepEqual(h['shot2.jpg'].order, [3, 3]);

  // Claude 把其中一張配在整段：照切好的位置放，三張都留下、共用 Claude 的小標題
  const claude = [{ src: 'shot2.jpg', startCharIdx: 11, endCharIdx: 21, title: '連兩天跌停' }];
  const segs = planner.applyHints(claude, Object.entries(h).map(([file, x]) => ({ file, ...x })), U);
  assert.deepEqual(segs.map((s) => [s.src, s.startCharIdx, s.endCharIdx, s.title]), [
    ['shot3.jpg', 11, 15, '連兩天跌停'], ['shot4.jpg', 16, 18, '連兩天跌停'], ['shot2.jpg', 19, 21, '連兩天跌停'],
  ]);
});

test('同一段話的子句不夠分：照字數平均切；本身就以數字結尾的原文不當成編號', () => {
  const U = [
    { i: 0, sid: 0, text: '今天大盤重挫', startCharIdx: 0, endCharIdx: 5 },
    { i: 1, sid: 0, text: '創意欣興奇鋐都跌停', startCharIdx: 6, endCharIdx: 14 },
  ];
  const { hints: h } = hints.resolveHints({ 'a.png': '創意欣興奇鋐都跌停2.png', 'b.png': '創意欣興奇鋐都跌停1.png', 'c.png': '創意欣興奇鋐都跌停3.png' }, U);
  assert.deepEqual(['b.png', 'a.png', 'c.png'].map((f) => [h[f].startCharIdx, h[f].endCharIdx]), [[6, 8], [9, 11], [12, 14]]);
  // 「收在41,661點」以數字結尾也照整段比對，不會被拆成「收在41,66」＋編號 1
  const one = hints.hintFor('收在41661.png', UNITS);
  assert.equal(one.seq, undefined);
  assert.deepEqual(pick(one), [1, 1, 'exact']);
});
