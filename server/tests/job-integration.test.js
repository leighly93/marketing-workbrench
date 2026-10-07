'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, write, loadServer, workFile, webSource } = require('./isolated-server');
const { createJobStore } = require('../../shared/job-store');
const { applicationPath, cliPath } = require('../../shared/paths');

test('新建工作依完整 ID 建立目錄；成品名稱防覆蓋且重載仍能依 ID 定位', async (t) => {
  const root = fixture(t);
  const request = loadServer(root);
  const result = await request('POST', '/api/jobs', { template: 'dapan', title: '中文測試標題', body: '這是合成稿件。' });
  assert.equal(result.status, 200);
  const job = result.body.job;
  const store = createJobStore(root);
  store.scan();
  const dir = store.directory(job.id);
  assert.ok(path.basename(dir).includes('_中文測試標題_'));
  assert.ok(fs.readFileSync(path.join(dir, 'script.txt'), 'utf8').includes('這是合成稿件。'));
  const first = request.archivePath(job, 'output-dapan.mp4');
  assert.equal(first, path.join(dir, 'portrait.mp4'));
  write(first, '第一次產出');
  assert.equal(request.archivePath(job, 'output-dapan.mp4'), path.join(dir, 'portrait(2).mp4'));
  assert.equal(request.archivePath(job, 'output-dapan-landscape.mp4'), path.join(dir, 'landscape.mp4'));
  assert.equal((await loadServer(root)('GET', `/api/jobs/${job.id}`)).status, 200);
});

test('頁型查得到：準備中讀工作區、跑完讀自己的快照，不會拿到別支的', async (t) => {
  const root = fixture(t);
  const id = '20260917-114243-xhy1';
  write(path.join(root, 'storage', 'jobs', id, '_meta', 'job.json'), {
    id, template: 'midday', owner: '莉莉', title: '標題\n第二行',
    status: 'review', createdAt: '2026-09-17T03:42:43.385Z', emotion: 'fluent',
    skipGenerate: false, noSpeed: false, withAd: false, autoApprove: false, brand: null,
  });
  write(workFile(root, id, 'input', 'script.txt'), '===\n===\n標題\n第二行\n===\n內文\n');
  // 這支自己的快照：籌碼日報
  write(workFile(root, id, 'state', 'src', 'app-images.generated.json'),
    { images: [{ file: 'shot1.jpg', page: 'chips-daily', pageLabel: '籌碼日報' }] });
  // 共用工作區留著別支的分析結果 —— review 狀態不該讀到它
  write(path.join(applicationPath(root), 'src', 'app-images.generated.json'),
    { images: [{ file: 'shot1.jpg', page: 'other-job', pageLabel: '別支工作的頁型' }] });

  const r = await loadServer(root)('GET', `/api/jobs/${id}/pages`);
  assert.equal(r.status, 200);
  assert.equal(r.body.pages['shot1.jpg'].pageLabel, '籌碼日報',
    'review 的工作要讀自己的快照，讀 ROOT 會拿到別支正在跑的工作的頁型');
});

test('前台：截圖總覽兩頁共用同一份實作，點一下的行為各自不同', () => {
  const app = webSource();

  assert.match(app, /function shotFigures\(job, images, count, pages, onPick\)/,
    '兩頁要共用同一個函式，各寫一份遲早會漂走');

  // 配圖計畫頁：點一下＝加一段計畫
  assert.match(app, /shotFigures\(job, pv\.images, count, pv\.pages, addSeg\)/);
  // 手動標記頁：點一下＝加一個標注，次數數的是 ANNOTS
  assert.match(app, /shotFigures\(job, imgs, count, S\.ANNOT_PAGES, \(n\) => addAnnot\(job, n\)\)/);
  const annot = app.slice(app.indexOf('function annotCard(job)'), app.indexOf('function autoGoRow'));
  assert.match(annot, /id: 'annotWall'/, '手動標記頁要有截圖總覽的容器');

  // 標注改動後次數要跟著更新，不然點完縮圖數字還停在舊的
  const draw = app.slice(app.indexOf('function drawAnnots(job)'), app.indexOf('function saveAnnots'));
  assert.match(draw, /drawAnnotWall\(job\)/);
});

