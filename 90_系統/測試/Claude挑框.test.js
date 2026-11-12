'use strict';

// Claude 挑框旁觀模式（2026-11-11）：OCR 詞框編號 → Claude 只回編號 → 聯集成框 → 跟人工框比對。
// 不呼叫真的 claude：端到端那幾條用 CLAUDE_BIN 換成假的腳本。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { applicationPath } = require('../paths');

const ROOT = path.resolve(__dirname, '../..');
const APP = applicationPath(ROOT);
const picker = require(path.join(APP, 'scripts/cell-picker'));
const { summary } = require(path.join(APP, 'scripts/claude-cells'));

const WORDS = [
  { t: '塑化', x: 80, y: 220, w: 150, h: 70 },
  { t: '族群', x: 240, y: 224, w: 150, h: 72 },
  { t: '南亞', x: 86, y: 404, w: 150, h: 74 },
  { t: '7.17%', x: 600, y: 410, w: 200, h: 66 },
  { t: '台塑', x: 86, y: 584, w: 150, h: 74 },
  { t: '漲停', x: 600, y: 588, w: 150, h: 70 },
];

test('同一高度的詞框排成同一列，列內由左到右', () => {
  const rows = picker.rowsOf(WORDS);
  assert.deepEqual(rows.map((r) => r.map((w) => w.t)), [['塑化', '族群'], ['南亞', '7.17%'], ['台塑', '漲停']]);
  const c = picker.candidates(WORDS);
  assert.deepEqual(c.rows.get('R2'), ['W3', 'W4']);
  assert.match(c.listing, /R2（y≈441）：W3「南亞」x86 W4「7\.17%」x600/);
  // 縮圖比例：清單座標跟著換算，跟 Claude 看到的圖對得上
  assert.match(picker.candidates(WORDS, 0.5).listing, /R2（y≈221）：W3「南亞」x43 W4「7\.17%」x300/);
});

test('只認存在的編號；整列與單字合併；none 照實回報', () => {
  const c = picker.candidates(WORDS);
  assert.deepEqual(picker.parseReply('{"rows":["R2"],"words":["W6"],"why":"南亞"}', c).ids.sort(), ['W3', 'W4', 'W6']);
  assert.deepEqual(picker.parseReply('前言 {"rows":["R9"],"words":["W99"]}', c), { none: true, ids: [], why: '回覆的編號都不存在' });
  assert.equal(picker.parseReply('{"none":true,"why":"圖上沒有"}', c).none, true);
  assert.equal(picker.parseReply('不是 JSON', c), null);
});

test('回覆裡有好幾份 JSON（先答再改口）取最後一份', () => {
  const c = picker.candidates(WORDS);
  const text = '{"words":[],"box":null,"none":false}\n\nWait — 規則 1 說只框漲跌幅：{"words":["W4"],"why":"漲跌幅"}';
  assert.deepEqual(picker.parseReply(text, c), { none: false, ids: ['W4'], why: '漲跌幅' });
});

test('OCR 沒讀到時可以自己給 box（縮圖座標），換回原圖像素', () => {
  const c = picker.candidates(WORDS);
  const r = picker.parseReply('{"words":[],"box":[50,100,200,40],"why":"OCR 沒讀到"}', c);
  assert.deepEqual(r.box, { x: 50, y: 100, w: 200, h: 40 });
  assert.deepEqual(picker.unscaleBox(r.box, 0.5, 1170, 2532), { x: 100, y: 200, w: 400, h: 80 });
  assert.deepEqual(picker.unscaleBox({ x: 500, y: 0, w: 400, h: 10 }, 0.5, 1170, 2532), { x: 1000, y: 0, w: 170, h: 20 });
  assert.equal(picker.parseReply('{"words":[],"box":[1,2,0,5]}', c).none, true);
});

test('送給 Claude 的圖縮到長邊 1568、總像素 115 萬以內（超過它會自己再縮，座標就對不上）', () => {
  const { fitSize } = require(path.join(APP, 'scripts/claude-cli'));
  assert.deepEqual(fitSize(1206, 1221), { width: 1064, height: 1078, scale: 1064 / 1206 });
  assert.deepEqual(fitSize(1170, 2532), { width: 724, height: 1568, scale: 724 / 1170 });
  assert.deepEqual(fitSize(800, 600), { width: 800, height: 600, scale: 1 });
});

