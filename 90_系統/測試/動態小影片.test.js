'use strict';

// 動態小影片（2026-09-18）：腳本標一段文字 → 那段換成帶動畫的圖卡，逐項進場對齊旁白。
//
// 這支盯的是「時間怎麼算出來」，因為那是整個功能的價值所在，也是最容易靜默失效的地方：
//   ① 項目的 at 在腳本裡比對不到 → 必須退回等距，不能讓整段沒有動態或時間亂掉。
//   ② 同一個詞在段落裡出現兩次 → 第二項不能配回第一次的位置（時間會倒退）。
//   ③ 兩個版型的畫布與安全區是「腳本」與「Root.tsx 的 composition」各寫一份 ——
//      改了一邊忘了另一邊，render 出來的尺寸就跟貼上去的區域對不上。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { applicationPath } = require('../paths');

const repository = path.resolve(__dirname, '../..');
const app = applicationPath(repository);
const { resolveRange, resolveItemTimes, keywordOf, ORIENTATIONS,
        orientationsFor, TEMPLATE_MOTION } =
  require(path.join(app, 'scripts/render-motion.js'));

/** 造一份好算的字幕：每個字剛好 0.2 秒，第 n 個字從 n×0.2 秒開始。 */
function 字幕(text) {
  return {
    text,
    times: [...text].map((_, i) => ({ start: +(i * 0.2).toFixed(2), end: +((i + 1) * 0.2).toFixed(2) })),
  };
}

test('整段範圍：給 charIdx 就直接用，秒數取頭尾', () => {
  const subs = 字幕('零一二三四五六七八九');
  const r = resolveRange({ startCharIdx: 2, endCharIdx: 5 }, subs, 0);
  assert.equal(r.startCharIdx, 2);
  assert.equal(r.endCharIdx, 5);
  assert.equal(r.startSec, 0.4);
  assert.equal(r.endSec, 1.2);
});

test('整段範圍：沒給 charIdx 就用 at 在腳本裡比對', () => {
  const subs = 字幕('今天台股大漲但籌碼鬆動');
  const r = resolveRange({ at: '籌碼鬆動' }, subs, 0);
  assert.equal(r.startCharIdx, 7);
  assert.equal(r.endCharIdx, 10);
});

test('整段範圍：at 找不到要報錯，不能默默略過', () => {
  const subs = 字幕('今天台股大漲');
  assert.throws(() => resolveRange({ at: '完全不存在的句子' }, subs, 0), /找不到/);
});

test('整段範圍：charIdx 超出腳本長度要報錯', () => {
  const subs = 字幕('只有六個字');
  assert.throws(() => resolveRange({ startCharIdx: 0, endCharIdx: 99 }, subs, 0), /超出/);
});

test('每一項的進場時間：對齊旁白唸到它的那一刻', () => {
  //            0123456789...
  const subs = 字幕('接下來看法人賣多少和融資被洗掉');
  const range = resolveRange({ startCharIdx: 0, endCharIdx: 14 }, subs, 0);
  const spec = resolveItemTimes({
    items: [{ text: '法人賣多少', at: '法人賣多少' }, { text: '融資被洗掉', at: '融資被洗掉' }],
  }, range, subs);
  // 「法人」在第 4 個字 → 0.8 秒；本段從 0 秒開始，所以相對也是 0.8
  assert.equal(spec.items[0].atSec, 0.8);
  // 「融資」在第 10 個字 → 2.0 秒
  assert.equal(spec.items[1].atSec, 2);
  assert.ok(!spec.items[0]._fallback && !spec.items[1]._fallback);
});

test('每一項的進場時間：相對於本段開頭，不是影片開頭', () => {
  const subs = 字幕('前面廢話後面才是重點');
  const range = resolveRange({ startCharIdx: 4, endCharIdx: 9 }, subs, 0); // 從 0.8 秒開始
  const spec = resolveItemTimes({ items: [{ text: '重點', at: '重點' }] }, range, subs);
  // 「重」在第 8 個字＝1.6 秒，減掉本段起點 0.8 → 0.8
  assert.equal(spec.items[0].atSec, 0.8);
});

test('比對不到的那一項退回等距，其餘照常對齊', () => {
  const subs = 字幕('甲乙丙丁戊己庚辛壬癸');
  const range = resolveRange({ startCharIdx: 0, endCharIdx: 9 }, subs, 0); // 0～2 秒
  const spec = resolveItemTimes({
    items: [{ text: '對得上', at: '丙' }, { text: '對不上', at: '這段不在裡面' }],
  }, range, subs);
  assert.equal(spec.items[0].atSec, 0.4);      // 「丙」是第 2 個字
  assert.ok(!spec.items[0]._fallback);
  assert.ok(spec.items[1]._fallback);           // 第二項退回等距
  assert.equal(spec.items[1].atSec, 1.333); // 2 秒的 2/(2+1)，取到小數三位
});

test('同一個詞出現兩次時，第二項不能配回前面（時間不可倒退）', () => {
  const subs = 字幕('法人買超之後法人賣超');
  const range = resolveRange({ startCharIdx: 0, endCharIdx: 9 }, subs, 0);
  const spec = resolveItemTimes({
    items: [{ text: '先買', at: '法人' }, { text: '後賣', at: '法人' }],
  }, range, subs);
  assert.equal(spec.items[0].atSec, 0);         // 第一個「法人」在開頭
  assert.equal(spec.items[1].atSec, 1.2);       // 第二個「法人」在第 6 個字
  assert.ok(spec.items[1].atSec > spec.items[0].atSec);
});

test('已經算好 atSec 的項目不會被覆蓋', () => {
  const subs = 字幕('隨便什麼字');
  const range = resolveRange({ startCharIdx: 0, endCharIdx: 4 }, subs, 0);
  const spec = resolveItemTimes({ items: [{ text: 'x', atSec: 3.5 }] }, range, subs);
  assert.equal(spec.items[0].atSec, 3.5);
});

test('檔名關鍵字：剝掉標點、截到 10 字', () => {
  assert.equal(keywordOf('法人到底賣多少？聯茂跌停'), '法人到底賣多少聯茂跌'); // 剝掉「？」後截前 10 字
  assert.equal(keywordOf('，。！？'), '動態');
  assert.equal(keywordOf(''), '動態');
});

