'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { ADAPTERS, MOCK, paidJobs } = require('./quotas');
const { fixture, write, loadServer, workFile } = require('../tests/isolated-server');

const NOW = new Date(2026, 9, 8, 12, 0, 0);
const JOBS = [
  { id: 'paid-1', status: 'done', skipGenerate: false },
  { id: 'paid-2', status: 'done' },                       // 沒有 skipGenerate 欄位＝有生成
  { id: 'reused', status: 'done', skipGenerate: true },   // 沿用現成講者影片，沒花錢
  { id: 'fake', status: 'done', mock: true },             // 模擬模式
  { id: 'failed', status: 'failed' },
  { id: 'running', status: 'preparing' },
];

describe('額度 adapter（假資料，但由真實工作數決定）', () => {
  test('只有出完、非模擬、有生成的工作算花過錢', () => {
    assert.deepEqual(paidJobs(JOBS).map((j) => j.id), ['paid-1', 'paid-2']);
  });

  test('HeyGen 點數與 MiniMax 餘額隨出完的工作遞減、不會變負的，形狀固定', async () => {
    const ctx = { allJobs: () => JOBS };
    const heygen = await ADAPTERS.heygen(ctx, NOW);
    assert.deepEqual(heygen, {
      id: 'heygen', label: 'HeyGen', kind: 'credits', unit: 'credits',
      remaining: MOCK.heygen.total - 2 * MOCK.heygen.perJob, total: MOCK.heygen.total,
      resetAt: new Date(2026, 10, 1).toISOString(), updatedAt: NOW.toISOString(), source: 'mock',
      note: '尚未接上 HeyGen 額度查詢（/v2/user/remaining_quota），目前是假資料',
    });
    const minimax = await ADAPTERS.minimax(ctx, NOW);
    assert.deepEqual(minimax, {
      id: 'minimax', label: 'MiniMax', kind: 'balance', unit: 'USD',
      remaining: 48.4, total: null, resetAt: null, updatedAt: NOW.toISOString(), source: 'mock',
      note: 'MiniMax 沒有公開餘額 API，目前是假資料',
    });

    const many = { allJobs: () => Array.from({ length: 200 }, (_, i) => ({ id: String(i), status: 'done' })) };
    assert.equal((await ADAPTERS.heygen(many, NOW)).remaining, 0);
    assert.equal((await ADAPTERS.minimax(many, NOW)).remaining, 0);
  });
});

test('/api/quotas：供應者列表加本機狀態，鎖與磁碟用量跟 /api/health 同一份', async (t) => {
  const root = fixture(t);
  for (const j of JOBS) write(workFile(root, j.id, 'job.json'), { template: 'dapan', createdAt: '2026-10-01T00:00:00Z', ...j });
  write(workFile(root, 'queued-1', 'job.json'), { id: 'queued-1', status: 'queued', template: 'dapan', createdAt: '2026-10-02T00:00:00Z' });
  write(path.join(root, '.run.lock'), '1');
  const request = loadServer(root);
  const quotas = await request('GET', '/api/quotas');
  assert.equal(quotas.status, 200);
  assert.equal(quotas.body.mock, true);
  assert.deepEqual(quotas.body.providers.map((p) => [p.id, p.remaining]), [['heygen', 925], ['minimax', 48.4]]);
  const health = (await request('GET', '/api/health')).body;
  assert.deepEqual(quotas.body.local.lock, { locked: health.locked, externalLock: health.externalLock, lockAgeMin: health.lockAgeMin });
  assert.equal(quotas.body.local.lock.locked, true);
  assert.equal(quotas.body.local.externalLock, undefined);
  assert.equal(quotas.body.local.diskMB, health.diskMB);
  assert.equal(quotas.body.local.busy, false);
  // 「正在跑」那支是 loadJobs 時標成 failed 的（伺服器重開、pid 不在），所以沒有 runningJobId
  assert.deepEqual(quotas.body.local.queue, { queued: 1, approved: 0, runningJobId: null });
});
