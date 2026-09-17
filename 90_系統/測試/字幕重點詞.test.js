'use strict';

// 字幕重點詞（2026-09-17）：人工在配圖計畫頁拖選的腳本字元範圍，成品裡那幾個字放大變黃。
//
// 這份資料跟配圖計畫是**兩份**：重點詞可能落在完全沒有配圖的句子上，塞不進 shots 陣列，
// 所以另外存成 src/emphasis.generated.json。要盯的地方有三個：
//   ① 寫回的正規化（排序、合併相鄰、丟掉壞值）—— 前台與伺服器規則必須一致，
//      不然「已標 N 處」在送出前後會跳號。
//   ② 一定要寫 ROOT 不是快照（跟 applyPlanEdits 同一個坑，2026-08-18）。
//   ③ 渲染端能不能把字元索引對回字幕 —— 前提是「words 去空白拼接 == _scriptCharTimes 筆數」，
//      這條假設一旦破了，重點詞就會標到隔壁字上。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, write, loadServer, repository, workFile } = require('./隔離服務');
const { applicationPath } = require('../paths');

const EMPHASIS_FILE = 'src/emphasis.generated.json';
// 伺服器跑在 vm 沙箱裡，它建的陣列／物件原型跟這邊不同 realm，
// strict deepEqual 會因為「結構一樣但原型不同」而失敗 —— 先轉回純資料再比。
const plain = (v) => JSON.parse(JSON.stringify(v));
const readMarks = (root) =>
  JSON.parse(fs.readFileSync(path.join(applicationPath(root), EMPHASIS_FILE), 'utf8')).marks;

test('重點詞寫回 ROOT，並且排序、合併相鄰、丟掉壞值', (t) => {
  const root = fixture(t);
  const api = loadServer(root);

  const marks = plain(api.writeEmphasis([
    { startCharIdx: 18, endCharIdx: 19 },
    { startCharIdx: 16, endCharIdx: 17 },     // 跟上面相鄰 → 併成 16~19
    { startCharIdx: 5, endCharIdx: 3 },       // 頭尾顛倒 → 自動翻正
    { startCharIdx: -2, endCharIdx: 4 },      // 負數 → 丟掉
    { startCharIdx: 'x', endCharIdx: 9 },     // 不是數字 → 丟掉
    null,
  ]));

  assert.deepEqual(marks, [
    { startCharIdx: 3, endCharIdx: 5 },
    { startCharIdx: 16, endCharIdx: 19 },
  ]);
  // ⚠️ 要落在 ROOT（app 根），不是工作快照 —— run.js --render-only 只讀 ROOT
  assert.deepEqual(readMarks(root), marks);
});

test('重疊的標記併成一段，不會留下兩筆蓋來蓋去的範圍', (t) => {
  const root = fixture(t);
  const api = loadServer(root);
  assert.deepEqual(
    plain(api.writeEmphasis([
      { startCharIdx: 10, endCharIdx: 20 },
      { startCharIdx: 15, endCharIdx: 25 },
      { startCharIdx: 40, endCharIdx: 41 },
    ])),
    [{ startCharIdx: 10, endCharIdx: 25 }, { startCharIdx: 40, endCharIdx: 41 }]);
});

test('讀不到或壞掉的重點詞檔一律當成沒標，不要讓計畫頁整頁掛掉', (t) => {
  const root = fixture(t);
  const api = loadServer(root);
  const app = applicationPath(root);
  assert.deepEqual(plain(api.emphasisOf(app)), [], '檔案不存在');
  write(path.join(app, EMPHASIS_FILE), '{壞掉的 JSON');
  assert.deepEqual(plain(api.emphasisOf(app)), [], '壞掉的 JSON');
  write(path.join(app, EMPHASIS_FILE), { marks: 'nope' });
  assert.deepEqual(plain(api.emphasisOf(app)), [], 'marks 不是陣列');
  write(path.join(app, EMPHASIS_FILE), { marks: [{ startCharIdx: 1 }, { startCharIdx: 2, endCharIdx: 3 }] });
  assert.deepEqual(plain(api.emphasisOf(app)), [{ startCharIdx: 2, endCharIdx: 3 }], '欄位不齊的那筆要濾掉');
});

test('換下一支工作時，上一支的重點詞要被清掉（它不會被任何一步重新產生）', (t) => {
  const root = fixture(t);
  const api = loadServer(root);
  const app = applicationPath(root);

  // 上一支留下的標記，加上一份會被重算的計畫檔當對照
  api.writeEmphasis([{ startCharIdx: 3, endCharIdx: 9 }]);
  write(path.join(app, 'src/DapanXiaobao/dapan-shots.generated.json'), [{ src: 'shot1.png' }]);
  assert.equal(readMarks(root).length, 1);

  // doPrepare 準備下一支工作時走的就是這一支
  api.clearWorkspaceInputs();

  assert.equal(fs.existsSync(path.join(app, EMPHASIS_FILE)), false,
    '重點詞沒清掉的話，下一支會拿別份腳本的字元索引去標，成品會有無關的字變黃');
  assert.equal(fs.existsSync(path.join(app, 'src/DapanXiaobao/dapan-shots.generated.json')), true,
    '會被 auto-shot 重算的檔案不要動它');
});

