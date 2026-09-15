#!/usr/bin/env node
/**
 * 出片前台（server）
 * ─────────────────────────────────────────────────────────────
 * 跑在 Leighly 的 Mac 上，同事用瀏覽器連進來出片。
 *
 *   啟動：node server/index.js          （或 npm run studio）
 *   同事連：http://<這台 Mac 的 IP>:4000
 *
 * 設計重點（2026-08-13 討論定案）：
 *   1. 零外部依賴 —— 只用 Node 內建模組。不用 npm install，少一個會壞的環節。
 *   2. 嚴格排隊 —— 整條流程共用同一個 public/，所以一次只跑一支。
 *      使用者的實際用量是「日報13:30／大盤14:00／三大法人16:00，各一兩支」，
 *      撞車機率極低，而 render 實測只要 1~2 分鐘（出片兩支約 2~3 分鐘），
 *      所以不做資料夾隔離 —— 那要動四個 composition 的資料流，不划算。
 *   3. 兩段式，但審核關卡可關 —— 前半段算出配圖計畫後停下來給人看，
 *      確認後才 render。建立工作時勾「直接出片」就變回一段式。
 *      使用者原話：「我甚至不想做兩段式，最終想要一段式」。
 *   4. 審核不卡別人 —— 前半段跑完就把工作區快照起來、放開，
 *      下一支可以立刻開始。不會有人去吃午餐就全公司停擺。
 *   5. 修正紀錄 —— 存「AI 原本的計畫」vs「人改成什麼」。
 *      這是判斷「什麼時候可以安心關掉審核」的依據，不然永遠不敢關。
 */

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { workspaceRoot, dataPath, resolveDataReference } = require('../../paths');
const { spawn, execFileSync } = require('child_process');
// 「你教過的東西」記憶庫。memKeyOf／mergeRuns 一定要跟 auto-shot.js 共用同一份實作 ——
// 這裡負責寫、auto-shot 負責讀，鍵值算法漂掉的話學到的東西下次就對不上（2026-08-21）。
const SHOT_MEMORY = require('../scripts/shot-memory');
const { resolveManualOverlaps } = require('../scripts/script-utils');
const { imageSize, pickImageSize } = require('../scripts/image-size');
// 2026-08-27：自動唸法檢查（scripts/check-pronunciation.js）不再由伺服器跑。
// 它算出來的東西大部分是錯的（兩份字幕的 words 會因為空字串而整段錯開；拼音又因為
// nonZh:'consecutive' 把連續英數字併成一格而再錯開一次），而卡片同事也看得到，
// 等於製造一批要人駁回的假回報。人耳本來就會聽過每一支 —— ground truth 在耳朵那邊。
// 那支腳本留著當 CLI（npm run check:pronounce），想手動驗某一支還是跑得動。

const ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = workspaceRoot(ROOT);
const { createJobStore, outputName } = require('../../工作儲存');
const STORE = createJobStore(WORKSPACE_ROOT, fs);
const JOBS_DIR = STORE.base;
const WEB_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || '127.0.0.1';

// 網址加 ?k=<這串字> 才算管理者（例：http://mkt-video.local:4000/?k=YOUR_ADMIN_KEY）。
// 換暗號改這一行就好，改完要重開伺服器。設成空字串＝關掉遠端管理，只剩本機。
// ⚠️ 暗號會出現在網址列與瀏覽器歷史紀錄，不要把帶暗號的網址貼給同事。
const ADMIN_KEY = process.env.ADMIN_KEY || '';

// 工作紀錄、素材及製作快照持續保留，不按日期自動刪除。

// 修正原因的快選標籤。
// ⚠️ **2026-08-21 起前台不再問原因** —— 配圖計畫編輯器的「為什麼要改」整塊已移除（使用者：
//    「其他同事會看不懂」）。所以這份清單目前**沒有人在畫**，`/api/health` 照樣回傳只是留著介面。
//    「為什麼」改由修正紀錄頁的 `autoWhy` 自動推斷（AI 完全沒用到這張圖／用過但沒配到這一句／
//    AI 原本沒框，人自己框了…），不再依賴人填。
//    要恢復問原因：把 `server/public/index.html` 的 `.tags` 樣式、編輯器裡的
//    `為什麼要改` 區塊、`drawEdTags()`、`edCtx.tags`、`e.reasonTags/reasonNote` 幾處加回來
//    （backup：`server/public/index.html.bak-no-reason-*`）。伺服器端從未拆掉，加回前台就會通。
// 固定選項才能直接統計次數 —— 自由文字只能人工讀。刪標籤要小心：歷史紀錄裡的舊標籤會變成孤兒。
const REASON_TAGS = [
  'AI 沒框到重點',
  'AI 完全沒用到這張圖',
  '框錯位置',
  '框太小',
  '框太大',
  '股名／關鍵字沒辨識到',
  '這句該用別張圖',
  '出現時間不對',
  '不該滑動',
  '應該要滑動',
];

// append-only 彙總檔：一行一筆 JSON。
// 為什麼要另外一份 —— corrections 原本只存在 jobs/<id>/job.json，前台按「刪除」就一起消失
// （2026-08-18 實際狀況：19 支只剩 2 支留著）。這份進版控，換電腦、重裝、刪工作都不會丟。
const CORRECTIONS_LOG = dataPath(WORKSPACE_ROOT, 'corrections.jsonl');

// 同事的留言／唸法回報。同樣是 append-only、進版控 —— 理由同上，留言更不該跟著工作被清掉。
// 「已讀／收錄」不是就地改，是再追加一行 { op:'status', id, status }，讀的時候摺疊起來。
const MESSAGES_LOG = dataPath(WORKSPACE_ROOT, 'messages.jsonl');
// 共用發音詞庫。只有管理者能改，每支影片送出前自動併進 script.txt 的發音替換段。
const PRONOUNCE_PATH = dataPath(WORKSPACE_ROOT, 'pronounce.json');

// 成品保存於各筆工作第一層；工作內容不依年代自動刪除。
const ARCHIVE_DIR = JOBS_DIR;

// ── 版型設定 ──────────────────────────────
// plan  = 配圖計畫檔。審核關卡就是讓人改這個檔。
// title = 標題設定，四個版型不共用（2026-08-17 使用者定案）：
//   lines = 前台給幾個輸入框（＝影片上顯示幾行）
//   per   = 每行字數上限，前台用 maxlength 直接擋住不給打
//   wrap  = 版型能不能自動換行。投廣模板的標題在旋轉過的上方 bar 上，
//           沒有換行空間，所以是 false；其餘三個超過還有得救。
//   ⚠️ 這些是使用者拍板的數字，不是從字級回推的。改字級不用動這裡，
//      但如果使用者說「字太小 / 擠出去了」，回來一起看。
const TEMPLATES = {
  // ⚠️ 這個物件的「宣告順序＝前台版型清單的顯示順序」（index.html 用 Object.entries(TPLS) 畫）。
  // 2026-08-31 使用者要求：盤中焦點 → 大盤小報 → 三大法人 → 焦點股日報（焦點股日報放最後）。
  // 2026-09-15 使用者指定美股焦點「放最右邊」＝可見項目的最後一個，所以排在大盤小報之後。
  //（institution / focusstock / default 都標了 hidden、前台不畫，所以美股焦點就是最右邊那個。）
  // 要調順序就搬這裡的區塊，不要去 index.html 排序。
  // ⚠️ 2026-09-11 起前台實際只看得到**盤中焦點與大盤小報**兩個（2026-09-15 起再加上美股焦點）—— 三大法人、焦點股日報、
  //    投廣模板都標了 hidden。宣告順序與內容全部保留，拿掉 hidden 就原地回來。
  //    /api/health 仍然回傳**全部**版型：工作列表要靠它顯示舊工作的版型名稱（見 public/app.js 的 pickable）。
  midday: {
    // 2026-08-31 新增。版面照大盤小報直式複製一份，所以標題規格跟大盤小報一樣（兩行、每行 10 字參考值）。
    // ⚠️ 2026-09-14 使用者把參考值從 9 改成 10，並指定「一樣置中，可以參考圖片很靠邊沒關係」——
    //    直式可用寬 960px（left/right 各 60）÷ 字級 103 ≈ 9.3 字，10 字幾乎貼齊左右邊，
    //    這是使用者看過成品截圖後拍板的。wrap 仍是 true，超過只是折行、字級不變。
    title: { lines: 2, per: 10, wrap: true, where: '開場第一秒' },
    label: '盤中焦點',
    hint: '',
    // 只出直式（使用者定案「只出直式」），所以只有一個輸出、不需要 outputLabels 標「直式／橫式」。
    outputs: ['out/output-midday.mp4'],
    plan: 'src/MiddayFocus/midday-shots.generated.json',
    planKind: 'shots',
    flags: [],
  },
  dapan: {
    // 2026-09-14 使用者：跟盤中焦點一起從 9 改成 10（見 midday 那段說明）。
    // 橫式的標題在右側面板，可用寬 706px ÷ 字級 68 ≈ 10.4 字 —— 兩邊都是「剛好塞得下、很靠邊」。
    title: { lines: 2, per: 10, wrap: true, where: '直式：開場第一秒　／　橫式：右側面板全程顯示' },
    label: '大盤小報',
    hint: '',
    outputs: ['out/output-dapan.mp4', 'out/output-dapan-landscape.mp4'],
    outputLabels: { 'output-dapan.mp4': '直式', 'output-dapan-landscape.mp4': '橫式' },
    plan: 'src/DapanXiaobao/dapan-shots.generated.json',
    planKind: 'shots',
    flags: [],
  },
  usstock: {
    // 2026-09-15 新增。使用者定案「基本上跟盤中焦點一樣」，所以標題規格直接沿用盤中焦點
    // （兩行、每行 10 字參考值；wrap 仍是 true，超過只是折行、字級不變）。
    title: { lines: 2, per: 10, wrap: true, where: '開場第一秒' },
    label: '美股焦點',
    hint: '',
    // 只出直式（同盤中焦點），所以只有一個輸出、不需要 outputLabels 標「直式／橫式」。
    outputs: ['out/output-usstock.mp4'],
    plan: 'src/UsStock/usstock-shots.generated.json',
    planKind: 'shots',
    flags: [],
  },
  institution: {
    title: { lines: 2, per: 11, wrap: true, where: '開場第一秒' },
    label: '三大法人',
    // 2026-09-11 使用者：「目前都用不到了」→ 從前台選版型清單拿掉。
    // 跟投廣模板同一個做法：**整條產線原封不動保留**（render:institution、auto-focus、
    // MINIMAX_FIXED_ANCHOR_VOICES.institution、planKind: 'focus' 那套寫回規則全都還在），
    // 這裡只是不給前台選。要重新開放：刪掉這行 hidden 就會回到清單。
    // ⚠️ 沒有加 disabled —— 舊工作照樣能開、能改配圖、能重跑，只是開不了新的。
    //    真要連 API 建立都擋掉再補 disabled: true（見 default 那個先例與 POST 建立處的檢查）。
    hidden: true,
    hint: '',
    outputs: ['out/output-institution.mp4'],
    plan: 'src/Institution/institution-focus.generated.json',
    // focus＝「區塊帶 + 黃框」而不是「一張截圖」，寫回規則跟 shots 不同（見 planItemsOf 上方註解）。
    // 2026-08-21 起跟另外兩個一樣可以線上改（使用者：「配圖計劃也改人手工，因為現在配的還是不好」）。
    planKind: 'focus',
    flags: [],
  },
  focusstock: {
    // 2026-08-17 使用者定案：可以超過六個字、可以換行，但字級一律不變。
    // FocusstockComposition 的「超長就縮小」邏輯已經拿掉，改成自然折行：
    // 145px 字級 ÷ 1000px 可用寬 ≈ 一行 7 字，14 字剛好折成兩行、版面還有空間。
    title: { lines: 1, per: 14, wrap: true, where: '開場第一秒（超過 7 字會折行，字級不變）' },
    label: '焦點股日報',
    // 2026-09-11 使用者：「目前都用不到了」→ 從前台選版型清單拿掉（同 institution，見上面那段註解）。
    // 這支的客製版／投廣套框版兩條輸出、--with-ad 旗標都照原樣留著。
    hidden: true,
    // 2026-08-13 使用者定案：只出客製版。要投廣套框版才勾選項（run.js 的 --with-ad）。
    hint: '',
    outputs: ['out/output-focusstock.mp4', 'out/output-focusstock-ad.mp4'],
    outputLabels: { 'output-focusstock.mp4': '', 'output-focusstock-ad.mp4': '投廣版' },
    plan: 'src/Focusstock/focusstock-shots.generated.json',
    planKind: 'shots',
    // 2026-08-13 使用者：投廣套框版的選項先不要顯示。
    // 程式碼整條都留著（job.withAd → run.js --with-ad → render:focusstock-ad），
    // 只是這裡不宣告 with-ad，前台就不會畫那個勾選框。要恢復把 'with-ad' 加回來即可。
    flags: [],
  },
  default: {
    title: { lines: 2, per: 12, wrap: false, where: '上方 bar 全程顯示' },
    label: '投廣模板',
    // 投廣模板先收起來（2026-08-18 變灰不給點 → 2026-08-20 使用者要求連選項都拿掉），**未來可能會回來**。
    // 整條產線（render:marketing、品牌素材、投廣套框）全部原封不動保留，這裡只是不給前台選。
    // 要重新開放：刪掉 hidden 就會出現在清單、再刪 disabled 就能點。
    hidden: true,
    disabled: true,
    // 起漲K線 / 籌碼K線：差在 frame・logo・outro・bgm・deeplinks，都在 assets/<品牌>/。
    // 清單是掃資料夾來的 —— 之後多一個品牌就多一個資料夾，不用改程式。
    brands: true,
    hint: '',
    outputs: ['out/output.mp4'],
    plan: 'src/marketing-shots.generated.json',
    planKind: 'shots',
    flags: [],
  },
};

/** 投廣模板可選的品牌 = assets/ 底下有 frame.png 的資料夾 */
function listBrands() {
  const dir = path.join(WORKSPACE_ROOT, '共用素材');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'frame.png')))
    .map((e) => e.name);
}

// public/ 裡屬於「套版素材」的檔案，清場時不要動（run.js 會自己重新複製，
// 但留著可以少複製一次；字型更是絕對不能刪）。跟 analyze-app-images.js 同一條規則。
const TEMPLATE_ASSET = /^(dapan|focusstock|institution|midday|usstock)-|^(frame|logo)\.png$|^NotoSans|^outro\.mp4$|^\./i;

// 快照要保存哪些檔案：public/ 整包 ＋ src/ 底下的產出物。
// 這些是「上一段跑完的成果」，後半段 render 完全靠它們。
function snapshotTargets() {
  const list = ['public'];
  const src = path.join(ROOT, 'src');
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (/\.generated\.json$/.test(e.name) || /^subtitles(\.original)?\.json$/.test(e.name))
        list.push('src/' + r);
    }
  };
  if (fs.existsSync(src)) walk(src, '');
  return list;
}

// ── 小工具 ────────────────────────────────
const nowISO = () => new Date().toISOString();
const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });

function copyRecursive(from, to) {
  if (!fs.existsSync(from)) return;
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    ensureDir(to);
    for (const n of fs.readdirSync(from)) copyRecursive(path.join(from, n), path.join(to, n));
  } else {
    ensureDir(path.dirname(to));
    fs.copyFileSync(from, to);
  }
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
}

function dirSize(p) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else n += fs.statSync(f).size;
    }
  };
  try { walk(p); } catch (_) {}
  return n;
}

/** 本機在區網上的 IP，開機訊息要印給同事看 */
function lanIP() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}

// 啟動時間 vs 程式碼修改時間。
// 改完檔案忘了重開伺服器 → 網頁看起來「沒有變」，因為版型設定是這個程序回答的。
// 這個坑第一次就踩到了（2026-08-13），所以讓網頁自己判斷、自己提醒。
const STARTED_AT = Date.now();
const WEB_FILES = ['index.html', 'styles.css', 'app.js'].map((name) => path.join(WEB_DIR, name));
function webChangedAt() {
  let t = 0;
  for (const file of WEB_FILES) {
    try { t = Math.max(t, fs.statSync(file).mtimeMs); } catch (_) {}
  }
  return t || null;
}

function codeChangedAt() {
  let t = 0;
  for (const f of [__filename, ...WEB_FILES, path.join(ROOT, 'run.js')]) {
    try { t = Math.max(t, fs.statSync(f).mtimeMs); } catch (_) {}
  }
  return t;
}

// ── 工作儲存 ──────────────────────────────
// 用檔案存，伺服器重開不會掉。不用資料庫 —— 一天十幾筆而已。
ensureDir(JOBS_DIR);

function jobDir(id) { return STORE.path(id); }
function jobPath(id, ...parts) { return STORE.path(id, ...parts); }
function jobFile(id) { return jobPath(id, 'job.json'); }

function loadJobs() {
  const out = [];
  for (const j of STORE.scan()) {
    try {
      // 伺服器上次是在跑到一半被關掉的。
      // run.js 是 detached 的，所以它很可能還活著 —— 那就不是「中斷」，
      // 是「在背景繼續跑」。標成失敗會讓人以為 HeyGen 點數白花了（其實沒有）。
      if (j.status === 'preparing' || j.status === 'rendering') {
        if (isRunJs(j.pid)) {
          j.status = 'detached';
          j.error = null;
        } else {
          j.status = 'failed';
          j.error = '伺服器重新啟動，這支工作中斷了。請重新建立。';
        }
      }
      out.push(j);
    } catch (_) {}
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

let JOBS = loadJobs();
JOBS.forEach(saveJob);

function saveJob(j) {
  STORE.directory(j.id, j);
  ensureDir(jobDir(j.id));
  fs.writeFileSync(jobFile(j.id), JSON.stringify(j, null, 2));
}

function getJob(id) { return JOBS.find((j) => j.id === id); }

/**
 * 更新「重開前就在跑、現在在背景」的那些工作。
 * 伺服器沒有接回它們（那是方案 B），只負責把狀態顯示對，
 * 並告訴使用者怎麼零成本接回（講者影片還在 public/heygen.mp4）。
 */
function refreshDetached() {
  for (const j of JOBS) {
    if (j.status !== 'detached') continue;
    if (isRunJs(j.pid)) continue;
    j.status = 'detached-done';
    j.pid = null;
    appendLog(j, '\n🔚 這支在背景跑完了（伺服器當時已重開，沒有接回流程）。\n'
      + '   講者影片留在 public/heygen.mp4 —— 重新建立工作並勾「用現成的講者影片」，\n'
      + '   就能零成本接著出片，不用再花 HeyGen 點數。\n');
    saveJob(j);
  }
}

function appendLog(job, line) {
  const f = jobPath(job.id, 'log.txt');
  ensureDir(path.dirname(f));
  fs.appendFileSync(f, line.endsWith('\n') ? line : line + '\n');
}

function newId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    '-' + Math.random().toString(36).slice(2, 6)
  );
}

// ── 工作區（public/ 與 src/ 產出物）──────────
const LOCK = path.join(WORKSPACE_ROOT, '.run.lock');

/** 把 public/ 裡上一支工作留下的東西清掉（套版素材與字型保留） */
function clearWorkspaceInputs() {
  const pub = path.join(ROOT, 'public');
  if (!fs.existsSync(pub)) return;
  for (const n of fs.readdirSync(pub)) {
    if (TEMPLATE_ASSET.test(n)) continue;
    if (/\.(png|jpg|jpeg|mp4|txt|wav|mp3|m4a|aac)$/i.test(n)) rmrf(path.join(pub, n));
  }
  // 標注檔要指名清掉。不能用 *.json 一律清 —— deeplinks.json 是投廣品牌素材。
  rmrf(path.join(pub, 'annotations.json'));
}

