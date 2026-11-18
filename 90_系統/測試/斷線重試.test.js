'use strict';

// MiniMax 配音斷線自動重試（2026-11-18）：只重試網路層失敗，最多 3 次；對方有回應的錯誤不重試。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { applicationPath } = require('../paths');

const APP = applicationPath(path.resolve(__dirname, '../..'));
const { withNetworkRetry } = require(path.join(APP, 'scripts/net-retry'));
const noSleep = { sleep: async () => {} };
const netErr = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });

test('斷線兩次後成功：回傳結果，重試記錄兩次', async () => {
  let calls = 0;
  const seen = [];
  const out = await withNetworkRetry(async () => { if (++calls < 3) throw netErr(); return 'ok'; },
    { ...noSleep, onRetry: (r) => seen.push(r) });
  assert.equal(out, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(seen.map((r) => r.n), [1, 2]);
  assert.match(seen[0].error, /fetch failed（ECONNRESET）/);
});

test('一直斷線：第一次＋重試 3 次後丟出原本的錯誤', async () => {
  let calls = 0;
  await assert.rejects(withNetworkRetry(async () => { calls++; throw netErr(); }, noSleep), /fetch failed/);
  assert.equal(calls, 4);
});

test('對方有回應的錯誤（例如回傳不是 JSON）不重試', async () => {
  let calls = 0;
  await assert.rejects(withNetworkRetry(async () => { calls++; throw new SyntaxError('Unexpected token <'); }, noSleep), SyntaxError);
  assert.equal(calls, 1);
});

test('等待時間逐次拉長', async () => {
  const waits = [];
  let calls = 0;
  await withNetworkRetry(async () => { if (++calls < 4) throw netErr(); return 1; },
    { delayMs: 3000, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(waits, [3000, 6000, 9000]);
});

test('run.js 的 MiniMax 呼叫有包重試，fetch 與讀 body 都在裡面', () => {
  const src = fs.readFileSync(path.join(APP, 'run.js'), 'utf8');
  assert.match(src, /await withNetworkRetry\(async \(\) => \{\n\s+const res = await fetch\(url,[\s\S]*?return \{ res, data: await res\.json\(\) \};/);
  assert.match(src, /retries: 3,/);
});
