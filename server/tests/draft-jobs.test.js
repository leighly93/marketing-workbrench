'use strict';

// 草稿流程（先建一支最簡單的，再慢慢補素材與設定）：
//   PATCH 改設定只限草稿、標題與唸法重組 script.txt；上傳／刪素材維護 job.files；
//   自己的草稿自己可以刪；列表可分頁。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, write, loadServer, workFile } = require('./isolated-server');
const { folderName } = require('../../shared/job-store');

const BODY = '今天台股上漲兩百點，台積電領軍走強。';
const NEW_JOB = { template: 'dapan', owner: 'Ryan', title: '第一行\n第二行', body: BODY, voice: '台積電→台基電' };
/** PNG 檔頭：上傳的 .png 會被嗅探格式，亂湊的位元組會被擋下。 */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const scriptOf = (root, job) => fs.readFileSync(path.join(root, 'storage', 'jobs', folderName(job), 'script.txt'), 'utf-8');

async function createDraft(request) {
  const r = await request('POST', '/api/jobs', NEW_JOB);
  assert.equal(r.status, 200);
  return r.body.job;
}

test('建立時留下原始內文；PATCH 改標題與唸法會重組 script.txt，標題照版型規則整理', async (t) => {
  const root = fixture(t);
  const request = loadServer(root);
  const job = await createDraft(request);
  assert.equal(job.status, 'draft');
  assert.equal(job.scriptBody, BODY);
  assert.equal(scriptOf(root, job), `台積電→台基電\n===\n===\n第一行\n第二行\n===\n${BODY}\n`);

  // 標題：行首尾空白去掉、空行不算、超過版型行數截掉（dapan 兩行）；唸法沿用原本自己填的
  let r = await request('PATCH', `/api/jobs/${job.id}`, { title: '  新標題  \n\n第二行\n第三行' });
  assert.equal(r.status, 200);
  assert.equal(r.body.job.title, '新標題\n第二行');
  assert.equal(scriptOf(root, job), `台積電→台基電\n===\n===\n新標題\n第二行\n===\n${BODY}\n`);
  assert.deepEqual(r.body.job.voiceRules.own, ['台積電→台基電']);

  // 唸法：整段換掉、命中清單重算、script.txt 第一段跟著換
  r = await request('PATCH', `/api/jobs/${job.id}`, { voice: '台股→胎股\n沒出現→不算' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.job.voiceRules.own, ['台股→胎股', '沒出現→不算']);
  assert.deepEqual(r.body.job.voiceRules.hit.map((h) => [h.from, h.src, h.times]), [['台股', 'own', 1]]);
  assert.equal(scriptOf(root, job), `台股→胎股\n沒出現→不算\n===\n===\n新標題\n第二行\n===\n${BODY}\n`);

  // 其他設定：旗標轉成布林、語氣走白名單、署名空白回預設；回應就是 publicJob（同事看不到 ip）
  r = await request('PATCH', `/api/jobs/${job.id}`, { owner: '  ', skipGenerate: 1, noSpeed: 'yes', autoApprove: false, emotion: 'angry' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.job.owner, r.body.job.skipGenerate, r.body.job.noSpeed, r.body.job.autoApprove, r.body.job.emotion],
    ['未署名', true, true, false, 'fluent']);
  const colleague = await loadServer(root, { remoteAddress: '192.168.1.23' })('PATCH', `/api/jobs/${job.id}`, { autoApprove: true });
  assert.equal(colleague.status, 200);
  assert.equal(colleague.body.job.ip, undefined);
  assert.equal(colleague.body.job.autoApprove, true);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'storage', 'jobs', folderName(job), '_meta', 'job.json'), 'utf-8'));
  assert.equal(saved.title, '新標題\n第二行');
  assert.equal(saved.noSpeed, true);
});

test('PATCH：不是草稿回 409；找不到回 404；功能上線前的草稿從 script.txt 救回內文', async (t) => {
  const root = fixture(t);
  const request = loadServer(root);
  const job = await createDraft(request);
  request.getJob(job.id).status = 'queued';
  const r = await request('PATCH', `/api/jobs/${job.id}`, { title: 'x' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, '只有草稿可以改設定');
  assert.equal((await request('PATCH', '/api/jobs/nope', { title: 'x' })).status, 404);

  // 舊草稿：job.json 沒有 scriptBody，但 script.txt 在 → 內文從最後一段救回來
  write(workFile(root, 'old-draft', 'job.json'), { id: 'old-draft', status: 'draft', template: 'dapan', owner: 'Amy', title: '舊', createdAt: '2026-10-01T00:00:00Z', voiceRules: { own: ['A→B'], shared: [], hit: [] } });
  write(workFile(root, 'old-draft', 'input', 'script.txt'), 'A→B\n===\n===\n舊\n===\n舊內文有 A。\n');
  const old = loadServer(root);
  const patched = await old('PATCH', '/api/jobs/old-draft', { voice: 'A→C' });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.job.scriptBody, '舊內文有 A。');
  assert.equal(fs.readFileSync(workFile(root, 'old-draft', 'input', 'script.txt'), 'utf-8'), 'A→C\n===\n===\n舊\n===\n舊內文有 A。\n');

  // 連 script.txt 都沒有 → 400
  write(workFile(root, 'bare-draft', 'job.json'), { id: 'bare-draft', status: 'draft', template: 'dapan', owner: 'Amy', title: '空', createdAt: '2026-10-01T00:00:00Z' });
  const bare = await loadServer(root)('PATCH', '/api/jobs/bare-draft', { voice: 'A→C' });
  assert.equal(bare.status, 400);
});