function snapshotWorkspace(job) {
  const dst = jobPath(job.id, 'state');
  rmrf(dst);
  for (const rel of snapshotTargets()) copyRecursive(path.join(ROOT, rel), path.join(dst, rel));
}

function restoreWorkspace(job) {
  const src = jobPath(job.id, 'state');
  if (!fs.existsSync(src)) throw new Error('找不到這支工作的快照，可能已被清理。請重新建立。');
  clearWorkspaceInputs();
  for (const rel of snapshotTargets()) {
    const from = path.join(src, rel);
    if (fs.existsSync(from)) copyRecursive(from, path.join(ROOT, rel));
  }
}

// ── 交付規格（客戶／平台會逐項驗的 12 項）─────────────
// 分析與實測依據：90_系統/維護說明/影片交付規格.md
//
// Remotion 那邊只給 `--crf 23`，沒有任何編碼參數控制，所以有五項一定不合規：
//   響度（−12 LUFS、True Peak +0.2 dBTP＝已在削波）／色彩標籤（bt470bg＋full range，
//   是錯的標籤不是只有沒填）／yuvj420p／GOP 250（x264 預設）／Level 4.0。
// 修法不是改渲染，是在「收成品」這一步用 ffmpeg 轉一次交付檔。
// ⚠️ 渲染流程一個字都沒動 —— run.js／remotion.config.ts／npm run render:* 全部原樣。
//
// 只有下面白名單裡的輸出會轉（2026-08-21 使用者點名的三個直式，2026-08-31 加上盤中焦點共四個）：
//   （2026-09-15 起加上美股焦點共五個）
//   橫式（output-dapan-landscape）過不了規格第 4 項「1080×1920 直式、不加黑邊」，硬套只會加黑邊或裁切；
//   投廣版（output-focusstock-ad）與投廣模板（output.mp4）使用者定案不套。
//   不在名單裡的照舊直接 copyFileSync。
const DELIVERY_SPEC_OUTPUTS = {
  dapan: ['output-dapan.mp4'],
  // 盤中焦點只出直式，整支都要照交付規格轉（2026-08-31 使用者：「輸出也要照轉檔規則」）
  midday: ['output-midday.mp4'],
  // 美股焦點同樣只出直式，整支都要照交付規格轉（跟盤中焦點同一條規則）
  usstock: ['output-usstock.mp4'],
  focusstock: ['output-focusstock.mp4'],
  institution: ['output-institution.mp4'],
};

function needsDeliverySpec(job, outName) {
  return (DELIVERY_SPEC_OUTPUTS[job.template] || []).includes(outName);
}

/** 跑一次 ffmpeg，不阻塞 event loop（轉一支 1080×1920 要一兩分鐘，execFileSync 會讓整個前台卡死） */
function runFfmpeg(args, onStderr) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
    let tail = '';
    child.stderr.on('data', (b) => {
      const s = b.toString();
      if (onStderr) onStderr(s);
      tail = (tail + s).slice(-20000); // 只留尾巴：loudnorm 的 JSON 在最後，錯誤訊息也在最後
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(tail) : reject(new Error(`ffmpeg 結束碼 ${code}：${tail.slice(-800)}`))));
  });
}

// `-fps_mode` 是 ffmpeg 5.0 才有的（4.x 只有 `-vsync`）。本機是哪一版不一定，
// 猜錯整條轉檔就掛掉退回 copyFileSync＝規格白做，所以問一次、記起來。
let fpsModeSupported = null;
async function supportsFpsMode() {
  if (fpsModeSupported !== null) return fpsModeSupported;
  try {
    const out = await runFfmpeg(['-hide_banner', '-h', 'full']);
    fpsModeSupported = /-fps_mode/.test(out);
  } catch (_) {
    fpsModeSupported = false;
  }
  return fpsModeSupported;
}

/**
 * Pass 1：量測響度。
 *
 * ⚠️ TP 目標寫 −1.5 而不是規格的 −1：AAC 是有損編碼，壓完峰值會往上回彈。
 *    2026-08-21 實測 −1 出來的成品量到 −0.9 dBTP，剛好超規格 0.1，所以留 0.5 dB 邊際。
 *    兩趟的 I／TP／LRA 目標必須一致（target_offset 是照這組目標算的）。
 * 兩趟是必要的 —— 單趟 loudnorm 走 dynamic 模式會做動態壓縮，語音聽起來會怪；
 * 兩趟用線性增益，聽感不變，代價只是多花兩三秒。
 */
async function measureLoudness(file) {
  const out = await runFfmpeg([
    '-hide_banner', '-nostats', '-i', file,
    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-',
  ]);
  const start = out.lastIndexOf('{');
  const end = out.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('loudnorm 沒有回傳 JSON');
  const m = JSON.parse(out.slice(start, end + 1));
  for (const k of ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset']) {
    if (m[k] === undefined || m[k] === '-inf' || m[k] === 'inf') throw new Error(`loudnorm 的 ${k} 量不出來（${m[k]}）`);
  }
  return m;
}

/**
 * Pass 2：交付轉檔。
 *
 * 幾個容易改壞的地方，改之前先看這裡：
 *  - `scale=in_range=pc:out_range=tv` 只壓 range、**故意不碰 matrix**。源被標成 yuvj（full range）
 *    ＋ bt470bg（PAL 矩陣），但內容其實是 bt709 的網頁畫面 —— 標籤本身就是錯的。
 *    讓 ffmpeg「相信」錯標籤去做矩陣轉換，顏色會被改壞；這裡是壓完 range 再由輸出端重打 bt709。
 *  - `-colorspace / -color_primaries / -color_trc` 三個都要給。規格第 9 項要 primaries／transfer／matrix
 *    皆填，缺一項就不算「明確標記」。
 *  - `scenecut=0` ＋ `open-gop=0`：不關場景偵測，x264 會臨時插 I-frame，GOP 就不是固定 15；
 *    open-gop=0 才是 closed GOP。
 *  - `aresample=48000` 最容易漏 —— loudnorm 內部會把音訊升到 192 kHz，不接這個就不是 48 kHz，
 *    規格第 7 項直接掛。
 *  - 位元率走 **CRF 21 ＋ maxrate 5M 品質導向**（2026-08-21 使用者定案）。規格那欄「目標 5 Mbps」
 *    與「建議 CRF 21 品質導向」本來是矛盾的；選品質導向是因為 K 線細線條／字幕邊緣／APP 截圖小字
 *    都是高頻細節，撐不住固定位元率的削法。若對方檢核要求「必須接近 5 Mbps」才改 two-pass ABR。
 */
async function transcodeForDelivery(from, to, onProgress) {
  const m = await measureLoudness(from);
  const cfrArgs = (await supportsFpsMode()) ? ['-fps_mode', 'cfr'] : ['-vsync', 'cfr'];
  const tmp = to + '.delivery.tmp.mp4';
  try {
    await runFfmpeg([
      '-y', '-hide_banner', '-nostats', '-i', from,
      '-c:v', 'libx264', '-profile:v', 'high', '-level:v', '4.1', '-preset', 'slow',
      '-crf', '21', '-maxrate', '5M', '-bufsize', '10M',
      // GOP 15＝0.5 秒一個 I-frame，關鍵影格密度是預設的 16 倍，位元率會明顯往上跑。
      // 這是整份規格裡最貴的一項，也是唯一需要盯實際位元率的。
      '-x264-params', 'keyint=15:min-keyint=15:scenecut=0:open-gop=0:bframes=2',
      // ⚠️ `setparams` 不是多寫的 —— ffmpeg 7/8 會把濾鏡鏈輸出的 frame 色彩屬性套到編碼器上，
      //    蓋掉下面 `-color_primaries`／`-color_trc`（源檔這兩欄是 unknown，就被蓋成 unknown）。
      //    2026-08-21 實測：本機 ffmpeg 8.1.1 出來的成品 primaries／transfer 都是 unknown、只有
      //    matrix=bt709 活著（scale 會處理矩陣），規格第 9 項「三欄皆填」等於沒過。ffmpeg 4.4 沒這問題，
      //    所以不是參數寫錯、是版本行為差異。setparams 從 4.3 就有，新舊版都安全，兩邊都留著。
      '-vf', 'scale=in_range=pc:out_range=tv,format=yuv420p'
        + ',setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-r', '30', ...cfrArgs,
      '-af', `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}`
        + `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}`
        + ':linear=true,aresample=48000',
      '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart', '-brand', 'mp42',
      tmp,
    ], onProgress);
    fs.renameSync(tmp, to); // 轉完才就位 —— 中途失敗不會在成品庫留半支
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
  return m;
}

/**
 * 把成品另存到成品庫，檔名取成人看得懂的：
 *   成品/2026-08/0817-大盤小報-台股反彈-橫式.mp4
 * jobs/ 會被自動清掉，這裡不會 —— 這才是「以後還找得到」的那一份。
 */
function archivePath(job, outName) {
  const dir = STORE.directory(job.id, job);
  ensureDir(dir);
  const name = outputName(outName);
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let dest = path.join(dir, name);
  let n = 2;
  while (fs.existsSync(dest)) dest = path.join(dir, `${base}(${n++})${ext}`);
  return dest;
}

// ── 配音語氣（2026-09-14 使用者定案）──────────────────────────
// MiniMax 的 emotion 參數。九個合法值裡前台只開放兩個，**而且白名單一定要在伺服器端**：
// 前台不顯示只擋得住同事，擋不住直接打 /api/jobs 的人，而 whisper 配 speech-2.8
// 是「整支出片直接失敗」（API 回 2013），不是音色變掉而已。
// 收到白名單以外的值一律當預設 —— 不回 400，因為這欄位不是同事填的，是介面送的，
// 擋下整支工作不如用預設把片出完（使用者定案：「server 收到非 happy/fluent 一律當 fluent」）。
// 第一個是預設值：舊工作的 job.json 沒有這個欄位，重跑時也會拿到它。
// ⚠️ 值要跟 server/public/app.js 的 EMOTIONS 一致，由 90_系統/測試/配音語氣.test.js 綁住。
const EMOTIONS = ['fluent', 'happy'];
const normalizeEmotion = (v) => (EMOTIONS.includes(v) ? v : EMOTIONS[0]);

// ── 執行 run.js ───────────────────────────
/** pid 還活著，而且真的是我們的 run.js（防 pid 被回收後誤判） */
function isRunJs(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch (_) { return false; }
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' });
    return /run\.js/.test(out);
  } catch (_) { return false; }
}

/**
 * 跑 run.js。
 *
 * ⚠️ 兩個關鍵決定（2026-08-17 與使用者討論後定案的「方案 C」）：
 *
 *  1. 輸出「直接寫進 log 檔」，不經過父程序的管道。
 *     以前是 child.stdout → appendLog；伺服器一被關掉，管道就斷了，
 *     run.js 還在跑但 log 完全沒東西，而且它可能因為 EPIPE 直接死掉。
 *
 *  2. detached：讓它有自己的程序群組。
 *     在終端機按 Ctrl+C 時，訊號是送給「整個前景程序群組」的 —— 不 detached
 *     就會連 run.js 一起殺掉，HeyGen 生成到一半的點數就白花了。
 *
 * 合起來的效果：伺服器可以隨時關、隨時重開，正在跑的那支會自己跑完，
 * 講者影片會留在 public/heygen.mp4，重新建立工作勾「用現成的講者影片」就零成本接回。
 */
function runPipeline(job, args) {
  return new Promise((resolve, reject) => {
    appendLog(job, `\n$ node run.js ${args.join(' ')}\n`);
    const logPath = jobPath(job.id, 'log.txt');
    ensureDir(path.dirname(logPath));
    const fd = fs.openSync(logPath, 'a');
    let child;
    try {
      child = spawn('node', ['run.js', ...args], {
        cwd: ROOT,
        env: { ...process.env, FORCE_COLOR: '0', WORKBENCH_JOB_ID: job.id },
        detached: true,
        stdio: ['ignore', fd, fd],
      });
    } finally {
      fs.closeSync(fd); // 父程序不需要留著這個 fd，子程序自己有一份
    }
    job.pid = child.pid;
    job.pidArgs = args.join(' ');
    saveJob(job);
    child.unref(); // 不要讓子程序撐住父程序的 event loop
    child.on('error', reject);
    child.on('close', (code) => {
      job.pid = null;
      code === 0 ? resolve() : reject(new Error(`run.js 結束碼 ${code}，詳見執行記錄`));
    });
  });
}

// ── 配圖計畫：讀取／縮圖／寫回 ──────────────
function charTimes() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'subtitles.json'), 'utf-8'))._scriptCharTimes || [];
  } catch (_) { return []; }
}

/**
 * 取子句清單。切法與字元對位一律交給 auto-shot.js 算（--sentences），
 * 伺服器不自己實作第二套 —— 兩套遲早會漂走。
 */
