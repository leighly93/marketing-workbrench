'use strict';

// 箭頭（2026-09-16）是第三種人工標記，跟 cell（黃框）、region（顯示區域）各自獨立。
//
// 它要穿過的是一條**跟框不同**的路：標注頁存進 annotations.json → auto-shot 併成配圖計畫
// → 渲染端畫出來。這條路上有兩個很容易把它弄丟的地方：
//   ① auto-shot 併標注時如果沒有把 arrow 帶過去，前台看得到、成品沒有（靜默失效）。
//   ② 只畫箭頭、不畫框的標注仍舊是 `wholePage: true`（圖片擺法不變）——
//      要是連 arrow 都被吃掉，那一段就完全看不出使用者標過東西。
// 這支測試盯的就是這兩件事。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { applicationPath } = require('../paths');

const repository = path.resolve(__dirname, '../..');
const sourceApp = applicationPath(repository);
const 稿件 = '# 合成發音規則\n===\n合成標題\n===\n今天市場穩定，成交量也回來了。\n';
const 圖 = { file: 'shot1.png', width: 1018, height: 1607, words: [] };
const 箭頭 = { x1: 120, y1: 1000, x2: 620, y2: 760, color: '#FF3B30' };

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

// 產線路徑.test.js 的同名夾具，只保留 auto-shot 需要的部分：合成副本 + 禁止外部呼叫。
function fixture(t, scripts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '影片 配圖箭頭測試 '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = applicationPath(root);
  fs.mkdirSync(path.join(app, 'public'), { recursive: true });
  fs.mkdirSync(path.join(app, 'src'), { recursive: true });
  for (const name of ['paths.js', '工作儲存.js']) {
    fs.copyFileSync(path.join(repository, '90_系統', name), path.join(root, '90_系統', name));
  }
  fs.symlinkSync(path.join(sourceApp, 'node_modules'), path.join(app, 'node_modules'), 'dir');
  for (const name of scripts) {
    const destination = path.join(app, 'scripts', name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(sourceApp, 'scripts', name), destination);
  }
  const guard = path.join(root, '禁止外部呼叫.cjs');
  write(guard, `const cp = require('node:child_process');
const blocked = () => { throw new Error('隔離測試禁止網路及外部程序'); };
cp.exec = cp.execSync = cp.execFile = cp.spawn = cp.spawnSync = cp.execFileSync = blocked;
global.fetch = blocked;
require('node:http').request = require('node:https').request = blocked;
`);
  fs.mkdirSync(path.join(root, '90_系統/暫存/產線輸出'), { recursive: true });
  // stdout 混著給人看的進度（「✋ 讀到 N 筆人工標注」），所以計畫要寫檔再讀。
  // ⚠️ --out 只是換輸出位置，要有 --write 才會真的落檔；這裡一律指向合成副本的產線暫存，
  //    不會碰到正式的 *-shots.generated.json。
  const plan = (name = 'auto-shot.js') => {
    execFileSync(process.execPath,
      ['--require', guard, path.join(app, 'scripts', name), '--write', '--out', 'out/計畫.json'], {
        cwd: app, encoding: 'utf8', timeout: 15000,
        env: { PATH: process.env.PATH, WORKBENCH_CALLER_CWD: root },
      });
    return JSON.parse(fs.readFileSync(
      path.join(root, '90_系統', '暫存', '產線輸出', '計畫.json'), 'utf8'));
  };
  return { root, app, plan };
}