test('草稿上傳與刪素材：job.files 隨 input/ 重掃；刪除只限草稿、不能刪稿件', async (t) => {
  const root = fixture(t);
  const request = loadServer(root);
  const job = await createDraft(request);
  assert.equal(job.files, undefined);

  let r = await request('POST', `/api/jobs/${job.id}/upload?name=image1.png`, PNG);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.files, ['image1.png', 'script.txt']);
  r = await request('POST', `/api/jobs/${job.id}/upload?auto=1&ext=.png`, PNG);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.files, ['image1.png', r.body.name, 'script.txt']);
  r = await request('POST', `/api/jobs/${job.id}/upload?name=heygen.mp4`, Buffer.from('synthetic-video'));
  assert.equal(r.status, 200);
  assert.deepEqual((await request('GET', `/api/jobs/${job.id}`)).body.job.files, ['heygen.mp4', 'image1.png', 'shot1.png', 'script.txt']);

  // 檔名會先 basename：跳不出 input/
  r = await request('DELETE', `/api/jobs/${job.id}/upload?name=${encodeURIComponent('../job.json')}`);
  assert.equal(r.status, 404);
  assert.equal((await request('DELETE', `/api/jobs/${job.id}/upload?name=script.txt`)).status, 400);
  assert.equal((await request('DELETE', `/api/jobs/${job.id}/upload`)).status, 400);
  r = await request('DELETE', `/api/jobs/${job.id}/upload?name=image1.png`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, files: ['heygen.mp4', 'shot1.png', 'script.txt'] });
  assert.equal(fs.existsSync(path.join(root, 'storage', 'jobs', folderName(job), 'inputs', 'image1.png')), false);
  assert.equal(fs.existsSync(path.join(root, 'storage', 'jobs', folderName(job), 'script.txt')), true);

  request.getJob(job.id).status = 'queued';
  r = await request('DELETE', `/api/jobs/${job.id}/upload?name=shot1.png`);
  assert.equal(r.status, 409);
  assert.equal((await request('DELETE', '/api/jobs/nope/upload?name=x.png')).status, 404);
});

test('同事（非管理者）只能刪自己的草稿，而且要帶 ?by=署名', async (t) => {
  const root = fixture(t);
  const admin = loadServer(root);
  const job = await createDraft(admin);
  const colleague = loadServer(root, { remoteAddress: '192.168.1.23' });

  assert.equal((await colleague('DELETE', `/api/jobs/${job.id}`)).status, 403);
  assert.equal((await colleague('DELETE', `/api/jobs/${job.id}?by=Amy`)).status, 403);
  assert.equal((await colleague('DELETE', '/api/jobs/nope?by=Ryan')).status, 403);
  const ok = await colleague('DELETE', `/api/jobs/${job.id}?by=${encodeURIComponent(' Ryan ')}`);
  assert.equal(ok.status, 200);
  assert.equal((await colleague('GET', `/api/jobs/${job.id}`)).status, 404);
  assert.equal(fs.existsSync(path.join(root, 'storage', 'jobs', folderName(job))), false);

  // 不是草稿的，署名對了也不行
  write(workFile(root, 'done-1', 'job.json'), { id: 'done-1', status: 'done', template: 'dapan', owner: 'Ryan', title: 'x', createdAt: '2026-10-01T00:00:00Z' });
  const again = loadServer(root, { remoteAddress: '192.168.1.23' });
  assert.equal((await again('DELETE', '/api/jobs/done-1?by=Ryan')).status, 403);
  assert.equal((await loadServer(root)('DELETE', '/api/jobs/done-1')).status, 200);
});

test('列表分頁：limit（預設 50、最多 500）、offset，另回 total', async (t) => {
  const root = fixture(t);
  const ids = Array.from({ length: 60 }, (_, i) => `job-${String(i).padStart(3, '0')}`);
  for (const [i, id] of ids.entries()) {
    write(workFile(root, id, 'job.json'), { id, status: 'done', template: 'dapan', title: id, createdAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString() });
  }
  const request = loadServer(root);
  const all = await request('GET', '/api/jobs');
  assert.equal(all.body.total, 60);
  assert.equal(all.body.jobs.length, 50);
  assert.equal(all.body.jobs[0].id, 'job-059');   // 新的在前
  const page = await request('GET', '/api/jobs?limit=5&offset=58');
  assert.deepEqual(page.body.jobs.map((j) => j.id), ['job-001', 'job-000']);
  assert.equal(page.body.total, 60);
  assert.equal((await request('GET', '/api/jobs?limit=9999')).body.jobs.length, 60);
  assert.equal((await request('GET', '/api/jobs?limit=0&offset=-3')).body.jobs.length, 1);
});
