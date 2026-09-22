'use strict';

// 修正紀錄的「人工標記」那一列，「原本」欄寫的是對照組（假裝沒人標注、讓 AI 自己排一次）的結果。
// 這一欄空白有三種完全不同的意思，講錯就是把假話寫進評估資料：
//   1. 對照組有排東西、只是沒排到這一句 → 真的是「AI 本來不配圖」（有價值的訊號）。
//   2. 對照組整份 0 段 → 根本沒有基準可比（多半是頁型沒認出來），不能算成 AI 判斷不配圖。
//   3. focus 版型（三大法人）的對照組段落**沒有 src** —— 圖永遠是那張版面截圖，
//      auto-focus 只寫 section／cellText。以前直接拿 c.src 比對，整批比出 undefined、
//      `from` 變空字串，於是 institution 的每一筆都被寫成「AI 本來不配圖」（2026-09-14 修）。
//      ⚠️ 2026-09-22 該版型移除，出片路徑上的那條例外跟著刪了，但**歷史紀錄還在**，
//         改由 correctionRows() 認 'institution' 代號標成 legacyNoSrc（見本檔最後一個測試）。

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, write, loadServer, workFile } = require('./隔離服務');

const 旁白 = '外資今天買超三百億';

function 假子程序() {
  // 「系統框選建議」那一次 execFileSync：回空結果就好，這裡驗的不是它。
  return { execFileSync() { return ''; }, spawn() { throw new Error('隔離測試不出片'); } };
}

function 建立待確認工作(root, { id, template, 對照組, 版面圖 }) {
  write(workFile(root, id, 'job.json'), {
    id, title: '對照組測試', status: 'review', template,
    createdAt: '2026-09-14', owner: '合成測試',
    planView: { rows: [], chars: Array.from(旁白).map((c) => ({ c })) },
  });
  write(workFile(root, id, 'input', 'annotations.json'), {
    shots: [{ src: 版面圖 || 'shot1.png', startCharIdx: 0, endCharIdx: 旁白.length - 1,
      cell: { x: 100, y: 200, w: 300, h: 40 }, imgW: 1000, imgH: 2000 }],
  });
  write(workFile(root, id, 'state', 'public', 'script.txt'), `===\n===\n標題\n===\n${旁白}\n`);
  write(workFile(root, id, 'state', 'src', 'app-images.generated.json'), {
    images: [{ file: 版面圖 || 'shot1.png', width: 1000, height: 2000, page: 'stock-k', words: [] }],
  });
  write(workFile(root, id, 'auto-noannots.json'), 對照組);
  if (版面圖) {
    write(workFile(root, id, 'state', 'src/Institution/institution-regions.generated.json'), {
      imageFile: 版面圖, imageWidth: 1000, imageHeight: 2000, sections: {}, words: [],
    });
  }
}

async function 取人工標記(root, id) {
  const request = loadServer(root, { childProcess: 假子程序(), idleTimers: true });
  const res = await request('POST', `/api/jobs/${id}/approve`, { by: '合成測試' });
  assert.equal(res.status, 200);
  const row = (res.body.job.corrections || []).find((r) => r.type === '人工標記');
  assert.ok(row, '沒有留下「人工標記」這一列');
  return row;
}

test('對照組整份 0 段 → 記成「比不出來」，不能記成「AI 本來不配圖」', async (t) => {
  const root = fixture(t);
  const ID = '20260914-090000-aaaa';
  建立待確認工作(root, { id: ID, template: 'midday', 對照組: [] });

  const row = await 取人工標記(root, ID);
  assert.equal(row.autoKind, 'noCounterfactual');
  assert.doesNotMatch(row.autoWhy, /本來一張圖都不會配/,
    '對照組什麼都沒排，卻宣稱 AI 判斷這一句不用配圖 —— 這是假的評估資料');
  assert.match(row.autoWhy, /比不出/);
});

test('對照組有排、只是沒排到這一句 → 才是「AI 本來不配圖」', async (t) => {
  const root = fixture(t);
  const ID = '20260914-090000-bbbb';
  建立待確認工作(root, { id: ID, template: 'midday',
    對照組: [{ src: 'shot1.png', startCharIdx: 旁白.length + 10, endCharIdx: 旁白.length + 15, _auto: true }] });

  const row = await 取人工標記(root, ID);
  assert.equal(row.autoKind, 'none');
  assert.equal(row.from, null);
  assert.match(row.autoWhy, /本來一張圖都不會配/);
});

// 2026-09-22：唯一的 focus 版型（三大法人）已移除，所以「focus 版型的對照組沒有 src」
// 這個案例不再有真實的觸發路徑，測試一併移除。
// server/index.js 裡 planKind === 'focus' 的分支仍留著（見該檔 focus 段落的說明），
// 未來若重新啟用 focus 版型，把這個測試從這個 commit 的 diff 撿回來即可。

// ── 已移除版型的歷史紀錄（2026-09-22）────────────────────────────
// 三大法人是歷來唯一的 focus 版型，它的對照組段落沒有 src，所以 2026-09-14 之前
// 留下的那 38 筆「人工標記」的「原本」欄一律是空的 —— 不是 AI 沒配圖，是比對時
// 拿了對照組根本沒有的欄位。append-only 的歷史檔不改，靠 correctionRows() 在回應裡
// 標成 legacyNoSrc，頁面才不會講「AI 本來不配圖」的假話。
//
// ⚠️ 這個測試存在的理由：那段判斷原本寫成「查 TEMPLATES[r.template].planKind === 'focus'」，
//    版型一移除就永遠落空、假話會自己回來。改成認 'institution' 這個代號之後，
//    用這個測試綁住 —— 別再改回去查 TEMPLATES。
test('已移除版型的舊紀錄要標成 legacyNoSrc —— 版型沒了，假話不能跟著回來', async (t) => {
  const root = fixture(t);
  const ID = '20260901-120000-dddd';
  write(workFile(root, ID, 'job.json'), {
    id: ID, title: '三大法人舊工作', status: 'done', template: 'institution',
    createdAt: '2026-09-01', approvedAt: '2026-09-01T04:00:00.000Z', owner: '合成測試',
    // 2026-09-14 之前的紀錄：沒有 autoKind，from 也是空的
    corrections: [{ type: '人工標記', at: '2026-09-01T04:00:00.000Z', from: '', to: 'shot1.png' }],
  });
  const request = loadServer(root, { childProcess: 假子程序(), idleTimers: true });
  const res = await request('GET', '/api/corrections');
  assert.equal(res.status, 200);
  const row = (res.body.rows || []).find((r) => r.job === ID && r.type === '人工標記');
  assert.ok(row, '修正紀錄裡找不到那支舊工作');
  assert.equal(row.autoKind, 'legacyNoSrc',
    'institution 是已移除的 focus 版型，舊紀錄的空白「原本」要標成「比不出來」而不是「AI 本來不配圖」');
});
