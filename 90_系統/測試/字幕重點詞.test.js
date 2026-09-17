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
const { fixture, write, loadServer, repository } = require('./隔離服務');
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