test('兩個版型的畫布與安全區，腳本與 Root.tsx 必須一致', () => {
  // 腳本用這組數字去 render，composition 用那組數字決定畫布與內容區。
  // 只改一邊的話：render 出來的尺寸跟 MotionOverlay 貼上去的區域對不上，畫面會歪掉。
  const root = fs.readFileSync(path.join(app, 'src/Root.tsx'), 'utf-8');
  for (const o of Object.values(ORIENTATIONS)) {
    const i = root.indexOf(`id="${o.composition}"`);
    assert.ok(i > 0, `Root.tsx 找不到 composition ${o.composition}`);
    const block = root.slice(i, root.indexOf('/>', i));
    assert.match(block, new RegExp(`width=\\{${o.width}\\}`), `${o.label} 寬度不一致`);
    assert.match(block, new RegExp(`height=\\{${o.height}\\}`), `${o.label} 高度不一致`);
    assert.match(block, new RegExp(`safeTop:\\s*${o.safeTop}\\b`), `${o.label} safeTop 不一致`);
    assert.match(block, new RegExp(`safeBottom:\\s*${o.safeBottom}\\b`), `${o.label} safeBottom 不一致`);
  }
});

test('安全區必須避開字幕：直式 y1440 起、橫式 y918 起', () => {
  // 這兩個數字是量出來的（Subtitles.tsx 的 paddingTop／paddingBottom），
  // 動態的內容區下緣不能超過它，否則文字會被字幕蓋住。
  assert.ok(ORIENTATIONS.p.safeBottom <= 1440, '直式安全區下緣壓到字幕了');
  assert.ok(ORIENTATIONS.l.safeBottom <= 918, '橫式安全區下緣壓到字幕了');
  // 直式上緣要避開招牌 bar（實測不透明到 y309）
  assert.ok(ORIENTATIONS.p.safeTop >= 310, '直式安全區上緣被招牌 bar 蓋到了');
});

// ── 以下跑真正的 CLI（在隔離目錄裡），補上純函式測不到的那幾條 ──────────
// render-motion.js 的 ROOT 是 __dirname/..，所以把它複製到 tmp/scripts/ 底下，
// 整個 tmp 就變成它眼中的應用程式根目錄：不會碰到真的 src/ 與 public/。

const os = require('node:os');
const { execFileSync } = require('node:child_process');

function 隔離環境(字幕文字) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src/MotionClip'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
  for (const f of ['render-motion.js', 'motion-engine.js'])
    fs.copyFileSync(path.join(app, 'scripts', f), path.join(dir, 'scripts', f));
  const times = [...(字幕文字 || '')].map((_, i) => ({ start: +(i * 0.2).toFixed(2), end: +((i + 1) * 0.2).toFixed(2) }));
  fs.writeFileSync(path.join(dir, 'src/subtitles.json'),
    JSON.stringify({ _scriptText: 字幕文字 || '', _scriptCharTimes: times }));
  return dir;
}
// ⚠️ MOTION_ENGINE=manual：測試只驗自己的邏輯，不打外部服務。
//    預設後端在 2026-09-19 改成 claude-cli，不寫死的話這裡每跑一次就叫一次 claude
//    —— 慢（實測 5.6 秒）、要網路、還吃訂閱額度。要測 engine 本身就自己指定。
const 跑 = (dir, ...args) =>
  execFileSync('node', [path.join(dir, 'scripts/render-motion.js'), ...args],
    { encoding: 'utf-8', env: { ...process.env, MOTION_ENGINE: 'manual' } });
const 產出 = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'src/MotionClip/motion.generated.json'), 'utf-8'));

test('產出檔被刪掉也要跑得起來 —— Remotion 是靜態 import 它的', () => {
  // 2026-09-19 實際出片踩到：清工作區時把 motion.generated.json **刪掉**（而不是清空），
  // 而 motion-timeline.ts 是 `import generatedMotion from './motion.generated.json'`。
  // 檔案不在，Remotion 連 bundle 都過不了 —— 而 render-motion 第一步就是 render。
  // 錯誤訊息是「Can't resolve './motion.generated.json'」，看起來像專案壞了，
  // 其實只差一個空陣列。所以這支程式要自己補上，不能假設有人先放好。
  const dir = 隔離環境('外資今天買超八百七十億而且是連續第二天');
  fs.writeFileSync(path.join(dir, 'public/motion.json'), JSON.stringify([{
    startCharIdx: 0,
    endCharIdx: 10,
    spec: {
      template: 'list',
      kicker: '今日盤勢',
      title: '外資|買超',
      items: [{ text: '買超 870 億', at: '八百七十億' }, { text: '連 2 日', at: '連續第二天' }],
    },
  }]));
  const out = path.join(dir, 'src/MotionClip/motion.generated.json');
  fs.rmSync(out, { force: true });
  assert.equal(fs.existsSync(out), false, '前提：這個檔一開始不存在');

  // manual 後端＝用上面貼好的 spec，不呼叫 claude；dry-run＝不真的 render。
  execFileSync('node', [path.join(dir, 'scripts/render-motion.js'), '--dry-run'],
    { encoding: 'utf-8', env: { ...process.env, MOTION_ENGINE: 'manual' } });

  assert.ok(fs.existsSync(out), 'render 之前就該把它補出來，否則 bundle 會失敗');
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf-8')), [], '補出來的是空陣列');
});

test('沒有參數檔：寫出空陣列，不是留著上一支的動態', () => {
  // 這是最常走的路徑 —— 大部分影片沒有動態。留著舊內容的話，
  // 下一支會莫名其妙帶上別支的動態畫面。
  const dir = 隔離環境('隨便什麼字');
  fs.writeFileSync(path.join(dir, 'src/MotionClip/motion.generated.json'), '[{"src":"上一支殘留.mp4"}]');
  const out = 跑(dir);
  assert.match(out, /不做動態/);
  assert.deepEqual(產出(dir), []);
});

test('參數檔是空陣列：一樣寫出空陣列', () => {
  const dir = 隔離環境('隨便什麼字');
  fs.writeFileSync(path.join(dir, 'public/motion.json'), '[]');
  跑(dir);
  assert.deepEqual(產出(dir), []);
});

