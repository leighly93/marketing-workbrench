'use strict';

const assert = require('node:assert/strict');
const tts = require('../pipeline/tts-text');

test('發音替換只讀 === 之前、略過 # 註解行', () => {
  const raw = '# 發音替換\n台積電→台基電\n# 註解→不要\n===\n標題\n===\n內文→不算';
  assert.deepEqual(tts.parseVoiceReplacements(raw), [{ from: '台積電', to: '台基電' }]);
});

test('減號：數字之間保留，其餘刪掉；全形破折號不動', () => {
  assert.equal(tts.stripSpeechHyphens('世芯-KY 未來 3-5 天'), '世芯KY 未來 3-5 天');
  assert.equal(tts.stripSpeechHyphens('等等—再說'), '等等—再說');
});

test('年份轉逐字中文，其他數字不動', () => {
  assert.equal(tts.numFix('2026 年營收 1,205 億'), '二零二六年營收 1,205 億');
  assert.equal(tts.numFix('2023-2024 年'), '2023-2024 年');
  assert.equal(tts.numFix('代號 2330 台積電'), '代號 2330 台積電');
});

test('cleanScript 只取最後一段內文，拿掉 marker 與括號內容', () => {
  const raw = '# 發音替換\n===\n標題\n===\n今天(image1)大盤(image1)（補充說明）上漲(logo)，(text:重點)字卡(/text)2026年見。';
  assert.equal(tts.cleanScript(raw), '今天大盤上漲，二零二六年見。');
});
