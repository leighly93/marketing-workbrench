'use strict';

// Claude 排配圖（2026-11-12）：哪張圖配哪幾句、卡片裁切、auto-shot 吃 --annots-file、run.js 的接法。
// 不呼叫真的 claude：claude-shot-plan.js 用 CLAUDE_BIN 換成假的腳本。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { applicationPath } = require('../paths');

const ROOT = path.resolve(__dirname, '../..');
const APP = applicationPath(ROOT);
const planner = require(path.join(APP, 'scripts/shot-planner'));
const picker = require(path.join(APP, 'scripts/cell-picker'));

const UNITS = [
  { i: 0, text: '今天台股大漲', startCharIdx: 0, endCharIdx: 5 },
  { i: 1, text: '收在41661點', startCharIdx: 6, endCharIdx: 13 },
  { i: 2, text: '聯發科大漲9.88%', startCharIdx: 14, endCharIdx: 22 },
  { i: 3, text: '台達電漲停', startCharIdx: 23, endCharIdx: 27 },
  { i: 4, text: '日月光也強彈', startCharIdx: 28, endCharIdx: 33 },
  { i: 5, text: '明天要注意', startCharIdx: 34, endCharIdx: 38 },
];

test('第一步：只收存在的圖與子句、最多 4 句、重疊的後者丟掉、照位置排', () => {
  const text = 'Wait 先想想 {"segments":[]}\n改成：' + JSON.stringify({ segments: [
    { image: 'shot1.png', from: 'U2', to: 'U5', title: '「電子股強彈」' },   // 剛好 4 句
    { image: 'shot2.png', from: 'U1', to: 'U0', title: '加權指數' },       // 顛倒 → 翻正
    { image: 'shot9.png', from: 'U5', to: 'U5', title: '不存在的圖' },
    { image: 'shot2.png', from: 'U3', to: 'U3', title: '跟上面重疊' },
    { image: 'shot1.png', from: 'U99', to: 'U99' },
  ] });
  const segs = planner.parseReply(text, { units: UNITS, files: ['shot1.png', 'shot2.png'] });
  assert.deepEqual(segs.map((s) => [s.src, s.startCharIdx, s.endCharIdx, s.title]), [
    ['shot2.png', 0, 13, '加權指數'],
    ['shot1.png', 14, 38, '電子股強彈'],
  ]);
  assert.equal(planner.parseReply('沒有 JSON', { units: UNITS, files: [] }), null);
});

test('同一張圖連續講好幾項拆成好幾段 → 併成一段（同一張卡片、金框往下移）', () => {
  const text = JSON.stringify({ segments: [
    { image: 'shot1.png', from: 'U2', to: 'U2', title: '聯發科大漲' },
    { image: 'shot1.png', from: 'U3', to: 'U3', title: '台達電漲停' },
    { image: 'shot1.png', from: 'U4', to: 'U4', title: '日月光強彈' },
  ] });
  const segs = planner.parseReply(text, { units: UNITS, files: ['shot1.png'] });
  assert.deepEqual(segs.map((s) => [s.startCharIdx, s.endCharIdx, s.title]), [[14, 33, '聯發科大漲']]);
  // 中間隔了一句就不併
  const apart = planner.parseReply(JSON.stringify({ segments: [
    { image: 'shot1.png', from: 'U0', to: 'U0' }, { image: 'shot1.png', from: 'U2', to: 'U2' },
  ] }), { units: UNITS, files: ['shot1.png'] });
  assert.equal(apart.length, 2);
});

test('動態：開頭一段在前 25%、結尾一段在後 25%，不跟截圖段重疊，不會有第 3 段', () => {
  const U = Array.from({ length: 20 }, (_, i) => ({ i, text: `句${i}`, startCharIdx: i * 10, endCharIdx: i * 10 + 9 }));
  const reply = JSON.stringify({ motions: [
    { from: 'U1', to: 'U2' }, { from: 'U9', to: 'U10' }, { from: 'U17', to: 'U19' }, { from: 'U16', to: 'U16' },
  ] });
  assert.deepEqual(planner.parseMotions(reply, { units: U, segments: [] }).map((m) => [m.startCharIdx, m.endCharIdx]),
    [[10, 29], [170, 199]]);
  // 跟截圖段重疊的不採用
  assert.deepEqual(planner.parseMotions(reply, { units: U, segments: [{ startCharIdx: 15, endCharIdx: 25 }] })
    .map((m) => m.startCharIdx), [170]);
  assert.match(planner.buildPrompt({ units: U, images: [] }), /開頭那段只能在 U0～U4 裡挑，結尾那段只能在 U15～U19 裡挑/);
});

test('第一步的 prompt 帶著子句編號與每張圖的 OCR 摘要', () => {
  const p = planner.buildPrompt({ units: UNITS, images: [{ label: '圖1（shot1.png）', ocr: '聯發科 3725' }] });
  assert.match(p, /U2：聯發科大漲9\.88%/);
  assert.match(p, /圖1（shot1\.png）：聯發科 3725/);
  assert.equal(planner.ocrSummary([{ t: 'a' }, { t: 'b' }], 10), 'a b');
});

test('卡片裁切一定包住金框、不會太扁、夾在圖內；沒給就退回框附近或整張', () => {
  assert.deepEqual(picker.fitCrop({ x: 10, y: 300, w: 500, h: 40 }, { x: 400, y: 320, w: 150, h: 50 }, 1206, 1221),
    { x: 10, y: 237, w: 564, h: 217 });
  assert.deepEqual(picker.fitCrop(null, null, 100, 200), { x: 0, y: 0, w: 100, h: 200 });
  const c = picker.fitCrop(null, { x: 300, y: 500, w: 100, h: 40 }, 1206, 1221);
  assert.ok(c.x === 0 && c.w === 1206 && c.y < 500 && c.y + c.h > 540);
  const parsed = picker.parseReply('{"none":true,"crop":[0,10,300,200]}', picker.candidates([]));
  assert.deepEqual(parsed.crop, { x: 0, y: 10, w: 300, h: 200 });
});

