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
const { resolveRange, resolveItemTimes, keywordOf, ORIENTATIONS } =
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
  fs.copyFileSync(path.join(app, 'scripts/render-motion.js'), path.join(dir, 'scripts/render-motion.js'));
  const times = [...(字幕文字 || '')].map((_, i) => ({ start: +(i * 0.2).toFixed(2), end: +((i + 1) * 0.2).toFixed(2) }));
  fs.writeFileSync(path.join(dir, 'src/subtitles.json'),
    JSON.stringify({ _scriptText: 字幕文字 || '', _scriptCharTimes: times }));
  return dir;
}
const 跑 = (dir, ...args) =>
  execFileSync('node', [path.join(dir, 'scripts/render-motion.js'), ...args], { encoding: 'utf-8' });
const 產出 = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'src/MotionClip/motion.generated.json'), 'utf-8'));

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
    spec: { template: 'list', items: [{ text: '法人賣多少', at: '法人賣多少' }] },
  }]));
  const out = 跑(dir, '--dry-run');
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
