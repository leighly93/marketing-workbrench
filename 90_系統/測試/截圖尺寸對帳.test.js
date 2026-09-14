'use strict';

// 事後補上傳的截圖一律照 shot<N> 依序命名（只看這支工作的素材夾），而
// src/app-images.generated.json 是**工作區共用**的產線檔 —— 於是新圖很容易撞到
// 上一支工作同名圖的分析結果：查得到那個檔名，尺寸與頁型卻是別張圖的。
//
// region（顯示區域）與 cell（黃框）存的是原圖像素座標，縮放比一錯整塊就位移＋縮放。
// 2026-09-14 使用者回報「8月營收／大戶狂賣／散戶 的顯示區域框錯」就是這樣來的：
// 三張圖實際都是 869×1884，分析檔卻寫 shot2=1179×1066、shot3=1031×1589。
// 更糟的是記憶庫也一起吃到假尺寸，把 y=1477 除以 1066 記成 1.3858 ——
// 比例座標大於 1，等於學了一個永遠框到圖外的位置。
//
// 判準：標注自己量到的尺寸（前台 img.naturalWidth/Height）必定屬於這支工作，一律優先；
// 對不上分析檔時，那筆分析連帶的頁型／代號也不能用。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, write, loadServer, workFile, repository } = require('./隔離服務');
const { applicationPath, dataPath } = require('../paths');

const { pickImageSize } = require(path.join(applicationPath(repository), 'scripts/image-size'));
const SHOT_MEMORY = require(path.join(applicationPath(repository), 'scripts/shot-memory'));

const 旁白 = '先進光8月營收甚至還在年減';
// 這支工作的真實截圖尺寸；分析檔裡那筆是上一支工作留下的同名圖。
const 真實 = { w: 869, h: 1884 };
const 撞名舊值 = { w: 1179, h: 1066 };

test('標注量到的尺寸優先於分析檔，並標出那筆分析是別張圖的', () => {
  const 撞名 = pickImageSize({ width: 撞名舊值.w, height: 撞名舊值.h }, { imgW: 真實.w, imgH: 真實.h });
  assert.deepEqual(撞名, { width: 真實.w, height: 真實.h, stale: true });

  const 一致 = pickImageSize({ width: 真實.w, height: 真實.h }, { imgW: 真實.w, imgH: 真實.h });
  assert.equal(一致.stale, false, '尺寸對得上就不是撞名，頁型仍然可用');

  // 沒被分析過的圖（2026-09-01 就有的退路）：分析檔查不到 → 用標注自帶的尺寸。
  assert.deepEqual(pickImageSize(undefined, { imgW: 真實.w, imgH: 真實.h }),
    { width: 真實.w, height: 真實.h, stale: false });
  // 標注沒帶尺寸（舊工作、舊格式）→ 只能信分析檔，維持原行為。
  assert.deepEqual(pickImageSize({ width: 撞名舊值.w, height: 撞名舊值.h }, {}),
    { width: 撞名舊值.w, height: 撞名舊值.h, stale: false });
});

test('撞名時，記憶庫用標注的尺寸換算比例，頁型不沿用別張圖的', (t) => {
  const root = fixture(t);
  const cell = { x: 601, y: 1477, w: 133, h: 86 };
  const 結果 = SHOT_MEMORY.learn(root,
    [{ src: 'shot2.jpg', cell, imgW: 真實.w, imgH: 真實.h, phrase: 旁白 }],
    [{ file: 'shot2.jpg', width: 撞名舊值.w, height: 撞名舊值.h, page: 'revenue', stockCode: '3362', words: [] }],
    '2026-09-14T03:24:47.000Z');

  assert.deepEqual(結果.learnedNames, {}, '撞名那筆的代號是別張圖的，不能拿來學股名');

  const mem = JSON.parse(fs.readFileSync(dataPath(root, 'shot-memory.json'), 'utf-8'));
  const keys = Object.keys(mem.pages);
  assert.equal(keys.length, 1);
  const [key] = keys;
  assert.ok(!key.startsWith('revenue@'), `頁型是別張圖的，不能當記憶鍵：${key}`);
  assert.equal(key, `unknown-other@${(真實.w / 真實.h).toFixed(2)}`);

  const 學到 = mem.pages[key].cell;
  assert.ok(學到.y > 0 && 學到.y < 1, `比例座標必須落在圖內，實際 ${學到.y}`);
  assert.equal(學到.y, +(cell.y / 真實.h).toFixed(4));
});

test('計畫頁確認後，撞名的段落不會把假尺寸學進記憶庫', async (t) => {
  const root = fixture(t);
  const id = '20260914-111744-71s8';
  write(workFile(root, id, 'job.json'), {
    id, title: '撞名測試', status: 'review', template: 'midday',
    createdAt: '2026-09-14', owner: '合成測試',
    planView: { rows: [], chars: Array.from(旁白).map((c) => ({ c })) },
  });
  write(workFile(root, id, 'input', 'annotations.json'), { shots: [] });
  write(workFile(root, id, 'state', 'public', 'script.txt'), `===\n===\n標題\n===\n${旁白}\n`);
  // 上一支工作留下的同名分析：檔名對得上，尺寸與頁型卻是別張圖的。
  write(workFile(root, id, 'state', 'src', 'app-images.generated.json'), {
    images: [{ file: 'shot2.jpg', width: 撞名舊值.w, height: 撞名舊值.h,
      page: 'revenue', stockCode: '3362', words: [] }],
  });

  const request = loadServer(root, {
    childProcess: { execFileSync() { return ''; }, spawn() { throw new Error('隔離測試不出片'); } },
    idleTimers: true,
  });
  const res = await request('POST', `/api/jobs/${id}/approve`, {
    by: '合成測試',
    edits: [{
      i: 'a0', _added: true, _manual: true, deleted: false, src: 'shot2.jpg',
      cell: { x: 601, y: 1477, w: 133, h: 86 },
      region: { x: 0, y: 1243, w: 869, h: 327 },
      startCharIdx: 0, endCharIdx: 旁白.length - 1,
      imgW: 真實.w, imgH: 真實.h,
    }],
  });
  assert.equal(res.status, 200);

  const mem = JSON.parse(fs.readFileSync(dataPath(root, 'shot-memory.json'), 'utf-8'));
  for (const [key, box] of Object.entries(mem.pages)) {
    assert.ok(key.endsWith(`@${(真實.w / 真實.h).toFixed(2)}`), `記憶鍵的長寬比要照真實尺寸：${key}`);
    assert.ok(box.cell.y > 0 && box.cell.y < 1, `比例座標必須落在圖內，實際 ${box.cell.y}`);
  }
});