test('渲染端的對位前提：words 去空白拼起來，長度要等於 _scriptCharTimes', () => {
  // 重點詞存的是「腳本第幾個字」，而字幕是 word 拼出來的。Subtitles.tsx 靠這條等式
  // 把兩者對起來（見 Phrase.map 的說明）。這裡拿真實產線檔驗，破了就是標到錯的字上。
  const subtitles = path.join(applicationPath(repository), 'src/subtitles.json');
  const data = JSON.parse(fs.readFileSync(subtitles, 'utf8'));
  const times = data._scriptCharTimes || [];
  if (!times.length) return;   // 空工作台（剛 init 過）沒有字幕可驗，跳過
  const chars = (data.segments || [])
    .flatMap((s) => s.words || [])
    .map((w) => String(w.word).trim())
    .join('').length;
  assert.equal(chars, times.length,
    'words 拼接長度與 _scriptCharTimes 對不上 —— 重點詞會標到隔壁字');
});

// ── 三個階段都要標得到（2026-09-17 使用者回報第二次）──────────────────
// 原本只有配圖計畫頁開放，而且那一區還排在「確認，開始出片」的**下面**：
// 人滑到按鈕就以為到底了，一按就換成「排隊等出片」卡片，整個功能等於看不到。
// 勾「標好了，直接出片」的工作更慘 —— 那條路根本不經過計畫頁。
// 現在改成工作自己的 input/emphasis.json，準備中／待確認／排隊三個階段共用同一份。

/**
 * 一支還沒出片的工作。
 * ⚠️ 狀態用 queued 不用 preparing —— loadJobs() 會把 preparing／rendering 依「run.js
 *    還活著嗎」重判成 detached 或 failed，測試環境沒有活著的 pid，寫 preparing 進去
 *    一載入就變 failed。真的在跑的那一種由下面的 detached 代表。
 */
function pendingJob(root, id = '20260917-114243-xhy1') {
  write(path.join(root, '工作紀錄', id, '_製作資料', 'job.json'), {
    id, template: 'midday', owner: '莉莉', title: '標題第一行\n標題第二行',
    status: 'queued', createdAt: '2026-09-17T03:42:43.385Z', emotion: 'fluent',
    skipGenerate: false, noSpeed: false, withAd: false, autoApprove: true, brand: null,
  });
  write(workFile(root, id, 'input', 'script.txt'), '===\n===\n標題第一行\n標題第二行\n===\n內文內文內文\n');
  return id;
}

test('還沒出片就能標重點詞，存在工作自己的 input/ 裡而不是共用的 ROOT', async (t) => {
  const root = fixture(t);
  const id = pendingJob(root);
  const request = loadServer(root);

  const put = await request('PUT', `/api/jobs/${id}/emphasis`, {
    marks: [
      { startCharIdx: 18, endCharIdx: 19 },
      { startCharIdx: 16, endCharIdx: 17 },   // 相鄰 → 併成 16~19
      { startCharIdx: 5, endCharIdx: 3 },     // 頭尾顛倒 → 翻正
      { startCharIdx: -1, endCharIdx: 2 },    // 負數 → 丟掉
    ],
  });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.marks, [
    { startCharIdx: 3, endCharIdx: 5 },
    { startCharIdx: 16, endCharIdx: 19 },
  ], '伺服器要用跟前台 toggleEmph() 同一條正規化規則，不然「已標 N 處」會跳號');

  // ⚠️ ROOT 是共用工作區，這個階段可能正被別支工作佔著 —— 現在寫進去就是污染別人。
  assert.equal(fs.existsSync(path.join(applicationPath(root), EMPHASIS_FILE)), false,
    '準備階段不可以寫 ROOT，真正寫進去的時機只有 doRender 的 restoreWorkspace 之後');
  // 落在 input/：backupJobArtifacts 備份的是 input/ 全部，重新出片也整包帶走
  assert.deepEqual(
    JSON.parse(fs.readFileSync(workFile(root, id, 'input', 'emphasis.json'), 'utf8')).marks,
    put.body.marks);

  const get = await request('GET', `/api/jobs/${id}/emphasis`);
  assert.equal(get.status, 200);
  assert.deepEqual(get.body.marks, put.body.marks, '讀回來要跟存進去的一致');
});