test('命名規則：public 用 ASCII、素材用看得懂的中文名', () => {
  // public/ 的檔名要進 Remotion 的 staticFile，中文路徑容易出事，所以刻意分兩套。
  const dir = 隔離環境('接下來看法人賣多少和融資被洗掉');
  fs.writeFileSync(path.join(dir, 'public/motion.json'), JSON.stringify([{
    startCharIdx: 0, endCharIdx: 14, keyword: '三個觀察重點',
    // list 至少兩項 —— 少於兩項 motion-engine 會判定不合格（一項的條列沒有意義）
    spec: { template: 'list', items: [{ text: '法人賣多少', at: '法人賣多少' },
                                      { text: '融資洗掉沒', at: '融資被洗掉' }] },
  }]));
  // 指定 dapan：只有它有橫式，不指定的話只會出直式（見 orientationsFor）
  const out = 跑(dir, '--dry-run', '--template=dapan');
  assert.match(out, /public\/motion-1-p\.mp4/, '直式 public 檔名');
  assert.match(out, /public\/motion-1-l\.mp4/, '橫式 public 檔名');
});

test('字幕還沒轉好就跑：要報錯，不能默默產出沒有時間的動態', () => {
  const dir = 隔離環境('');   // _scriptCharTimes 是空的
  fs.writeFileSync(path.join(dir, 'public/motion.json'), JSON.stringify([{ startCharIdx: 0, endCharIdx: 1, spec: {} }]));
  assert.throws(() => 跑(dir), (e) => /correct-subtitles|_scriptCharTimes/.test(e.stdout + e.stderr));
});

test('dry-run 不會寫壞既有的 motion.generated.json', () => {
  const dir = 隔離環境('接下來看法人賣多少和融資被洗掉');
  fs.writeFileSync(path.join(dir, 'src/MotionClip/motion.generated.json'), '["原本的內容"]');
  fs.writeFileSync(path.join(dir, 'public/motion.json'), JSON.stringify([{
    startCharIdx: 0, endCharIdx: 14, spec: { items: [{ text: 'x', at: '法人' }] },
  }]));
  跑(dir, '--dry-run');
  assert.deepEqual(產出(dir), ['原本的內容'], 'dry-run 不該動產出檔');
});

// ── run.js 的接線（2026-09-18）─────────────────────────────────
// run.js 不能 require（它會直接跑 main），所以這幾條是讀原始碼做結構檢查。
// 脆弱歸脆弱，但擋得住「重構時把 try/catch 拿掉」這種會靜默吃掉成品的改動。

test('run.js：動態排在字幕之後、停在出片前之前', () => {
  // 之前：沒有 _scriptCharTimes 就算不出每一項的秒數。
  // 之後：--stop-before-render 停下來時，配圖計畫頁才看得到動態、可以預覽與棄用。
  const src = fs.readFileSync(path.join(app, 'run.js'), 'utf-8');
  const 字幕 = src.indexOf('transcribeWithRetry();');
  const 動態 = src.indexOf('renderMotionClips();');
  const 停下 = src.indexOf('if (STOP_BEFORE_RENDER)');
  assert.ok(字幕 > 0 && 動態 > 字幕, '動態必須排在轉字幕之後');
  assert.ok(停下 > 動態, '動態必須在「停在出片前」之前跑完');
});

test('run.js：動態失敗要降級，而且要清空 generated 檔', () => {
  // 不清空的話會沿用上一支的 motion.generated.json ——
  // 這支影片會貼上**別支的動態畫面**，而且完全沒有錯誤訊息。
  const src = fs.readFileSync(path.join(app, 'run.js'), 'utf-8');
  const i = src.indexOf('function renderMotionClips()');
  assert.ok(i > 0, 'run.js 找不到 renderMotionClips');
  const fn = src.slice(i, src.indexOf('\nfunction ', i + 10));
  assert.match(fn, /catch\s*\(/, '沒有 catch —— 動態掛掉會讓整支出片失敗');
  assert.match(fn, /不影響出片/, 'catch 裡要留下可辨識的記錄');
  assert.match(fn, /writeFileSync\(\s*motionGenerated/, '降級時必須清空 motion.generated.json');
});

test('run.js：清殘留的 regex 只打中動態檔，不能誤刪講者影片或套版素材', () => {
  // 這個 regex 會直接 unlinkSync。打太寬的話會刪掉 heygen.mp4 ——
  // 那是花了 HeyGen 額度生出來的，刪掉就得重跑。
  const src = fs.readFileSync(path.join(app, 'run.js'), 'utf-8');
  const m = src.match(/if \((\/\^motion[^/]*\/)\.test\(f\)\)/);
  assert.ok(m, 'run.js 找不到清殘留的 regex');
  const re = new RegExp(m[1].slice(1, -1));
  for (const 該刪 of ['motion-1-p.mp4', 'motion-2-l.mp4', 'motion-10-p.mp4']) {
    assert.ok(re.test(該刪), `${該刪} 應該要被清掉`);
  }
  for (const 不該刪 of ['heygen.mp4', 'outro.mp4', 'dapan-bgm.wav', 'shot1.png',
                        'motion.json', 'minimax.mp3', 'motion-1-p.mp4.bak']) {
    assert.ok(!re.test(不該刪), `${不該刪} 不該被清掉`);
  }
});

// ── 伺服器端（2026-09-18）─────────────────────────────────────
// 動態的設定存在工作自己的 input/motion.json。選這個位置是因為 stageJobInputs 會把
// 整個 input/ 複製進 ROOT/public，而 render-motion.js 讀的就是 public/motion.json ——
// 不必另外接線，「重新出片」整包帶走 input/ 也自動沿用。
// 要盯的是：正規化（只收一段、丟壞值、spec 原樣留著）、狀態守門、以及 preparing 時
// 要補寫 ROOT/public（那代表 run.js 正佔著 ROOT 在跑，不補就趕不上 renderMotionClips）。

const { fixture: 沙箱, write: 寫檔, loadServer } = require('./隔離服務');
const { applicationPath: appPath } = require('../paths');
const { createJobStore } = require('../工作儲存');

// 工作目錄是「工作紀錄/<日期>_<標題>_<完整ID>」，不是 jobs/<id> —— 要用正式的解析器拿路徑
const 工作檔 = (root, id, ...parts) => path.join(createJobStore(root).directory(id), ...parts);

// 伺服器跑在 vm 沙箱，原型跟這邊不同 realm，strict deepEqual 會誤判 —— 先轉純資料
const 純 = (v) => JSON.parse(JSON.stringify(v));
const 稿件 = { template: 'dapan', title: '合成標題', body: '這是合成稿件。' };

test('伺服器：只收一段、丟掉壞值、spec 原樣保留', (t) => {
  const root = 沙箱(t);
  const api = loadServer(root);
  const got = 純(api.normalizeMotion([
    { startCharIdx: 10, endCharIdx: 40, keyword: '三大法人', spec: { template: 'list', items: [] } },
    { startCharIdx: 50, endCharIdx: 60 },          // 第二段 → 使用者定案每支只有 1 段，丟掉
    { startCharIdx: 'x', endCharIdx: 9 },          // 不是數字 → 丟掉
    { startCharIdx: 9, endCharIdx: 3 },            // 頭尾顛倒 → 丟掉（不自動翻正，那會猜錯意圖）
    null,
  ]));
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], {
    startCharIdx: 10, endCharIdx: 40, keyword: '三大法人',
    spec: { template: 'list', items: [] },
  });
});