function scriptUnits(scriptPath) {
  if (!fs.existsSync(scriptPath)) return { units: [], chars: [] };
  try {
    const out = execFileSync('node', ['scripts/auto-shot.js', '--sentences', `--script=${scriptPath}`],
      { cwd: ROOT, encoding: 'utf-8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
    const j = JSON.parse(out);
    return { units: j.units || [], chars: j.chars || [] };
  } catch (_) { return { units: [], chars: [] }; }
}
function unitsOf(scriptPath) { return scriptUnits(scriptPath).units; }

function readPlanFrom(baseDir, tpl) {
  const cfg = TEMPLATES[tpl];
  if (!cfg || !cfg.plan) return null;
  const f = path.join(baseDir, cfg.plan);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch (_) { return null; }
}

function shotsOf(plan) {
  if (!plan) return [];
  return Array.isArray(plan) ? plan : plan.shots || [];
}

// ── 三大法人的計畫（planKind: 'focus'）──────────────
// 跟另外兩個版型不一樣的地方，動這段之前先看懂：
//  1. 一列不是「一張截圖」，是「版面圖上的一個區塊帶 ＋ 一個黃框」。所以 focus 檔裡**沒有 src**
//     （永遠是那張版面截圖），只有 `section`（區塊代號）＋ `cellText`（要框住的字）。
//  2. **自動列的框不在檔案裡** —— 檔案只寫 `section` 與 `cellText`，真正的座標是渲染時
//     由 `institution-timeline.ts` 拿 OCR 逐字框去比對算出來的。這就是「框到隔壁格」的來源。
//     所以要讓人看到 AI 到底框到哪、才能拖著改，這裡必須把座標**先解出來給前台看**
//     （`focusRowView()`），但**不寫回檔案** —— 寫回去會讓沒被碰過的自動列變成人工列、
//     少掉 `cellPad()` 的自動留白，畫面就跟原本不一樣了。
//  3. `(shot:)` 標記的全螢幕截圖段在**另一份檔**（institution-shots.generated.json）。
//     前台只能有一份列表，所以下面把兩份併成一份。
const INSTITUTION_SHOTS_PLAN = 'src/Institution/institution-shots.generated.json';
const INSTITUTION_REGIONS = 'src/Institution/institution-regions.generated.json';

function institutionRegions(baseDir) {
  try { return JSON.parse(fs.readFileSync(path.join(baseDir, INSTITUTION_REGIONS), 'utf-8')); }
  catch (_) { return null; }
}

/**
 * 計畫的「一列」清單。
 * ⚠️ buildPlanView 與 applyPlanEdits **一定要都走這支** —— 前台回傳的 `e.i` 是這個陣列的索引，
 *    兩邊併的順序只要差一點，人改的東西就會套到別一列上去。
 */
function planItemsOf(baseDir, tpl) {
  const plan = readPlanFrom(baseDir, tpl);
  if ((TEMPLATES[tpl] || {}).planKind !== 'focus') return { plan, items: shotsOf(plan) };
  let shots = [];
  try {
    shots = JSON.parse(fs.readFileSync(path.join(baseDir, INSTITUTION_SHOTS_PLAN), 'utf-8')) || [];
  } catch (_) {}
  const items = [
    ...shotsOf(plan),
    // (shot:) 的段沒有框、就是整張蓋滿 → 併進來時標成 wholePage，語意跟另外兩個版型一致
    ...(Array.isArray(shots) ? shots : []).map((s) => ({ ...s, wholePage: true, _fromShots: true })),
  ].sort((a, b) => (a.startCharIdx ?? 0) - (b.startCharIdx ?? 0));
  return { plan, items };
}

/**
 * 在區塊帶內找 OCR 逐字框裡包含 cellText 的字。
 * ⚠️ 這段是 `src/Institution/institution-timeline.ts` 的 `findCellBox()` 的**第二份實作**
 *    （一份 TS 給渲染用、一份 JS 給前台預覽用）。規則要一致：信心 ≥30、文字包含、
 *    中心點落在帶內、取信心最高的那個。**改一邊一定要同步改另一邊**，不然前台看到的框
 *    跟實際渲染出來的框會不一樣 —— 那比沒有預覽更糟。
 */
function findCellIn(reg, cellText, band) {
  if (!reg || !cellText || !band) return null;
  const cy = (w) => w.y + w.h / 2;
  const cands = (reg.words || [])
    .filter((w) => w.c >= 30 && String(w.t).includes(cellText))
    .filter((w) => cy(w) >= band.top && cy(w) <= band.bottom);
  if (!cands.length) return null;
  const best = cands.sort((a, b) => b.c - a.c)[0];
  return { x: best.x, y: best.y, w: best.w, h: best.h };
}

/** focus 的一列 → 前台看得懂的樣子（把 section/cellText 解成實際座標）。**只影響顯示，不寫檔。** */
function focusRowView(s, reg) {
  if (!reg) return s;
  const src = s.src || reg.imageFile;
  const isLayout = src === reg.imageFile;
  // 手動列自己就有 region；自動列要拿 section 去查區塊帶
  const band = s.region
    ? { top: s.region.y, bottom: s.region.y + s.region.h }
    : (isLayout ? (reg.sections || {})[s.section] : null);
  const region = s.region
    || (band ? { x: 0, y: band.top, w: reg.imageWidth, h: band.bottom - band.top } : null);
  const cell = s.cell || (isLayout ? findCellIn(reg, s.cellText, band) : null);
  return {
    ...s, src, region, cell,
    imageWidth: s.imageWidth || (isLayout ? reg.imageWidth : null),
    imageHeight: s.imageHeight || (isLayout ? reg.imageHeight : null),
    wholePage: !!s.wholePage || (!region && !cell),
  };
}

/**
 * 沒被自動計畫吃到的手動標注。
 * auto-shot 是在 run.js 最後才讀 public/annotations.json 的。標注頁存檔的時間
 * 只要晚於那一刻（勾「用現成的講者影片」時，「準備中」可能只有幾十秒），那筆標注
 * 就進不了計畫 —— 前台看起來就是「我標的那張圖不見了」（2026-08-21 使用者回報）。
 * 前台會把這裡回傳的每一筆自動補成人工段，使用者不用重標。
 * 比對規則：同一張圖、字元範圍有重疊就算已經進去了
 *（auto-shot 會微調頭尾、也會合併，不能只比對相等）。
 */
function pendingAnnotsOf(job, rows) {
  let ann = [];
  try {
    ann = JSON.parse(fs.readFileSync(
      jobPath(job.id, 'input', 'annotations.json'), 'utf-8')).shots || [];
  } catch (_) { return []; }
  return ann
    .filter((a) => a && a.src
      && typeof a.startCharIdx === 'number' && typeof a.endCharIdx === 'number')
    .map((a) => ({
      src: a.src,
      startCharIdx: Math.min(a.startCharIdx, a.endCharIdx),
      endCharIdx: Math.max(a.startCharIdx, a.endCharIdx),
      region: a.region || null, cell: a.cell || null,
      imgW: a.imgW || null, imgH: a.imgH || null,
    }))
    .filter((a) => !(rows || []).some((r) => r.src === a.src && r.startCharIdx != null
      && !(r.endCharIdx < a.startCharIdx || r.startCharIdx > a.endCharIdx)));
}

/**
 * approve 的當下再算一次「還沒進計畫的人工標注」，補成人工段。
 *
 * 為什麼要再算一次：`pendingAnnotsOf()` 只在**進編輯頁的那一刻**算一次，判斷「這筆標注
 * 有沒有被計畫收進去」。同事接著把那一列改去別的區間之後，原本代表那筆標注的列就不見了，
 * 那筆標注會無聲無息消失，前台也不會再提醒（2026-08-25 使用者回報；0825 那支
 * shot1@62~79「框加權指數 45169.46」就是這樣不見的）。
 *
 * ⚠️ 被同事**刪掉**的段落不要復活 —— 同一張圖、範圍重疊而且 deleted 的，視為刻意移除。
 */
function appendMissingAnnots(job, edits) {
  let ann = [];
  try {
    ann = JSON.parse(fs.readFileSync(
      jobPath(job.id, 'input', 'annotations.json'), 'utf-8')).shots || [];
  } catch (_) { return edits; }
  const overlaps = (a, list) => list.some((e) => e.src === a.src
    && typeof e.startCharIdx === 'number' && typeof e.endCharIdx === 'number'
    && !(e.endCharIdx < a.lo || e.startCharIdx > a.hi));
  const kept = edits.filter((e) => !e.deleted);
  const dropped = edits.filter((e) => e.deleted);
  const added = [];
  ann.forEach((a, i) => {
    if (!a || !a.src) return;
    if (typeof a.startCharIdx !== 'number' || typeof a.endCharIdx !== 'number') return;
    const item = {
      src: a.src,
      lo: Math.min(a.startCharIdx, a.endCharIdx),
      hi: Math.max(a.startCharIdx, a.endCharIdx),
    };
    if (overlaps(item, kept)) return;      // 已經有段落代表它了
    if (overlaps(item, dropped)) return;   // 同事刻意刪掉的，不要復活
    added.push({
      i: `ann${i}`, _added: true, _manual: true, _late: true, deleted: false,
      src: a.src, cell: a.cell || null, region: a.region || null,
      startCharIdx: item.lo, endCharIdx: item.hi,
      imgW: a.imgW || null, imgH: a.imgH || null,
    });
  });
  if (added.length) {
    appendLog(job, `\n✋ 有 ${added.length} 筆人工標注沒被計畫收進去，已自動補回（不補的話會無聲消失）\n`);
  }
  return added.length ? edits.concat(added) : edits;
}

/**
 * 把配圖計畫整理成前台看得懂的樣子：秒數、框住什麼、縮圖。
 * 縮圖是「截圖上畫好黃框」的小圖 —— 同事不用想像，一眼就知道會框到哪。
 */
/** 這支工作每張截圖「系統判定的頁型」：{ 檔名: { page, pageLabel, stockName, stockCode, width, height } }。讀不到就空物件。 */
function pagesOf(state) {
  const out = {};
  try {
    const ims = JSON.parse(fs.readFileSync(path.join(state, 'src', 'app-images.generated.json'), 'utf-8')).images || [];
    for (const im of ims) out[im.file] = { page: im.page || 'unknown', pageLabel: im.pageLabel || '未知頁面',
      stockName: im.stockName || null, stockCode: im.stockCode || null, width: im.width, height: im.height };
  } catch (_) {}
  return out;
}

function buildPlanView(job) {
  const state = jobPath(job.id, 'state');
  const ct = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(state, 'src/subtitles.json'), 'utf-8'))._scriptCharTimes || [];
    } catch (_) { return charTimes(); }
  })();
  const kind = TEMPLATES[job.template].planKind;
  const reg = kind === 'focus' ? institutionRegions(state) : null;
  // focus 的自動列在檔案裡只有 section/cellText，要先解成座標前台才畫得出來、才拖得動
  const shots = planItemsOf(state, job.template).items
    .map((s) => (kind === 'focus' ? focusRowView(s, reg) : s));
  const thumbDir = jobPath(job.id, 'thumbs');
  ensureDir(thumbDir);

  const rows = shots.map((s, i) => {
    const st = ct[s.startCharIdx] ? ct[s.startCharIdx].start : null;
    const en = ct[s.endCharIdx] ? ct[s.endCharIdx].end : null;
    const thumb = `plan-${i}.png`;
    try { makeThumb(path.join(state, 'public', s.src), s.cell, path.join(thumbDir, thumb)); }
    catch (_) {}
    return {
      i,
      src: s.src,
      phrase: s._phrase || '',
      start: st, end: en,
      dur: st != null && en != null ? +(en - st).toFixed(1) : null,
      cellText: s.cellText || (s.wholePage ? '整張' : ''),
      wholePage: !!s.wholePage,
      // 框的座標與原圖尺寸 —— 前台直接用比例畫出來，也讓人可以拖著改
      //（2026-08-17 使用者：「我認為你可以看我手動來學習」）
      cell: s.cell || null,
      region: s.region || null,
      // 前台在腳本上拖選，存的就是字元索引（比叫人填秒數直觀得多）
      startCharIdx: s.startCharIdx,
      endCharIdx: s.endCharIdx,
      imageWidth: s.imageWidth || null,
      imageHeight: s.imageHeight || null,
      thumb: fs.existsSync(path.join(thumbDir, thumb)) ? thumb : null,
    };
  });

  // 可以換的圖：這支工作上傳的所有截圖
  const images = [];
  const pub = path.join(state, 'public');
  if (fs.existsSync(pub)) {
    for (const n of fs.readdirSync(pub)) {
      if (TEMPLATE_ASSET.test(n)) continue;
      if (/\.(png|jpe?g)$/i.test(n)) images.push(n);
    }
  }
  const totalSec = ct.length ? ct[ct.length - 1].end : null;
  return {
    kind,
    // 2026-08-21 起三大法人也能線上改（使用者：「配圖計劃也改人手工，因為現在配的還是不好」）。
    // 前台的閘門改看 editable，不要再用 `kind !== 'shots'` 判斷。
    editable: true,
    // 三大法人的聚焦是「捲到區塊帶 + 壓暗其餘」，沒有「往下滑動」這回事 ——
    // 勾了也不會有任何效果，所以前台不要畫那個勾選框（靜默失效比沒有更糟）。
    rows, images, totalSec,
    // 2026-09-07 每張圖系統判定的頁型，給審核頁顯示＋決定要不要給 📌（認不出來才給）。
    pages: pagesOf(state),
    pendingAnnots: pendingAnnotsOf(job, rows),
    ...scriptUnits(path.join(state, 'public', 'script.txt')),
    unused: images.filter((n) => !rows.some((r) => r.src === n)),
  };
}

/** 用 ffmpeg 在截圖上畫黃框、縮成小圖 */
function makeThumb(imgPath, cell, outPath) {
  if (!fs.existsSync(imgPath)) return;
  if (fs.existsSync(outPath)) return;
  const vf = [];
  if (cell && cell.w > 0 && cell.h > 0) {
    vf.push(`drawbox=x=${Math.round(cell.x)}:y=${Math.round(cell.y)}:w=${Math.round(cell.w)}:h=${Math.round(cell.h)}:color=yellow@0.95:t=10`);
  }
  vf.push('scale=300:-1');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', imgPath, '-vf', vf.join(','), outPath], {
    stdio: 'ignore', timeout: 20000,
  });
}

/**
 * 把使用者改過的計畫寫回快照裡的計畫檔。
 * 只支援 v1 開放的三種修改：換圖 / 切換滑動 / 刪掉這段。
 * 換圖時原本的框座標就沒意義了 —— 改成框新那張圖的標題（跟 auto-shot 的退路一致）。
 */
function applyPlanEdits(job, edits) {
  // ⚠️ 2026-08-18 真因修正（「手動框選一直不見、而且沒勾滑動卻自己滑」）：
  // 這裡要改的是「ROOT 工作區」，不是 jobs/<id>/state 快照。
  // doRender 的順序是 restoreWorkspace(state → ROOT) 之後才呼叫本函式，
  // 而 run.js --render-only 只讀 ROOT 的 *.generated.json。
  // 原本寫回快照 = 寫進一個 doRender 結尾就 rmrf 掉的資料夾 →
  // 所有人工框選／改時間／加一段全部靜默消失，render 用的還是自動計畫
  // （當年還會自動帶上已移除的 pan:true），前台卻顯示「已套用 N 項人工修正」。
  // 過去每次都在下面的合併／裁切邏輯裡找原因，但那些程式根本沒作用在被 render 的檔案上。
  const state = ROOT;
  const cfg = TEMPLATES[job.template];
  const f = path.join(state, cfg.plan);
  const { plan, items: shots } = planItemsOf(state, job.template);
  if (!plan) throw new Error('找不到配圖計畫檔');
  // 三大法人：一列是「區塊帶 + 黃框」而不是「一張截圖」，寫回的規則不一樣（見 planItemsOf 上方註解）
  const FOCUS = cfg.planKind === 'focus';
  const reg = FOCUS ? institutionRegions(state) : null;

  let images = [];
  try {
    images = JSON.parse(fs.readFileSync(path.join(state, 'src/app-images.generated.json'), 'utf-8')).images || [];
  } catch (_) {}

  // 秒數 → 字元索引（人工調時間用）。取「結束時間還沒超過目標」的最後一個字。
  let CT = [];
  try {
    CT = JSON.parse(fs.readFileSync(path.join(state, 'src/subtitles.json'), 'utf-8'))._scriptCharTimes || [];
  } catch (_) {}
  const idxAtStart = (t) => {
    let best = 0;
    for (let i = 0; i < CT.length; i++) if (CT[i] && CT[i].start <= t) best = i;
    return best;
  };
  const idxAtEnd = (t) => {
    let best = 0;
    for (let i = 0; i < CT.length; i++) if (CT[i] && CT[i].end <= t) best = i;
    return best;
  };

  const UNITS = unitsOf(path.join(state, 'public', 'script.txt'));

  const keep = [];
  edits.forEach((e) => {
    // e._added = 前台「＋ 加一段」新增的段，原本計畫裡沒有 → 從空白開始
    //（2026-08-18 使用者：上傳 6 張只自動用了 2 張，其餘要能自己補上）。
    const s = e._added ? {} : shots[e.i];
    if (!s || e.deleted) return;
    // 新增的段一定要有出現範圍，否則是半成品，跳過
    if (e._added && !(typeof e.startCharIdx === 'number' || typeof e.from === 'number')) return;
    if (e._added) { s.src = ''; s._auto = false; s._added = true; }
    // ⚠️ focus 檔的自動列**沒有被碰過就原封不動放回去**。
    //    不能讓它走下面那段（把前台傳回來的 cell/region 寫進檔案）—— 前台看到的框是
    //    `focusRowView()` 幫它解出來的，寫回去等於把自動列變成人工列：`institution-timeline.ts`
    //    看到 `f.cell` 就會設 `cellManual: true`、跳過 `cellPad()` 的自動留白，
    //    於是「我什麼都沒改，框卻變瘦了」。判斷只認前台明確標記的 `_manual`／`_added`。
    if (FOCUS && !e._manual && !e._added) {
      const orig = { ...s };
      delete orig._fromShots;
      // src 一律補齊（渲染端本來就是 `f.src || 版面圖`，補了語意不變，但下面裁切要靠它比對同一張圖）
      if (!orig.src && reg) orig.src = reg.imageFile;
      keep.push(orig);
      return;
    }
    if (FOCUS) {
      // 換圖／加圖：三大法人沒有 app-images 的 topicBox 那套推算，尺寸直接用前台量到的原圖尺寸
      if (e.src) s.src = e.src;
      if (!s.src && reg) s.src = reg.imageFile;
      if (typeof e.imgW === 'number' && e.imgW > 0) s.imageWidth = e.imgW;
      if (typeof e.imgH === 'number' && e.imgH > 0) s.imageHeight = e.imgH;
      // 人工列不再靠 section／cellText 查表（那是「框到隔壁格」的來源），座標直接寫進去
      delete s.section; delete s.cellText; delete s._auto; delete s._ambiguous; delete s._cappedAt;
      delete s._fromShots;
    }
    if (!FOCUS && e.src && e.src !== s.src) {
      const img = images.find((m) => m.file === e.src);
      s.src = e.src;
      // ⚠️ 事後補上傳的圖不在 app-images.generated.json 裡（那支分析是在 doPrepare 一開頭
      //    跟 HeyGen 平行跑的），`img` 會是 undefined → imageWidth 沒有值 →
      //    ShotFocus.tsx 直接退成「整張顯示」，**使用者拉的框靜默失效**。
      //    退到前台量到的原圖尺寸（openEditor 存的 natW/natH），跟 FOCUS 那條分支同一個做法。
      //    2026-09-01（三大法人那邊 2026-08-21 就這樣做了，這裡一直沒補上）。
      // ⚠️ 2026-09-14：更糟的是「查得到、但那筆是**上一支工作**的同名圖」（見
      //    invalidateStaleAnalysis 的說明）—— 尺寸是別張圖的，框會整塊位移＋縮放。
      //    前台量到的 natW/natH 必定屬於這支工作正在看的那張圖，所以它一律優先。
      const picked = pickImageSize(img, e);
      s.imageWidth = picked.width;
      s.imageHeight = picked.height;
      // 尺寸對不上＝這筆分析是別張圖的 → 連帶的頁型也不能用（它決定自動配圖怎麼框）。
      s.page = img && !picked.stale ? img.page : undefined;
      // 換了圖一定要清掉舊圖的框 —— 框存的是「原圖像素座標」，套到另一張圖上一定是錯的位置。
      // ⚠️ 2026-08-26 使用者定案「**我故意不畫黃框就是不要，不要幫我加上去**」：
      //    這裡以前有一條退路，換圖又沒重畫框時就照 img.topicBox 框「頁面標題」。
      //    但 `_added`（前台「＋加一段」）的段是從 `s = {}` 開始的、`s.src` 永遠 undefined，
      //    所以這個條件**對每一筆新加的段都成立** → 使用者只畫顯示區域、故意不畫黃框，
      //    也會被補上一個框標題的黃框（0826「且南亞更直接攻上漲停」那段實測到，
      //    同支還有 shot7／shot8 框標題、shot4 框 PCB、shot5 框 ABF 四段）。
      //    現在一律不補。「系統原本會怎麼圈」改成只算給修正紀錄看（見 suggestCellFor()），
      //    不寫進計畫檔 —— 跟 2026-08-25「人工沒標就不要出現、自動判定只進修正紀錄」同一條規則，
      //    只是層級從「段落」下到「框」。
      delete s.cell; delete s.cellText;
      s.isColumn = false;
    }
    // 人工拖出來的框：完全照使用者給的，不再套任何自動推算。
    // ⚠️ region（顯示區域）與 cell（黃框）是兩件事，各自可有可無
    //（2026-08-17 使用者指出的設計錯誤）。
    const R = (b) => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) });
    if (e.cell !== undefined || e.region !== undefined) {
      const hasCell = e.cell && e.cell.w > 0 && e.cell.h > 0;
      const hasRegion = e.region && e.region.w > 0 && e.region.h > 0;
      if (hasCell) { s.cell = R(e.cell); s.cellText = '人工黃框'; s.isColumn = false; }
      else { delete s.cell; delete s.cellText; }
      if (hasRegion) s.region = R(e.region); else delete s.region;
      s.wholePage = !hasCell && !hasRegion;   // 都沒有 → 整張顯示
      s._manualCell = hasCell || hasRegion;
    }
    // 出現範圍：優先用「子句範圍」（前台拉的），秒數只是退路。
    // 子句 → 字元索引的對位是 auto-shot 算好附在 units 裡的，這裡只取頭尾。
    if (typeof e.startCharIdx === 'number' && typeof e.endCharIdx === 'number') {
      s.startCharIdx = Math.min(e.startCharIdx, e.endCharIdx);
      s.endCharIdx = Math.max(e.startCharIdx, e.endCharIdx);
      s._manualTime = true;
    } else if (typeof e.from === 'number' && typeof e.to === 'number') {
      const lo = Math.min(e.from, e.to), hi = Math.max(e.from, e.to);
      const u0 = UNITS.find((u) => u.i === lo), u1 = UNITS.find((u) => u.i === hi);
      if (u0 && u1 && u0.startCharIdx != null && u1.endCharIdx != null) {
        s.startCharIdx = u0.startCharIdx;
        s.endCharIdx = Math.max(u0.startCharIdx, u1.endCharIdx);
        s._manualTime = true;
      }
    } else if (CT.length && typeof e.start === 'number' && typeof e.end === 'number' && e.end > e.start) {
      s.startCharIdx = idxAtStart(e.start);
      s.endCharIdx = Math.max(s.startCharIdx, idxAtEnd(e.end));
      s._manualTime = true;
    }
    // 2026-08-18 修正：只有前台明確標記的段（_manual＝人工新增或編輯過、_added＝加一段）
    // 才算「人工段」。之前用「有沒有 cell/charIdx 欄位」來猜，但前台會把自動段的欄位
    // 原樣回傳，害自動段也被當成人工段、永遠不會被裁 → shot5 的自動滑動蓋掉手動黃框。
    s._userManual = !!(e._manual || e._added);
    keep.push(s);
  });

  const isManual = (s) => !!(s._userManual || s._annotated);

  // ── 人工段之間的重疊：後標的為主（2026-08-25 使用者定案「以後標的為主」）──
  // 下面那段只裁「自動段」而且只比對**同一張圖** → 兩段都是人工、又是不同圖的重疊
  // 完全沒人管，畫面上就是兩張截圖疊在一起（0825 那支 27.3~28.2 秒實測到的）。
  // ⚠️ 一定要在 keep.sort() **之前**做 —— 這裡的順序還是 edits 的順序，也就是
  //    「後加的排後面」（前台新增的段、appendMissingAnnots 補回來的都在最後），
  //    排序過就分不出誰先誰後了。
  // ⚠️ 主要防線其實在 scripts/auto-shot.js（勾「直接出片」不會經過這裡）；
  //    這一份是擋「同事自己在計畫頁拉出重疊」的情況，兩邊用同一支演算法。
  {
    const mans = keep.filter(isManual);
    if (mans.length > 1) {
      const durOf = (a, b) => {
        const s0 = CT[a] ? CT[a].start : null, e0 = CT[b] ? CT[b].end : null;
        return s0 == null || e0 == null ? null : e0 - s0;
      };
      const r = resolveManualOverlaps(mans, { durOf, minSec: 1.4 });
      if (r.notes.length) {
        const rest = keep.filter((x) => !isManual(x));
        keep.length = 0;
        keep.push(...rest, ...r.items);
        appendLog(job, '\n🔀 人工段重疊，後標的為主：\n' + r.notes.map((n) => '   ' + n).join('\n') + '\n');
      }
    }
  }

  // 依出現時間排序 —— 新增的段可能插在中間，順序不對會讓「連續同圖合併」判斷錯
  keep.sort((a, b) => (a.startCharIdx ?? 0) - (b.startCharIdx ?? 0));

  // ── 人工段落蓋過重疊的自動段（同一張圖）──
  // 2026-08-18 使用者實際踩到：自動把 shot5 配成「整張滑動」(char133~176)，
  // 使用者又在 shot5 的 char133/143/151 手動框了欣興/景碩/南電。兩個時間重疊、
  // 又是同一張圖 → buildShotRuns 合併後，滑動那格把手動黃框蓋掉，框看起來「消失」。
  // 規則：手動段（_added / _manualCell / _manualTime）優先，把重疊到的「自動段」裁掉；
  // 自動段被裁到剩太少就整個拿掉。這樣「我手動框的一定會贏」。
  // （isManual 在上面「人工 vs 人工」那段就宣告了，兩處共用同一個判準。）
  const manuals = keep.filter(isManual);
  for (const a of keep) {
    if (isManual(a) || a.startCharIdx == null) continue; // 只裁自動段
    const origLen = (a.endCharIdx ?? 0) - (a.startCharIdx ?? 0) + 1;
    const origEnd = a.endCharIdx;
    const overlapped = [];
    for (const m of manuals) {
      if (m.src !== a.src || m.startCharIdx == null) continue;
      if (m.endCharIdx < a.startCharIdx || m.startCharIdx > a.endCharIdx) continue; // 沒重疊
      overlapped.push(m);
      // 手動段蓋住自動段開頭 → 自動段往後縮
      if (m.startCharIdx <= a.startCharIdx && m.endCharIdx >= a.startCharIdx)
        a.startCharIdx = m.endCharIdx + 1;
      // 手動段蓋住自動段結尾 → 自動段往前縮
      if (m.startCharIdx <= a.endCharIdx && m.endCharIdx >= a.endCharIdx)
        a.endCharIdx = m.startCharIdx - 1;
    }
    const newLen = (a.endCharIdx ?? 0) - (a.startCharIdx ?? 0) + 1;
    // 被裁到剩不到一半、或幾乎沒了 → 整段拿掉（使用者顯然是要用手動的取代它）
    if (a.startCharIdx > a.endCharIdx || newLen < Math.max(3, origLen * 0.5)) {
      a._drop = true;
      // 2026-08-18 使用者定案「依照我手動的判定為主」：
      // 自動段整段丟掉後，原本它撐著的「尾巴」會變成沒有圖 → 同一張圖中途下畫面、
      // 切回講者（實際踩到：手動框到「景碩漲近5%」為止，後面「AI GPU ASIC 帶動…」就沒圖了）。
      // 改成把「最後一個蓋到它的人工段」延長到原自動段的結尾：
      // 同一張圖全程不下畫面（ShotFocus 的原始設計），而且框沿用人工框，
      // 不會讓自動判定的框在句尾跳回來。
      const tail = overlapped
        .filter((m) => m.endCharIdx < origEnd)
        .sort((x, y) => y.endCharIdx - x.endCharIdx)[0];
      if (tail) {
        // 不可以延長到「下一段（別張圖）」的頭上去
        const nexts = keep.filter((s) => s !== a && s !== tail && !s._drop
          && s.startCharIdx != null && s.startCharIdx > tail.endCharIdx);
        const limit = nexts.length ? Math.min(...nexts.map((s) => s.startCharIdx)) - 1 : origEnd;
        tail.endCharIdx = Math.max(tail.endCharIdx, Math.min(origEnd, limit));
      }
    }
  }
  const kept = keep.filter((s) => !s._drop);

  const next = Array.isArray(plan) ? kept : { ...plan, shots: kept };
  fs.writeFileSync(f, JSON.stringify(next, null, 2));
  // 三大法人：(shot:) 那份檔的內容已經併進 focus 檔了（帶著 src ＋ wholePage），
  // 不清掉就會兩邊各畫一次、同一個時間疊兩層。**只在原本真的有東西時才寫**，
  // 免得每支工作都去動一個沒必要動的產物檔。
  if (FOCUS) {
    const sf = path.join(state, INSTITUTION_SHOTS_PLAN);
    try {
      const had = JSON.parse(fs.readFileSync(sf, 'utf-8'));
      if (Array.isArray(had) && had.length) fs.writeFileSync(sf, '[]\n');
    } catch (_) {}
  }
  return kept.length;
}

