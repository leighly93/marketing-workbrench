'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, write, loadServer, workFile } = require('./隔離服務');
const { folderName } = require('../工作儲存');

/**
 * 新建工作的資料夾是 `日期_標題_完整ID`（folderName 決定），不是裸 ID ——
 * workFile() 那套「邏輯名稱 → 合成目錄」只適用於測試自己擺好的工作。
 */
function newWorkFile(root, job, ...parts) {
  const dir = path.join(root, '工作紀錄', folderName(job));
  if (parts[0] === 'input') {
    if (parts[1] === 'script.txt') return path.join(dir, '稿件.txt');
    return path.join(dir, '素材', ...parts.slice(1));
  }
  return path.join(dir, '_製作資料', ...parts);
}

// 2026-09-16：字幕時間軸壞掉那支，同事只能手動重來 —— 重貼稿件、重傳截圖、
// **重畫一次顯示範圍與黃框**，而且重畫的結果跟原本不一樣（兩份 annotations.json
// 一個 1128 bytes、一個 936 bytes）。那些東西工作資料夾裡本來就全都留著。
// 這個檔案綁住「重新出片」：一鍵把同一份輸入再跑一次，標注原封不動。

const ANNOTS = {
  shots: [
    { src: 'shot1.png', startCharIdx: 0, endCharIdx: 27, imgW: 980, imgH: 1671,
      region: { x: 0, y: 145.97514204545453, w: 980.1483499848622, h: 256.3465909090909 },
      cell: { x: 40.20284589766878, y: 338.23508522727275, w: 301.44716924008475, h: 54.592329545454504 },
      arrow: { x1: 100, y1: 200, x2: 300, y2: 400 } },
    { src: 'shot1.png', startCharIdx: 28, endCharIdx: 41, imgW: 980, imgH: 1671,
      region: null, cell: null, arrow: null },
  ],
};

/** 一支跑完的工作：稿件、截圖、標注都在，講者影片留在製作快照裡。 */
function doneJob(root, id = '20260916-161822-jm3u') {
  write(path.join(root, '工作紀錄', id, '_製作資料', 'job.json'), {
    id, template: 'dapan', owner: 'Ryan', title: '標題第一行\n標題第二行',
    status: 'done', createdAt: '2026-09-16T08:18:22.837Z', emotion: 'happy',
    skipGenerate: false, noSpeed: false, withAd: true, autoApprove: true, brand: null,
    annotationCount: 2,
    voiceRules: { own: [], shared: ['反彈→反談'], hit: [{ from: '反彈', to: '反談', src: 'shared', times: 1 }] },
    outputs: [{ name: 'output-dapan.mp4' }],
  });
  write(workFile(root, id, 'input', 'script.txt'), '反彈→反談\n===\n===\n標題第一行\n標題第二行\n===\n內文內文內文\n');
  write(workFile(root, id, 'input', 'shot1.png'), '截圖位元組');
  write(workFile(root, id, 'input', 'annotations.json'), ANNOTS);
  write(workFile(root, id, 'state', 'public', 'heygen.mp4'), '加速過的講者影片');
  return id;
}

test('重新出片：稿件、截圖、標注與講者影片原封不動帶到新工作', async (t) => {
  const root = fixture(t);
  const src = doneJob(root);
  const request = loadServer(root);

  const r = await request('POST', `/api/jobs/${src}/redo`, {});
  assert.equal(r.status, 200);
  const job = r.body.job;

  // 停在 draft：要先讓人進標注頁看過框才送出，不能自己排進佇列
  assert.equal(job.status, 'draft');
  assert.equal(job.redoOf, src);
  assert.notEqual(job.id, src);
  // 一律用現成講者影片 → 不呼叫 HeyGen／MiniMax，不重新扣點數
  assert.equal(job.skipGenerate, true);
  // 旗標整組沿用，不是回到預設值
  assert.equal(job.template, 'dapan');
  assert.equal(job.owner, 'Ryan');
  assert.equal(job.title, '標題第一行\n標題第二行');
  assert.equal(job.emotion, 'happy');
  assert.equal(job.withAd, true);
  assert.equal(job.autoApprove, true);
  assert.deepEqual(job.voiceRules.hit, [{ from: '反彈', to: '反談', src: 'shared', times: 1 }]);

  // 稿件要一字不差 —— 重新套一次共用詞庫的話，詞庫改過之後就跟當初那支不一樣了
  assert.equal(fs.readFileSync(newWorkFile(root, job, 'input', 'script.txt'), 'utf8'),
    fs.readFileSync(workFile(root, src, 'input', 'script.txt'), 'utf8'));
  // 標注（顯示範圍／黃框／箭頭）要完全一樣，這就是整個功能的重點
  assert.deepEqual(JSON.parse(fs.readFileSync(newWorkFile(root, job, 'input', 'annotations.json'), 'utf8')), ANNOTS);
  assert.equal(fs.readFileSync(newWorkFile(root, job, 'input', 'shot1.png'), 'utf8'), '截圖位元組');
  // 素材裡沒有 heygen.mp4（原本是 HeyGen 現生的）→ 要從製作快照補進去
  assert.equal(fs.readFileSync(newWorkFile(root, job, 'input', 'heygen.mp4'), 'utf8'), '加速過的講者影片');

  // submit 會檢查 skipGenerate 的工作有沒有 heygen.mp4，files 要含它才過得了
  assert.ok(job.files.includes('heygen.mp4'));
  assert.ok(job.files.includes('annotations.json'));
  assert.ok(job.files.includes('script.txt'));
  assert.equal(job.annotationCount, 2);

  // 原本那支不能被動到
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '工作紀錄', src, '_製作資料', 'job.json'), 'utf8')).status, 'done');
});

