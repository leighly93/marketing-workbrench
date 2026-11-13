'use strict';

// 大盤小報橫式明體字幕（2026-11-11）：重點詞紅／綠／金與金色底線的自動挑選規則。
// 規則本體是 src/DapanXiaobao/serif-emphasis.ts（純函式），這裡用 esbuild 轉成 CommonJS 直接測。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { applicationPath } = require('../paths');

const ROOT = path.resolve(__dirname, '../..');
const APP = applicationPath(ROOT);

function loadRules() {
  const esbuild = require(require.resolve('esbuild', { paths: [APP] }));
  const source = fs.readFileSync(path.join(APP, 'src/DapanXiaobao/serif-emphasis.ts'), 'utf8');
  const { code } = esbuild.transformSync(source, { loader: 'ts', format: 'cjs' });
  const mod = { exports: {} };
  new Function('module', 'exports', code)(mod, mod.exports);
  return mod.exports;
}
const { toneFor, pickUnderlines } = loadRules();

const toneOf = (text, word) => {
  const at = text.indexOf(word);
  return toneFor(text, at, at + word.length);
};

test('上漲字眼用紅、下跌字眼用綠，沒有方向用金', () => {
  assert.equal(toneOf('近五日已經漲了42.9%', '42.9%'), 'red');
  assert.equal(toneOf('光頡年增67.4%', '67.4%'), 'red');
  assert.equal(toneOf('華新科法人只買超7.4億', '7.4億'), 'red');
  assert.equal(toneOf('9月營收公布呈現年減7.3%', '7.3%'), 'green');
  assert.equal(toneOf('三大法人連兩天賣超', '賣超'), 'green');
  assert.equal(toneOf('國巨今天成交612億', '612億'), 'gold');
});

test('漲跌字眼同時出現就退回金色，不要賭方向', () => {
  assert.equal(toneOf('漲多跌少3%', '3%'), 'gold');
});

test('只看重點詞前 4 字、後 2 字，離太遠的字眼不算', () => {
  assert.equal(toneOf('昨天大漲今天成交量縮到9,744億', '9,744億'), 'gold');
});

test('底線最多 6 句、句首至少隔 8 秒，有數字的重點詞先挑', () => {
  const phrases = [
    { start: 0, hl: ['國巨'] },
    { start: 3, hl: ['612億'] },      // 有數字 → 先挑，擠掉 0 秒那句
    { start: 9, hl: [] },             // 沒重點詞不參加
    { start: 12, hl: ['42.9%'] },
    { start: 14, hl: ['7.3%'] },      // 離 12 秒太近
    { start: 30, hl: ['法人'] },
  ];
  assert.deepEqual([...pickUnderlines(phrases)].sort((a, b) => a - b), [1, 3, 5]);

  const many = Array.from({ length: 20 }, (_, i) => ({ start: i * 10, hl: ['1億'] }));
  assert.equal(pickUnderlines(many).size, 6);
  assert.equal(pickUnderlines([]).size, 0);
});

test('明體字型是完整 WOFF2 並附授權', () => {
  const font = fs.readFileSync(applicationPath(ROOT, 'public/NotoSerifTC-Black.woff2'));
  assert.equal(font.toString('ascii', 0, 4), 'wOF2', '不可把下載錯誤的 HTML 當字型');
  assert.equal(font.readUInt32BE(8), font.length, 'WOFF2 檔頭記錄的長度要等於實際檔案');
  assert.ok(font.length > 3 * 1024 * 1024, '完整字集約 3.7MB，太小代表被裁過字');
  assert.match(
    fs.readFileSync(path.join(ROOT, '90_系統/第三方授權/NotoSerifTC-OFL.txt'), 'utf8'),
    /SIL OPEN FONT LICENSE/,
  );
});

test('字幕字型 2026-11-12 起改思源黑體 900（使用者：明體難閱讀），用完整字集的可變字重檔', () => {
  const src = fs.readFileSync(applicationPath(ROOT, 'src/DapanXiaobao/SerifSubtitles.tsx'), 'utf8');
  assert.match(src, /const FONT_FILE = 'NotoSansTC-VF\.ttf'/);
  assert.match(src, /const FONT_WEIGHT = 900/);
  assert.match(src, /fontWeight: FONT_WEIGHT/);
  assert.ok(fs.statSync(applicationPath(ROOT, 'public/NotoSansTC-VF.ttf')).size > 5 * 1024 * 1024, '完整字集');
});