/** 追加寫進 append-only 彙總檔。寫失敗只警告，絕對不能讓 approve 掛掉。 */
function appendCorrectionsLog(job, diffs) {
  if (!diffs || !diffs.length) return;
  if (job.correctionsLoggedAt) return; // 同一支只寫一次（append-only 沒有去重機制）
  try {
    ensureDir(path.dirname(CORRECTIONS_LOG));
    const at = nowISO();
    const lines = diffs.map((d) => JSON.stringify({
      at, job: job.id, template: job.template,
      by: job.approvedBy || job.owner || '', title: (job.title || '').replace(/\n/g, ' '),
      ...d,
    }));
    fs.appendFileSync(CORRECTIONS_LOG, lines.join('\n') + '\n');
    job.correctionsLoggedAt = at;
  } catch (e) {
    appendLog(job, `\n⚠️ 修正紀錄彙總檔寫入失敗（不影響出片）：${e.message}\n`);
  }
}

function readCorrectionsLog() {
  if (!fs.existsSync(CORRECTIONS_LOG)) return [];
  const out = [];
  for (const line of fs.readFileSync(CORRECTIONS_LOG, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) {} // 壞掉那行就跳過，不要整份報廢
  }
  return out;
}

/** 彙總檔 ∪ 還沒進彙總檔的舊 job（往前相容，不用做一次性搬遷） */
function allCorrections() {
  const rows = readCorrectionsLog();
  const seen = new Set(rows.map((r) => r.job));
  for (const j of JOBS) {
    if (seen.has(j.id)) continue;
    for (const c of j.corrections || [])
      rows.push({ at: j.approvedAt, job: j.id, template: j.template, by: j.approvedBy || j.owner || '', ...c });
  }
  // 2026-09-14 起「人工標記」會自己寫 autoKind。它之前的紀錄沒有這個欄位，
  // 其中 focus 版型（三大法人）那批的「原本」一律是空的 —— 不是 AI 沒配圖，
  // 是比對時拿了對照組根本沒有的 `src` 欄位（見 recordCorrections 的 cfSrc）。
  // append-only 的歷史檔不改，這裡只在回應裡標成「舊紀錄不可信」，讓頁面不要再講假話。
  // 另一種空白：那一輪對照組整份是 0 段（不是「AI 判斷這裡不用配圖」，是根本沒有基準可比）。
  // 舊紀錄裡看不出來，只能回頭看工作的 auto-noannots.json；工作被刪就維持原樣。
  const cfEmpty = new Map();
  const cfIsEmpty = (id) => {
    if (cfEmpty.has(id)) return cfEmpty.get(id);
    let v = false;
    try {
      const a = JSON.parse(fs.readFileSync(jobPath(id, 'auto-noannots.json'), 'utf-8'));
      v = Array.isArray(a) && !a.length;
    } catch (_) { v = false; }
    cfEmpty.set(id, v);
    return v;
  };
  for (const r of rows) {
    if (r.type !== '人工標記' || r.autoKind || r.from) continue;
    if ((TEMPLATES[r.template] || {}).planKind === 'focus') r.autoKind = 'legacyNoSrc';
    else if (cfIsEmpty(r.job)) r.autoKind = 'noCounterfactual';
  }
  return rows;
}

/**
 * 修正紀錄：AI 原本怎麼排、人改成什麼。
 * 這是判斷「什麼時候可以安心關掉審核關卡」的依據 ——
 * 某一類修正連續兩週沒出現，那部分就可以不用看了。
 */
/**
 * 「系統原本會怎麼圈」——只給修正紀錄用，不會進影片。
 *
 * 2026-08-26 使用者定案：「我故意不畫黃框就是不要，不要幫我加上去；最終影片顯示要照人手工框的，
 * 自動的部分一樣要做但是要記錄到『修正紀錄』裡。」`applyPlanEdits()` 因此不再補框，
 * 系統的判斷改由這支算出來寫進 `90_系統/資料/corrections.jsonl`。
 *
 * 做法是 spawn 一次 `scripts/auto-shot.js --suggest-cells=`，跟「對照組」（`--no-annots`）
 * 同一個模式 —— 那組挑框規則（漲跌幅／數字／整列／記憶庫／標題）吃 REGIONS、官方股名表、
 * 記憶庫、OCR 詞框合併一整套模組層狀態，抽成共用模組給這裡 require 等於開第二份實作。
 *
 * ⚠️ 一定要讀 `jobs/<id>/state` 快照的腳本與圖片分析，不可以讀 ROOT —— 按下「確認，開始出片」
 *    的當下，ROOT 可能已經被下一支工作佔用了（`learnFromEdits()` 早就踩過同一個坑）。
 * ⚠️ 記憶庫刻意讀 ROOT 的最新版，但**本函式一定要在 `learnFromEdits()` 之前跑**
 *    （`/approve` 與 autoApprove 兩條路現在都是這個順序），否則建議會被使用者這一支剛教的
 *    東西污染，變成「系統早就知道」的假象。
 * 算失敗就回空的 —— 寧可少記，不要記出假的比對（沿用對照組的處置）。
 */
function suggestCellsFor(job, items) {
  const map = {};
  try {
    if (!Array.isArray(items) || !items.length) return map;
    if ((TEMPLATES[job.template] || {}).planKind === 'focus') return map;  // 三大法人走 auto-focus，另案
    const st = jobPath(job.id, 'state');
    const script = path.join(st, 'public', 'script.txt');
    const images = path.join(st, 'src', 'app-images.generated.json');
    if (!fs.existsSync(script) || !fs.existsSync(images)) return map;
    const seen = new Set();
    const want = [];
    for (const it of items) {
      if (!it || !it.src || typeof it.startCharIdx !== 'number' || typeof it.endCharIdx !== 'number') continue;
      const lo = Math.min(it.startCharIdx, it.endCharIdx), hi = Math.max(it.startCharIdx, it.endCharIdx);
      const k = `${it.src}@${lo}~${hi}`;
      if (seen.has(k)) continue;
      seen.add(k);
      want.push({ src: it.src, startCharIdx: lo, endCharIdx: hi });
    }
    if (!want.length) return map;
    const inF = jobPath(job.id, 'cell-suggest-in.json');
    const outF = jobPath(job.id, 'cell-suggest.json');
    fs.writeFileSync(inF, JSON.stringify(want, null, 2));
    execFileSync('node', [path.join('scripts', 'auto-shot.js'),
      `--script=${script}`, `--images=${images}`, `--suggest-cells=${inF}`, '--out', outF],
      { cwd: ROOT, stdio: 'ignore', timeout: 120000 });
    const arr = JSON.parse(fs.readFileSync(outF, 'utf-8'));
    (Array.isArray(arr) ? arr : []).forEach((r) => {
      map[`${r.src}@${r.startCharIdx}~${r.endCharIdx}`] = r;
    });
    const boxed = Object.values(map).filter((r) => r && r.cell).length;
    appendLog(job, `\n🔍 系統框選建議：${want.length} 段算出 ${boxed} 個框（只寫進修正紀錄，不進影片）\n`);
  } catch (e) {
    appendLog(job, `\n⚠️ 系統框選建議計算失敗（不影響出片，只是修正紀錄少一項）：${e.message}\n`);
  }
  return map;
}

function recordCorrections(job, before, edits) {
  const diffs = [];
  const beforeRows = (before && before.rows) || []; // 缺 planView 也不要讓 approve 整個掛掉
  const chars = (before && before.chars) || [];
  const ct = (() => {
    try {
      return JSON.parse(fs.readFileSync(jobPath(job.id, 'state', 'src/subtitles.json'), 'utf-8'))
        ._scriptCharTimes || [];
    } catch (_) { return charTimes(); }
  })();

  const textOf = (a, b) => (a == null || b == null || !chars.length ? ''
    : chars.slice(a, b + 1).map((c) => c.c).join(''));
  const secOf = (a, b) => {
    const st = ct[a] ? ct[a].start : null, en = ct[b] ? ct[b].end : null;
    return st == null || en == null ? null : `${st.toFixed(1)}~${en.toFixed(1)}s`;
  };
  // 框的比對一律先四捨五入 —— 前台拖出來的是浮點數，計畫檔裡是整數，不歸一化會每次都判定「改過」
  const box = (x) => (x && x.w > 0 && x.h > 0
    ? { x: Math.round(x.x), y: Math.round(x.y), w: Math.round(x.w), h: Math.round(x.h) } : null);
  const same = (x, y) => JSON.stringify(box(x)) === JSON.stringify(box(y));
  // 使用者在編輯器選的原因（快選標籤 + 補充文字）。一列可能產生多筆 diff，都掛同一份原因。
  // ⚠️ 2026-08-21 起前台不再送這兩個欄位（編輯器的「為什麼要改」已移除），所以新紀錄的
  //    `reason` 一律是 null，修正紀錄頁那一欄會顯示「—」。**故意留著不拆**：
  //    `90_系統/資料/corrections.jsonl` 裡的舊資料還有原因、頁面照樣要顯示；而且哪天要恢復問原因，
  //    只要把前台那塊加回來就通，伺服器端不用再動。
  const reasonOf = (e) => {
    const tags = Array.isArray(e.reasonTags) ? e.reasonTags.filter(Boolean) : [];
    const note = typeof e.reasonNote === 'string' ? e.reasonNote.trim() : '';
    return tags.length || note ? { tags, note } : null;
  };
  // 這張圖在自動計畫裡出現過幾次 → 判斷「AI 完全沒用到」還是「用了但沒配到這一句」
  // 「AI 本來會怎麼配」＝ 對照組（jobs/<id>/auto-noannots.json，buildCounterfactual 產的）。
  // ⚠️ 2026-08-25 起計畫檔只放人工標注（auto-shot 預設濾掉自動段），planView.rows 裡
  //    **已經沒有 AI 的判斷了** —— 再拿它當「AI 本來的樣子」會講出假話
  //    （「AI 完全沒用到這張圖」其實只是「人沒用到」）。統一改讀對照組。
  //    對照組讀不到就退回舊行為，寧可粗糙也不要整段沒有。
  let cfRows = beforeRows;
  try {
    const cf = JSON.parse(fs.readFileSync(jobPath(job.id, 'auto-noannots.json'), 'utf-8'));
    if (Array.isArray(cf) && cf.length) cfRows = cf;
  } catch (_) {}
  const autoUse = {};
  cfRows.forEach((r) => { autoUse[r.src] = (autoUse[r.src] || 0) + 1; });

  // ── 「系統原本會怎麼圈」（2026-08-26）──
  // 成品的框只吃人工畫的（applyPlanEdits 不再補框），系統的判斷在這裡算出來、只寫進紀錄。
  // 一次把「這一支所有有範圍的段落」都問完（一次 spawn），下面各類型再各自取用。
  const wantSuggest = [];
  edits.forEach((e) => {
    const b = beforeRows[e.i] || {};
    wantSuggest.push({ src: e.src || b.src, startCharIdx: e.startCharIdx, endCharIdx: e.endCharIdx });
  });
  try {
    const ann0 = JSON.parse(fs.readFileSync(
      jobPath(job.id, 'input', 'annotations.json'), 'utf-8')).shots || [];
    ann0.forEach((a) => wantSuggest.push(a));
  } catch (_) { /* 沒有標注檔就只問計畫頁改過的那些 */ }
  const SUG = suggestCellsFor(job, wantSuggest);
  const sugOf = (src, a, b) => (src == null || a == null || b == null ? null
    : SUG[`${src}@${Math.min(a, b)}~${Math.max(a, b)}`] || null);
  /** 人沒畫黃框、系統原本會框 → 補一句話進「AI 當時的判斷」欄 */
  const sugNote = (sug, manualCell) => (sug && sug.cell && !box(manualCell)
    ? `；人刻意不畫黃框，系統原本會框「${sug.cellText || '—'}」（${sug.why || '規則判定'}）——`
      + '只記錄、不進影片'
    : '');

  edits.forEach((e) => {
    const reason = reasonOf(e);
    const phrase = textOf(e.startCharIdx, e.endCharIdx);

    // ── 新增一段：AI 漏掉的圖被人補上 ──
    // 2026-08-18 使用者要求：要記「為什麼 AI 沒判斷到」，所以除了那句旁白，
    // 還記下這張圖自動計畫用過幾次、這段旁白原本被哪張圖蓋著（＝AI 當時的判斷）。
    if (e._added) {
      if (e.startCharIdx == null) return;
      const coveredBy = cfRows.filter((r) => r.startCharIdx != null
        && r.startCharIdx <= e.endCharIdx && r.endCharIdx >= e.startCharIdx);
      const sug = sugOf(e.src, e.startCharIdx, e.endCharIdx);
      diffs.push({
        type: '新增一段',
        phrase,
        from: e.src, to: e.src,
        systemCell: sug ? box(sug.cell) : null,
        systemCellText: sug ? sug.cellText : null,
        systemPage: sug ? sug.page : null,   // 2026-09-03：記下系統當時判的頁型（cell-suggest 本來就帶 page），給 page-types / memKey 用
        systemWhy: sug ? sug.why : null,
        autoWhy: (autoUse[e.src]
          ? `AI 用過這張圖 ${autoUse[e.src]} 次，但沒配到這一句`
          : 'AI 完全沒用到這張圖') + sugNote(sug, e.cell),
        autoCoveredBy: coveredBy.map((r) => r.src + (r.cellText ? `（${r.cellText}）` : '')),
        manual: secOf(e.startCharIdx, e.endCharIdx),
        manualChars: `${e.startCharIdx}~${e.endCharIdx}`,
        manualCell: box(e.cell), manualRegion: box(e.region),
        size: e.imgW && e.imgH ? { w: e.imgW, h: e.imgH } : null,
        reason,
      });
      return;
    }

    const b = beforeRows[e.i];
    if (!b) return;
    if (e.deleted) { diffs.push({ type: '刪掉這段', phrase: b.phrase, from: b.src, reason }); return; }

    if (e.src && e.src !== b.src)
      diffs.push({ type: '換圖', phrase: b.phrase || phrase, from: b.src, to: e.src, reason });

    // ── 改框 ──
    // 2026-08-18 使用者要求：「就算 AI 原本沒框也要記錄為什麼人手動框了」。
    // 原本的判斷式是 `e.cell && b.cell`，所以「AI 沒框、人自己框」這個最重要的訊號
    // 完全記不到；而且 region（顯示區域）從頭到尾沒進紀錄 —— 只畫顯示區域是最常見的操作。
    const cellChanged = !same(e.cell, b.cell);
    const regionChanged = !same(e.region, b.region);
    if (cellChanged || regionChanged) {
      const hadAuto = !!(box(b.cell) || box(b.region));
      const hasManual = !!(box(e.cell) || box(e.region));
      const sug = sugOf(e.src || b.src, e.startCharIdx ?? b.startCharIdx, e.endCharIdx ?? b.endCharIdx);
      diffs.push({
        type: '改框',
        phrase: b.phrase || phrase,
        from: b.src,
        autoCell: box(b.cell), manualCell: box(e.cell),
        autoRegion: box(b.region), manualRegion: box(e.region),
        autoCellText: b.cellText,
        systemCell: sug ? box(sug.cell) : null,
        systemCellText: sug ? sug.cellText : null,
        systemPage: sug ? sug.page : null,   // 2026-09-03：記下系統當時判的頁型（cell-suggest 本來就帶 page），給 page-types / memKey 用
        systemWhy: sug ? sug.why : null,
        autoWhy: (!hadAuto
          ? 'AI 原本沒框（整張顯示），人自己框了 → 自動判定沒抓到重點'
          : !hasManual
            ? '人把 AI 的框整個拿掉，改成整張顯示'
            : `AI 框了「${b.cellText || '—'}」，人改了位置或大小`) + sugNote(sug, e.cell),
        changed: [cellChanged ? '黃框' : null, regionChanged ? '顯示區域' : null].filter(Boolean).join('＋'),
        size: b.imageWidth && b.imageHeight ? { w: b.imageWidth, h: b.imageHeight } : null,
        reason,
      });
    }

    // ── 改時間 ──
    // 2026-08-18 修正：原本比對 e.start / e.end，但前台改出現範圍時只更新
    // startCharIdx / endCharIdx，start / end 一直是自動算出來的值 → 差值永遠 0，
    // 這一類從上線到現在「從來沒有被記錄過一筆」。改成以字元索引為準。
    if (e.startCharIdx != null && b.startCharIdx != null
      && (e.startCharIdx !== b.startCharIdx || e.endCharIdx !== b.endCharIdx)) {
      diffs.push({
        type: '改時間',
        phrase: b.phrase || phrase,
        from: b.src,
        auto: secOf(b.startCharIdx, b.endCharIdx)
          || `${(b.start ?? 0).toFixed(1)}~${(b.end ?? 0).toFixed(1)}s`,
        manual: secOf(e.startCharIdx, e.endCharIdx),
        autoChars: `${b.startCharIdx}~${b.endCharIdx}`,
        manualChars: `${e.startCharIdx}~${e.endCharIdx}`,
        autoPhrase: b.phrase || textOf(b.startCharIdx, b.endCharIdx),
        manualPhrase: phrase,
        autoWhy: 'AI 給的出現範圍不對（太長／太短／位置偏了）',
        reason,
      });
    }
  });

  // ── 人工標記 vs 對照組 ────────────────────
  // 「手動標記」頁標過的句子，auto-shot／auto-focus 是**完全不碰**的 —— 標注本身就變成
  // 計畫的一部分，所以上面那個迴圈永遠比不出差異，最有價值的訊號（人覺得非自己標不可）
  // 一筆都留不下來。`buildCounterfactual()` 在準備階段多跑了一次 `--no-annots`，
  // 這裡拿那份「AI 本來會怎麼配」來對照（2026-08-21 使用者：「要，而且要真的比對」）。
  // 對照組算失敗（檔案不在）就整段跳過 —— 寧可少記，不要記出假的比對。
  try {
    const ann = JSON.parse(fs.readFileSync(
      jobPath(job.id, 'input', 'annotations.json'), 'utf-8')).shots || [];
    const cf = JSON.parse(fs.readFileSync(
      jobPath(job.id, 'auto-noannots.json'), 'utf-8')) || [];
    // focus 版型（三大法人）的對照組段落**沒有 src** —— 圖永遠是那張版面截圖，
    // auto-focus 只寫 section／cellText（見 planItemsOf 上方那段說明）。
    // 2026-09-14 修：以前直接拿 `c.src` 比對，focus 的段落全部比出 undefined，
    // `from` 變成空字串，修正紀錄頁就一律顯示「（AI 本來不配圖）」——
    // 明明 AI 有配，紀錄卻說沒配，institution 的 38 筆全是這樣來的。
    const FOCUS_CF = (TEMPLATES[job.template] || {}).planKind === 'focus';
    const cfReg = FOCUS_CF ? institutionRegions(jobPath(job.id, 'state')) : null;
    // 拿不到版面圖檔名（舊工作沒留快照）也不能退回 undefined —— 寧可寫「版面截圖」這個
    // 說得出口的名字，也不要讓它變成「不配圖」。
    const cfSrc = (c) => (c && c.src) || (FOCUS_CF ? ((cfReg && cfReg.imageFile) || '版面截圖') : null);
    // 對照組整份是空的（auto-shot／auto-focus 這一輪一段都沒排，多半是頁型沒認出來）
    // ＝ 這支根本沒有可比的基準，不是「AI 判斷這裡不用配圖」。兩者要分開講。
    const noCf = !Array.isArray(cf) || !cf.length;
    for (const a of ann) {
      if (!a || !a.src || typeof a.startCharIdx !== 'number' || typeof a.endCharIdx !== 'number') continue;
      const lo = Math.min(a.startCharIdx, a.endCharIdx), hi = Math.max(a.startCharIdx, a.endCharIdx);
      // 對照組裡蓋到這段旁白的所有段落 ＝ AI 本來會在這裡放的東西
      const hit = (Array.isArray(cf) ? cf : []).filter((c) => c && c.startCharIdx != null
        && !(c.endCharIdx < lo || c.startCharIdx > hi));
      const first = hit[0] || null;
      const hitSrcs = [...new Set(hit.map(cfSrc).filter(Boolean))];
      const sameImg = hit.some((c) => cfSrc(c) === a.src);
      const manualBoxed = !!(box(a.cell) || box(a.region));
      const sug = sugOf(a.src, lo, hi);
      diffs.push({
        type: '人工標記',
        systemCell: sug ? box(sug.cell) : null,
        systemCellText: sug ? sug.cellText : null,
        systemPage: sug ? sug.page : null,   // 2026-09-03：記下系統當時判的頁型（cell-suggest 本來就帶 page），給 page-types / memKey 用
        systemWhy: sug ? sug.why : null,
        phrase: textOf(lo, hi),
        from: hitSrcs.length ? hitSrcs.join('／') : null,
        // 「原本」為空時，這一欄說明是哪一種空：沒得比（noCf）還是真的沒配（none）。
        // 舊紀錄沒有這個欄位，前台會照舊顯示（見 app.js 的 drawFix）。
        autoKind: noCf ? 'noCounterfactual' : (hit.length ? 'covered' : 'none'),
        to: a.src,
        auto: first ? secOf(first.startCharIdx, hit[hit.length - 1].endCharIdx) : null,
        autoChars: first ? `${first.startCharIdx}~${hit[hit.length - 1].endCharIdx}` : null,
        autoCell: first ? box(first.cell) : null,
        autoRegion: first ? box(first.region) : null,
        autoCellText: first ? (first.cellText || (first.wholePage ? '整張顯示' : '')) : '',
        manual: secOf(lo, hi),
        manualChars: `${lo}~${hi}`,
        manualCell: box(a.cell), manualRegion: box(a.region),
        autoWhy: (noCf
          ? '這一支的對照組一段都沒排出來（多半是頁型沒認出來），所以比不出 AI 本來會怎麼配'
          : !hit.length
            ? '這一句 AI 本來一張圖都不會配（對照組：留在講者畫面）'
            : !sameImg
              ? `AI 本來會配「${hitSrcs.join('／')}」，人改用「${a.src}」`
              : manualBoxed
                ? `AI 本來也用這張圖、框「${first.cellText || '整張顯示'}」，人自己框了別的地方`
                : 'AI 本來也用這張圖，人只是重新指定了出現範圍') + sugNote(sug, a.cell),
        size: a.imgW && a.imgH ? { w: a.imgW, h: a.imgH } : null,
        reason: null,
      });
    }
  } catch (_) { /* 沒有標注或沒有對照組 → 這一類就不記 */ }

  job.corrections = diffs;
  // autoPlan＝「AI 本來會怎麼配」的存證（只寫進 job.json，publicJob 會把它拿掉不外送）。
  // 2026-08-25 起一樣改讀對照組 —— 計畫檔裡已經沒有自動段了，照舊寫的話這欄會變成
  // 「人工計畫」的複本，名不副實，之後翻紀錄的人會被騙。
  job.autoPlan = cfRows.map((r, i) => ({
    i: r.i != null ? r.i : i,
    src: r.src,
    cellText: r.cellText || (r.wholePage ? '整張顯示' : ''),
    phrase: r.phrase || r._phrase || '',
  }));
  appendCorrectionsLog(job, diffs);
  saveJob(job);
  return diffs;
}