test('重新出片：素材裡自己就有講者影片時，用素材那份（那是這支當初真正送進去的）', async (t) => {
  const root = fixture(t);
  const src = doneJob(root);
  write(workFile(root, src, 'input', 'heygen.mp4'), '當初送進去的講者影片');
  const request = loadServer(root);

  const r = await request('POST', `/api/jobs/${src}/redo`, {});
  assert.equal(r.status, 200);
  assert.equal(fs.readFileSync(newWorkFile(root, r.body.job, 'input', 'heygen.mp4'), 'utf8'), '當初送進去的講者影片');
});

test('重新出片：缺講者影片就講清楚缺什麼，不要靜默失敗或跑到一半才炸', async (t) => {
  const root = fixture(t);
  const id = '20260907-115319-mq02';
  write(path.join(root, '工作紀錄', id, '_製作資料', 'job.json'),
    { id, template: 'dapan', owner: '未署名', title: '舊工作', status: 'done', createdAt: '2026-09-07' });
  write(workFile(root, id, 'input', 'script.txt'), '===\n===\n舊工作\n===\n內文\n');
  const request = loadServer(root);

  const r = await request('POST', `/api/jobs/${id}/redo`, {});
  assert.equal(r.status, 400);
  assert.match(r.body.error, /缺少重跑需要的檔案/);
  assert.match(r.body.error, /講者影片/);
  // 沒有留下半成品的新工作
  assert.deepEqual(fs.readdirSync(path.join(root, '工作紀錄')), [id]);
});

test('重新出片：還在背景跑的工作不給重跑（製作快照這一刻正在被寫）', async (t) => {
  const root = fixture(t);
  const src = doneJob(root);
  const file = path.join(root, '工作紀錄', src, '_製作資料', 'job.json');
  write(file, { ...JSON.parse(fs.readFileSync(file, 'utf8')), status: 'detached' });

  const r = await loadServer(root)('POST', `/api/jobs/${src}/redo`, {});
  assert.equal(r.status, 400);
  assert.match(r.body.error, /還在跑/);
  assert.deepEqual(fs.readdirSync(path.join(root, '工作紀錄')), [src]);
});

test('重新出片：preparing／rendering 也在擋下來的名單裡', () => {
  // 這兩個狀態沒辦法用隔離測試走行為路徑：伺服器一載入，loadJobs() 就會把
  // 「狀態是 preparing／rendering 但 run.js 沒在跑」的工作判成 failed（那是它的本意，
  // 為了伺服器重開後不讓人以為 HeyGen 點數白花）。真實情況下這兩個狀態活在
  // 記憶體裡的 JOBS，不會被重判，所以這裡改成綁住名單本身。
  const src = fs.readFileSync(path.join(__dirname, '..', '應用程式', 'server', 'index.js'), 'utf8');
  const m = src.match(/\/\/ 正在跑的不給重跑[\s\S]{0,200}?if \(\[([^\]]+)\]\.includes\(src\.status\)\)/);
  assert.ok(m, 'server/index.js 找不到 redo 的「正在跑」判斷');
  for (const s of ["'preparing'", "'rendering'", "'detached'"]) assert.match(m[1], new RegExp(s));
});

test('重新出片：版型已經不在了就直接講，不要複製出一支送出必炸的工作', async (t) => {
  const root = fixture(t);
  const id = '20260916-161822-jm3u';
  doneJob(root, id);
  const file = path.join(root, '工作紀錄', id, '_製作資料', 'job.json');
  write(file, { ...JSON.parse(fs.readFileSync(file, 'utf8')), template: '早就砍掉的版型' });

  const r = await loadServer(root)('POST', `/api/jobs/${id}/redo`, {});
  assert.equal(r.status, 400);
  assert.match(r.body.error, /版型「早就砍掉的版型」已經不在了/);
  assert.deepEqual(fs.readdirSync(path.join(root, '工作紀錄')), [id]);
});

