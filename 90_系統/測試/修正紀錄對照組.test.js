'use strict';

// 修正紀錄的「人工標記」那一列，「原本」欄寫的是對照組（假裝沒人標注、讓 AI 自己排一次）的結果。
// 這一欄空白有三種完全不同的意思，講錯就是把假話寫進評估資料：
//   1. 對照組有排東西、只是沒排到這一句 → 真的是「AI 本來不配圖」（有價值的訊號）。
//   2. 對照組整份 0 段 → 根本沒有基準可比（多半是頁型沒認出來），不能算成 AI 判斷不配圖。
//   3. focus 版型（三大法人）的對照組段落**沒有 src** —— 圖永遠是那張版面截圖，
//      auto-focus 只寫 section／cellText。以前直接拿 c.src 比對，整批比出 undefined、
//      `from` 變空字串，於是 institution 的每一筆都被寫成「AI 本來不配圖」（2026-09-14 修）。

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

test('focus 版型的對照組沒有 src → 要補成版面截圖，不能算成「AI 本來不配圖」', async (t) => {
  const root = fixture(t);
  const ID = '20260914-090000-cccc';
  建立待確認工作(root, { id: ID, template: 'institution', 版面圖: '版面.png',
    // auto-focus 真實輸出的形狀：section ＋ cellText，沒有 src
    對照組: [{ section: 'sec1', cellText: '+304.97', startCharIdx: 0, endCharIdx: 旁白.length - 1, _auto: true }] });

  const row = await 取人工標記(root, ID);
  assert.equal(row.autoKind, 'covered');
  assert.equal(row.from, '版面.png', '對照組明明有配這一句，「原本」卻是空的');
  assert.doesNotMatch(row.autoWhy, /本來一張圖都不會配/);
});
