'use strict';

// 大盤小報語速（2026-11-17 使用者定案）：MiniMax 直接講快 130%，HeyGen 照快速音檔對嘴，不再事後加速；
// 非 MiniMax 配的大盤小報講者影片事後 130%；其他版型維持原速配音＋事後 125%。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { applicationPath } = require('../paths');

const APP = applicationPath(path.resolve(__dirname, '../..'));
const src = fs.readFileSync(path.join(APP, 'run.js'), 'utf8');

test('MiniMax 語速：只有大盤小報 1.3，送進 voice_setting', () => {
  assert.match(src, /const MINIMAX_TTS_SPEED = TEMPLATE === "dapan" \? 1\.3 : 1\.0;/);
  assert.match(src, /voice_id: voiceId,\n\s+speed: MINIMAX_TTS_SPEED,/);
});

test('MiniMax 講快的講者影片一下載就蓋記號，統一加速會略過；事後加速大盤小報 130%、其他 125%', () => {
  assert.match(src, /await downloadVideo\(videoUrl, heygenPath\);\n.*\n\s+if \(FIXED_ANCHOR_USE_MINIMAX\) stampSpedByMinimax\(heygenPath\);/);
  assert.match(src, /-metadata comment="\$\{SPED_TAG\}=minimax\$\{MINIMAX_TTS_SPEED\}"/, '記號要用 alreadySpedUp 認得的 SPED_TAG');
  assert.match(src, /if \(MINIMAX_TTS_SPEED === 1\) return;/, '原速配音的版型不蓋記號');
  assert.match(src, /const SPEED_FACTOR = TEMPLATE === "dapan" \? 1\.3 : 1\.25;/);
});
