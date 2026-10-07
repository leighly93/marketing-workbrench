'use strict';

const assert = require('node:assert/strict');
const { fixture, loadServer } = require('./isolated-server');

const newJob = { template: 'dapan', owner: '測試', title: '標題', body: '今天台股上漲。' };

test('模擬模式：health 告訴前台掛警示，新工作帶 mock 標記', async (t) => {
  const request = loadServer(fixture(t), { env: { WORKBENCH_MOCK: '1' } });
  assert.equal((await request('GET', '/api/health')).body.mock, true);
  const created = await request('POST', '/api/jobs', newJob);
  assert.equal(created.status, 200);
  assert.equal(created.body.job.mock, true);
});

test('正式模式：沒有警示、工作沒有 mock 欄位', async (t) => {
  const request = loadServer(fixture(t));
  assert.equal((await request('GET', '/api/health')).body.mock, false);
  const created = await request('POST', '/api/jobs', newJob);
  assert.equal(created.body.job.mock, undefined);
});
