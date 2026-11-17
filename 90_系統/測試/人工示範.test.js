'use strict';

// 人工框選紀錄接回 Claude 排配圖（2026-11-13 使用者：「之前有做紀錄讓 OCR 看截圖人怎麼選怎麼用，那個現在有幫助嗎？」→ 兩件都做）：
//   ① 重新出片原封不動帶過來的標注不重記、不重學（11/12～13 的 71 筆裡 68 筆是重複）
//   ② 排卡片時附上同一種頁面以前人怎麼裁、怎麼框

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { applicationPath } = require('../paths');

const APP = applicationPath(path.resolve(__dirname, '../..'));
const memory = require(path.join(APP, 'scripts/shot-memory'));
const picker = require(path.join(APP, 'scripts/cell-picker'));

const MULTI = {
  'revenue@0.46': [
    { cell: { x: 0.33, y: 0.73, w: 0.16, h: 0.04 }, region: { x: 0, y: 0.68, w: 1, h: 0.26 }, phrases: ['南亞科8月營收446.9億元再創歷史新高'], hits: 1 },
    { cell: { x: 0.79, y: 0.45, w: 0.13, h: 0.21 }, region: { x: 0, y: 0.22, w: 1, h: 0.46 }, phrases: ['南亞科78月營收合計已經超過第二季整季'], hits: 1 },
    { cell: { x: 0.36, y: 0.77, w: 0.13, h: 0.03 }, region: { x: 0, y: 0.71, w: 1, h: 0.22 }, phrases: ['雙鴻7月營收37.65億元'], hits: 5 },
    { cell: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, phrases: [], hits: 9 },   // 沒有旁白的不拿來當示範
  ],
};

test('示範：同一種頁面裡挑旁白最像的，都不像就挑用最多次的；最多 n 筆', () => {
  const ex = memory.examplesFor(MULTI, 'revenue@0.46', '環球晶9月營收51.29億元', 2);
  assert.equal(ex.length, 2);
  assert.match(ex[0].phrase, /營收/);
  assert.ok(ex.every((e) => e.cell && e.phrases === undefined));
  assert.deepEqual(memory.examplesFor(MULTI, 'kline@0.46', '環球晶'), [], '別種頁面不拿');
  assert.deepEqual(memory.examplesFor({}, 'revenue@0.46', '營收'), []);
  assert.equal(memory.examplesFor(MULTI, 'revenue@0.46', '完全無關的一句話', 9).length, 3);
});

test('卡片 prompt：示範座標換算成送出去的圖尺寸，沒有示範就不出現這段', () => {
  const ex = memory.examplesFor(MULTI, 'revenue@0.46', '雙鴻7月營收', 1);
  const p = picker.buildCardPrompt({ steps: [{ id: 'U1', text: '雙鴻7月營收' }], page: 'revenue', listing: '', width: 1000, height: 2000, examples: ex });
  assert.match(p, /剪輯師以前在\*\*同一種頁面\*\*/);
  assert.match(p, /旁白「雙鴻7月營收37\.65億元」→ 卡片 \[0, 1420, 1000, 440\]、金框 \[360, 1540, 130, 60\]/);
  assert.match(p, /股價卡規則仍然優先/);
  const none = picker.buildCardPrompt({ steps: [{ id: 'U1', text: 'x' }], page: 'revenue', listing: '', width: 10, height: 10 });
  assert.doesNotMatch(none, /剪輯師以前/);
});

test('接線：排配圖照頁面找示範傳給 pickCard；重新出片原封不動的標注不重記不重學', () => {
  const plan = fs.readFileSync(path.join(APP, 'scripts/claude-shot-plan.js'), 'utf8');
  assert.match(plan, /memory\.examplesFor\(pagesMulti, memory\.memKeyOf\(\{ page: im\.page/);
  const engine = fs.readFileSync(path.join(APP, 'scripts/cell-picker-engine.js'), 'utf8');
  assert.match(engine, /buildCardPrompt\(\{[^)]*examples[, }][^)]*\}\)/);
  const server = fs.readFileSync(path.join(APP, 'server/index.js'), 'utf8');
  assert.match(server, /function annotsInheritedUnchanged\(job\)/);
  assert.match(server, /if \(!annotsInheritedUnchanged\(job\)\) try \{\n      const ann = JSON\.parse/, 'learnFromEdits');
  assert.match(server, /if \(!annotsInheritedUnchanged\(job\)\) try \{\n    const ann = JSON\.parse/, 'recordCorrections');
});