test('漲跌組自動補齊：漲跌點數＋正下方漲跌幅、左邊被讀成「人」的 ▲ 一起框', () => {
  // 取自 1109 暴漲近2,000點 shot1 的 OCR（聯發科、台達電兩檔）
  const words = [
    { t: '_3725', x: 18, y: 156, w: 289, h: 130 },
    { t: 'A335', x: 319, y: 180, w: 118, h: 34 },
    { t: '(9.88%)', x: 320, y: 230, w: 174, h: 44 },
    { t: '屬性', x: 531, y: 232, w: 319, h: 57 },
    { t: '_1160', x: 18, y: 471, w: 284, h: 128 },
    { t: '人', x: 319, y: 495, w: 29, h: 31 },
    { t: '105', x: 354, y: 492, w: 76, h: 36 },
  ];
  const c = picker.candidates(words);
  const idOf = (t) => [...c.words].find(([, w]) => w.t === t)[0];
  const texts = (ids) => ids.map((id) => c.words.get(id).t).sort();
  assert.deepEqual(texts(picker.expandChange([idOf('A335')], c)), ['(9.88%)', 'A335']);
  assert.deepEqual(texts(picker.expandChange([idOf('(9.88%)')], c)), ['(9.88%)', 'A335']);
  assert.deepEqual(texts(picker.expandChange([idOf('105')], c)), ['105', '人']);
  // 股價大字不是漲跌組，不能被帶進來
  assert.ok(!texts(picker.expandChange([idOf('A335')], c)).includes('_3725'));
});

test('編號挑到一部分、box 補 OCR 沒讀到的那塊，兩者都留著', () => {
  const c = picker.candidates(WORDS);
  const r = picker.parseReply('{"words":["W4"],"box":[600,480,200,40],"why":"補漲跌幅"}', c);
  assert.deepEqual(r.ids, ['W4']);
  assert.deepEqual(r.box, { x: 600, y: 480, w: 200, h: 40 });
});

test('框是詞框聯集外擴，夾在圖內', () => {
  assert.deepEqual(picker.unionBox([WORDS[2], WORDS[3]], 12, 1170, 2532), { x: 74, y: 392, w: 738, h: 98 });
  assert.deepEqual(picker.unionBox([{ x: 2, y: 3, w: 10, h: 10 }], 12, 100, 100), { x: 0, y: 0, w: 24, h: 25 });
  assert.equal(picker.unionBox([], 12, 100, 100), null);
});

test('數字驗算：對得上 pass、都對不上 fail、一邊沒數字 none', () => {
  assert.equal(picker.numberCheck('南亞 7.17%', '南亞漲7.17%台塑漲停'), 'pass');
  assert.equal(picker.numberCheck('成交 9,744 億', '成交量9744億'), 'pass');
  assert.equal(picker.numberCheck('台塑 5.4%', '南亞漲7.17%'), 'fail');
  assert.equal(picker.numberCheck('台塑 漲停', '南亞漲7.17%'), 'none');
});

test('重疊率', () => {
  assert.equal(picker.iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 }), 1);
  assert.equal(picker.iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 0, w: 10, h: 10 }), 0.333);
  assert.equal(picker.iou(null, { x: 0, y: 0, w: 1, h: 1 }), null);
});

// ── 端到端：假的 claude ──────────────────────────────────────────

