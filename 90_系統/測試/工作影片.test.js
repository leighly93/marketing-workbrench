'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { applicationPath } = require('../paths');
const { fixture, write, loadServer, workFile } = require('./隔離服務');

test('拆分後的網頁可取得 HTML、CSS 與 JavaScript，資源更新會反映版本時間', async (t) => {
  const root = fixture(t);
  const repository = path.resolve(__dirname, '../..');
  const contents = new Map();
  for (const name of ['index.html', 'styles.css', 'app.js']) {
    const content = fs.readFileSync(applicationPath(repository, 'server/public', name));
    contents.set(name, content);
    write(applicationPath(root, 'server/public', name), content);
  }
  assert.match(contents.get('index.html').toString(), /href="\/styles\.css"/);
  assert.match(contents.get('index.html').toString(), /src="\/app\.js"/);
  const changed = new Date(Date.now() + 10000);
  fs.utimesSync(applicationPath(root, 'server/public/app.js'), changed, changed);
  const request = loadServer(root);
  for (const [url, name, mime] of [['/', 'index.html', 'text/html'], ['/styles.css', 'styles.css', 'text/css'], ['/app.js', 'app.js', 'text/javascript']]) {
    const response = await request('GET', url);
    assert.equal(response.status, 200);
    assert.ok(response.headers['Content-Type'].startsWith(mime));
    assert.deepEqual(response.bytes, contents.get(name));
  }
  const health = await request('GET', '/api/health');
  assert.equal(health.body.webBuiltAt, fs.statSync(applicationPath(root, 'server/public/app.js')).mtimeMs);
});

function job(root, id, extra = {}) {
  const value = { id, status: 'done', template: 'dapan', createdAt: '2000-01-01T00:00:00Z', ...extra };
  write(workFile(root, id, 'job.json'), value);
  return value;
}

// 2026-09-22：投廣模板移除後，/api/health 不再回傳 brands。
// ⚠️ 這裡刻意反過來斷言「不回傳」：原本的 listBrands() 是掃「共用素材/ 底下有 frame.png
//    的資料夾」，未來節目改名成籌K／起K 系列、素材夾裡放了 frame.png 的話，
//    復活那個函式就會把節目誤當成投廣品牌列出來。要重做品牌選擇請用明確的設定，不要掃資料夾。
test('健康檢查不再回傳品牌清單，程式區也不需要另一份 assets', async (t) => {
  const root = fixture(t);
  write(path.join(root, '共用素材/合成品牌甲/frame.png'), 'synthetic-frame-a');
  write(path.join(root, '共用素材/合成品牌乙/frame.png'), 'synthetic-frame-b');
  write(path.join(root, '共用素材/無框素材/logo.png'), 'synthetic-logo');
  const response = await loadServer(root)('GET', '/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.brands, undefined, '品牌清單已隨投廣模板移除，不該再出現在 health');
  assert.equal(fs.existsSync(applicationPath(root, '共用素材')), false);
});

test('同名輸出的工作分別讀取各自成品，下載保留中文檔名', async (t) => {
  const root = fixture(t);
  const name = 'output-dapan.mp4';
  const first = job(root, 'fixture-first', { outputs: [{ name, archive: '工作紀錄/fixture-first/合成影片甲.mp4' }] });
  const second = job(root, 'fixture-second', { outputs: [{ name, archive: '工作紀錄/fixture-second/合成影片乙.mp4' }] });
  write(path.join(root, first.outputs[0].archive), 'first-video-content');
  write(path.join(root, second.outputs[0].archive), 'second-video-content');
  write(path.join(root, 'out', name), 'unrelated-current-render');
  write(workFile(root, first.id, 'out', name), 'older-job-fallback');
  const request = loadServer(root);
  const a = await request('GET', `/api/jobs/${first.id}/file/${name}?dl=1`);
  const b = await request('GET', `/api/jobs/${second.id}/file/${name}`);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.bytes.toString(), 'first-video-content');
  assert.equal(b.bytes.toString(), 'second-video-content');
  assert.equal(a.headers['Content-Type'], 'video/mp4');
  assert.ok(a.headers['Content-Disposition'].includes(`filename*=UTF-8''${encodeURIComponent('合成影片甲.mp4')}`));
  assert.equal(fs.existsSync(applicationPath(root, 'jobs')), false);
  assert.equal(fs.existsSync(applicationPath(root, '成品')), false);
});

test('成品缺件回報 404，不讀取工作外同名產線影片', async (t) => {
  const root = fixture(t);
  const name = 'output-dapan.mp4';
  const missing = job(root, 'fixture-missing', { outputs: [{ name, archive: '成品/2000-01/missing.mp4' }] });
  write(path.join(root, 'out', name), 'unrelated-current-render');
  write(applicationPath(root, 'out', name), 'incorrect-application-output');
  write(path.join(root, 'jobs/another-job/out', name), 'another-job-video');
  const response = await loadServer(root)('GET', `/api/jobs/${missing.id}/file/${name}`);
  assert.equal(response.status, 404);
  assert.ok(response.body.error);
  assert.equal(JSON.parse(fs.readFileSync(workFile(root, missing.id, 'job.json'), 'utf8')).status, 'done');
});

