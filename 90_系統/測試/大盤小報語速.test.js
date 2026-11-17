'use strict';

// 語速（2026-11-17 使用者定案改回）：所有版型 MiniMax 原速配音＋事後 ffmpeg 加速（大盤小報 130%、其他 125%）。
// 同日上午大盤小報曾改成 MiniMax 直接講快 150%，那批影片已蓋記號，重跑不會再加速。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { applicationPath } = require('../paths');

const APP = applicationPath(path.resolve(__dirname, '../..'));
const src = fs.readFileSync(path.join(APP, 'run.js'), 'utf8');

test('MiniMax 語速：所有版型原速 1.0，送進 voice_setting', () => {
  assert.match(src, /const MINIMAX_TTS_SPEED = 1\.0;/);
  assert.match(src, /voice_id: voiceId,\n\s+speed: MINIMAX_TTS_SPEED,/);
});

test('事後加速大盤小報 130%、其他 125%；原速配音不蓋記號，MiniMax 講快過的舊影片仍認得記號', () => {
  assert.match(src, /const SPEED_FACTOR = TEMPLATE === "dapan" \? 1\.3 : 1\.25;/);
  assert.match(src, /if \(MINIMAX_TTS_SPEED === 1\) return;/, '原速配音的版型不蓋記號');
  assert.match(src, /-metadata comment="\$\{SPED_TAG\}=minimax\$\{MINIMAX_TTS_SPEED\}"/, '記號要用 alreadySpedUp 認得的 SPED_TAG');
});