test('標注的箭頭會進配圖計畫：只有箭頭的段落照樣整張顯示，但箭頭不能被吃掉', (t) => {
  const { app, plan } = fixture(t, ['auto-shot.js', 'script-utils.js', 'shot-memory.js', 'image-size.js']);
  write(path.join(app, 'public', 'script.txt'), 稿件);
  write(path.join(app, 'src', 'app-images.generated.json'), { images: [圖] });
  write(path.join(app, 'public', 'annotations.json'), {
    shots: [
      // 只有箭頭：沒框、沒顯示區域
      { src: 圖.file, startCharIdx: 0, endCharIdx: 5, arrow: 箭頭, imgW: 圖.width, imgH: 圖.height },
      // 箭頭＋黃框：兩者要同時留著
      { src: 圖.file, startCharIdx: 7, endCharIdx: 12,
        cell: { x: 45, y: 216, w: 165, h: 58 },
        arrow: { ...箭頭, color: '#2E9BFF' }, imgW: 圖.width, imgH: 圖.height },
    ],
  });

  const 計畫 = plan();
  const 只有箭頭 = 計畫.find((s) => s.startCharIdx === 0);
  const 箭頭加框 = 計畫.find((s) => s.startCharIdx === 7);

  assert.ok(只有箭頭, '只畫箭頭的標注不可以整段消失');
  assert.deepEqual(只有箭頭.arrow, 箭頭);
  assert.equal(只有箭頭.wholePage, true, '沒框沒區域＝圖片整張顯示，箭頭不改變擺法');
  assert.equal(只有箭頭.cell, undefined);
  assert.equal(只有箭頭.region, undefined);

  assert.ok(箭頭加框, '箭頭＋黃框的標注要進計畫');
  assert.equal(箭頭加框.arrow.color, '#2E9BFF', '顏色要照使用者選的存');
  assert.ok(箭頭加框.cell, '黃框跟箭頭是兩件事，不能互相蓋掉');
  assert.notEqual(箭頭加框.wholePage, true, '有黃框就不是整張顯示');
});

test('壞掉的箭頭不寫進計畫：長度 0、座標不是數字都當成沒畫', (t) => {
  const { app, plan } = fixture(t, ['auto-shot.js', 'script-utils.js', 'shot-memory.js', 'image-size.js']);
  write(path.join(app, 'public', 'script.txt'), 稿件);
  write(path.join(app, 'src', 'app-images.generated.json'), { images: [圖] });
  write(path.join(app, 'public', 'annotations.json'), {
    shots: [
      { src: 圖.file, startCharIdx: 0, endCharIdx: 5, imgW: 圖.width, imgH: 圖.height,
        arrow: { x1: 100, y1: 100, x2: 100, y2: 100 } },                       // 長度 0
      { src: 圖.file, startCharIdx: 7, endCharIdx: 12, imgW: 圖.width, imgH: 圖.height,
        arrow: { x1: 100, y1: 100, x2: null, y2: 200 } },                      // 座標缺一個
    ],
  });
  for (const s of plan()) {
    assert.equal(s.arrow, undefined, `壞掉的箭頭不可以寫進計畫：${JSON.stringify(s.arrow)}`);
    assert.equal(s.wholePage, true, '箭頭無效就退回整張顯示，不是半成品');
  }
});

// ── 兩邊對不起來的那些地方 ────────────────────────────────────────
// 箭頭的定義散在三處：成品端（src/ShotFocus.tsx 的 SHOT_FOCUS.arrow）、前台預覽
// （server/public/app.js 的 ARROW_* 常數）、各版型的 timeline。2026-09-16 這三處各漏過一次：
//   ① 盤中焦點的 timeline 沒把 arrow 傳給渲染端 → 前台畫得出來、成品沒有（使用者實際踩到）。
//   ② 前台預覽的線寬是「容器寬的 2.2%」、成品是固定畫面 px → 兩邊粗細差兩三倍
//      （使用者：「成品的箭頭跟圈選的時候不一樣」）。
// 下面三支就是盯著這三處不要再各走各的。

const 應用程式 = applicationPath(repository);
const 讀 = (相對路徑) => fs.readFileSync(path.join(應用程式, 相對路徑), 'utf8');