/**
 * 把表單欄位組成 script.txt。
 *
 * 格式是既有解析器（script-utils.js / parse-*-script.js）認得的四段式：
 *   第 1 段      = 發音替換規則（一行一條 原文→唸法）
 *   第 2 段      = 保留不用（沿用既有腳本的習慣寫法）
 *   倒數第 2 段  = 開場卡標題（兩行）→ parse 會寫進 video-meta.json.titleText
 *   最後 1 段    = 內文
 *
 * 前台只讓同事填「標題」跟「內文」——`===` 只有 Leighly 看得懂，
 * 給同事看只會造成困擾（2026-08-13 使用者要求）。
 */
function buildScript({ voice, title, body }) {
  return [
    (voice || '').trim(),
    '===',
    '===',
    (title || '').trim(),
    '===',
    (body || '').trim(),
    '',
  ].join('\n');
}

// ── 發音替換 ──────────────────────────────
// 這條路本來就跑得通，這裡只是多接一個「共用詞庫」的來源：
//   script.txt 第 1 段 → script-utils 的 applyVoiceRulesForward() 在送 TTS 前把字換掉
//   → correct-subtitles.js 第 10 步做「反向」取代，字幕顯示回原文。
// 所以規則只要寫進 script.txt 就好，run.js 與 scripts/ 完全不用動，
// 而且每支工作的 script.txt 都留著「這次實際套了哪些」→ 可稽核、重跑可重現。

function readPronounce() {
  try {
    const j = JSON.parse(fs.readFileSync(PRONOUNCE_PATH, 'utf-8'));
    return Array.isArray(j) ? j : (j.rules || []);
  } catch (_) { return []; }
}

function writePronounce(rules) {
  ensureDir(path.dirname(PRONOUNCE_PATH));
  fs.writeFileSync(PRONOUNCE_PATH, JSON.stringify(rules, null, 2) + '\n');
}