test('成品缺件時仍可讀取同一工作的 out，Range 下載僅回傳指定位元組', async (t) => {
  const root = fixture(t);
  const name = 'output-dapan.mp4';
  const record = job(root, 'fixture-fallback', { outputs: [{ name, archive: '成品/2000-01/missing.mp4' }] });
  const content = Buffer.from('0123456789abcdef');
  write(workFile(root, record.id, 'out', name), content);
  write(path.join(root, 'out', name), 'unrelated-current-render');
  const response = await loadServer(root)('GET', `/api/jobs/${record.id}/file/${name}?dl=1`, undefined, { range: 'bytes=3-8' });
  assert.equal(response.status, 206);
  assert.deepEqual(response.bytes, content.subarray(3, 9));
  assert.equal(response.headers['Content-Range'], `bytes 3-8/${content.length}`);
  assert.equal(response.headers['Content-Length'], 6);
  assert.equal(response.headers['Accept-Ranges'], 'bytes');
  assert.ok(response.headers['Content-Disposition'].startsWith('attachment;'));
});

test('55 筆工作全部載入，列表目前保留 50 筆上限，較早工作仍可用完整 ID 查閱', async (t) => {
  const root = fixture(t);
  const statuses = ['done', 'failed', 'cancelled', 'review', 'detached-done'];
  const records = Array.from({ length: 55 }, (_, index) => job(root, `fixture-${String(index).padStart(3, '0')}`, {
    createdAt: new Date(Date.UTC(2000, 0, index + 1)).toISOString(), status: statuses[index % statuses.length],
  }));
  const request = loadServer(root);
  const list = await request('GET', '/api/jobs');
  assert.equal(list.status, 200);
  assert.equal(list.body.jobs.length, 50);
  assert.equal(list.body.jobs.some((entry) => entry.id === records[0].id), false);
  for (const record of records) {
    const detail = await request('GET', `/api/jobs/${record.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.job.id, record.id);
    assert.equal(detail.body.job.status, record.status);
  }
  assert.equal(fs.readdirSync(path.join(root, '工作紀錄')).length, 55);
  assert.equal(fs.existsSync(applicationPath(root, 'jobs')), false);
});

test('歷史 state/public 與 state/src 快照恢復至程式區，不在工作根建立第二個 public', (t) => {
  const root = fixture(t);
  const record = job(root, 'fixture-snapshot');
  const state = workFile(root, record.id, 'state');
  const image = Buffer.from('synthetic-historical-image');
  const generated = { synthetic: 'historical-metadata' };
  write(path.join(state, 'public/shot1.png'), image);
  write(path.join(state, 'src/DapanXiaobao/dapan-shots.generated.json'), generated);
  write(applicationPath(root, 'public/shot1.png'), 'current-image');
  write(applicationPath(root, 'src/DapanXiaobao/dapan-shots.generated.json'), { synthetic: 'current-metadata' });
  const request = loadServer(root);
  request.restoreWorkspace(record);
  assert.deepEqual(fs.readFileSync(applicationPath(root, 'public/shot1.png')), image);
  assert.deepEqual(JSON.parse(fs.readFileSync(applicationPath(root, 'src/DapanXiaobao/dapan-shots.generated.json'), 'utf8')), generated);
  assert.equal(fs.existsSync(path.join(root, 'public')), false);
  assert.equal(fs.existsSync(path.join(root, 'src')), false);

  write(applicationPath(root, 'public/shot2.png'), 'new-synthetic-image');
  request.snapshotWorkspace(record);
  assert.deepEqual(fs.readFileSync(path.join(state, 'public/shot1.png')), image);
  assert.equal(fs.readFileSync(path.join(state, 'public/shot2.png'), 'utf8'), 'new-synthetic-image');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'src/DapanXiaobao/dapan-shots.generated.json'), 'utf8')), generated);
  assert.equal(fs.existsSync(applicationPath(state)), false);
});

// 2026-09-11 事故回歸：同事在「一張截圖都沒有」的工作按「＋ 加一段」，前台退路是 src:''，
// 送出的網址變成 /api/jobs/<id>/file/（檔名空白）。伺服器把它解回 _製作資料/thumbs 這個
// **資料夾**，createReadStream 對目錄丟的是非同步 EISDIR（stream 的 'error' 事件），
// 呼叫端 try/catch 攔不到 → 未處理例外 → 整台伺服器中止，全公司連不進來 35 分鐘。
// 這裡鎖住：這類檔名一律 404，而且服務要還活著。
test('檔名空白或指向資料夾時回 404，且服務不得中止', async (t) => {
  const root = fixture(t);
  const record = job(root, 'fixture-empty-name');
  write(workFile(root, record.id, 'thumbs', 'plan-0.png'), 'synthetic-thumb');
  write(workFile(root, record.id, 'input', 'shot1.png'), 'synthetic-shot');
  const request = loadServer(root);
  // '..' 不在清單裡：new URL() 會先正規化掉，`/file/..` 變成 `/api/jobs/<id>/`，
  // 根本進不到檔案路由。'%2F' 則不會被正規化，解碼後 basename 一樣是空字串。
  for (const suffix of ['', '.', '%2F']) {
    const response = await request('GET', `/api/jobs/${record.id}/file/${suffix}`);
    assert.equal(response.status, 404, `檔名「${suffix}」應該回 404`);
    assert.ok(response.body.error);
  }
  const alive = await request('GET', `/api/jobs/${record.id}/file/plan-0.png`);
  assert.equal(alive.status, 200);
  assert.equal(alive.bytes.toString(), 'synthetic-thumb');
});
