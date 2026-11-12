'use strict';

// 右側大標題太長時在畫面上折行（2026-11-12 使用者：「標題字太小了！放大再放大但不要太超過」）。
// title-layout.ts 是 TypeScript，用 esbuild（Remotion 已帶）轉成 CommonJS 再測。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { applicationPath } = require('../paths');

const APP = applicationPath(path.resolve(__dirname, '../..'));
const esbuild = require(require.resolve('esbuild', { paths: [APP] }));
const src = fs.readFileSync(path.join(APP, 'src/DapanXiaobao/title-layout.ts'), 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', esbuild.transformSync(src, { loader: 'ts', format: 'cjs' }).code)(mod, mod.exports);
const { splitTitle, wrapTitleLines, fitTitleSize } = mod.exports;

const MAX_W = 706;            // 1920 − (1178 + 12) − 24
const MAX_EM = MAX_W / (58 * 1.08);

test('7eov 標題：白色那句太長 → 在「！」後折行，顏色跟著原句；字級比原本的 37px 大很多', () => {
  const rows = wrapTitleLines(splitTitle('只差 80 點！台股收盤險守「修正線」，\n明天這個價位一定要看'), MAX_EM);
  assert.deepEqual(rows, [
    { text: '只差 80 點！', group: 0 },
    { text: '台股收盤險守「修正線」', group: 0 },
    { text: '明天這個價位一定要看', group: 1 },
  ]);
  const size = fitTitleSize(rows.map((r) => r.text), MAX_W, 74);
  assert.ok(size >= 58, `字級 ${size}`);
  assert.ok(fitTitleSize(['只差 80 點！台股收盤險守「修正線」，', '明天這個價位一定要看'], MAX_W, 74) < 40, '原本的排法');
});

test('放得下就不折；沒有標點時不切在數字中間、不讓括號落單', () => {
  assert.deepEqual(wrapTitleLines(['暴漲近2,000點', '但這3個訊號還沒到位'], MAX_EM).map((r) => r.text),
    ['暴漲近2,000點', '但這3個訊號還沒到位']);
  const rows = wrapTitleLines(['外資連三天賣超2,548億投信反手大買'], MAX_EM);
  assert.equal(rows.length, 2);
  assert.equal(rows.map((r) => r.text).join(''), '外資連三天賣超2,548億投信反手大買');
  assert.ok(rows.every((r) => !/2,5$|^48/.test(r.text)), JSON.stringify(rows));
});

test('一行標題拆兩句時，數字裡的逗號不是切點', () => {
  assert.deepEqual(splitTitle('暴漲近2,000點但這3個訊號還沒到位，明天要看'), ['暴漲近2,000點但這3個訊號還沒到位', '明天要看']);
});
