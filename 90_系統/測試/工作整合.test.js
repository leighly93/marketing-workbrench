'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, write, loadServer } = require('./隔離服務');
const { planMigration, applyMigration } = require('../整理工具/工作資料搬移');
const { createJobStore } = require('../工作儲存');
const { applicationPath, cliPath } = require('../paths');

test('搬移後按完整 ID 讀回影片與稿件；缺片、試片、備份及歷史狀態均保留', async (t) => {
  const root = fixture(t);
  const a = { id: '20260901-120000-aaaa', title: '合成中文/標題', status: 'done', createdAt: '2026-09-01', outputs: [{ name: 'output-dapan.mp4', archive: '成品/甲.mp4' }], archived: ['成品/甲.mp4'] };
  const b = { id: '20260901-120001-bbbb', title: '合成中文/標題', status: 'failed', createdAt: '2026-09-01', outputs: [{ name: 'output-dapan.mp4', archive: '成品/不存在.mp4' }] };
  for (const j of [a, b]) write(path.join(root, 'jobs', j.id, 'job.json'), j);
  write(path.join(root, 'jobs', a.id, 'input/script.txt'), '原始稿件');
  write(path.join(root, 'jobs', a.id, 'input/heygen.mp4'), '原始講者');
  write(path.join(root, 'jobs', a.id, 'state/public/shot1.png'), '歷史快照');
  write(path.join(root, 'backups', '20260901-test', 'script.txt'), '原始稿件');
  write(path.join(root, 'backups', '20260901-test', 'heygen.mp4'), '原始講者');
  write(path.join(root, 'backups', 'unknown', 'script.txt'), '另一稿件');
  write(path.join(root, '成品/甲.mp4'), '正式影片');
  write(path.join(root, 'out/output-dapan.mp4'), '另一工作的試片');
  write(path.join(root, 'assets/品牌/frame.png'), '固定素材');
  const plan = planMigration(root);
  const manifest = path.join(root, '99_封存/fixture.json');
  const result = applyMigration(root, plan, manifest);
  assert.equal(result.jobs, 2);
  assert.equal(result.updated_job_metadata, 1);
  const store = createJobStore(root);
  const loaded = store.scan();
  assert.equal(loaded.find((j) => j.id === b.id).status, 'failed');
  const dir = store.directory(a.id);
  assert.match(path.basename(dir), /^2026-09-01_合成中文_標題_20260901-120000-aaaa$/);
  assert.equal(fs.readFileSync(path.join(dir, '直式.mp4'), 'utf8'), '正式影片');
  assert.equal(fs.readFileSync(path.join(dir, '稿件.txt'), 'utf8'), '原始稿件');
  assert.equal(fs.readFileSync(path.join(dir, '_製作資料/快照/public/shot1.png'), 'utf8'), '歷史快照');
  assert.equal(fs.readFileSync(path.join(dir, '_製作資料/備份/20260901-test/heygen.mp4'), 'utf8'), '原始講者');
  assert.equal(fs.readFileSync(path.join(root, '99_封存/待辨識/原產線輸出與試片/output-dapan.mp4'), 'utf8'), '另一工作的試片');
  assert.equal(fs.readFileSync(path.join(root, '99_封存/待辨識/製作備份/unknown/script.txt'), 'utf8'), '另一稿件');
  for (const name of ['jobs', 'assets', 'backups', 'out', '成品']) assert.equal(fs.existsSync(path.join(root, name)), false);
  const request = loadServer(root);
  assert.equal((await request('GET', `/api/jobs/${a.id}/file/output-dapan.mp4`)).bytes.toString(), '正式影片');
  assert.equal((await request('GET', `/api/jobs/${a.id}/file/script.txt`)).bytes.toString(), '原始稿件');
  assert.equal((await request('GET', `/api/jobs/${b.id}/file/output-dapan.mp4`)).status, 404);
  assert.equal(request.pruneOldJobs(), 0);
  assert.equal(fs.existsSync(path.join(dir, '素材/heygen.mp4')), true);
  request.stageJobInputs(a);
  assert.equal(fs.readFileSync(applicationPath(root, 'public/script.txt'), 'utf8'), '原始稿件');
  assert.equal(fs.readFileSync(applicationPath(root, 'public/heygen.mp4'), 'utf8'), '原始講者');
  assert.equal(cliPath(applicationPath(root), `jobs/${a.id}/input/script.txt`), path.join(dir, '稿件.txt'));
  request.backupJobArtifacts(a);
  assert.equal(fs.readFileSync(path.join(dir, '_製作資料/備份/工作備份/input/script.txt'), 'utf8'), '原始稿件');
});

test('搬移前發現來源改動時整批停止，不先搬走其他檔案', (t) => {
  const root = fixture(t);
  const jf = path.join(root, 'jobs/id/job.json');
  write(jf, { id: 'id', status: 'review' });
  const input = path.join(root, 'jobs/id/input/script.txt');
  write(input, '原稿');
  const plan = planMigration(root);
  write(input, '外部新增內容');
  assert.throws(() => applyMigration(root, plan, path.join(root, 'manifest.json')), /搬前檢查失敗/);
  assert.equal(fs.existsSync(jf), true);
  assert.equal(fs.existsSync(path.join(root, '工作紀錄')), false);
});

test('新建工作直接建立中文目錄；成品名稱防覆蓋且重載仍能依 ID 定位', async (t) => {
  const root = fixture(t);
  const request = loadServer(root);
  const result = await request('POST', '/api/jobs', { template: 'dapan', title: '中文測試標題', body: '這是合成稿件。' });
  assert.equal(result.status, 200);
  const job = result.body.job;
  const store = createJobStore(root);
  store.scan();
  const dir = store.directory(job.id);
  assert.ok(path.basename(dir).includes('_中文測試標題_'));
  assert.ok(fs.readFileSync(path.join(dir, '稿件.txt'), 'utf8').includes('這是合成稿件。'));
  const first = request.archivePath(job, 'output-dapan.mp4');
  assert.equal(first, path.join(dir, '直式.mp4'));
  write(first, '第一次產出');
  assert.equal(request.archivePath(job, 'output-dapan.mp4'), path.join(dir, '直式(2).mp4'));
  assert.equal(request.archivePath(job, 'output-dapan-landscape.mp4'), path.join(dir, '橫式.mp4'));
  assert.equal((await loadServer(root)('GET', `/api/jobs/${job.id}`)).status, 200);
  assert.equal(fs.existsSync(path.join(root, 'jobs')), false);
});

test('備份內容同時吻合多筆工作時保留待辨識，不任選一筆歸入', (t) => {
  const root = fixture(t);
  for (const id of ['first', 'second']) {
    write(path.join(root, 'jobs', id, 'job.json'), { id, status: 'done' });
    write(path.join(root, 'jobs', id, 'input/script.txt'), '相同稿件');
    write(path.join(root, 'jobs', id, 'input/heygen.mp4'), '相同講者');
  }
  write(path.join(root, 'backups/unknown/script.txt'), '相同稿件');
  write(path.join(root, 'backups/unknown/heygen.mp4'), '相同講者');
  const plan = planMigration(root);
  assert.equal(plan.files.find((f) => f.source === 'backups/unknown/heygen.mp4').destination, '99_封存/待辨識/製作備份/unknown/heygen.mp4');
});