test('伺服器：spec 的內容不在這裡驗 —— 那是 motion-engine 的事', (t) => {
  // 這一層只管「有沒有這個欄位」。三種模板各要什麼欄位只有 motion-engine 知道，
  // 兩邊都驗會漂走（這專案被「同一套規則兩份實作」咬過好幾次）。
  const root = 沙箱(t);
  const api = loadServer(root);
  const got = 純(api.normalizeMotion([{ startCharIdx: 0, endCharIdx: 5, spec: { 亂寫: true } }]));
  assert.deepEqual(got[0].spec, { 亂寫: true });
});

test('伺服器：存進工作自己的 input/motion.json，清空就把檔案刪掉', async (t) => {
  const root = 沙箱(t);
  const request = loadServer(root);
  const 建立 = await request('POST', '/api/jobs', 稿件);
  const id = 建立.body.job.id;   // POST /api/jobs 回的是 { job: {...} }
  const 檔 = 工作檔(root, id, '素材', 'motion.json');

  const 存 = await request('PUT', `/api/jobs/${id}/motion`,
    { entries: [{ startCharIdx: 3, endCharIdx: 9 }] });
  assert.equal(存.status, 200);
  assert.equal(存.body.count, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(檔, 'utf8')), [{ startCharIdx: 3, endCharIdx: 9 }]);

  const 讀 = await request('GET', `/api/jobs/${id}/motion`);
  assert.deepEqual(純(讀.body.entries), [{ startCharIdx: 3, endCharIdx: 9 }]);

  // 清空 → 檔案要消失，不是留一個空陣列。留著的話 render-motion 會走「參數檔是空的」
  // 那條路，行為一樣但多一次讀檔；更重要的是 input/ 裡不該留沒意義的檔案。
  const 清 = await request('PUT', `/api/jobs/${id}/motion`, { entries: [] });
  assert.equal(清.body.count, 0);
  assert.equal(fs.existsSync(檔), false);
});

test('伺服器：開始 render 之後就不給改，並且說清楚為什麼', async (t) => {
  const root = 沙箱(t);
  const api = loadServer(root);
  const request = api;
  const 建立 = await request('POST', '/api/jobs', 稿件);
  const id = 建立.body.job.id;   // POST /api/jobs 回的是 { job: {...} }
  // ⚠️ 要改記憶體裡那份 —— 伺服器的工作狀態不是每次從 job.json 重讀
  api.getJob(id).status = 'rendering';

  const res = await request('PUT', `/api/jobs/${id}/motion`,
    { entries: [{ startCharIdx: 0, endCharIdx: 5 }] });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /已經開始出片/);
});

