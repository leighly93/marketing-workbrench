'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { applicationPath, dataPath } = require('../paths');

// 空結構只供首次載入／編譯，並非製作樣本；出片流程會寫入真正生成資料。
const generated = {
  'subtitles.json': { text: '', segments: [], language: 'zh', _scriptBreaks: [], _scriptCharTimes: [] },
  'video-meta.json': { heygenDurationSec: 1, outroDurationSec: 0, headerDate: '', titleText: '', _bootstrap: true },
  // 字幕重點詞（2026-09-17）：人工在配圖計畫頁標的腳本字元範圍，所有版型共用一份
  //（字幕本身就只有 src/subtitles.json 一份，不分版型）。
  'emphasis.generated.json': { marks: [] },
  'overlays.generated.json': [],
  'textcards.generated.json': [],
  'marketing-shots.generated.json': [],
  'DapanXiaobao/dapan-shots.generated.json': [],
  'MiddayFocus/midday-shots.generated.json': [],
  'UsStock/usstock-shots.generated.json': [],
  'Focusstock/focusstock-shots.generated.json': [],
  'Focusstock/focusstock-assets.generated.json': { hasBgm: false, bgmFile: '' },
  'Institution/institution-shots.generated.json': [],
  'Institution/institution-focus.generated.json': [],
  'Institution/institution-regions.generated.json': { imageFile: '', imageWidth: 1, imageHeight: 1, sections: {}, words: [] },
};

function initialize(root) {
  const created = [], preserved = [];
  function writeMissing(file, content, mode) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.writeFileSync(file, content, { flag: 'wx', ...(mode ? { mode } : {}) });
      created.push(path.relative(root, file));
    } catch (error) {
      if (error.code !== 'EEXIST' || !fs.statSync(file).isFile()) throw error;
      preserved.push(path.relative(root, file));
    }
  }
  const json = (value) => JSON.stringify(value, null, 2) + '\n';
  for (const [name, value] of Object.entries(generated)) writeMissing(applicationPath(root, 'src', name), json(value));
  for (const [name, value] of Object.entries({
    'pronounce.json': [], 'stock-names.json': {},
    'shot-memory.json': { codeNames: {}, pages: {}, pagesMulti: {} },
    'page-samples/page-types.json': { version: 1, types: [] },
  })) writeMissing(dataPath(root, name), json(value));
  for (const name of ['messages.jsonl', 'corrections.jsonl']) writeMissing(dataPath(root, name), '');
  for (const dir of ['工作紀錄', '90_系統/暫存/產線輸出', '90_系統/製作備份/未指定工作']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.mkdirSync(applicationPath(root, 'public'), { recursive: true });
  let env = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  env = env.replace(/^ADMIN_KEY=.*$/m, `ADMIN_KEY=${crypto.randomBytes(24).toString('hex')}`);
  writeMissing(path.join(root, '.env'), env, 0o600);
  return { created, preserved };
}

if (require.main === module) {
  const result = initialize(path.resolve(__dirname, '../..'));
  console.log(`初始化完成：新增 ${result.created.length} 檔，保留 ${result.preserved.length} 個既有檔案。`);
  console.log('未生成影片、未呼叫外部服務。請依需要設定 .env，再執行 npm run doctor。');
}
module.exports = { initialize, generated };