// ── 端到端：假的 claude ──────────────────────────────────────────

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-plan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pub = path.join(dir, 'public');
  fs.mkdirSync(pub);
  fs.writeFileSync(path.join(pub, 'script.txt'), '今天台股大漲，收在41661點。聯發科大漲9.88%、台達電漲停。');
  fs.writeFileSync(path.join(pub, 'shot1.png'), PNG);
  fs.writeFileSync(path.join(dir, 'images.json'), JSON.stringify({ images: [{ file: 'shot1.png', width: 1, height: 1, page: 'unknown',
    words: [{ t: '聯發科', x: 0, y: 0, w: 1, h: 1 }] }] }));
  // 假的 claude：有附圖（第一步一定附全部截圖），第一步回分配、第二步回框＋裁切
  const fake = path.join(dir, 'fake-claude.js');
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs');
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.log'))}, input + '\\n');
const content = JSON.parse(input.trim().split('\\n')[0]).message.content;
const text = content.find((c) => c.type === 'text').text;
const unit = (text.match(/U(\\d+)：聯發科/) || [])[1];
const stepIds = [...text.matchAll(/^(U\\d+)：/gm)].map((m) => m[1]);
const reply = text.includes('子句') ? JSON.stringify({
    segments: unit ? [{ image: 'shot1.png', from: 'U' + unit, to: 'U' + unit, title: '聯發科' }] : [],
    motions: [{ from: 'U0', to: 'U0', why: '開頭' }],
  })
  : JSON.stringify({ crop: [0, 0, 1, 1], steps: stepIds.map((u) => ({ unit: u, words: ['W1'] })), why: '聯發科' });
console.log(JSON.stringify({ type: 'result', is_error: false, result: reply }));
`);
  fs.chmodSync(fake, 0o755);
  return { dir, pub, fake };
}

function plan(ws, env = {}) {
  const out = path.join(ws.pub, 'claude-annotations.json');
  const stdout = execFileSync(process.execPath, [path.join(APP, 'scripts/claude-shot-plan.js'),
    `--script=${path.join(ws.pub, 'script.txt')}`, `--images=${path.join(ws.dir, 'images.json')}`,
    `--public=${ws.pub}`, `--out=${out}`, `--motion-out=${path.join(ws.pub, 'claude-motion.json')}`],
  { encoding: 'utf8', env: { ...process.env, CLAUDE_BIN: ws.fake, CELL_PICKER: 'claude-cli', ...env } });
  return { stdout, out, data: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null };
}

test('端到端：排出段落寫成標注格式（region＝卡片裁切、cell＝金框、title）', (t) => {
  const ws = workspace(t);
  const r = plan(ws);
  assert.match(r.stdout, /Claude 排配圖：1 張卡片、1 段金框位置（1 段有框）、1 段動態/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ws.pub, 'claude-motion.json'), 'utf8')),
    [{ startCharIdx: 0, endCharIdx: 5 }]);   // U0「今天台股大漲」
  const [s] = r.data.shots;
  assert.equal(s.src, 'shot1.png');
  assert.equal(s.title, '聯發科');
  assert.ok(s.region && s.cell);
  assert.equal(r.data.by, 'claude');
  assert.match(fs.readFileSync(path.join(ws.dir, 'calls.log'), 'utf8'), /"type":"image"/);
});

test('排不出東西就不留檔：上一支留下的計畫與動態一定先清掉（auto-shot 照舊吃人工標注）', (t) => {
  const ws = workspace(t);
  fs.writeFileSync(path.join(ws.pub, 'claude-annotations.json'), '{"shots":[{"src":"上一支的"}]}');
  fs.writeFileSync(path.join(ws.pub, 'claude-motion.json'), '[{"startCharIdx":0,"endCharIdx":1}]');
  fs.writeFileSync(path.join(ws.pub, 'script.txt'), '今天天氣很好。明天再說。');   // 沒講到圖上任何東西
  const r = plan(ws);
  assert.match(r.stdout, /沒有句子適合配圖/);
  assert.equal(r.data, null);
  assert.equal(fs.existsSync(path.join(ws.pub, 'claude-motion.json')), false);
});

test('關掉開關不呼叫 claude', (t) => {
  const ws = workspace(t);
  const r = plan(ws, { CELL_PICKER: 'off' });
  assert.match(r.stdout, /已關閉/);
  assert.equal(r.data, null);
  assert.equal(fs.existsSync(path.join(ws.dir, 'calls.log')), false);
});

test('run.js：大盤小報有 Claude 計畫就讓 auto-shot 吃它；auto-shot 認得 --annots-file 並帶 title', () => {
  const run = fs.readFileSync(path.join(APP, 'run.js'), 'utf8');
  assert.match(run, /runBackground\("node scripts\/claude-shot-plan\.js"/);
  assert.match(run, /auto-shot:dapan -- --annots-file=public\/claude-annotations\.json/);
  assert.match(run, /render-motion -- --template=\$\{TEMPLATE\} --input=public\/claude-motion\.json/);
  const auto = fs.readFileSync(path.join(APP, 'scripts/auto-shot.js'), 'utf8');
  assert.match(auto, /--annots-file=/);
  assert.match(auto, /title: a\.title\.trim\(\)/);
});