test('伺服器：preparing 時要補寫 ROOT/public，才趕得上 run.js 的動態那一步', async (t) => {
  // 動態是在 prepare 階段就 render 的（配圖計畫頁才預覽得到）。
  // 人在「準備中」標的若不補進 ROOT，run.js 讀不到 → 這支就沒有動態。
  const root = 沙箱(t);
  const api = loadServer(root);
  const request = api;
  const 建立 = await request('POST', '/api/jobs', 稿件);
  const id = 建立.body.job.id;   // POST /api/jobs 回的是 { job: {...} }
  api.getJob(id).status = 'preparing';

  await request('PUT', `/api/jobs/${id}/motion`, { entries: [{ startCharIdx: 1, endCharIdx: 8 }] });
  const rootMotion = path.join(appPath(root), 'public', 'motion.json');
  assert.ok(fs.existsSync(rootMotion), 'preparing 時必須補寫 ROOT/public/motion.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(rootMotion, 'utf8')), [{ startCharIdx: 1, endCharIdx: 8 }]);

  // 清空時也要把 ROOT 那份刪掉，不然 run.js 會拿舊設定去做
  await request('PUT', `/api/jobs/${id}/motion`, { entries: [] });
  assert.equal(fs.existsSync(rootMotion), false, '清空時 ROOT 那份也要刪掉');
});

test('伺服器：queued 階段不補寫 ROOT —— 那會污染別支正在跑的工作', async (t) => {
  const root = 沙箱(t);
  const request = loadServer(root);
  const 建立 = await request('POST', '/api/jobs', 稿件);
  const id = 建立.body.job.id;   // POST /api/jobs 回的是 { job: {...} }   // 建立後預設是 draft，不是 preparing

  await request('PUT', `/api/jobs/${id}/motion`, { entries: [{ startCharIdx: 1, endCharIdx: 8 }] });
  assert.equal(fs.existsSync(path.join(appPath(root), 'public', 'motion.json')), false,
    '只有 preparing 才代表這支正佔著 ROOT');
});

// ── 條列字級自適應（2026-09-21）──────────────────────────────
// 文字少、空間大就放大到上限 104；字多就自己收斂，不能折行。
// 折行在成品裡很難看，而且是 render 出來才看得到 —— 所以用測試守住算式。

/** 跟 MotionClipComposition 同一套算法（那支是 .tsx，測試 require 不進來） */
const 字級下限 = 44;
function 算字級(text, { avail, max }) {
  const w = [...text].reduce((n, c) => n + (/[\x20-\x7e]/.test(c) ? 0.55 : 1), 0);
  return { 字級: Math.round(Math.max(字級下限, Math.min(max, (avail * 0.97) / w))), 視覺寬: w };
}

/** 兩種模板的文字可用寬（都已扣掉圖示、gap、卡片 padding 與外框） */
const 可用寬 = {
  contrast: 1080 - 74 * 2 - 68 - 6 - 56 - 20,
  list: 1080 - 74 * 2 - 56 - 6 - 96 - 28,
};

test('條列字級：短文字放大到上限，長文字自己收斂且不會折行', () => {
  // 兩種模板的可用寬不一樣（list 的編號徽章比 contrast 的勾勾大），要各自驗。
  for (const [模板, avail] of Object.entries(可用寬)) {
    const 設定 = { avail, max: 104 };
    for (const s of ['外資870億買超', '連2日買力道放大', '台積電ADR漲3.5%',
                     '營收落地或由虧轉盈', '三大法人同步站在買方這邊',
                     '外資買超創今年新高紀錄再刷新']) {
      const { 字級, 視覺寬 } = 算字級(s, 設定);
      assert.ok(字級 <= 104, `${模板}／${s}：不能超過上限`);
      assert.ok(字級 * 視覺寬 <= avail,
        `${模板}／${s}：算出 ${字級}px × ${視覺寬} 字 = ${Math.round(字級 * 視覺寬)}px，`
        + `超過可用的 ${avail}px 會折行`);
    }
    // 短的要真的有放大（不然這個功能等於沒做）
    assert.equal(算字級('外資870億買超', 設定).字級, 104, `${模板}：短文字應該撐到上限`);
  }
});

test('list 只有一項也要出動態 —— 擋掉的代價是整支都沒有', () => {
  // 2026-09-21 使用者：「只有一個沒關係！要出動態！」
  // 原本要求至少兩項（理由是「一項的條列沒有意義」），但那是美感判斷，
  // 而擋掉等於整支影片沒有動態。實際 render 過，一張卡片置中，版面不會壞。
  const { validate, buildPrompt } = require(path.join(app, 'scripts/motion-engine.js'));

  const 一項 = validate({ template: 'list', items: [{ text: '外資買超八百七十億', at: '外資' }] });
  assert.ok(一項, '一項不能被擋掉');
  assert.equal(一項.items.length, 1);

  // 界線另一端維持原樣
  assert.equal(validate({ template: 'list', items: [] }), null, '零項沒東西可畫，還是要擋');
  assert.equal(validate({ template: 'list', items: Array(6).fill({ text: 'x' }) }), null, '超過五項要擋');

  // prompt 也要一致，否則 claude 會為了湊數硬編一個沒內容的點
  assert.match(buildPrompt('隨便一段旁白'), /只給一項/, 'prompt 要講明可以只給一項');
});

test('prompt 要求每項最多 9 個字，但驗證**不**擋 —— 擋了就整支沒動態', () => {
  // 2026-09-21 使用者定案：字數只在 prompt 要求，不寫進 validate。
  // 「不能不出動態」—— 驗證擋掉的代價是整支影片沒有動態，比字小得多。
  // 超過 9 字時交給 fitFontSize 縮小處理，畫面會小一點但東西還在。
  const { buildPrompt, validate } = require(path.join(app, 'scripts/motion-engine.js'));

  assert.match(buildPrompt('隨便一段旁白'), /最多 9 個字/, 'prompt 要講明 9 個字');

  // 12 個字的項目**必須**通過驗證（這正是不擋的意思）
  const 超長 = validate({
    template: 'list',
    items: [{ text: '三大法人同步站在買方這邊', at: '法人' }, { text: '外資買超創今年新高紀錄', at: '外資' }],
  });
  assert.ok(超長, '超過 9 字不能被擋掉 —— 擋了整支就沒有動態');
  assert.equal(超長.items[0].text, '三大法人同步站在買方這邊', '也不能偷偷截斷');
});

test('條列字級：放不下就要縮，不能硬撐原本的大小', () => {
  // 2026-09-21 踩到：一開始寫成「只放大不縮小」，下限設成原本的 66，
  // 結果長文字在加了外框、可用寬變窄之後，硬撐 66 反而折行
  //（12 字 × 66px = 792px，list 可用只有 746px）。放不下就該縮。
  const { 字級, 視覺寬 } = 算字級('三大法人同步站在買方這邊', { avail: 可用寬.list, max: 104 });
  assert.ok(字級 < 66, `應該縮到比原本的 66 小，實際 ${字級}`);
  assert.ok(字級 * 視覺寬 <= 可用寬.list, '縮完之後要真的放得下');
  assert.ok(字級 >= 字級下限, '但也不能無限縮到看不清楚');
});

test('條列字級：留 3% 餘裕 —— 貼著邊界算遲早會折行', () => {
  // 2026-09-21 實際踩到：上限開 104 時「連2日買力道放大」算出 785px、可用 782px，
  // 差 3px 就折成兩行。字寬是估的（中文 1 格、半形 0.55 格），不可能永遠剛好。
  const avail = 1000;
  const 剛好塞滿 = '一二三四五六七八九十';          // 10 格
  const { 字級 } = 算字級(剛好塞滿, { avail, max: 999 });
  assert.ok(字級 * 10 <= avail * 0.98, `應該留餘裕，實際用了 ${字級 * 10}/${avail}`);
});

// ── 做在結尾就演到片尾（2026-09-21）──────────────────────────
// 使用者定案：動態做在腳本結尾的話不要淡出回講者，直接延續到影片結束，剩幾秒都延續。
// 判定是「拖到腳本最後」，所以使用者自己控制得了：拖到底＝延續，刻意留一段＝照舊回講者。

/** 隔離環境 + 一份講者影片長度 */
function 隔離環境含片長(字幕文字, heygenDurationSec) {
  const dir = 隔離環境(字幕文字);
  fs.writeFileSync(path.join(dir, 'src/video-meta.json'),
    JSON.stringify({ heygenDurationSec }));
  return dir;
}

/** 一段 list 參數，manual 後端直接用（不叫 claude） */
const 兩項參數 = (startCharIdx, endCharIdx) => JSON.stringify([{
  startCharIdx, endCharIdx,
  spec: { template: 'list', kicker: '今日盤勢', title: '重點|兩件事',
          items: [{ text: '第一件', at: '外資' }, { text: '第二件', at: '買超' }] },
}]);

test('拖到腳本結尾：演到影片結束，而不是在旁白講完就淡出', () => {
  // 20 個字 × 0.2 秒 = 旁白 4 秒，但講者影片有 9 秒
  const 字 = '外資買超八百七十億連續第二天力道放大了喔';
  const dir = 隔離環境含片長(字, 9);
  fs.writeFileSync(path.join(dir, 'public/motion.json'), 兩項參數(4, 字.length - 1));

  const out = 跑(dir, '--dry-run');
  assert.match(out, /做在結尾/, '應該判定成做在結尾');
  // 0.8s 開始、演到 9s ＝ 8.2 秒，而不是旁白結束的 4 秒
  assert.match(out, /0\.80s–9\.00s（8\.2 秒）/, `延到片尾的秒數不對：${out}`);
});

test('沒拖到結尾就照舊 —— 留一段旁白是使用者的選擇', () => {
  const 字 = '外資買超八百七十億連續第二天力道放大了喔';
  const dir = 隔離環境含片長(字, 9);
  // 只標到一半，後面還有 10 個字的旁白
  fs.writeFileSync(path.join(dir, 'public/motion.json'), 兩項參數(0, 9));

  const out = 跑(dir, '--dry-run');
  assert.doesNotMatch(out, /做在結尾/, '中間那段不該延續，後面還有旁白要配講者畫面');
  assert.match(out, /0\.00s–2\.00s（2 秒）/, `不該延長：${out}`);
});

test('讀不到講者影片長度就維持原樣，不要亂猜', () => {
  // video-meta.json 不存在（例如還沒 transcribe）。寧可照舊淡出，
  // 也不要因為一個猜出來的數字把動態拉過頭、蓋掉後面的畫面。
  const 字 = '外資買超八百七十億連續第二天力道放大了喔';
  const dir = 隔離環境(字);   // 沒有 video-meta.json
  fs.writeFileSync(path.join(dir, 'public/motion.json'), 兩項參數(4, 字.length - 1));

  const out = 跑(dir, '--dry-run');
  assert.doesNotMatch(out, /做在結尾/);
});

// ── 接到其他版型（2026-09-21）────────────────────────────────
// 只有大盤小報有橫式輸出，其餘版型都只出直式。安全區沿用各 composition 自己那個
// 量過的 safeTop（招牌實心到哪）—— 動態要避開的東西跟截圖黃框完全一樣。

/** 版型代號 → 直式 composition 的檔案 */
const 版型檔案 = {
  dapan: 'src/DapanXiaobao/DapanComposition.tsx',
  midday: 'src/MiddayFocus/MiddayFocusComposition.tsx',
  usstock: 'src/UsStock/UsStockComposition.tsx',
};

test('只有大盤小報出橫式，其他版型只出直式', () => {
  assert.deepEqual(orientationsFor('dapan').map((o) => o.key), ['p', 'l']);
  assert.deepEqual(orientationsFor('midday').map((o) => o.key), ['p']);
  assert.deepEqual(orientationsFor('usstock').map((o) => o.key), ['p']);
});

test('不認得的版型只出直式 —— 猜錯的代價不對稱', () => {
  // 少一支橫式只是沒有；多一支是每次出片都白等十秒、白佔 1.3MB。
  assert.deepEqual(orientationsFor('還沒接的版型').map((o) => o.key), ['p']);
  assert.deepEqual(orientationsFor('').map((o) => o.key), ['p']);
});

test('美股焦點的招牌比較高，安全區要跟著讓', () => {
  assert.equal(orientationsFor('usstock')[0].safeTop, 325);
  assert.equal(orientationsFor('midday')[0].safeTop, 310);
});

test('動態的安全區要跟該版型 composition 自己的 safeTop 一致', () => {
  // 兩邊各寫一份數字，改了一邊忘了另一邊，動態就會壓到招牌或字幕。
  // composition 的 safeTop 是量出來的（招牌實心到 y幾），動態沒有理由另立一套。
  for (const [代號, 檔] of Object.entries(版型檔案)) {
    const code = fs.readFileSync(path.join(app, 檔), 'utf-8');
    const m = code.match(/safeTop=\{(\d+)\}/);
    assert.ok(m, `${檔} 找不到 safeTop`);
    assert.equal(orientationsFor(代號)[0].safeTop, Number(m[1]),
      `${代號}：動態的 safeTop 跟 composition 的不一致`);
  }
});

test('登記了動態的版型，composition 就要真的貼上去', () => {
  // 反過來也要成立：TEMPLATE_MOTION 有登記卻沒掛 MotionOverlay 的話，
  // 每次出片都會 render 出 mp4，然後沒有任何人用它 —— 白花十幾秒而且完全沒有錯誤訊息。
  for (const 代號 of Object.keys(TEMPLATE_MOTION)) {
    const 檔 = 版型檔案[代號];
    assert.ok(檔, `TEMPLATE_MOTION 有 ${代號}，但測試的版型檔案表沒有 —— 補一筆`);
    const code = fs.readFileSync(path.join(app, 檔), 'utf-8');
    assert.match(code, /<MotionOverlay/, `${代號} 登記了動態卻沒有貼上去`);
  }
});

// ── 動態素材落地（2026-09-21）────────────────────────────────
// render 出來的 mp4 躺在共用工作區，下一支出片就被清掉 —— 出一支沒一支。
// 所以出片收尾時複製一份進 input/動態/，成品頁可以單獨下載。
// 放**子目錄**是刻意的：重新出片與備份那兩段都有 isFile() 過濾，子目錄自動被跳過
//（新工作會自己重產，不需要繼承；備份也不必為可重產的東西佔空間）。

test('成品頁可以下載「素材／動態」裡的動態小影片（檔名是中文）', async (t) => {
  const root = 沙箱(t);
  const request = loadServer(root);
  const 建立 = await request('POST', '/api/jobs', 稿件);
  const id = 建立.body.job.id;

  const 檔名 = '動態1_外資買超八百七十億_直式.mp4';
  寫檔(工作檔(root, id, '素材', '動態', 檔名), '假的-mp4-內容');

  const r = await request('GET', `/api/jobs/${id}/file/${encodeURIComponent(檔名)}`);
  assert.equal(r.status, 200, '路由的候選目錄要含 input/動態，否則成品頁的下載連結會 404');
  assert.equal(r.headers['Content-Type'], 'video/mp4');

  const dl = await request('GET', `/api/jobs/${id}/file/${encodeURIComponent(檔名)}?dl=1`);
  assert.ok(/filename\*=UTF-8''/.test(dl.headers['Content-Disposition'] || ''),
    '中文檔名要走 RFC 5987，不然 Node 會丟 ERR_INVALID_CHAR');
});

test('出片收尾：把動態 mp4 複製進「素材／動態」，用看得懂的檔名', async (t) => {
  const root = 沙箱(t);
  const api = loadServer(root);
  const 建立 = await api('POST', '/api/jobs', 稿件);
  const id = 建立.body.job.id;

  const pub = path.join(appPath(root), 'public');
  寫檔(path.join(pub, 'motion-1-p.mp4'), '直式內容');
  寫檔(path.join(pub, 'motion-1-l.mp4'), '橫式內容');
  寫檔(path.join(appPath(root), 'src/MotionClip/motion.generated.json'), [{
    src: 'motion-1-p.mp4', _niceName: '動態1_外資買超_直式.mp4',
    srcLandscape: 'motion-1-l.mp4', _niceNameLandscape: '動態1_外資買超_橫式.mp4',
  }]);

  const clips = api.collectMotionAssets({ id });

  assert.deepEqual(純(clips.map((c) => c.name)),
    ['動態1_外資買超_直式.mp4', '動態1_外資買超_橫式.mp4']);
  assert.equal(fs.readFileSync(工作檔(root, id, '素材', '動態', '動態1_外資買超_直式.mp4'), 'utf-8'), '直式內容');
  assert.equal(fs.readFileSync(工作檔(root, id, '素材', '動態', '動態1_外資買超_橫式.mp4'), 'utf-8'), '橫式內容');
});

test('出片收尾：只出直式的版型不會生出空的橫式檔', async (t) => {
  // --only=p 的版型（之後的盤中焦點／美股焦點）srcLandscape 是空的，不能硬湊一個出來。
  const root = 沙箱(t);
  const api = loadServer(root);
  const id = (await api('POST', '/api/jobs', 稿件)).body.job.id;
  寫檔(path.join(appPath(root), 'public', 'motion-1-p.mp4'), '直式內容');
  寫檔(path.join(appPath(root), 'src/MotionClip/motion.generated.json'),
    [{ src: 'motion-1-p.mp4', _niceName: '動態1_只有直式_直式.mp4' }]);

  const clips = api.collectMotionAssets({ id });
  assert.equal(clips.length, 1);
  assert.deepEqual(fs.readdirSync(工作檔(root, id, '素材', '動態')), ['動態1_只有直式_直式.mp4']);
});

test('出片收尾：這支不再有動態時，上一次的檔要被清掉', async (t) => {
  // 重跑後動態可能被取消或產不出來。舊檔留著的話，成品頁會列出一支
  // 根本不在這支影片裡的素材（而且下載得到），比沒有更糟。
  const root = 沙箱(t);
  const api = loadServer(root);
  const id = (await api('POST', '/api/jobs', 稿件)).body.job.id;
  寫檔(工作檔(root, id, '素材', '動態', '上一次的_直式.mp4'), '舊的');
  寫檔(path.join(appPath(root), 'src/MotionClip/motion.generated.json'), []);

  const clips = api.collectMotionAssets({ id });
  assert.deepEqual(純(clips), []);   // 純()：沙箱是不同 realm，直接 deepEqual 會誤判
  assert.equal(fs.existsSync(工作檔(root, id, '素材', '動態')), false, '整個目錄要清掉');
});

test('出片前把素材搬進工作區時，不要把「動態」子目錄也帶過去', async (t) => {
  const root = 沙箱(t);
  const api = loadServer(root);
  const 建立 = await api('POST', '/api/jobs', 稿件);
  const id = 建立.body.job.id;

  寫檔(工作檔(root, id, '素材', 'shot1.png'), '假截圖');
  寫檔(工作檔(root, id, '素材', '動態', '動態1_某段話_直式.mp4'), '上一次出片的產物');

  api.stageJobInputs({ id });

  const pub = path.join(appPath(root), 'public');
  assert.ok(fs.existsSync(path.join(pub, 'shot1.png')), '真正的素材還是要複製過去');
  assert.equal(fs.existsSync(path.join(pub, '動態')), false,
    '動態是上一次的產物不是這次的輸入，複製過去只是白佔空間（一支約 3MB）');
});

// ── 被 src/ 靜態 import 的產出檔，一律不准刪 ──────────────────────
// 2026-09-19 同一個症頭連續踩兩次（motion.generated.json、emphasis.generated.json）：
// 清工作區把檔案「刪掉」而不是「清空」，Remotion bundle 直接失敗，
// 錯誤訊息長得像專案壞了。與其每次補一個個案，不如讓測試自己去掃 ——
// 以後新增任何一個被 import 的 generated 檔，忘了這件事就會在這裡被擋下來。
test('清工作區只能清空、不能刪掉被 src/ 靜態 import 的 generated 檔', () => {
  const srcDir = path.join(app, 'src');
  const imported = new Set();
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(e.name)) continue;      // .fuse_hidden 之類的殘留不算
      const code = fs.readFileSync(full, 'utf-8');
      for (const m of code.matchAll(/from\s+'(\.[^']*\.generated\.json)'/g)) {
        imported.add(path.relative(app, path.resolve(path.dirname(full), m[1])));
      }
    }
  })(srcDir);
  assert.ok(imported.size >= 2, `應該掃得到被 import 的產出檔，實際 ${imported.size} 個`);

  const server = fs.readFileSync(path.join(app, 'server/index.js'), 'utf-8');
  // server 用常數指路徑，先把常數解出來再比對
  const consts = new Map();
  for (const m of server.matchAll(/^const ([A-Z_]+FILE) = '([^']+)';/gm)) consts.set(m[1], m[2]);
  const 被刪掉的 = [];
  for (const m of server.matchAll(/rmrf\(path\.join\(ROOT,\s*([A-Z_]+FILE)\)\)/g)) {
    const target = consts.get(m[1]);
    if (target && imported.has(target)) 被刪掉的.push(`${m[1]}（${target}）`);
  }
  assert.deepEqual(被刪掉的, [],
    '這些檔被 src/ 靜態 import，rmrf 掉會讓 Remotion bundle 失敗；改成寫入空值');
});