function parseVoiceLines(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    // 跟 script-utils.js 的 parseVoiceRules 同一條規則：# 開頭是註解、要有 →
    const m = line.match(/^([^#→\n][^→]*)→(.+)$/);
    if (m && m[1].trim() && m[2].trim()) out.push({ from: m[1].trim(), to: m[2].trim() });
  }
  return out;
}

/**
 * 這一支要用的發音替換 = 同事自己填的 ＋ 共用詞庫。
 *
 * ⚠️ 兩件事決定了順序，改之前先看懂：
 *  ① `applyVoiceRulesForward()` 是**照陣列順序做字串取代**，先套的先贏。所以同事填的排前面，
 *     而且同一個「原文」在詞庫那邊會被濾掉 → 等於「本支覆寫共用詞庫」，不用另做覆寫機制。
 *  ② 共用詞庫內部照「原文長度」由長到短排。短詞先套會把長詞拆散 ——
 *     例：先套「玉→ㄩˋ」，後面的「采鈺→彩玉」就再也對不上了。
 */
function mergeVoiceRules(ownText) {
  const own = parseVoiceLines(ownText);
  const taken = new Set(own.map((r) => r.from));
  const shared = readPronounce()
    .filter((r) => r && r.enabled !== false && r.from && r.to && !taken.has(r.from))
    .sort((a, b) => [...b.from].length - [...a.from].length);
  return { own, shared };
}

/**
 * 這支「真的被換掉」的規則有哪幾條。
 *
 * 為什麼要另外算：共用詞庫會長到幾十條，全部列在前台等於沒列。人工聽的時候想知道的是
 * 「我剛剛聽到的那個字，系統到底有沒有動過手」—— 有動過還唸錯 ＝ 規則沒生效（要換寫法），
 * 沒動過 ＝ 這是新的詞（直接回報）。這兩件事的處置完全不同。
 *
 * ⚠️ 掃描方式必須跟 script-utils.js 的 applyVoiceRulesForward() 一模一樣（長的優先、
 *    由左到右、命中就跳過整個 from）—— 用 indexOf 逐條數的話，被長詞吃掉的短詞會被多算。
 */
function voiceRuleHits(text, rules) {
  const list = (rules || []).filter((r) => r && r.from);
  const s = String(text || '');
  if (!list.length || !s) return [];
  const sorted = [...list].sort((a, b) => b.from.length - a.from.length);
  const times = new Map();
  let i = 0;
  while (i < s.length) {
    const hit = sorted.find((r) => s.startsWith(r.from, i));
    if (hit) { times.set(hit.from, (times.get(hit.from) || 0) + 1); i += hit.from.length; }
    else i += 1;
  }
  return list.filter((r) => times.has(r.from))
    .map((r) => ({ from: r.from, to: r.to, src: r.src || 'shared', times: times.get(r.from) }));
}

/**
 * 同事在「唸法」填的詞，出片時順手送一份到收件匣
 * （2026-09-14 使用者定案：「送出後可以當作『跟我說』那邊的『這個詞唸錯了』寄信給我，我統一收錄」）。
 *
 * 只送**沒看過**的，不然同一個詞每天出片就多一筆，收件匣會被自己灌爆：
 *   ① 共用詞庫已經有那個原文就不送 —— 連**停用**的也算看過（停用＝看過而且決定不要，
 *      再送一次等於一直來吵同一件事）。
 *   ② 收件匣裡同一個原文還沒處理（status 不是 done）也不送。
 * 標 auto:true —— 收件匣才分得出「同事特地回報的」跟「出片時順手帶上的」，
 * 前者是他真的被唸錯困擾到，後者只是路過，處理的優先順序不一樣。
 *
 * ⚠️ 整支包在 try 裡：回報只是順手，壞掉也不能擋住出片。
 */
function reportOwnVoiceRules(job, own) {
  if (!own || !own.length) return;
  try {
    const known = new Set(readPronounce().filter((r) => r && r.from).map((r) => r.from));
    const seen = new Set(readMessages()
      .filter((m) => m.kind === 'pronounce' && m.status !== 'done' && m.word)
      .map((m) => m.word));
    for (const r of own) {
      if (known.has(r.from) || seen.has(r.from)) continue;
      seen.add(r.from);   // 同一次送出裡填了兩條一樣的原文也只送一筆
      appendMessage({
        id: `${Date.now()}-${msgSeq++}`,
        at: nowISO(), by: job.owner, kind: 'pronounce', job: job.id,
        status: 'new', auto: true, word: r.from, suggest: r.to, why: '',
      });
    }
  } catch (_) {}
}

function voiceSection(own, shared) {
  return [
    ...own.map((r) => `${r.from}→${r.to}`),
    ...(shared.length ? ['# ↓ 共用發音詞庫（自動帶入，不用手改）'] : []),
    ...shared.map((r) => `${r.from}→${r.to}`),
  ].join('\n');
}

// ── 佇列 ──────────────────────────────────
let busy = false;

function pickNext() {
  // 已確認要 render 的優先（人已經等過一輪了），其次才是新工作
  return (
    JOBS.filter((j) => j.status === 'approved').sort((a, b) => (a.approvedAt < b.approvedAt ? -1 : 1))[0] ||
    JOBS.filter((j) => j.status === 'queued').sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0]
  );
}

function queuePosition(job) {
  if (job.status !== 'queued' && job.status !== 'approved') return 0;
  const list = JOBS.filter((j) => j.status === 'queued' || j.status === 'approved');
  const order = list.sort((a, b) => {
    const w = (j) => (j.status === 'approved' ? 0 : 1);
    if (w(a) !== w(b)) return w(a) - w(b);
    return (a.approvedAt || a.createdAt) < (b.approvedAt || b.createdAt) ? -1 : 1;
  });
  return order.findIndex((j) => j.id === job.id) + (busy ? 1 : 0);
}

let lockWaitLogged = null;
function tick() {
  if (busy) return;
  const job = pickNext();
  if (!job) return;
  // .run.lock 存在但伺服器沒在跑東西 → 鎖是「外面」造成的：
  // Leighly 自己在終端機跑 run.js，或上次沒清乾淨留下的。
  // 這時候要排隊等，不能把工作標成失敗 —— 同事只會看到一個看不懂的錯誤
  //（2026-08-17 使用者問「工作區被鎖住時還可以建立工作嗎」時發現）。
  if (fs.existsSync(LOCK)) {
    if (lockWaitLogged !== job.id) {
      lockWaitLogged = job.id;
      appendLog(job, '\n⏳ 工作區正被其他流程使用（.run.lock），排隊等它結束…\n');
    }
    setTimeout(tick, 5000);
    return;
  }
  lockWaitLogged = null;
  busy = true;
  const work = job.status === 'approved' ? doRender(job) : doPrepare(job);
  work
    .catch((e) => {
      job.status = 'failed';
      job.error = e.message;
      appendLog(job, '\n❌ ' + e.message + '\n');
      saveJob(job);
    })
    .finally(() => {
      busy = false;
      try { backupJobArtifacts(job); } catch (_) {}   // 先備份再 prune，順序不能反
      try { pruneOldJobs(); } catch (_) {}
      setTimeout(tick, 200);
    });
}

/**
 * 「對照組」計畫：假裝沒有人工標注，讓自動判定自己排一次。
 *
 * 為什麼要這一步（2026-08-21 使用者定案「要，而且要真的比對」）：
 * 手動標記過的句子，auto-shot／auto-focus 是**完全不碰**的 —— 標注直接變成計畫的一部分。
 * 所以那些句子在修正紀錄裡沒有「AI 的版本」可以比，等於最有價值的訊號（人覺得需要自己標）
 * 一筆都沒留下。這裡多跑一次同一支腳本、只是加上 `--no-annots`，就得到「AI 本來會怎麼配」。
 *
 * 安全性：
 *   - 一定帶 `--out` 寫到 `jobs/<id>/auto-noannots.json`，**不會碰到要 render 的計畫檔**。
 *   - 不呼叫 HeyGen、不重新轉字幕，只是重跑判定，幾秒鐘的事。
 *   - 整段包在 try 裡，失敗就當沒有對照組（修正紀錄少一種類型，不影響出片）。
 *   - 沒有任何標注就不用跑（多數情況），省下這幾秒。
 */
function buildCounterfactual(job) {
  try {
    const annFile = jobPath(job.id, 'input', 'annotations.json');
    if (!fs.existsSync(annFile)) return;
    const shots = (JSON.parse(fs.readFileSync(annFile, 'utf-8')).shots || []).filter((a) => a && a.src);
    if (!shots.length) return;

    const out = jobPath(job.id, 'auto-noannots.json');
    const script = TEMPLATES[job.template].planKind === 'focus' ? 'auto-focus.js' : 'auto-shot.js';
    execFileSync('node', [path.join('scripts', script), '--write', '--out', out, '--no-annots'],
      { cwd: ROOT, stdio: 'ignore', timeout: 120000 });

    const n = JSON.parse(fs.readFileSync(out, 'utf-8')).length;
    appendLog(job, `\n🔬 對照組：不看手動標記的話，自動判定會排 ${n} 段（只用來寫修正紀錄，不影響出片）\n`);
  } catch (e) {
    appendLog(job, `\n⚠️ 對照組計算失敗（不影響出片，只是修正紀錄少一項）：${e.message}\n`);
  }
}

function stageJobInputs(job) {
  copyRecursive(jobPath(job.id, 'input'), path.join(ROOT, 'public'));
  copyRecursive(jobPath(job.id, 'input', 'script.txt'), path.join(ROOT, 'public', 'script.txt'));
}

async function doPrepare(job) {
  job.status = 'preparing';
  job.startedAt = nowISO();
  saveJob(job);

  clearWorkspaceInputs();
  stageJobInputs(job);

  // 發音替換是「默默套用」的（使用者定案，畫面上不顯示），但出現怪唸法時
  // 總要查得到是不是它搞的 —— 所以在執行記錄留一行。前台完全看不到這段。
  const vr = job.voiceRules || {};
  if ((vr.own || []).length || (vr.shared || []).length) {
    appendLog(job, `\n🗣  發音替換：本支 ${(vr.own || []).length} 條`
      + `${(vr.own || []).length ? '（' + vr.own.join('、') + '）' : ''}`
      + `　共用詞庫 ${(vr.shared || []).length} 條`
      + `${(vr.shared || []).length ? '（' + vr.shared.join('、') + '）' : ''}\n`);
  }

  const args = [`--template=${job.template}`, '--stop-before-render'];
  if (job.brand) args.push(`--brand=${job.brand}`);
  if (job.skipGenerate) args.push('--skip-generate');
  if (job.noSpeed) args.push('--no-speed');
  if (job.withAd) args.push('--with-ad');
  // 一律明講，不靠 run.js 的預設 —— 出片當下用的是哪個語氣要留在執行記錄裡（run.js 配音那行會印）。
  args.push(`--emotion=${normalizeEmotion(job.emotion)}`);
  await runPipeline(job, args);

  buildCounterfactual(job);
  snapshotWorkspace(job);
  job.planView = buildPlanView(job);
  job.preparedAt = nowISO();

  if (job.autoApprove) {
    // 一段式：不停下來，直接接著 render
    job.status = 'approved';
    job.approvedAt = nowISO();
    job.approvedBy = '（自動出片）';
    appendLog(job, '\n⏩ 已勾選「直接出片」，跳過人工確認\n');
    // 2026-08-25：按「標好了，直接出片」也要留下修正紀錄、也要學進記憶庫。
    // 在這之前這兩支只在 /approve handler 呼叫，而這條路完全繞過它 —— 同事一按那顆按鈕，
    // 這支工作的 90_系統/資料/corrections.jsonl 與 90_系統/資料/shot-memory.json 就什麼都不會寫
    // （0825 那支實測：修正紀錄最後一筆還停在前一支）。
    // edits 傳空陣列：這條路沒人在計畫頁改過東西，能記能學的全部在 annotations.json 裡，
    // recordCorrections 的「人工標記 vs 對照組」與 learnFromEdits 都會自己去讀。
    recordCorrections(job, job.planView, []);
    learnFromEdits(job, []);
  } else {
    job.status = 'review';
  }
  saveJob(job);
}

async function doRender(job) {
  job.status = 'rendering';
  saveJob(job);

  restoreWorkspace(job);
  if (job.pendingEdits && job.pendingEdits.length) {
    applyPlanEdits(job, job.pendingEdits);
    // 「人工標記」那一類不是這一步套用的（它是標注頁的產物，只為了寫修正紀錄而記），
    // 算進來會讓這行數字看起來比實際改動多（2026-08-21）。
    const applied = (job.corrections || []).filter((c) => c.type !== '人工標記').length;
    appendLog(job, `\n✏️  已套用 ${applied} 項人工修正\n`);
  }

  const args = [`--template=${job.template}`, '--render-only'];
  if (job.withAd) args.push('--with-ad');
  const renderFrom = Date.now() - 3000; // 容忍一點時鐘誤差
  await runPipeline(job, args);

  // 收成品
  // ⚠️ 只收「這次真的重新產生」的檔。out/ 底下的檔名是固定的，上一支的成品會一直留著；
  //    不比對時間就會把舊檔當成這次的成果交出去
  //   （2026-08-17 實際踩到：只出客製版，卻附上四天前的投廣版）。
  // 成品只存「一份」，放在成品庫。網頁直接從那裡播、從那裡下載。
  // 不再在 jobs/<id>/out 留第二份 —— 同一支大盤存兩份就是 276MB，純浪費
  //（2026-08-17 使用者點出來的）。成品庫失敗才退回 jobs/ 當保險。
  job.finishedAt = nowISO();
  job.outputs = [];
  const fallbackDir = jobPath(job.id, 'out');
  for (const rel of TEMPLATES[job.template].outputs) {
    const from = path.join(WORKSPACE_ROOT, '90_系統', '暫存', '產線輸出', path.basename(rel));
    if (!fs.existsSync(from)) continue;
    if (fs.statSync(from).mtimeMs < renderFrom) {
      appendLog(job, `⏭  略過 ${rel}：這次沒有重新產生，是上一支留下的舊檔\n`);
      continue;
    }
    const name = path.basename(rel);
    let size = fs.statSync(from).size;
    try {
      const dest = archivePath(job, name);
      // 直式三個版型走交付規格轉檔，其餘（橫式／投廣版）照舊直接複製。
      // ⚠️ 轉檔失敗一定要退回 copyFileSync —— 不能因為 ffmpeg 掛掉就沒有成品。
      if (needsDeliverySpec(job, name)) {
        appendLog(job, `\n🎛  ${name} 轉交付規格（H.264 High 4.1／yuv420p／bt709／GOP 15／−14 LUFS／TP −1.5）…\n`);
        try {
          const m = await transcodeForDelivery(from, dest);
          size = fs.statSync(dest).size;
          appendLog(job, `   ✅ 轉檔完成（源響度 ${m.input_i} LUFS／TP ${m.input_tp} dBTP → −14／−1）\n`);
        } catch (e) {
          appendLog(job, `   ⚠️ 交付轉檔失敗，改用原始渲染檔（這支不合規，要手動補轉）：${e.message}\n`);
          fs.copyFileSync(from, dest);
        }
      } else {
        fs.copyFileSync(from, dest);
      }
      job.outputs.push({ name, size, archive: path.relative(WORKSPACE_ROOT, dest) });
    } catch (e) {
      ensureDir(fallbackDir);
      fs.copyFileSync(from, path.join(fallbackDir, name));
      job.outputs.push({ name, size });
      appendLog(job, `⚠️ 存進成品庫失敗，先留在工作區：${e.message}\n`);
    }
  }
  if (!job.outputs.length) throw new Error('render 跑完了，但找不到輸出檔案。請看執行記錄。');

  job.status = 'done';
  job.archived = job.outputs.map((o) => o.archive).filter(Boolean);
  if (job.archived.length) appendLog(job, '\n📁 成品庫：\n   ' + job.archived.join('\n   ') + '\n');

  // ── 唸法：不自動判、請人回報 ──────────────
  // 這裡以前會跑 check-pronunciation 然後把候選字寫進 job.pronounce。2026-08-27 拿掉了：
  // 判得不準（見檔頭註解），而人本來就會把每一支聽過一遍。改成提醒他去回報就好。
  appendLog(job, '\n🗣 出片完成，聽到唸錯的字可以回報 —— '
    + '工作頁「發音回報」那張卡片（就在成品下面），填「唸錯的詞」跟「該怎麼寫」送出即可。\n');

  // 保留製作快照，供歷史查閱與重跑使用。
  saveJob(job);
}

// ── HTTP ──────────────────────────────────
/**
 * 這個請求是不是「管理者」（＝ Leighly 本人）。
 *
 * 沒有帳號系統，也不需要 —— 用「從哪連進來」判斷就夠：
 *   本機 localhost = 坐在這台 Mac 前面的人 = Leighly
 *   區網 IP        = 同事
 * Leighly 偶爾用手機／別台連進來時，網址加 ?k=<ADMIN_KEY> 就好。
 * 這只是「不要讓同事看到內部資訊」，不是資安機制 —— 區網內本來就互相信任。
 *
 * 2026-08-21：舊的 ?admin=1 拿掉了（使用者要求）—— 誰都猜得到那五個字，
 * 直接在網址列打 /api/messages?admin=1 就能讀到收件匣。改成只有 Leighly 知道的暗號。
 */
function clientIp(req) {
  // Node 在雙堆疊 socket 上會把 IPv4 包成 ::ffff:192.168.x.x，去掉前綴才是人看得懂的 IP。
  // 這台是直連（沒有反向代理），所以不必理會 X-Forwarded-For —— 那個標頭可以偽造。
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function isAdmin(req, url) {
  if (ADMIN_KEY && url.searchParams.get('k') === ADMIN_KEY) return true;
  const ip = clientIp(req);
  return ip === '127.0.0.1' || ip === '::1';
}

function send(res, code, body, headers) {
  const h = { 'Cache-Control': 'no-store', ...(headers || {}) };
  if (typeof body === 'object' && !Buffer.isBuffer(body)) {
    body = JSON.stringify(body);
    h['Content-Type'] = 'application/json; charset=utf-8';
  }
  res.writeHead(code, h);
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const parts = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('內容太大')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

// ── 上傳圖片的格式防呆 ────────────────────────────────────────────
// 前台的檔名規則是「不是 .jpg 就叫 .png」（index.html 的 `ups`），**不看內容** ——
// 所以同事從 Chrome 右鍵存下來的 .webp、從 iPhone 相簿拿的 .heic，
// 都會變成「副檔名寫 png、內容不是 png」的檔案。
// tesseract 只吃 png/jpg，讀不出來就沒有 OCR → 沒有聚焦、也沒有截圖，
// 而版面偵測是**背景執行**的，同事只會看到「影片出來了但圖都沒放」，看不出哪裡錯。
// 所以在收檔的當下就嗅探真實格式：能轉的當場轉掉，不能轉的擋下來把話講清楚。
const IMAGE_KIND_LABEL = {
  webp: 'WebP（多半是從網頁右鍵存下來的）',
  heic: 'HEIC（iPhone 照片）',
  gif: 'GIF', bmp: 'BMP', tiff: 'TIFF',
};

/** 讀前 16 bytes 認格式。認不出來回 null（不要用副檔名猜，那正是這個坑的成因）。 */
function sniffImageKind(file) {
  const b = Buffer.alloc(16);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, b, 0, 16, 0);
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
  if (b.subarray(0, 4).toString('hex') === '89504e47') return 'png';
  if (b.subarray(0, 3).toString('hex') === 'ffd8ff') return 'jpeg';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  // heic/heif/avif 都是 ISO-BMFF：第 5~8 byte 是 'ftyp'
  if (b.subarray(4, 8).toString('latin1') === 'ftyp') return 'heic';
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (b.subarray(0, 2).toString('latin1') === 'BM') return 'bmp';
  const t = b.subarray(0, 4).toString('hex');
  if (t === '49492a00' || t === '4d4d002a') return 'tiff';
  return null;
}

/**
 * 原地轉檔。兩個工具都試，回傳成功的那個的名字、都失敗回 null。
 *   sips   —— macOS 內建，**HEIC 只有它一定讀得動**，不必 brew 裝東西
 *   ffmpeg —— 專案本來就在用，webp/gif/bmp/tiff 很穩
 * 順序是「先 sips 後 ffmpeg」：這台是 Mac，內建的那個不用擔心沒裝。
 */
function convertImageInPlace(file, targetExt) {
  const tmp = file + '.converting.' + targetExt;
  const attempts = [
    ['sips', ['-s', 'format', targetExt === 'jpg' ? 'jpeg' : 'png', file, '--out', tmp]],
    // -frames:v 1 -update 1：動畫 GIF／多頁 TIFF 只取第一張。
    // 少了這兩個旗標，ffmpeg 會想寫成一連串檔案、然後整個失敗（實測動畫 GIF 會被擋掉）。
    ['ffmpeg', ['-v', 'error', '-y', '-i', file, '-frames:v', '1', '-update', '1', tmp]],
  ];
  for (const [cmd, args] of attempts) {
    try {
      // execFileSync 會擋住整個 event loop，所以一定要有 timeout ——
      // 不然一張壞掉的大圖可以讓整台伺服器卡住，其他同事會以為前台掛了。
      execFileSync(cmd, args, { stdio: 'ignore', timeout: 60_000 });
      if (fs.existsSync(tmp) && fs.statSync(tmp).size > 0) {
        fs.renameSync(tmp, file);
        return cmd;
      }
    } catch (_) { /* 換下一個工具 */ }
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
  return null;
}

/**
 * 收檔後檢查一張圖能不能用。
 * 回 null＝不用管（不是圖，或格式本來就對）；回 { error } ＝擋下來；回 { converted, tool } ＝轉好了。
 */
/**
 * 事後補上傳時，下一張截圖要叫什麼名字。
 * 一律 shot<N>，N 取 input/ 裡現有 shotN 的最大值 +1（不是「數量 +1」——
 * 刪過檔的話數量會跟編號對不起來，就會撞名蓋掉別人的圖）。
 * 保險起見再檢查一次檔案存不存在，撞到就往下找。
 */
function nextShotName(job, ext) {
  const dir = jobPath(job.id, 'input');
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) {}
  let n = 0;
  for (const f of names) {
    const m = f.match(/^shot(\d+)\./i);
    if (m) n = Math.max(n, parseInt(m[1], 10));
  }
  let cand;
  do { n += 1; cand = `shot${n}${ext}`; } while (names.includes(cand) || fs.existsSync(path.join(dir, cand)));
  return cand;
}

/**
 * 工作送出之後才補進來的截圖，要自己送到「這支工作正在用的那幾份」。
 *
 * 三個地方，缺一個就會有一種靜默失敗：
 *   ① job.files —— 前台的標注頁與配圖計畫都是照這個清單畫圖的，不補就看不到新圖。
 *   ② ROOT/public —— 這支**正在跑**（preparing）的話，input/ 早就整包複製過去了，
 *      現在補寫還來得及被 run.js 最後才跑的 auto-shot／auto-focus 與 render 讀到。
 *      跟 PUT /annotations 同一個道理、同一個條件：**只有 preparing**。
 *      'queued' 不能補寫 —— 它還沒開始，input/ 之後會整包複製過去本來就會帶到，
 *      現在寫進去反而會蓋掉**別支正在跑**的工作（2026-08-21 已經踩過一次）。
 *   ③ state/public 快照 —— doRender() 是 clearWorkspaceInputs() 之後從快照還原的，
 *      只寫 ROOT/public 的話，準備跑完之後補的圖會在還原那一刻被清掉 → remotion 找不到檔案。
 *      快照還不存在（還在準備中）就不用寫，doPrepare 結尾自己會把 ROOT/public 凍進去。
 */
/**
 * 事後補上傳的截圖，要把「別支工作留下的同名分析」作廢。
 *
 * ⚠️ 2026-09-14 使用者回報「8月營收／大戶狂賣／散戶 的顯示區域框錯」的根因：
 *   `src/app-images.generated.json` 是**工作區共用**的產線檔，不是 per-job 的；那支分析在
 *   doPrepare 一開頭就跑完了，**事後**補上傳的圖從來沒被它看過。偏偏補上傳一律照
 *   `shot<N>` 依序命名（nextShotName 只看這支工作的 input/），很容易跟上一支工作的
 *   同名圖撞名 —— 於是檔案裡查得到 `shot2.jpg`，寫的卻是**別張圖**的尺寸與 OCR 結果。
 *   0914 那支：三張圖實際都是 869×1884，檔裡寫 shot2=1179×1066、shot3=1031×1589。
 *   `region`（顯示區域）與 `cell`（黃框）存的是原圖像素座標，縮放比一錯整塊就位移＋縮放：
 *   使用者圈的營收表格變成長條圖、圈的大戶賣超變成別的區塊。
 *   （2026-09-01 只補了「查不到那一筆 → 退到標注自帶尺寸」，查得到但是別張圖擋不住。）
 *
 * 作法是把那一筆改成「只剩實際尺寸」的最小筆，不是整筆刪掉：
 *   - 留 file/width/height → 下游拿得到正確縮放比，人工圈的框位置就對了。
 *   - 頁型、股名、topicBox、逐字框全部清掉 → 那些是別張圖的 OCR，留著會讓自動配圖
 *     照別張圖的座標亂框（比沒有更糟）。清成「未知頁面」＝這張沒被分析過，如實。
 *   - 不整筆刪：auto-shot.js 在 `imgs` 空掉時會直接 fail，出片就掛了。
 * 這張圖真正的分析結果要等下一次 analyze-app-images 才會有（重跑整支就會重算）。
 */
function invalidateStaleAnalysis(job, name, dest) {
  const size = imageSize(dest);
  if (!size) return;
  const files = [
    path.join(ROOT, 'src', 'app-images.generated.json'),
    jobPath(job.id, 'state', 'src', 'app-images.generated.json'),
  ];
  let fixed = null;
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(f, 'utf-8'));
      const list = Array.isArray(data.images) ? data.images : null;
      if (!list) continue;
      const i = list.findIndex((m) => m.file === name);
      if (i < 0) continue;   // 沒撞名＝沒有假資料，下游的「退到標注尺寸」本來就會處理
      const was = list[i];
      if (was.width === size.width && was.height === size.height
          && was.page === 'unknown' && !was.topicBox) continue;   // 已經是最小筆，不用重寫
      fixed = fixed || { w: was.width, h: was.height };
      list[i] = {
        file: name,
        width: size.width,
        height: size.height,
        page: 'unknown',
        pageLabel: '未知頁面',
        isStockPage: false,
        stockName: null,
        stockNameAlts: [],
        stockCode: null,
        topic: null,
        topicTerms: null,
        topicBox: null,
        words: [],
        _staleCleared: true,   // 給人看的：這筆是被作廢的，不是分析出來的
      };
      fs.writeFileSync(f, JSON.stringify(data, null, 2));
    } catch (_) {}
  }
  if (fixed) {
    appendLog(job, `   ↳ ${name} 撞到舊工作留下的同名分析（${fixed.w}×${fixed.h}），`
      + `已改回這張圖的實際尺寸 ${size.width}×${size.height} 並清掉舊的辨識結果`);
  }
}

function publishLateUpload(job, name, dest) {
  try {
    if (!Array.isArray(job.files)) job.files = [];
    if (!job.files.includes(name)) job.files.push(name);
    // planView 是「準備中」那一刻算好凍起來的，補上傳的圖不在裡面 —— 縮圖牆（planView.images）
    // 是照它畫的，不補的話重新整理一次新圖就不見了（前台當下是自己把檔名塞進去的）。
    if (job.planView && Array.isArray(job.planView.images)
        && !job.planView.images.includes(name)) job.planView.images.push(name);
    saveJob(job);
  } catch (_) {}
  const copies = [];
  try {
    if (job.status === 'preparing') {
      const to = path.join(ROOT, 'public', name);
      fs.copyFileSync(dest, to);
      copies.push('public/');
    }
    const snap = jobPath(job.id, 'state', 'public');
    if (fs.existsSync(snap)) {
      fs.copyFileSync(dest, path.join(snap, name));
      copies.push('快照');
    }
  } catch (e) {
    appendLog(job, `⚠️ ${name} 補進工作區時出錯：${e.message}（檔案已存在 input/，可重新上傳）`);
    return;
  }
  appendLog(job, `➕ 事後補上傳截圖 ${name}${copies.length ? `（已同步到 ${copies.join('、')}）` : ''}`);
  invalidateStaleAnalysis(job, name, dest);
}

function ensureUsableImage(dest) {
  const ext = path.extname(dest).toLowerCase();
  if (ext !== '.png' && ext !== '.jpg' && ext !== '.jpeg') return null; // heygen.mp4 之類的走這裡
  const want = ext === '.png' ? 'png' : 'jpeg';
  const kind = sniffImageKind(dest);
  if (kind === want) return null;
  if (!kind) return { error: '這個檔看起來不是圖片（認不出格式）。請改用 PNG 或 JPG 的截圖。' };
  // kind 是 png/jpeg 但跟副檔名對不上（.jpg 裡裝 png）也一起轉正 ——
  // 下游有些地方是用副檔名判斷的，留著遲早會踩到。
  const tool = convertImageInPlace(dest, ext === '.png' ? 'png' : 'jpg');
  if (!tool) {
    const label = IMAGE_KIND_LABEL[kind] || kind.toUpperCase();
    return {
      error: `這張圖是 ${label}，這台機器轉不過來。`
        + '請在 Mac 上用「預覽程式 → 檔案 → 轉存…」存成 PNG 再上傳一次。',
    };
  }
  return { converted: kind, tool };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.mp4': 'video/mp4', '.json': 'application/json',
};

