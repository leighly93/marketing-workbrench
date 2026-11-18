'use strict';

// 卡片輪播最短停留（2026-11-18 使用者選「輪播」）：疊不下的卡一張一張輪播，每個畫面至少停 0.8 秒，
// 太快的往後順延；時間不夠就平均分，不超出卡片區塊。card-pacing.ts 用 esbuild 轉成 CommonJS 再測。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { applicationPath } = require('../paths');

const APP = applicationPath(path.resolve(__dirname, '../..'));
const esbuild = require(require.resolve('esbuild', { paths: [APP] }));
const src = fs.readFileSync(path.join(APP, 'src/DapanXiaobao/card-pacing.ts'), 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', esbuild.transformSync(src, { loader: 'ts', format: 'cjs' }).code)(mod, mod.exports);
const { paceUnits, MIN_DWELL_SEC } = mod.exports;
const r2 = (xs) => xs.map((x) => Math.round(x * 100) / 100);

test('三張高的圖各唸 0.4 秒：每張停 0.8 秒、往後順延', () => {
  assert.equal(MIN_DWELL_SEC, 0.8);
  assert.deepEqual(r2(paceUnits([10, 10.4, 10.8], [10, 10.4, 10.8], 14)), [10, 10.8, 11.6]);
});

test('本來就停夠久的不動', () => {
  assert.deepEqual(paceUnits([10, 12, 15], [10, 12, 15], 18), [10, 12, 15]);
});

test('區塊時間不夠每張 0.8 秒：平均分，最後一張也停得到', () => {
  const out = paceUnits([10, 10.3, 10.6], [10, 10.3, 10.6], 11.5);
  assert.deepEqual(r2(out), [10, 10.5, 11]);
  assert.ok(out[2] + 0.5 <= 11.5 + 1e-9);
});

test('一疊 3 張後接第 4 張：從疊滿那一刻起算 0.8 秒才換', () => {
  // 一疊：第一張 10.0、最後一張 10.6；第 4 張原本 10.9 就要進來
  assert.deepEqual(r2(paceUnits([10, 10.9], [10.6, 10.9], 14)), [10, 11.4]);
});

test('AppCardShots 輪播前先過 paceUnits，整張卡（含金框換位）一起挪', () => {
  const tsx = fs.readFileSync(path.join(APP, 'src/DapanXiaobao/AppCardShots.tsx'), 'utf8');
  assert.match(tsx, /const paced = paceUnits\(units\.map\(\(g\) => g\[0\]\.startSec\), units\.map\(\(g\) => g\[g\.length - 1\]\.startSec\), b\.endSec\);/);
  assert.match(tsx, /steps: c\.steps\.map\(\(st\) => \(\{ \.\.\.st, startSec: Math\.min\(until, st\.startSec \+ d\) \}\)\)/);
});