// ── 動態渲染不能綁住 event loop，而且要停得下來（2026-09-21）──────────────
//
// 2026-09-18 接動態時用了 spawnSync，一段 17.9 秒的動態把整個伺服器凍結 31 秒 ——
// 前台按「確認，開始出片」完全沒反應（連 3 秒輪詢都停了），同事連按三次，
// 解凍後那幾次才被處理，跳出「這支工作現在不是待確認狀態」。改成非同步之後，
// 那 30 秒裡取消鍵**變成按得動的**，所以取消那條路要一起補：只殺 run.js 的話，
// 動態會繼續渲完、繼續往下真的出片，最後把 cancelled 蓋成 done。

const { EventEmitter } = require('node:events');

/** 一支假的 render-motion 子程序：close 由測試決定什麼時候發。 */
function 假動態程序() {
  const child = new EventEmitter();
  child.pid = 5151;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('close', null, 'SIGTERM'); return true; };
  return child;
}

/** 記下每一次 spawn；render-motion 給假的、run.js 給一支永遠不結束的。 */
function 假子程序() {
  const 叫過 = [];
  let 動態 = null;
  return {
    叫過,
    get 動態() { return 動態; },
    execFileSync: () => '',
    spawn(cmd, args) {
      叫過.push((args || []).join(' '));
      if ((args || []).some((a) => String(a).includes('render-motion.js'))) {
        動態 = 假動態程序();
        return 動態;
      }
      // run.js：立刻正常結束，讓 doRender 跑完（不然 await 會永遠掛著）
      return { pid: 4242, unref() {}, on(ev, cb) { if (ev === 'close') setImmediate(() => cb(0, null)); } };
    },
  };
}