function sendFile(req, res, file, download) {
  if (!fs.existsSync(file)) return send(res, 404, { error: '找不到檔案' });
  const st = fs.statSync(file);
  // ⚠️ 資料夾不能當檔案送 —— createReadStream 對目錄是**非同步**丟 EISDIR（stream 的
  //    'error' 事件），呼叫端的 try/catch 攔不到 → 未處理例外 → 整台伺服器當場死。
  //    2026-09-11 17:32：同事在沒有截圖的工作按「＋ 加一段」，前台送出檔名是空字串的
  //    /api/jobs/<id>/file/，解回 _製作資料/thumbs 這個目錄 → 全公司連不進來 35 分鐘。
  if (!st.isFile()) return send(res, 404, { error: '找不到檔案' });
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' };
  if (download) {
    // ⚠️ HTTP header 的值只能是 Latin-1 —— 中文檔名直接塞進去，Node 會丟
    //    ERR_INVALID_CHAR：`Invalid character in header content ["Content-Disposition"]`。
    //    成品在 843d768 之後會改名歸檔成「0826-三大法人-標題.mp4」，所以**從成品庫下載
    //    一定爆**；從 jobs/<id>/out/ 下載因為檔名是 output-xxx.mp4（純 ASCII）才沒事。
    //    2026-08-26 使用者回報。
    // 解法是 RFC 5987 的兩段式寫法：filename= 給 ASCII 退路，filename*= 給真正的 UTF-8 檔名，
    // 瀏覽器會優先採用後者 → 中文檔名照樣正確落地。
    const base = path.basename(file);
    const ascii = base.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    // ⚠️ encodeURIComponent 不會跳脫 ' ( ) *，但這四個不在 RFC 5987 的 attr-char 裡 ——
    //    而成品檔名真的會出現括號（同一天重跑會變成「…！(2).mp4」），要自己補跳脫。
    const enc = encodeURIComponent(base).replace(/['()*]/g, (c) =>
      '%' + c.charCodeAt(0).toString(16).toUpperCase());
    headers['Content-Disposition'] = `attachment; filename="${ascii}"; filename*=UTF-8''${enc}`;
  }

  // 保險：讀到一半出事（檔案被刪、權限、磁碟）也只能斷這一條連線。
  // 沒有這個 handler 的話，stream 的 'error' 會變成未處理例外，一個壞請求＝整台重開。
  const pipe = (stream) => {
    stream.on('error', (e) => {
      console.error(`  ⚠️ 送檔中斷 ${path.basename(file)}：${e.message}`);
      res.destroy();
    });
    return stream.pipe(res);
  };

  // 影片要支援拖時間軸 → Range
  const range = req.headers.range;
  if (range && /^bytes=\d*-\d*$/.test(range)) {
    const [a, b] = range.replace('bytes=', '').split('-');
    const start = a ? parseInt(a, 10) : 0;
    const end = b ? parseInt(b, 10) : st.size - 1;
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${st.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    });
    return pipe(fs.createReadStream(file, { start, end }));
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
  pipe(fs.createReadStream(file));
}

// ── 留言／唸法回報 ────────────────────────
let msgSeq = 0;

function appendMessage(obj) {
  ensureDir(path.dirname(MESSAGES_LOG));
  fs.appendFileSync(MESSAGES_LOG, JSON.stringify(obj) + '\n');
}

/** 讀回所有留言，並把後面追加的 { op:'status' } 摺疊上去 */
function readMessages() {
  if (!fs.existsSync(MESSAGES_LOG)) return [];
  const byId = new Map();
  for (const line of fs.readFileSync(MESSAGES_LOG, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }
    if (o.op === 'status') {
      const m = byId.get(o.id);
      if (m) m.status = o.status;
      continue;
    }
    if (o.id) byId.set(o.id, { status: 'new', ...o });
  }
  return [...byId.values()].map((message) => message.pinned
    ? { ...message, pinned: path.relative(WORKSPACE_ROOT, resolveDataReference(WORKSPACE_ROOT, message.pinned)) }
    : message);
}

/**
 * 把這一支的人工框選學進 90_系統/資料/shot-memory.json，下次遇到同一種頁面就自動套。
 *
 * 為什麼不是用 90_系統/資料/corrections.jsonl（修正紀錄）：那份是給人看的日記，
 * 出片流程一行都沒讀它 —— 使用者 2026-08-21 問「都有記錄了，下次應該就會自己認得吧？」
 * 答案是不會，因為沒有任何東西回頭讀它。這一支才是真的接回 auto-shot.js 的那條線。
 *
 * ⚠️ 圖片的頁型／代號要從**這支工作的快照**讀（jobs/<id>/state），不能讀 ROOT ——
 *    按確認的當下 ROOT 可能已經被下一支工作佔用了。
 */
function learnFromEdits(job, edits) {
  try {
    const state = jobPath(job.id, 'state');
    const imgs = JSON.parse(
      fs.readFileSync(path.join(state, 'src', 'app-images.generated.json'), 'utf-8')).images || [];
    const chars = (job.planView && job.planView.chars) || [];
    const textOf = (a, b) => (a == null || b == null || !chars.length ? ''
      : chars.slice(a, b + 1).map((c) => c.c).join(''));
    // 只學「人真的動過的」—— 自動段原樣送回來的不算，學了等於把 AI 自己的判斷
    // 當成人的示範，會愈學愈歪（跟 applyPlanEdits 用同一個 _manual／_added 判準）。
    const items = edits
      .filter((e) => (e._manual || e._added) && !e.deleted && e.src && e.cell && e.cell.w > 0)
      .map((e) => ({
        src: e.src, cell: e.cell, region: e.region,
        imgW: e.imgW, imgH: e.imgH,
        phrase: textOf(e.startCharIdx, e.endCharIdx),
        startCharIdx: e.startCharIdx,
      }));
    // ── 標注頁畫的框也要學（2026-08-25）──
    // 原本只學「在計畫頁動過的」，但標注頁的框是**直接變成計畫的一部分**、不算「動過」，
    // 所以一次都沒被學進去。而 auto-shot 從 8/25 起預設只用人工標注 —— 標注頁的框
    // 就是唯一會進成品的東西，不學它等於整個記憶庫再也收不到料。
    // 按「標好了，直接出片」的工作更是完全沒有 edits，能學的全部在這裡。
    const seen = new Set(items.map((it) => `${it.src}@${it.startCharIdx}`));
    try {
      const ann = JSON.parse(fs.readFileSync(
        jobPath(job.id, 'input', 'annotations.json'), 'utf-8')).shots || [];
      for (const a of ann) {
        if (!a || !a.src || !a.cell || !(a.cell.w > 0)) continue;
        if (typeof a.startCharIdx !== 'number' || typeof a.endCharIdx !== 'number') continue;
        const lo = Math.min(a.startCharIdx, a.endCharIdx), hi = Math.max(a.startCharIdx, a.endCharIdx);
        if (seen.has(`${a.src}@${lo}`)) continue;   // 同一句已經從計畫頁學過了，不要重複灌
        seen.add(`${a.src}@${lo}`);
        items.push({
          src: a.src, cell: a.cell, region: a.region,
          imgW: a.imgW, imgH: a.imgH,
          phrase: textOf(lo, hi), startCharIdx: lo,
        });
      }
    } catch (_) {}
    if (!items.length) return;
    const r = SHOT_MEMORY.learn(WORKSPACE_ROOT, items, imgs, nowISO());
    const bits = [];
    if (r.learnedPages.length) bits.push(`${r.learnedPages.length} 種頁面的框位`);
    const names = Object.entries(r.learnedNames);
    if (names.length) bits.push('代號 ' + names.map(([c, n]) => `${c}=${n}`).join('、'));
    if (bits.length) appendLog(job, `\n🧠 記住了：${bits.join('　')}（下次遇到同型頁面會自動套用）\n`);
  } catch (e) {
    // 學不起來不能影響出片
    try { appendLog(job, `\n⚠️ 標注記憶寫入失敗（不影響出片）：${e.message}\n`); } catch (_) {}
  }
}

// admin=false（＝同事）時，回應裡**根本不會有** ip 這個欄位 —— 不是前端不畫而已，
// 是伺服器不送。所以按 F12 翻 Network 也翻不到（2026-08-21 使用者要求）。
function publicJob(j, admin) {
  const { pid, pendingEdits, autoPlan, ip, ...rest } = j;
  const out = { ...rest, queuePosition: queuePosition(j) };
  if (admin && ip) out.ip = ip;
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const seg = p.split('/').filter(Boolean);
  const admin = isAdmin(req, url);

  try {
    // ── API ──
    if (p === '/api/health') {
      refreshDetached();
      return send(res, 200, {
        ok: true, busy,
        // locked 只代表「有鎖」；externalLock 才是需要提醒的狀況
        //（伺服器自己在跑的時候 run.js 也會建立 .run.lock，那是正常的）
        locked: fs.existsSync(LOCK),
        externalLock: !busy && fs.existsSync(LOCK),
        lockAgeMin: fs.existsSync(LOCK)
          ? Math.round((Date.now() - fs.statSync(LOCK).mtimeMs) / 60000) : null,
        templates: TEMPLATES, brands: listBrands(), reasonTags: REASON_TAGS,
        startedAt: STARTED_AT, codeChangedAt: codeChangedAt(),
        // 前台檔案本身的時間戳。已經開著的分頁不會自己重抓 index.html，
        // 所以要讓它自己發現「我手上這份網頁過期了」→ 跳「請重新整理」（2026-08-21）。
        webBuiltAt: webChangedAt(),
        admin: isAdmin(req, url),
        diskMB: Math.round(dirSize(JOBS_DIR) / 1048576),
        keep: { automatic: false },
      });
    }

    // ── 跟我說：留言／唸法回報 ──
    // 送出人人都可以（同事就是要靠這個跟我說話）；看收件匣只有管理者。
    if (p === '/api/messages' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const by = String(body.by || '').trim();
      if (!by) return send(res, 400, { error: '不知道是誰回報的，請先填「你是誰」' });
      const kind = ['pronounce', 'page-pin'].includes(body.kind) ? body.kind : 'note';
      // 2026-09-07 使用者定案：📌 只有管理者可以按（前端也只畫給管理者）。
      if (kind === 'page-pin' && !isAdmin(req, url)) return send(res, 403, { error: '📌 只有管理者可以記下頁型' });
      const m = {
        id: `${Date.now()}-${msgSeq++}`,
        at: nowISO(), by, kind,
        job: body.job ? String(body.job) : null,
        status: 'new',
      };
      if (kind === 'pronounce') {
        m.word = String(body.word || '').trim();
        m.suggest = String(body.suggest || '').trim();
        m.why = String(body.why || '').trim();
        if (!m.word || !m.suggest) return send(res, 400, { error: '「唸錯的詞」跟「建議怎麼寫」都要填' });
      } else if (kind === 'page-pin') {
        // 📌 記下這種頁（2026-09-07）：審核頁上系統認不出頁型的截圖旁那顆按鈕。
        // 只存「這是哪支工作的哪張圖」＋指紋（OCR 中文詞、尺寸、memKey）＋截圖副本，**不命名** ——
        // 使用者定案：當場手打會長出三種寫法，累積一批再用 scripts/page-pins.js 分群、一次命名。
        m.src = String(body.src || '').trim();
        if (!m.src || !m.job) return send(res, 400, { error: '📌 要知道是哪支工作的哪張圖' });
        m.text = String(body.text || '').trim();
        // 指紋與存圖都包在 try：任何一步失敗還是要把 📌 記下來（至少有 job/src 事後可追）
        try {
          const st = jobPath(m.job, 'state');
          let im = null;
          try {
            im = (JSON.parse(fs.readFileSync(path.join(st, 'src', 'app-images.generated.json'), 'utf-8')).images || [])
              .find((x) => x.file === m.src) || null;
          } catch (_) {}
          m.systemPage = im ? (im.page || 'unknown') : null;
          if (im) {
            // 指紋 = 合併字框後、只留中文 ≥2 字的詞（去數字：數字每天不同，版面標籤才是頁型特徵）
            const words = SHOT_MEMORY.mergeRuns(im.words || []).map((r) => r.t)
              .flatMap((t) => String(t).match(/[一-鿿]{2,}/g) || []);
            m.fingerprint = { words: [...new Set(words)].slice(0, 40), width: im.width, height: im.height,
              stockCode: im.stockCode || null, memKey: SHOT_MEMORY.memKeyOf(im) };
          }
          // 截圖存一份到 90_系統/資料/page-samples/_pinned/ —— jobs/ 會被 prune，指紋在、圖沒了就白搭
          const from = [path.join(st, 'public', m.src), jobPath(m.job, 'input', m.src)].find((f) => fs.existsSync(f));
          if (from) {
            const dest = dataPath(WORKSPACE_ROOT, 'page-samples', '_pinned', `${m.job}__${m.src}`);
            ensureDir(path.dirname(dest));
            if (!fs.existsSync(dest)) fs.copyFileSync(from, dest);
            m.pinned = path.relative(WORKSPACE_ROOT, dest);
          }
        } catch (e) { m.pinError = e.message; }
      } else {
        m.text = String(body.text || '').trim();
        if (!m.text) return send(res, 400, { error: '留言是空的' });
      }
      appendMessage(m);
      return send(res, 200, { ok: true, id: m.id });
    }

    if (p === '/api/messages' && req.method === 'GET') {
      if (!isAdmin(req, url)) return send(res, 403, { error: '只有管理者看得到收件匣' });
      return send(res, 200, { messages: readMessages() });
    }

    // 已讀／標回未讀。不就地改，追加一行 op:'status'，讀的時候摺疊 —— 檔案維持 append-only。
    if (p === '/api/messages/status' && req.method === 'POST') {
      if (!isAdmin(req, url)) return send(res, 403, { error: '只有管理者可以標記' });
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      if (!body.id) return send(res, 400, { error: '缺少 id' });
      appendMessage({ op: 'status', id: String(body.id), status: body.status === 'done' ? 'done' : 'new', at: nowISO() });
      return send(res, 200, { ok: true });
    }

    // ── 共用發音詞庫（只有管理者能改）──
    if (p === '/api/pronounce' && req.method === 'GET') {
      if (!isAdmin(req, url)) return send(res, 403, { error: '只有管理者看得到詞庫' });
      return send(res, 200, { rules: readPronounce() });
    }

    if (p === '/api/pronounce' && req.method === 'POST') {
      if (!isAdmin(req, url)) return send(res, 403, { error: '只有管理者可以改詞庫' });
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const from = String(body.from || '').trim();
      const to = String(body.to || '').trim();
      if (!from || !to) return send(res, 400, { error: '原文跟唸法都要填' });
      if (from === to) return send(res, 400, { error: '原文跟唸法一樣，這條沒有作用' });
      // ⚠️ 這是字串取代不是「詞」取代 —— 沒有詞邊界判斷。單支腳本填錯當場就聽得出來，
      //    但共用詞庫錯一條會靜默影響之後每一支影片，很難聯想到是它。
      //    單字一律擋死：「玉」會打中「采鈺」「玉山」「金玉」，幾乎不可能是對的。
      //    兩個字只提醒不擋 —— 台股公司名大多是兩個字（采鈺／精材／鴻海），那正是這個功能存在的理由。
      if ([...from].length < 2)
        return send(res, 400, {
          error: `「${from}」只有一個字，不能收進共用詞庫 —— 它會打中所有含這個字的詞。`
            + '請改成完整的詞；真的只能用單字，就在那一支的「唸法」欄位填，只影響那一支。',
        });
      if ([...from].length === 2 && !body.force)
        return send(res, 400, {
          error: `「${from}」只有兩個字。共用詞庫是整篇字串取代，如果有別的詞包含「${from}」，`
            + '那個詞也會被一起改掉。確定沒問題就再按一次「加進詞庫」。',
          short: true,
        });
      const rules = readPronounce();
      // 規則互相打架的檢查。applyVoiceRulesForward 已經改成「換過的地方不再被掃」，
      // 所以不會再靜默串接；但兩條規則互相包含時，實際會生效的是哪一條並不直觀，
      // 與其讓人事後才發現，不如在加的當下就講清楚。
      const clash = rules.filter((r) => r.enabled !== false && r.from !== from
        && (r.to.includes(from) || from.includes(r.from) || r.from.includes(from)));
      if (clash.length && !body.force)
        return send(res, 400, {
          error: `「${from}」跟詞庫裡的「${clash.map((r) => r.from + '→' + r.to).join('」「')}」有重疊，`
            + '兩條規則會搶同一段文字（實際生效的是比較長的那條）。'
            + '確定要加就再按一次「加進詞庫」。',
          clash: clash.map((r) => ({ from: r.from, to: r.to })),
        });
      const i = rules.findIndex((r) => r.from === from);
      const rule = {
        from, to,
        why: String(body.why || '').trim(),
        by: String(body.by || '').trim() || '管理者',
        at: nowISO(),
        enabled: true,
        ...(body.fromMessage ? { fromMessage: String(body.fromMessage) } : {}),
      };
      if (i >= 0) rules[i] = { ...rules[i], ...rule }; else rules.push(rule);
      writePronounce(rules);
      return send(res, 200, { ok: true, rules });
    }

    // 停用／啟用。不刪除 —— 刪掉就不知道當初為什麼加，之後又會有人再加一次。
    if (p === '/api/pronounce' && req.method === 'PATCH') {
      if (!isAdmin(req, url)) return send(res, 403, { error: '只有管理者可以改詞庫' });
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const rules = readPronounce();
      const r = rules.find((x) => x.from === String(body.from || ''));
      if (!r) return send(res, 404, { error: '詞庫裡沒有這一條' });
      r.enabled = !!body.enabled;
      writePronounce(rules);
      return send(res, 200, { ok: true, rules });
    }

    if (p === '/api/jobs' && req.method === 'GET') {
      refreshDetached();
      return send(res, 200, { jobs: JOBS.slice(0, 50).map((j) => publicJob(j, admin)), busy });
    }

    if (p === '/api/jobs' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      if (!TEMPLATES[body.template]) return send(res, 400, { error: '版型不對' });
      if (TEMPLATES[body.template].disabled) return send(res, 400, { error: '這個版型目前關閉中' });
      if (!body.body || !body.body.trim()) return send(res, 400, { error: '腳本是空的' });
      // 標題：行數一律以版型設定為準；每行字數只有「不能換行」的模板（投廣）才截斷。
      // 會換行的模板讓標題超過上限，交給 composition 自動換行（2026-08-17 使用者定案）。
      const tcfg = TEMPLATES[body.template].title || { lines: 2, per: 12, wrap: true };
      const title = String(body.title || '').split('\n')
        .map((l) => (tcfg.wrap ? l.trim() : l.trim().slice(0, tcfg.per))).filter(Boolean)
        .slice(0, tcfg.lines).join('\n');
      const job = {
        id: newId(),
        template: body.template,
        owner: (body.owner || '').trim() || '未署名',
        title,
        status: 'draft', // 上傳完檔案才轉 queued
        createdAt: nowISO(),
        // 送出這支的機器 IP。owner 是自己填的、可以亂填，這欄是佐證「到底哪台送的」。
        // 只在建立當下記一次（核准／取消／刪除都不記）；只有管理者拿得到（見 publicJob）。
        ip: clientIp(req),
        skipGenerate: !!body.skipGenerate,
        noSpeed: !!body.noSpeed,
        withAd: !!body.withAd,
        emotion: normalizeEmotion(body.emotion),
        brand: body.brand ? String(body.brand) : null,
        autoApprove: !!body.autoApprove,
      };
      // 共用詞庫在這裡就併進 script.txt —— 之後整條 pipeline 都不知道有這回事，
      // 而且這支工作的 script.txt 永遠留著「當時實際套了哪些規則」。
      const { own, shared } = mergeVoiceRules(body.voice);
      job.voiceRules = {
        own: own.map((r) => `${r.from}→${r.to}`),
        shared: shared.map((r) => `${r.from}→${r.to}`),
        // 只有打中內文的那幾條才會進 hit —— 前台顯示的是這個，不是整本詞庫。
        // 算的是 body.body（＝腳本內文），標題不送 TTS、不套發音替換。
        hit: voiceRuleHits(body.body, [
          ...own.map((r) => ({ ...r, src: 'own' })),
          ...shared.map((r) => ({ ...r, src: 'shared' })),
        ]),
      };
      STORE.directory(job.id, job);
      ensureDir(jobPath(job.id, 'input'));
      fs.writeFileSync(jobPath(job.id, 'input', 'script.txt'),
        buildScript({ voice: voiceSection(own, shared), title, body: body.body }));
      JOBS.unshift(job);
      saveJob(job);
      reportOwnVoiceRules(job, own);
      return send(res, 200, { job: publicJob(job, admin) });
    }

    // 上傳單一檔案：整個 request body 就是檔案內容（不用 multipart，省一個相依套件）
    // ?auto=1&ext=.png → 檔名交給伺服器排（手動標記頁的「＋ 上傳更多截圖」走這條）。
    // ⚠️ 編號一定要伺服器算：前台自己算的話，兩個人同時補圖就會撞到同一個 shotN，
    //    後上傳的直接蓋掉先上傳的，而且既有標注還指著那個檔名 → 圖被換掉且完全沒有提示。
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'upload' && req.method === 'POST') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      const auto = url.searchParams.get('auto') === '1';
      let name;
      if (auto) {
        const ext = /^\.jpe?g$/i.test(url.searchParams.get('ext') || '') ? '.jpg' : '.png';
        name = nextShotName(job, ext);
      } else {
        name = path.basename(url.searchParams.get('name') || '');
      }
      if (!name) return send(res, 400, { error: '缺少檔名' });
      const dest = jobPath(job.id, 'input', name);
      ensureDir(path.dirname(dest));
      // ⚠️ auto 模式要先把檔名佔起來。下面是 await（串流寫檔），一次選 3 張的話
      //    三個請求會在任何一個真正寫進去之前都算到同一個編號 → 互相覆蓋。
      if (auto) fs.writeFileSync(dest, '');
      await new Promise((ok, bad) => {
        const ws = fs.createWriteStream(dest);
        req.pipe(ws);
        ws.on('finish', ok);
        ws.on('error', bad);
      });
      // 副檔名是前台按「不是 jpg 就叫 png」硬取的，跟內容無關 —— 這裡才是第一次看到真正的位元組。
      const fix = ensureUsableImage(dest);
      if (fix && fix.error) {
        try { fs.unlinkSync(dest); } catch (_) {}
        return send(res, 400, { error: fix.error });
      }
      if (fix && fix.converted) {
        appendLog(job, `🖼  ${name}：偵測到 ${IMAGE_KIND_LABEL[fix.converted] || fix.converted}，`
          + `已用 ${fix.tool} 自動轉成 ${path.extname(dest).slice(1).toUpperCase()}`);
      }
      // 事後補上傳（工作已經送出去了）→ 要自己把檔案送到「這支工作正在用的那幾份」。
      // 建立工作時（status 'draft'）什麼都不用做：/submit 會重掃 input/，doPrepare 會整包複製。
      if (auto || job.status !== 'draft') publishLateUpload(job, name, dest);
      return send(res, 200, {
        ok: true, name, size: fs.statSync(dest).size,
        converted: (fix && fix.converted) || null,
        files: job.files || null,
      });
    }

    // 上傳完成 → 排進佇列
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'submit' && req.method === 'POST') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      const inputs = fs.readdirSync(jobPath(job.id, 'input'));
      if (fs.existsSync(jobPath(job.id, 'input', 'script.txt'))) inputs.push('script.txt');
      if (job.skipGenerate && !inputs.some((n) => /^heygen\.mp4$/i.test(n)))
        return send(res, 400, { error: '選了「用現成講者影片」，但沒有上傳 heygen.mp4' });
      job.status = 'queued';
      job.files = inputs;
      saveJob(job);
      tick();
      return send(res, 200, { job: publicJob(job, admin) });
    }

    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[2] && seg.length === 3 && req.method === 'GET') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      // planView 是在「準備中」那一步算好存起來的，所以功能上線前跑的工作
      // 會缺新欄位（例如子句清單 units → 前台的拉範圍會顯示「腳本還在讀…」）。
      // 快照還在的話就地重算，使用者不用重跑一支（2026-08-17 實際踩到）。
      if (job.status === 'review' && !(job.planView && (job.planView.units || []).length)
          && fs.existsSync(jobPath(job.id, 'state'))) {
        try {
          job.planView = buildPlanView(job);
          saveJob(job);
        } catch (_) {}
      }
      // planView 是「準備中」那一刻算好凍起來的，但標注可以在那之後才存進來。
      // 「沒被吃到的標注」很便宜（只讀一個 json，不重畫縮圖），每次都重算 ——
      // 不然剛好卡在計畫算完那一秒存下去的標注，會永遠不出現（2026-08-21）。
      if (job.status === 'review' && job.planView) {
        try { job.planView.pendingAnnots = pendingAnnotsOf(job, job.planView.rows); } catch (_) {}
      }
      return send(res, 200, { job: publicJob(job, admin) });
    }

    // 句子清單：交給 auto-shot.js 算（--sentences），確保前台看到的句子
    // 跟配圖用的句子是同一套切法。前台的標注頁存的是這裡的 sentence 編號。
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'sentences') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      const sp = jobPath(job.id, 'input', 'script.txt');
      if (!fs.existsSync(sp)) return send(res, 404, { error: '找不到腳本' });
      try {
        const out = execFileSync('node', ['scripts/auto-shot.js', '--sentences', `--script=${sp}`],
          { cwd: ROOT, encoding: 'utf-8', timeout: 20000 });
        return send(res, 200, JSON.parse(out));
      } catch (e) {
        return send(res, 500, { error: '句子切分失敗：' + e.message });
      }
    }

    // 人工標注：哪張圖配在哪一句、框哪裡、要不要滑動
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'annotations') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      const f = jobPath(job.id, 'input', 'annotations.json');
      if (req.method === 'GET') {
        const data = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : { shots: [] };
        return send(res, 200, data);
      }
      if (req.method === 'PUT') {
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        const data = { shots: Array.isArray(body.shots) ? body.shots : [] };
        ensureDir(path.dirname(f));
        fs.writeFileSync(f, JSON.stringify(data, null, 2));
        // ⚠️ 這支正在跑的話，input/ 早就被複製到 public/ 了。
        // auto-shot 是在 run.js 最後才執行，所以現在補寫一份到 public/ 還來得及 ——
        // 這就是「等 HeyGen 的時候順便標注」能生效的關鍵。
        // ⚠️ 只有 'preparing' 才補寫 —— 那代表「這支正佔著 ROOT 在跑」。
        //    'queued' 的還沒開始，它的 input/ 之後會整包複製到 ROOT/public，本來就會帶到；
        //    現在補寫反而會蓋掉別支正在跑的工作。
        if (job.status === 'preparing') {
          fs.writeFileSync(path.join(ROOT, 'public', 'annotations.json'), JSON.stringify(data, null, 2));
        }
        job.annotationCount = data.shots.length;
        saveJob(job);
        // 這支的配圖計畫已經算完了 → 這次存的標注不會進計畫。以前這裡照樣回 ok，
        // 前台顯示「已儲存」，使用者到配圖計畫才發現圖不見（2026-08-21 回報）。
        // 真的沒吃到的那幾筆，buildPlanView 的 pendingAnnots 會讓前台自動補回去。
        const applied = ['queued', 'preparing', 'detached'].includes(job.status);
        return send(res, 200, { ok: true, count: data.shots.length, applied });
      }
    }

    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'log') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      const f = jobPath(job.id, 'log.txt');
      const text = fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : '';
      return send(res, 200, { text });
    }

    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'approve' && req.method === 'POST') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      if (job.status !== 'review') return send(res, 400, { error: '這支工作現在不是待確認狀態' });
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const edits = appendMissingAnnots(job, Array.isArray(body.edits) ? body.edits : []);
      // ⚠️ approvedBy 要在 recordCorrections 之前設好 —— 彙總檔要記「是誰改的」
      job.approvedBy = (body.by || '').trim() || job.owner;
      job.approvedAt = nowISO();
      recordCorrections(job, job.planView, edits);
      learnFromEdits(job, edits);
      job.pendingEdits = edits;
      job.status = 'approved';
      saveJob(job);
      tick();
      return send(res, 200, { job: publicJob(job, admin) });
    }

    // 「標好了就直接出片」：HeyGen 跑完不停在確認關卡，直接接著 render。
    // 這只是一個旗標，doPrepare 是在最後一刻才讀 —— 所以 HeyGen 還在生成的期間
    // 隨時可以改主意（取消勾選、繼續改標注），都還來得及。
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'auto-approve' && req.method === 'POST') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      if (!['queued', 'preparing', 'detached'].includes(job.status))
        return send(res, 400, { error: '這支已經過了準備階段，改不了了' });
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      job.autoApprove = !!body.on;
      saveJob(job);
      return send(res, 200, { job: publicJob(job, admin) });
    }

    // 反悔鍵：已經在排隊等出片 → 退回「等你確認」。
    // 真的開始 render（status 轉 rendering）之後就退不回來了，那時只能取消重跑。
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'unapprove' && req.method === 'POST') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      if (job.status !== 'approved')
        return send(res, 400, { error: '這支現在不是「排隊等出片」，退不回來' });
      if (!job.planView) return send(res, 400, { error: '這支沒有配圖計畫可以確認' });
      job.status = 'review';
      job.autoApprove = false;
      job.pendingEdits = [];
      delete job.approvedAt;
      delete job.approvedBy;
      appendLog(job, '\n↩️ 已退回「等你確認」\n');
      saveJob(job);
      return send(res, 200, { job: publicJob(job, admin) });
    }

    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'cancel' && req.method === 'POST') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      if (['preparing', 'rendering'].includes(job.status))
        return send(res, 400, { error: '正在跑的工作不能取消，請等它結束' });
      job.status = 'cancelled';
      rmrf(jobPath(job.id, 'state'));
      saveJob(job);
      return send(res, 200, { job: publicJob(job, admin) });
    }

    // 刪除整筆工作（含影片、紀錄）。只有本機管理者能刪；正在跑的不給刪。
    // （2026-08-18 使用者要求：列表加刪除，但只有我本機可以、別人不行。）
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[2] && seg.length === 3 && req.method === 'DELETE') {
      if (!isAdmin(req, url)) return send(res, 403, { error: '只有管理者可以刪除工作' });
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      if (['preparing', 'rendering'].includes(job.status))
        return send(res, 400, { error: '正在跑的工作不能刪，請先取消或等它結束' });
      rmrf(STORE.directory(job.id));      // 明確刪除整筆工作（含影片、稿件與製作資料）
      JOBS = JOBS.filter((x) => x.id !== job.id);
      return send(res, 200, { ok: true });
    }

    // 檔案：縮圖 / 截圖 / 成品
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'file') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      const name = path.basename(decodeURIComponent(seg.slice(4).join('/')));
      // ''、'.'、'..' 的 basename 會讓下面的 jobPath 解回「資料夾本身」而不是檔案。
      // 路徑是 basename 過的，跳不出工作目錄，但拿資料夾去開 stream 會炸（見 sendFile）。
      if (!name || name === '.' || name === '..') return send(res, 404, { error: '找不到檔案' });
      // 成品在成品庫，不在 jobs/ 底下（只存一份）
      const arc = (job.outputs || []).find((o) => o.name === name && o.archive);
      if (arc) {
        const f = path.resolve(WORKSPACE_ROOT, arc.archive);
        if (f.startsWith(STORE.directory(job.id) + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile())
          return sendFile(req, res, f, url.searchParams.get('dl') === '1');
      }
      for (const d of ['out', 'thumbs', 'state/public', 'input']) {
        const f = jobPath(job.id, d, name);
        // isFile：上面成品那條跟下面靜態檔那條本來就有，只有這個迴圈漏了。
        if (fs.existsSync(f) && fs.statSync(f).isFile())
          return sendFile(req, res, f, url.searchParams.get('dl') === '1');
      }
      return send(res, 404, { error: '找不到檔案' });
    }

    // 修正紀錄總覽：哪一類最常被改 → 規則庫還缺什麼
    // 只給 Leighly 看（2026-08-17 要求）—— 這是內部檢討用的，同事看了只會困惑
    if (p === '/api/corrections') {
      if (!isAdmin(req, url)) return send(res, 403, { error: '這頁只有管理者看得到' });
      // 來源改成 append-only 彙總檔（90_系統/資料/corrections.jsonl）∪ 還沒進檔的舊 job。
      // 以前只讀 JOBS，工作被刪紀錄就一起消失（2026-08-18 使用者要求改掉）。
      const rows = allCorrections().sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
      const byType = {}, byTag = {};
      let noReason = 0;
      for (const r of rows) {
        byType[r.type] = (byType[r.type] || 0) + 1;
        const tags = (r.reason && r.reason.tags) || [];
        if (!tags.length && !(r.reason && r.reason.note)) noReason += 1;
        for (const t of tags) byTag[t] = (byTag[t] || 0) + 1;
      }
      return send(res, 200, {
        total: rows.length, byType, byTag, noReason,
        logged: fs.existsSync(CORRECTIONS_LOG),
        rows: rows.slice(0, 200),
      });
    }

    // 舊版管理介面相容入口；永久工作資料不再由此刪除
    if (p === '/api/prune' && req.method === 'POST') {
      if (!isAdmin(req, url)) return send(res, 403, { error: '只有管理者可以清理' });
      const freed = pruneOldJobs();
      return send(res, 200, { ok: true, freedMB: Math.round(freed / 1048576) });
    }

    if (p === '/api/unlock' && req.method === 'POST') {
      rmrf(LOCK);
      return send(res, 200, { ok: true });
    }

    // ── 靜態檔 ──
    const file = path.join(WEB_DIR, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
    if (file.startsWith(WEB_DIR) && fs.existsSync(file) && fs.statSync(file).isFile())
      return sendFile(req, res, file);

    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

/**
 * 把一支工作的原始輸入備份至該工作 _製作資料/備份/工作備份/。
 * 2026-09-03 使用者定案：備份 = input/ 全部（heygen.mp4、截圖、script.txt、annotations.json）
 *   + job.json + log.txt；排除 state/、thumbs/、衍生的 *.json。
 * 為什麼不沿用 run.js 的 backupJob()：那支只存 public/heygen.mp4 + script.txt，
 *   截圖與 annotations.json 從來沒被備份過，prune 一刪就沒了（2026-09-02 實際發生：07g0 的 input/ 消失）。
 * input/ 內同名同大小就跳過（prepare 與 render 各會經過一次 .finally，heygen.mp4 不要複製兩次）；
 * job.json / log.txt 很小且會一直變，每次都覆蓋。
 * 寫失敗只寫進 log 警告，絕對不能影響出片。
 * ⚠️ 尚未做保留期限（heygen.mp4 幾天後清掉）—— 使用者還沒定案，先只加不刪。
 */
function backupJobArtifacts(job) {
  if (!job || !job.id) return;
  const src = jobDir(job.id);
  const dst = jobPath(job.id, '備份', '工作備份');
  const copy = (from, to, skipIfSameSize) => {
    if (!fs.existsSync(from)) return;
    if (skipIfSameSize && fs.existsSync(to) && fs.statSync(to).size === fs.statSync(from).size) return;
    ensureDir(path.dirname(to));
    fs.copyFileSync(from, to);
  };
  try {
    const input = jobPath(job.id, 'input');
    copy(jobPath(job.id, 'input', 'script.txt'), path.join(dst, 'input', 'script.txt'), false);
    if (fs.existsSync(input)) {
      for (const n of fs.readdirSync(input)) {
        const f = path.join(input, n);
        if (fs.statSync(f).isFile()) copy(f, path.join(dst, 'input', n), true);
      }
    }
    copy(path.join(src, 'job.json'), path.join(dst, 'job.json'), false);
    copy(path.join(src, 'log.txt'), path.join(dst, 'log.txt'), false);
  } catch (e) {
    try { appendLog(job, `\n⚠️ 工作備份失敗（不影響出片）：${e.message}\n`); } catch (_) {}
  }
}

/**
 * 舊清理入口保留，但不刪除永久工作資料。
 * 回傳釋出的位元組數。啟動時與每支工作跑完後都會呼叫。
 */
function pruneOldJobs() {
  // 工作紀錄是永久資料；不依時間、狀態或缺片清理輸入、影片與快照。
  // 暫存清理需另設明確範圍，目前此舊入口保留為無副作用操作。
  return 0;
}


// 連 port 都還沒開就掛掉的情況，要講人話。
// 最常見的是「上一個伺服器忘了關」—— 丟一坨 stack trace 沒有任何幫助
//（2026-08-17 使用者實際遇到）。
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  ❌ Port ${PORT} 已經有人在用了 —— 多半是上一個伺服器還開著。`);
    console.error('');
    console.error('     先把舊的關掉，再重開：');
    console.error(`       lsof -ti:${PORT} | xargs kill`);
    console.error('       npm run studio');
    console.error('');
    console.error('     裝成背景服務的話改用：');
    console.error('       launchctl kickstart -k gui/$(id -u)/com.cmoney.marketing-video-studio');
    console.error('');
  } else {
    console.error('\n  ❌ 伺服器啟動失敗：' + e.message + '\n');
  }
  process.exit(1);
});

// 關掉伺服器時講清楚：正在跑的那支不會被殺掉，也不會浪費 HeyGen 點數。
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (busy) {
      console.log('');
      console.log('  ⚠️  有工作正在跑 —— 它會繼續在背景完成，HeyGen 點數不會浪費。');
      console.log('     重開後那支會顯示「背景執行中」，跑完會告訴你怎麼接回。');
    }
    console.log('\n  伺服器已關閉\n');
    process.exit(0);
  });
}

server.listen(PORT, HOST, () => {
  pruneOldJobs();
  const ip = lanIP();
  console.log('');
  console.log('  🎬  出片前台已啟動');
  console.log('  ─────────────────────────────────');
  console.log(`  你自己：   http://localhost:${PORT}`);
  console.log(`  同事連：   http://${ip}:${PORT}`);
  console.log('');
  console.log(`  工作資料夾：${path.relative(process.cwd(), JOBS_DIR)}/  （${JOBS.length} 筆，${(dirSize(JOBS_DIR) / 1048576).toFixed(0)} MB）`);
  console.log('  工作保留：  影片、稿件、素材與快照不會依日期自動清除');
  console.log(`  成品庫：    ${path.relative(process.cwd(), ARCHIVE_DIR)}/  （不會自動清，這份要自己管）`);
  console.log('  按 Ctrl+C 結束');
  console.log('');
  tick();
});

module.exports = server;