test('開始出片之後不給改重點詞 —— 改了也進不了這支成品，不要讓人白標', async (t) => {
  const root = fixture(t);
  const id = pendingJob(root);
  const file = path.join(root, '工作紀錄', id, '_製作資料', 'job.json');
  const job = JSON.parse(fs.readFileSync(file, 'utf8'));

  for (const status of ['done', 'failed', 'cancelled']) {
    write(file, { ...job, status });
    const request = loadServer(root);
    const r = await request('PUT', `/api/jobs/${id}/emphasis`, { marks: [{ startCharIdx: 1, endCharIdx: 2 }] });
    assert.equal(r.status, 400, `${status} 應該擋下來`);
  }
  // 反過來，還沒 render 的幾個狀態都要放行。
  // preparing 不在這串裡是因為 loadJobs() 會把它重判掉（見 pendingJob 的說明）——
  // 真的在跑的那一種是 detached，它有進來。
  for (const status of ['draft', 'queued', 'detached', 'review', 'approved']) {
    write(file, { ...job, status });
    const request = loadServer(root);
    const r = await request('PUT', `/api/jobs/${id}/emphasis`, { marks: [{ startCharIdx: 1, endCharIdx: 2 }] });
    assert.equal(r.status, 200, `${status} 還來得及，應該放行`);
  }
});

test('退回確認不會把標好的重點詞清掉', async (t) => {
  const root = fixture(t);
  const id = pendingJob(root);
  const file = path.join(root, '工作紀錄', id, '_製作資料', 'job.json');
  const job = JSON.parse(fs.readFileSync(file, 'utf8'));
  write(file, { ...job, status: 'approved', approvedBy: '莉莉', planView: { rows: [], editable: true } });
  const request = loadServer(root);

  await request('PUT', `/api/jobs/${id}/emphasis`, { marks: [{ startCharIdx: 3, endCharIdx: 9 }] });
  const back = await request('POST', `/api/jobs/${id}/unapprove`, {});
  assert.equal(back.status, 200);
  assert.equal(back.body.job.status, 'review');

  const after = await request('GET', `/api/jobs/${id}/emphasis`);
  assert.deepEqual(after.body.marks, [{ startCharIdx: 3, endCharIdx: 9 }],
    '退回確認是「我還要再改」，不是「我要重標」—— 清掉的話標記會無聲消失');
});

test('確認出片沒帶 emphasis 欄位時，不要把準備階段標好的抹掉', (t) => {
  const root = fixture(t);
  const id = pendingJob(root);
  const api = loadServer(root);
  const job = { id };

  api.saveJobEmphasis(job, [{ startCharIdx: 4, endCharIdx: 8 }]);
  assert.deepEqual(plain(api.readJobEmphasis(job)), [{ startCharIdx: 4, endCharIdx: 8 }]);
  // approve 只有在 body 真的帶了陣列時才覆寫（舊前台不帶這個欄位）
  assert.deepEqual(plain(api.readJobEmphasis({ id: '不存在的工作' })), [], '讀不到就當沒標，不要炸');
});

test('前台：準備中、待確認、排隊等出片三個階段都要有重點詞區塊，而且都排在送出鍵上面', () => {
  const app = fs.readFileSync(
    path.join(__dirname, '..', '應用程式', 'server', 'public', 'app.js'), 'utf8');

  assert.match(app, /function emphasisBox\(job, covered\)/, '三個階段要共用同一個函式，不要各寫一份');

  // ① 標注頁（draft／queued／preparing／detached）
  const annot = app.slice(app.indexOf('function annotCard(job)'), app.indexOf('function autoGoRow'));
  assert.match(annot, /emphasisBox\(job/, '標注頁少了重點詞區塊 —— 那才是大家實際待的地方');
  assert.ok(annot.indexOf('emphasisBox(job') < annot.indexOf('autoGoRow(job)'),
    '要排在「標好了，直接出片」上面，不然按下去就進佇列了，等於看不到');

  // ② 配圖計畫頁：一定要在「確認，開始出片」之前。
  //    ⚠️ planCard 開頭還有一個 early return（版型不支援線上調整）也帶著同名按鈕，
  //       要比的是**最後**那一顆 —— 用 indexOf 會比到 early return 那個，永遠是綠的。
  const plan = app.slice(app.indexOf('function planCard(job)'), app.indexOf('function emphasisBox'));
  assert.ok(plan.indexOf('emphasisBox(job') < plan.lastIndexOf("'確認，開始出片'"),
    '重點詞排在確認鍵下面的話，人滑到按鈕就以為到底了（2026-09-17 實際發生）');

  // ③ 排隊等出片：還沒 render，仍然改得動
  const approved = app.slice(app.indexOf("if (job.status === 'approved')"), app.indexOf("if (job.status === 'review'"));
  assert.match(approved, /emphasisBox\(job/, '按完確認就換成這張卡片，這裡沒有的話一樣補標不了');

  // 改了就存，不再只靠 approve 那一下夾帶（準備中與排隊階段根本沒有那顆按鈕）
  assert.match(app, /async function saveEmph\(\)/);
  assert.match(app, /\/emphasis`, \{\s*method: 'PUT'/);
});