/** 擺一支可以直接跑 doRender 的工作（製作快照要在，restoreWorkspace 才不會丟例外）。 */
function 待出片工作(root, id = '20260921-112923-ssai') {
  寫檔(path.join(root, '工作紀錄', id, '_製作資料', 'job.json'), {
    id, template: 'dapan', owner: '莉莉', title: '合成標題',
    status: 'approved', createdAt: '2026-09-21T03:29:23.090Z',
    approvedAt: '2026-09-21T03:32:24.246Z', approvedBy: '莉莉',
    skipGenerate: true, pendingEdits: [],
  });
  寫檔(path.join(root, '工作紀錄', id, '_製作資料', '快照', 'public', 'heygen.mp4'), '講者影片');
  return id;
}

test('動態渲染跑到一半按取消：不往下出片，也不會被蓋成完成', { timeout: 10000 }, async (t) => {
  const root = 沙箱(t);
  const id = 待出片工作(root);
  const 子程序 = 假子程序();
  const api = loadServer(root, { childProcess: 子程序, idleTimers: true });

  const job = api.getJob(id);
  const 出片 = api.doRender(job);
  await new Promise((r) => setImmediate(r));   // 讓 doRender 跑到 await runMotion

  assert.ok(子程序.動態, '這時候動態渲染應該已經起來了');
  assert.equal(子程序.動態.killed, false);

  const 取消 = await api('POST', `/api/jobs/${id}/cancel`);
  assert.equal(取消.status, 200);
  assert.equal(取消.body.stopped, true, '取消要回報「有停到東西」——動態那支也算');
  assert.equal(子程序.動態.killed, true, '取消必須連動態渲染一起殺掉');

  await 出片;

  assert.equal(job.status, 'cancelled', 'cancelled 不能被 done 蓋掉');
  assert.ok(!子程序.叫過.some((a) => a.includes('run.js')),
    '取消之後不能再往下叫 run.js 真的出片，實際叫過：' + JSON.stringify(子程序.叫過));

  const log = fs.readFileSync(path.join(root, '工作紀錄', id, '_製作資料', 'log.txt'), 'utf-8');
  assert.match(log, /動態渲染已停止/);
  assert.doesNotMatch(log, /動態小影片重算失敗/,
    '取消不是失敗 —— 寫成「這支沒有動態」會讓人以為出片還在跑');
});

