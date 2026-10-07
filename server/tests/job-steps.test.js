'use strict';

// 步驟記錄（_meta/steps.json）：GET /api/jobs/:id/steps 讀；確認／退回／取消會改「等待人工確認」那一步。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture, write, loadServer, workFile } = require('./isolated-server');

const 旁白 = '今天台股上漲兩百點。';
const 假子程序 = { execFileSync() { return ''; }, spawn() { throw new Error('隔離測試不出片'); } };

/** 停在待確認的工作：計畫頁需要的東西都在，steps.json 裡 review 那一步還在跑。 */
function reviewJob(root, id, extra = {}) {
  write(workFile(root, id, 'job.json'), {
    id, title: '步驟測試', status: 'review', template: 'midday', owner: '合成測試',
    createdAt: '2026-10-01T00:00:00Z', planView: { rows: [], chars: Array.from(旁白).map((c) => ({ c })) }, ...extra,
  });
  write(workFile(root, id, 'state', 'public', 'script.txt'), `===\n===\n標題\n===\n${旁白}\n`);
  write(workFile(root, id, 'steps.json'), {
    version: 1, steps: [
      { id: 'transcribe', label: '字幕轉錄', status: 'ok', startedAt: '2026-10-01T00:01:00Z', endedAt: '2026-10-01T00:01:05Z', ms: 5000, attempt: 1 },
      { id: 'review', label: '等待人工確認', status: 'running', startedAt: '2026-10-01T00:02:00Z', attempt: 1 },
    ],
  });
}
const stepsOf = (root, id) => JSON.parse(fs.readFileSync(workFile(root, id, 'steps.json'), 'utf-8')).steps;

test('GET /steps：找不到工作 404、沒有記錄檔是空陣列、有就照檔案回', async (t) => {
  const root = fixture(t);
  write(workFile(root, 'bare', 'job.json'), { id: 'bare', status: 'draft', template: 'midday', createdAt: '2026-10-01T00:00:00Z' });
  reviewJob(root, 'with-steps');
  const request = loadServer(root);
  assert.equal((await request('GET', '/api/jobs/nope/steps')).status, 404);
  assert.deepEqual((await request('GET', '/api/jobs/bare/steps')).body, { steps: [] });
  const r = await request('GET', '/api/jobs/with-steps/steps');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.steps.map((s) => [s.id, s.status]), [['transcribe', 'ok'], ['review', 'running']]);
});

test('確認出片把 review 結掉（備註是誰）；退回確認再開一筆；取消把還在跑的標成 cancelled', async (t) => {
  const root = fixture(t);
  reviewJob(root, 'flow');
  const request = loadServer(root, { childProcess: 假子程序, idleTimers: true });

  const approved = await request('POST', '/api/jobs/flow/approve', { by: '合成測試' });
  assert.equal(approved.status, 200);
  let review = stepsOf(root, 'flow').filter((s) => s.id === 'review');
  assert.equal(review.length, 1);
  assert.equal(review[0].status, 'ok');
  assert.equal(review[0].note, '合成測試');
  assert.ok(review[0].endedAt);

  // 退回：request 的 setImmediate 已經把 tick 跑掉（出片被假子程序擋下來 → failed）；
  // doRender 是非同步的，等它真的收尾再把狀態撥回 approved 來測退回那條路。
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(request.getJob('flow').status, 'failed');
  request.getJob('flow').status = 'approved';
  const back = await request('POST', '/api/jobs/flow/unapprove', {});
  assert.equal(back.status, 200);
  review = stepsOf(root, 'flow').filter((s) => s.id === 'review');
  assert.equal(review.length, 2);
  assert.deepEqual([review[1].status, review[1].attempt, review[1].note], ['running', 2, '退回確認']);

  const cancelled = await request('POST', '/api/jobs/flow/cancel', {});
  assert.equal(cancelled.status, 200);
  review = stepsOf(root, 'flow').filter((s) => s.id === 'review');
  assert.deepEqual([review[1].status, review[1].note], ['cancelled', '人工取消']);
  // 已經結束的步驟不受影響
  assert.equal(stepsOf(root, 'flow').find((s) => s.id === 'transcribe').status, 'ok');
});

test('出片失敗：還在跑的步驟標成 failed，工作記下 failedAt', async (t) => {
  const root = fixture(t);
  reviewJob(root, 'boom');
  const request = loadServer(root, { childProcess: 假子程序, idleTimers: true });
  // approve → setImmediate(tick) → doRender → restoreWorkspace 之後 runMotion 會 spawn → 假子程序丟錯
  //（動態那段會降級、不丟出），接著 runPipeline 也 spawn → 丟出 → tick 標成 failed。
  await request('POST', '/api/jobs/boom/approve', { by: '合成測試' });
  await new Promise((resolve) => setTimeout(resolve, 20));   // doRender 是非同步的，等它收尾
  const job = (await request('GET', '/api/jobs/boom')).body.job;
  assert.equal(job.status, 'failed');
  assert.ok(job.failedAt);
  const steps = stepsOf(root, 'boom');
  assert.equal(steps.some((s) => s.status === 'running'), false);
  const prep = steps.find((s) => s.id === 'render-prep');
  assert.equal(prep && prep.status, 'ok');
  assert.equal(steps.find((s) => s.id === 'motion-render').status, 'warning');
  // render 是 run.js 自己記的，這裡 spawn 被擋下來所以沒有；收尾也沒走到
  assert.equal(steps.some((s) => s.id === 'finalize'), false);
});
