'use strict';

// recordCorrections() 一定要跑在 learnFromEdits() 之前。
// 兩支都會碰 90_系統/資料/shot-memory.json：前者 spawn 的「系統框選建議」**讀**它，
// 後者把這一支的人工標注**寫**進去。順序反過來的話，建議會撈回使用者五毫秒前才畫的框，
// 修正紀錄的「系統原本會框」就變成抄人的答案，看起來像系統早就知道。
// 這個污染沒有任何外顯症狀（次數 1 跟真的有一次前例長得一模一樣），
// 而 systemCell 是自動框選準確度的評估來源（scripts/_vision-trial/iou.js 的基準線 IoU 0.301），
// 污染後指標會趨近 1.0 —— 錯的方向剛好是「讓人放心」的那個。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { repository, fixture, write, loadServer, workFile } = require('./隔離服務');
const { applicationPath, dataPath } = require('../paths');

const ID = '20260911-090000-cccc';
const 旁白 = '八月營收年增飆破6倍';
const 頁型 = 'stock-k@0.50';            // memKeyOf({ page: 'stock-k', width: 1000, height: 2000 })
const 人畫的框 = { x: 100, y: 200, w: 300, h: 40 };
const 舊框 = { x: 0.69, y: 0.8, w: 0.15, h: 0.04 };   // 之前那一支教的，比例座標

function 建立待確認工作(root) {
  write(workFile(root, ID, 'job.json'), {
    id: ID, title: '順序測試', status: 'review', template: 'midday',
    createdAt: '2026-09-11', owner: '合成測試',
    planView: { rows: [], chars: Array.from(旁白).map((c) => ({ c })) },
  });
  write(workFile(root, ID, 'input', 'annotations.json'), {
    shots: [{ src: 'shot3.jpg', startCharIdx: 0, endCharIdx: 旁白.length - 1,
      cell: 人畫的框, imgW: 1000, imgH: 2000 }],
  });
  write(workFile(root, ID, 'state', 'public', 'script.txt'), `===\n===\n標題\n===\n${旁白}\n`);
  write(workFile(root, ID, 'state', 'src', 'app-images.generated.json'), {
    images: [{ file: 'shot3.jpg', width: 1000, height: 2000, page: 'stock-k', words: [] }],
  });
  // 對照組：AI 有排東西（所以比得出來），只是沒排到這一句 → 這一句 AI 本來不配圖。
  // ⚠️ 不可以寫成空陣列 —— 那是「對照組整份沒排出來」，語意是「比不出來」（見 recordCorrections 的 autoKind）。
  write(workFile(root, ID, 'auto-noannots.json'), [
    { src: 'shot3.jpg', startCharIdx: 旁白.length + 10, endCharIdx: 旁白.length + 15, _auto: true },
  ]);
  // 同型頁面之前已經教過一次 —— 建議應該看到這一筆，不該看到使用者這次畫的框。
  write(dataPath(root, 'shot-memory.json'), {
    codeNames: {},
    pages: { [頁型]: { cell: 舊框, region: null, label: '你標過的位置', at: '2026-09-01T00:00:00.000Z', n: 1 } },
  });
}

// 假的 auto-shot：只回答「--suggest-cells」那一次，而且照**當下**的記憶庫內容回答，
// 這樣被污染時 n 會變成 2、框會變成人剛畫的那一個，測試就抓得到。
function 假子程序(root, 觀測) {
  const 記憶檔 = dataPath(root, 'shot-memory.json');
  return {
    execFileSync(file, args) {
      const 旗標 = (args || []).find((a) => String(a).startsWith('--suggest-cells='));
      if (!旗標) return '';
      const 記憶 = JSON.parse(fs.readFileSync(記憶檔, 'utf-8'));
      const 頁 = (記憶.pages || {})[頁型] || null;
      觀測.push({ 記憶時的框: 頁 && 頁.cell, 記憶時的次數: 頁 && 頁.n });
      const want = JSON.parse(fs.readFileSync(旗標.slice('--suggest-cells='.length), 'utf-8'));
      fs.writeFileSync(args[args.indexOf('--out') + 1], JSON.stringify(want.map((q) => ({
        ...q,
        cell: 頁 ? { x: Math.round(頁.cell.x * 1000), y: Math.round(頁.cell.y * 2000),
          w: Math.round(頁.cell.w * 1000), h: Math.round(頁.cell.h * 2000) } : null,
        cellText: 頁 ? `你標過的位置（同型頁面已標 ${頁.n} 次）` : null,
        why: 頁 ? '記憶庫（你標過的同型頁面）' : '規則庫的區域定義',
      }))));
      return '';
    },
    spawn() { throw new Error('隔離測試不出片'); },
  };
}