test('取消排隊中的另一支，不能打斷正在跑的那支動態', { timeout: 10000 }, async (t) => {
  const root = 沙箱(t);
  const id = 待出片工作(root);
  const 別支 = '20260921-090000-zzzz';
  寫檔(path.join(root, '工作紀錄', 別支, '_製作資料', 'job.json'), {
    id: 別支, template: 'dapan', owner: '莉莉', title: '排隊中的另一支',
    status: 'queued', createdAt: '2026-09-21T01:00:00.000Z',
  });
  const 子程序 = 假子程序();
  const api = loadServer(root, { childProcess: 子程序, idleTimers: true });

  const job = api.getJob(id);
  const 出片 = api.doRender(job);
  await new Promise((r) => setImmediate(r));

  const 取消 = await api('POST', `/api/jobs/${別支}/cancel`);
  assert.equal(取消.status, 200);
  assert.equal(子程序.動態.killed, false, '取消 B 不能殺掉 A 正在跑的動態');

  子程序.動態.emit('close', 0, null);   // 動態正常跑完，出片繼續
  // 合成環境裡沒有真的成品檔，所以 doRender 最後會以「找不到輸出檔案」收尾。
  // 這支要證明的是「它有繼續往下走」，不是它出得了片。
  await assert.rejects(出片, /找不到輸出檔案/);
  assert.ok(子程序.叫過.some((a) => a.includes('run.js')), 'A 應該照常往下出片');
  assert.notEqual(job.status, 'cancelled', 'A 不該被 B 的取消波及');
});
