'use strict';

// 大盤小報標題拆行（2026-11-12 使用者：「建立工作那標題改一行就好，之後給 Claude 自己辨識」）。
// 不呼叫真的 claude：claude-title.js 用 CLAUDE_BIN 換成假的腳本。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { applicationPath } = require('../paths');

const ROOT = path.resolve(__dirname, '../..');
const APP = applicationPath(ROOT);
const splitter = require(path.join(APP, 'scripts/title-splitter'));

const TITLE = '盤中翻紅尾盤跌掉 800 點發生什麼事?';

test('回覆要剛好兩行、一字不差（空白不計），否則不採用', () => {
  assert.deepEqual(splitter.parseReply('{"lines":["盤中翻紅尾盤跌掉 800 點","發生什麼事?"]}', TITLE),
    ['盤中翻紅尾盤跌掉 800 點', '發生什麼事?']);
  assert.equal(splitter.parseReply('{"lines":["盤中翻紅尾盤大跌 800 點","發生什麼事?"]}', TITLE), null, '改了字');
  assert.equal(splitter.parseReply('{"lines":["盤中翻紅尾盤跌掉 800 點發生什麼事?"]}', TITLE), null, '只有一行');
  assert.equal(splitter.parseReply('{"lines":["盤中翻紅","尾盤跌掉 800 點","發生什麼事?"]}', TITLE), null, '三行');
  assert.equal(splitter.parseReply('不是 JSON', TITLE), null);
});

test('只有一行的標題才交給 Claude；prompt 要求不改字、不拆數字單位', () => {
  assert.equal(splitter.needsSplit(TITLE), true);
  assert.equal(splitter.needsSplit('暴漲近2,000點\n但這3個訊號還沒到位'), false);
  assert.equal(splitter.needsSplit(''), false);
  const p = splitter.buildPrompt(TITLE);
  assert.match(p, /一個字都不能改/);
  assert.match(p, /不要把數字和單位拆開/);
  assert.ok(p.includes(TITLE));
});

function workspace(t, reply) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-title-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = path.join(dir, 'fake-claude.js');
  fs.writeFileSync(fake, `#!/usr/bin/env node
require('fs').readFileSync(0, 'utf8');
console.log(JSON.stringify({ type: 'result', is_error: false, result: ${JSON.stringify(reply)} }));
`);
  fs.chmodSync(fake, 0o755);
  return { dir, fake, script: path.join(dir, 'script.txt'), out: path.join(dir, 'claude-title.txt') };
}

function run(ws, scriptText, env = {}) {
  fs.writeFileSync(ws.script, scriptText);
  return execFileSync(process.execPath, [path.join(APP, 'scripts/claude-title.js'), `--script=${ws.script}`, `--out=${ws.out}`],
    { encoding: 'utf8', env: { ...process.env, CLAUDE_BIN: ws.fake, CELL_PICKER: 'claude-cli', ...env } });
}

test('端到端：一行標題 → 寫出兩行；兩行標題、改字、關閉時不寫檔且清掉上一支的', (t) => {
  const ws = workspace(t, '{"lines":["盤中翻紅尾盤跌掉 800 點","發生什麼事?"]}');
  run(ws, `===\n${TITLE}\n===\n今天台股…`);
  assert.equal(fs.readFileSync(ws.out, 'utf8'), '盤中翻紅尾盤跌掉 800 點\n發生什麼事?\n');

  const stdout = run(ws, '===\n暴漲近2,000點\n但這3個訊號還沒到位\n===\n今天台股…');
  assert.match(stdout, /本來就分好行/);
  assert.equal(fs.existsSync(ws.out), false, '上一支的拆行結果要先清掉');

  const bad = workspace(t, '{"lines":["盤中大跌","發生什麼事?"]}');
  run(bad, `===\n${TITLE}\n===\n今天台股…`);
  assert.equal(fs.existsSync(bad.out), false, '改了字就不用');

  run(ws, `===\n${TITLE}\n===\n今天台股…`, { CELL_PICKER: 'off' });
  assert.equal(fs.existsSync(ws.out), false);
});

test('接線：run.js 大盤小報一開始就背景拆標題、parse 前等它；parse-dapan-script 用它；建立工作只剩一行', () => {
  const runJs = fs.readFileSync(path.join(APP, 'run.js'), 'utf8');
  assert.match(runJs, /TEMPLATE === "dapan" \? runBackground\("node scripts\/claude-title\.js"/);
  assert.ok(runJs.indexOf('await claudeTitle') < runJs.indexOf('prepareShots();\n  renderMotionClips'), '要在 parse-script 之前等它');
  const parse = fs.readFileSync(path.join(APP, 'scripts/parse-dapan-script.js'), 'utf8');
  assert.match(parse, /claude-title\.txt/);
  assert.match(parse, /squash\(split\) === squash\(titleText\)/, '一字不差才用');
  const server = fs.readFileSync(path.join(APP, 'server/index.js'), 'utf8');
  assert.match(server, /dapan: \{[\s\S]*?title: \{ lines: 1,/);
  assert.match(server, /rmrf\(path\.join\(pub, 'claude-title\.txt'\)\)/, '換工作要清掉上一支的拆行結果');
});