test('重新出片：找不到工作回 404', async (t) => {
  const root = fixture(t);
  doneJob(root);
  const request = loadServer(root);
  const r = await request('POST', '/api/jobs/20260101-000000-zzzz/redo', {});
  assert.equal(r.status, 404);
});

test('重新出片複製過來的工作，送出時過得了 submit 的現成影片檢查', async (t) => {
  const root = fixture(t);
  const src = doneJob(root);
  const request = loadServer(root, { idleTimers: true });

  const created = (await request('POST', `/api/jobs/${src}/redo`, {})).body.job;
  const submitted = await request('POST', `/api/jobs/${created.id}/submit`, {});
  // 重點是別被 submit 的「選了用現成講者影片，但沒有上傳 heygen.mp4」擋下來。
  // 送出後佇列會立刻把它撿走（同一個 tick 內就轉 preparing），所以只確認它離開了 draft。
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.notEqual(submitted.body.job.status, 'draft');
  assert.ok(submitted.body.job.files.includes('heygen.mp4'));
});

test('確認關卡改完標注要回報「有吃到」，不能顯示計畫已經算完的紅字警告', async (t) => {
  const root = fixture(t);
  const src = doneJob(root);
  const request = loadServer(root);
  const created = (await request('POST', `/api/jobs/${src}/redo`, {})).body.job;

  const saved = await request('PUT', `/api/jobs/${created.id}/annotations`,
    { shots: [{ src: 'shot1.png', startCharIdx: 0, endCharIdx: 5, region: null, cell: null, arrow: null }] });
  assert.equal(saved.status, 200);
  // applied=false 的話前台會紅字說「這支的配圖計畫已經算完，這筆不會自動進去」——
  // 對 draft 完全相反：它根本還沒開始跑，submit 後 input/ 會整包複製過去。
  assert.equal(saved.body.applied, true);
  assert.equal(saved.body.count, 1);
});

test('標注頁在 draft 要讀得到圖與句子，不然確認關卡是空白的', async (t) => {
  const root = fixture(t);
  const src = doneJob(root);
  const request = loadServer(root);
  const created = (await request('POST', `/api/jobs/${src}/redo`, {})).body.job;

  // 圖片走 /file/：那支 API 會找 input/，draft 的素材就在那裡
  const img = await request('GET', `/api/jobs/${created.id}/file/shot1.png`);
  assert.equal(img.status, 200);
  assert.equal(img.bytes.toString(), '截圖位元組');
  // 標注讀得回來，而且就是原本那一份
  const annots = await request('GET', `/api/jobs/${created.id}/annotations`);
  assert.equal(annots.status, 200);
  assert.deepEqual(annots.body, ANNOTS);
});

test('前台：draft 狀態要開標注頁，重新出片按鈕只給跑完或失敗的工作', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', '應用程式', 'server', 'public', 'app.js'), 'utf8');
  // 標注卡要在 draft 也出現，不然複製過來的工作看不到框、也就無從確認
  const m = app.match(/if \(\[([^\]]+)\]\.includes\(job\.status\)\) parts\.push\(annotCard\(job\)\)/);
  assert.ok(m, 'app.js 找不到標注卡的狀態判斷');
  assert.match(m[1], /'draft'/);
  assert.match(app, /\['done', 'failed'\]\.includes\(job\.status\)\) parts\.push\(redoCard\(job\)\)/);
  // 確認關卡：draft + redoOf 才顯示
  assert.match(app, /job\.status === 'draft' && job\.redoOf/);
  // draft 也要能取消，不然按了重新出片又反悔的工作會永遠留在列表裡
  const cancel = app.match(/\[([^\]]+)\]\.includes\(job\.status\)\n?\s*\? el\('button', \{ class: 'ghost danger'/);
  assert.ok(cancel, 'app.js 找不到取消鈕的狀態判斷');
  assert.match(cancel[1], /'draft'/);
  // 停在 draft 等人確認的工作不能顯示「建立中」——那會讓人以為系統還在忙
  assert.match(app, /function statusText\(j\)/);
  assert.match(app, /j\.status === 'draft' && j\.redoOf\) return '等你確認'/);
  assert.doesNotMatch(app, /STATUS_TEXT\[j\.status\] \|\| j\.status;\n\s*if \(j\.queuePosition/);
});