test('按下確認時「系統框選建議」看到的記憶庫還沒學這一支 —— recordCorrections 跑在 learnFromEdits 之前', async (t) => {
  const root = fixture(t);
  建立待確認工作(root);
  const 觀測 = [];
  // tick() 會在回應前排隊下一支（setTimeout），走這條路的測試必須放行計時器。
  const request = loadServer(root, { childProcess: 假子程序(root, 觀測), idleTimers: true });

  const res = await request('POST', `/api/jobs/${ID}/approve`, { by: '合成測試' });
  assert.equal(res.status, 200);

  assert.equal(觀測.length, 1, '「系統框選建議」沒有跑到 —— 這個測試等於什麼都沒驗');
  assert.deepEqual(觀測[0].記憶時的框, 舊框,
    '建議讀到的是使用者這一支剛畫的框：learnFromEdits 跑在 recordCorrections 之前了');
  assert.equal(觀測[0].記憶時的次數, 1, '記憶庫在算建議之前就被這一支加過一次了');

  // 反向保險：learnFromEdits 真的有跑完，否則上面兩條會因為「根本沒學」而假通過。
  const 記憶 = JSON.parse(fs.readFileSync(dataPath(root, 'shot-memory.json'), 'utf-8'));
  assert.equal(記憶.pages[頁型].n, 2, 'learnFromEdits 沒把這一支學進去');
  assert.deepEqual(記憶.pages[頁型].cell, { x: 0.1, y: 0.1, w: 0.3, h: 0.02 });

  // 寫進修正紀錄的「系統原本會框」必須是舊的那一筆，不是人剛畫的。
  const 人工標記 = (res.body.job.corrections || []).find((r) => r.type === '人工標記');
  assert.ok(人工標記, '沒有留下「人工標記」這一列');
  assert.equal(人工標記.systemWhy, '記憶庫（你標過的同型頁面）');
  assert.match(人工標記.systemCellText, /已標 1 次/);
  assert.notDeepEqual(人工標記.systemCell, 人畫的框, '「系統原本會框」抄了使用者自己畫的框');
  assert.match(人工標記.autoWhy, /本來一張圖都不會配/);
});

test('recordCorrections 與 learnFromEdits 成對出現，而且一律先記錄再學', () => {
  const 原始碼 = fs.readFileSync(applicationPath(repository, 'server/index.js'), 'utf8');
  const 程式 = 原始碼.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\n)[ \t]*\/\/[^\n]*/g, '$1');
  const 呼叫 = [...程式.matchAll(/(?<!function\s)\b(recordCorrections|learnFromEdits)\s*\(/g)].map((m) => m[1]);

  assert.ok(呼叫.length >= 2, '找不到呼叫點 —— 函式改名的話這個測試要跟著改');
  assert.equal(呼叫.length % 2, 0,
    `有一條路只呼叫了其中一支：${呼叫.join(' → ')}。`
    + '只記錄不學 → 記憶庫收不到料；只學不記錄 → 這一支的修正紀錄整段消失（2026-08-25 的「直接出片」就是這樣漏掉的）');
  for (let i = 0; i < 呼叫.length; i += 2) {
    assert.deepEqual([呼叫[i], 呼叫[i + 1]], ['recordCorrections', 'learnFromEdits'],
      `第 ${i / 2 + 1} 組呼叫順序反了：${呼叫.join(' → ')}。`
      + 'learnFromEdits 會把這一支的標注寫進 shot-memory.json，'
      + '先跑的話 recordCorrections 的「系統原本會框」就會撈回人自己畫的框');
  }
});