// ── 取消鈕（2026-09-17 使用者要求「一進到下一頁就要一直顯示」）────────────────
// 實際踩到的：HeyGen 卡在 processing 十幾分鐘，那支是 preparing —— 舊白名單裡沒有它，
// 畫面上連按鈕都沒有，後端也回 400「正在跑的工作不能取消」，人只能乾等。

test('正在跑的工作也能取消，而且不會被事後標成失敗', async (t) => {
  const root = fixture(t);
  const id = '20260917-114243-xhy1';
  write(path.join(root, 'storage', 'jobs', id, '_meta', 'job.json'), {
    id, template: 'midday', owner: '莉莉', title: '標題\n第二行',
    // detached＝run.js 還活著（loadJobs 判定的）。preparing 寫進 fixture 會被重判成
    // failed（測試環境沒有活著的 pid），所以用 detached 代表「正在跑」那一類。
    status: 'detached', createdAt: '2026-09-17T03:42:43.385Z', emotion: 'fluent',
    skipGenerate: false, noSpeed: false, withAd: false, autoApprove: false, brand: null,
  });
  write(workFile(root, id, 'input', 'script.txt'), '===\n===\n標題\n第二行\n===\n內文\n');
  const request = loadServer(root);

  const r = await request('POST', `/api/jobs/${id}/cancel`, {});
  assert.equal(r.status, 200, '正在跑的工作要受理取消，不能再回 400 叫人等');
  assert.equal(r.body.job.status, 'cancelled');

  // 執行記錄要留痕，不然事後看不出這支是被人喊停還是自己掛掉
  const log = await request('GET', `/api/jobs/${id}/log`);
  assert.match(log.body.text, /已取消/);
});

test('已經結束的工作不給「取消」——那是要刪掉，走列表的刪除', async (t) => {
  const root = fixture(t);
  const id = '20260917-100000-done';
  const base = {
    id, template: 'midday', owner: '莉莉', title: '標題\n第二行',
    createdAt: '2026-09-17T02:00:00.000Z', emotion: 'fluent',
    skipGenerate: false, noSpeed: false, withAd: false, autoApprove: false, brand: null,
  };
  const file = path.join(root, 'storage', 'jobs', id, '_meta', 'job.json');
  for (const status of ['done', 'failed']) {
    write(file, { ...base, status });
    const request = loadServer(root);
    const r = await request('POST', `/api/jobs/${id}/cancel`, {});
    assert.equal(r.status, 400, `${status} 不該用取消`);
  }
  // 已經取消過的再按一次不要報錯（前台兩個人同時按、或重複點）
  write(file, { ...base, status: 'cancelled' });
  const request = loadServer(root);
  const again = await request('POST', `/api/jobs/${id}/cancel`, {});
  assert.equal(again.status, 200);
  assert.equal(again.body.job.status, 'cancelled');
});

test('前台：取消鈕在頁首、一律顯示，只有已經結束的不畫', () => {
  const app = webSource();

  const m = app.match(/function cancelBtn\(job\) \{\n\s*if \(\[([^\]]+)\]\.includes\(job\.status\)\) return '';/);
  assert.ok(m, '找不到 cancelBtn 的狀態判斷');
  for (const s of ['draft', 'queued', 'preparing', 'rendering', 'detached', 'review', 'approved']) {
    assert.doesNotMatch(m[1], new RegExp(`'${s}'`), `${s} 還沒結束，取消鈕要顯示`);
  }

  // 要在頁首那一列（「← 回列表」旁邊），不是埋在最下面的執行記錄裡 ——
  // 埋在下面的話，正在跑的工作整頁都是 log，按鈕在捲軸外面等於沒有。
  const head = app.slice(app.indexOf('const head = el('), app.indexOf('const parts = [head]'));
  assert.match(head, /cancelBtn\(job\)/, '取消鈕要放在頁首');
  const logCard = app.slice(app.indexOf('const logCard = el('), app.indexOf('parts.push(logCard)'));
  assert.doesNotMatch(logCard, /cancelBtn\(job\)/, '同一頁不要兩顆一樣的紅字按鈕');

  // 正在跑的要先講清楚代價，不能只問一句「確定取消？」
  assert.match(app, /點數不會退回/);
});