// 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cells-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(state, 'src'), { recursive: true });
  fs.mkdirSync(path.join(state, 'public'), { recursive: true });
  fs.writeFileSync(path.join(state, 'public', 'shot1.png'), PNG);
  fs.writeFileSync(path.join(state, 'src', 'app-images.generated.json'), JSON.stringify({
    images: [{ file: 'shot1.png', width: 1170, height: 2532, page: 'unknown', words: WORDS }],
  }));
  fs.writeFileSync(path.join(dir, 'in.json'), JSON.stringify([
    { src: 'shot1.png', startCharIdx: 10, endCharIdx: 20, phrase: '南亞漲7.17%', imgW: 1170, imgH: 2532,
      cell: { x: 70, y: 390, w: 750, h: 100 } },
    { src: 'shot1.png', startCharIdx: 30, endCharIdx: 40, phrase: '今天還出現新的資金方向', imgW: 1170, imgH: 2532, cell: null },
  ]));
  fs.writeFileSync(path.join(dir, 'suggest.json'), JSON.stringify([
    { src: 'shot1.png', startCharIdx: 10, endCharIdx: 20, cell: { x: 328, y: 89, w: 503, h: 169 } },
  ]));
  // 假的 claude：記下 stdin，照旁白回 R2 或 none（stream-json 的 result 行）
  const fake = path.join(dir, 'fake-claude.js');
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs');
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(path.join(dir, 'stdin.log'))}, input);
const text = JSON.parse(input.trim().split('\\n')[0]).message.content.find((c) => c.type === 'text').text;
const reply = text.includes('旁白：「南亞漲') ? '{"rows":["R2"],"why":"南亞那一列"}' : '{"none":true,"why":"整體大意"}';
console.log(JSON.stringify({ type: 'system', subtype: 'init' }));
console.log(JSON.stringify({ type: 'result', is_error: false, result: reply }));
`);
  fs.chmodSync(fake, 0o755);
  return { dir, state, fake };
}

function runCells(ws, env) {
  const out = path.join(ws.dir, 'out.json');
  const stdout = execFileSync(process.execPath, [path.join(APP, 'scripts/claude-cells.js'),
    `--in=${path.join(ws.dir, 'in.json')}`, `--state=${ws.state}`, `--suggest=${path.join(ws.dir, 'suggest.json')}`,
    `--out=${out}`, '--job=test-job', '--no-append'],
  { encoding: 'utf8', env: { ...process.env, ...env } });
  return { stdout, results: JSON.parse(fs.readFileSync(out, 'utf8')) };
}

test('端到端：Claude 回編號 → 框、驗算與重疊率；圖片真的有送過去', (t) => {
  const ws = workspace(t);
  const { stdout, results } = runCells(ws, { CLAUDE_BIN: ws.fake, CELL_PICKER: 'claude-cli' });
  const [a, b] = results;
  assert.equal(a.claude.status, 'picked');
  assert.equal(a.claude.source, 'ocr');
  assert.deepEqual(a.claude.cell, { x: 74, y: 392, w: 738, h: 98 });
  assert.equal(a.claude.verify, 'pass');
  assert.ok(a.iouClaude > 0.9, `Claude 框跟人工框應該幾乎重疊：${a.iouClaude}`);
  assert.equal(a.iouSystem, 0);
  assert.equal(b.claude.status, 'none');
  assert.equal(b.jobId, 'test-job');
  const sent = fs.readFileSync(path.join(ws.dir, 'stdin.log'), 'utf8');
  assert.match(sent, /"type":"image"/);
  assert.match(sent, /W4「7\.17%」x/);
  assert.match(stdout, /你有畫框的 1 段裡，Claude 框到同一塊 1 段、規則庫 0 段/);
  assert.match(stdout, /你沒畫框的 1 段裡，Claude 也沒框 1 段/);
});

test('沒裝 claude、或開關關著：不丟例外，照實記錄', (t) => {
  const ws = workspace(t);
  const missing = runCells(ws, { CLAUDE_BIN: path.join(ws.dir, 'no-such-claude'), CELL_PICKER: 'claude-cli' });
  assert.equal(missing.results[0].claude.status, 'failed');
  assert.match(missing.results[0].claude.error, /找不到/);
  assert.match(missing.stdout, /2 段失敗/);
  const off = runCells(ws, { CLAUDE_BIN: ws.fake, CELL_PICKER: 'off' });
  assert.equal(off.results[0].claude.status, 'off');
});

test('摘要：沒有段落時也有一句話', () => {
  assert.equal(summary([]), 'Claude 框選對照：沒有可比對的段落');
});