test('有接 region 的 timeline，一定也要把 arrow 傳給渲染端', () => {
  const 目錄 = path.join(應用程式, 'src');
  const timelines = fs.readdirSync(目錄, { recursive: true })
    .filter((n) => String(n).endsWith('-timeline.ts'));
  assert.ok(timelines.length >= 4, `找不到 timeline，測試本身可能過期了：${timelines}`);

  const 漏接 = timelines.filter((n) => {
    const 內容 = fs.readFileSync(path.join(目錄, String(n)), 'utf8');
    // 有把 region 交給 ShotFocus 的，就是走這一整套視覺語言的版型 → 箭頭也該一起交出去。
    return /region:\s*g\.region/.test(內容) && !/arrow:\s*g\.arrow/.test(內容);
  });
  assert.deepEqual(漏接, [], '這些版型會吃掉使用者畫的箭頭（畫得出來、成品沒有）');
});

test('前台預覽的箭頭比例，要跟成品端的常數一致', () => {
  const 成品 = 讀('src/ShotFocus.tsx');
  const arrow = 成品.slice(成品.indexOf('  arrow: {'));
  const 取 = (欄位) => {
    const m = new RegExp(`${欄位}:\\s*(\\d+)`).exec(arrow);
    assert.ok(m, `SHOT_FOCUS.arrow 找不到 ${欄位}`);
    return Number(m[1]);
  };
  const width = 取('width'), headLen = 取('headLen');
  const headWidth = 取('headWidth'), headRound = 取('headRound');

  const 前台 = 讀('server/public/app.js');
  const 比例 = (名稱) => {
    const m = new RegExp(`${名稱}\\s*=\\s*(\\d+)\\s*/\\s*(\\d+)`).exec(前台);
    assert.ok(m, `app.js 找不到 ${名稱}`);
    return [Number(m[1]), Number(m[2])];
  };
  const shaft = /ARROW_SHAFT\s*=\s*(\d+)/.exec(前台);
  assert.ok(shaft, 'app.js 找不到 ARROW_SHAFT');
  assert.equal(Number(shaft[1]), width, '線寬對不上');
  assert.deepEqual(比例('ARROW_HEAD_RATIO'), [headLen, width], '箭鏃長度比例對不上');
  assert.deepEqual(比例('ARROW_HEAD_W_RATIO'), [headWidth, width], '箭鏃寬度比例對不上');
  assert.deepEqual(比例('ARROW_ROUND_RATIO'), [headRound, width], '箭鏃圓角比例對不上');
});

test('前台色票與成品色票是同一組', () => {
  // ⚠️ 要抓「定義」那一處，不是註解裡提到名字的地方 —— 所以正則要帶上後面的賦值符號。
  const 取色 = (文字, 定義) => {
    const m = 定義.exec(文字);
    assert.ok(m, `找不到色票定義：${定義}`);
    return (m[1].match(/#[0-9A-Fa-f]{6}/g) || []).map((c) => c.toUpperCase());
  };
  const 成品 = 取色(讀('src/ShotFocus.tsx'), /palette:\s*\[([^\]]*)\]/);
  const 前台 = 取色(讀('server/public/app.js'), /ARROW_COLORS\s*=\s*\[([^\]]*)\]/);
  assert.ok(成品.length >= 4, `色票看起來不對：${成品}`);
  assert.deepEqual(前台, 成品, '選色盤兩邊不一致，使用者選的顏色會跟成品不同');
});

test('直式配圖寬度：前台參考線／箭頭換算跟成品端同一個數字', () => {
  // 2026-09-24 使用者定案不滿版的直式配圖一律 1070 寬。前台拿這個數字畫「字幕壓到／看不到」
  // 兩條參考線，對不上的話標注頁的線就會跟成品差一截。
  const 成品 = /verticalImageWidth:\s*(\d+)/.exec(讀('src/ShotFocus.tsx'));
  const 前台 = /const SHOT_W\s*=\s*(\d+)/.exec(讀('server/public/app.js'));
  assert.ok(成品, 'ShotFocus.tsx 找不到 SHOT_FOCUS.verticalImageWidth');
  assert.ok(前台, 'app.js 找不到 SHOT_W');
  assert.equal(Number(前台[1]), Number(成品[1]), '直式配圖寬度兩邊不一致');
});
