#!/usr/bin/env node
/**
 * 通用「APP 截圖分析」：把 public/ 裡的 image*.png 全部跑一次 OCR，辨識出
 *   ① 這是哪一頁（籌碼日報／法人／主力／大戶／大盤／K線／焦點股清單／營收／資券…）
 *   ② 是哪一檔股票（股名＋代號）
 *   ③ 整頁逐字框（含座標），供之後「框某個數字／局部放大」的效果使用
 * 結果寫到 src/app-images.generated.json。
 *
 * 跟三大法人的 analyze-institution-image.js 分工：
 *   - 三大法人 = 固定版面資訊圖 → 用①②③④編號推區塊帶
 *   - 這支     = 變動版面 APP 截圖 → 用「錨點文字」判頁面、用裁切單行辨識股名
 *
 * 重點技巧（2026-08-12 實測）：股名在頂部是大字美術字，整頁 OCR 只認得出「健」認不出「鼎」；
 * 改成「裁出股名區塊 + --psm 7（單行模式）」就能穩定讀出「健鼎」「金居」。
 *
 * OCR：走 scripts/ocr-engine.js（2026-09-08 起）。預設 tesseract（brew install tesseract tesseract-lang），
 *      .env 設 OCR_ENGINE=vision 改用 Apple Vision；這支只呼叫 ocrPage()/ocrCrop()，不直接碰引擎。
 * 用法：node scripts/analyze-app-images.js   （run.js 會在生成 HeyGen 時平行呼叫）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { workspaceRoot } = require('../../paths');
const ROOT = path.resolve(__dirname, '..');
// 讓 PAGE_RULES 等開關在單獨執行時也讀得到 .env（run.js 已載過，重複載無害、不覆蓋既有值）
try { require('dotenv').config({ path: path.join(workspaceRoot(ROOT), '.env'), quiet: true }); } catch (_) {}
const OCR = require('./ocr-engine'); // OCR_ENGINE 開關在這個模組裡讀
const PUBLIC_DIR = path.join(ROOT, 'public');
const OUT_PATH = path.join(ROOT, 'src', 'app-images.generated.json');

// 頁面特徵：OCR 全文包含這些關鍵字 → 判定為該頁（越前面越優先）
const PAGE_SIGNATURES_V1 = [
  { page: 'chip-daily', label: '籌碼日報', all: ['統計', '天數'] },
  { page: 'big-holder', label: '大戶', all: ['大戶持股'] },
  { page: 'margin', label: '資券', all: ['融資餘額'] },
  { page: 'revenue', label: '營收', all: ['月營收'] },
  { page: 'legal-person', label: '法人', all: ['八大行庫'] },
  { page: 'main-force', label: '主力', all: ['買賣家數差'] },
  { page: 'market', label: '大盤', all: ['加權指數', '櫃買指數'] },
  { page: 'focus-list', label: '焦點股清單', all: ['持股變動'] },
  // 焦點股「排行榜」：左側是篩選條件（噴發向上／短線籌碼集中／大戶買散戶賣／主力連買／
  // 外資連買／投信連買／Top1券商買超異常），右側是 股票｜周成交量｜股價｜漲跌幅
  //（2026-08-13 新增，素材：Image_20260810_135408_598）
  { page: 'focus-rank', label: '焦點股排行', all: ['周成交量'] },
  { page: 'focus-rank', label: '焦點股排行', all: ['排行', '漲跌幅'] },
  // 個股「即時／五檔」頁：上半分時走勢圖，下半內外盤比＋委買量/買價/賣價/委賣量五檔，
  // 最下面 單量/估量、總量/量增(量縮)、振幅/高低價差
  //（2026-08-13 新增，素材：南亞科 2408／華邦電 2344／友達 2409／群創 3481）
  { page: 'realtime', label: '個股即時五檔', all: ['委買量'] },
  { page: 'realtime', label: '個股即時五檔', all: ['買價', '賣價'] },
  // 產業／族群頁：欄位是「股票 股價 走勢 產業」（2026-08-12 使用者的材料／散熱／PCB 三張）
  { page: 'industry-list', label: '族群清單', all: ['股票', '走勢'] },
  { page: 'kline', label: 'K線', all: ['乖離率'] },
];

/**
 * PAGE_RULES=v2（.env 開關，預設 v1 = 上面那份，一個字都沒改）
 * 2026-09-03 依 90_系統/資料/page-samples/page-types.json（26 型，人確認過）重寫。
 * 比對規則多了 none：全文含任一個就排除。
 *
 * 修掉的兩個舊 bug：
 *   market  ── 舊規則「加權指數+櫃買指數」太泛，會吃到指數K線頁與三大法人速覽圖 → 加「台指期貨」必要條件
 *   focus-rank ── 舊第二條「排行+漲跌幅」會吃到加權貢獻排行 → 拿掉，只留「周成交量」
 * 新增 14 型（key 對應 page-types.json 的 legacyKey）：
 *   realtime-trend 個股即時（大戶散戶 tab）—— 2026-09 最常截，21 張全 unknown 的主因
 *   index-kline 指數K線 ／ contrib-rank 加權貢獻排行 ／ us-kline 美股個股K線 ／ watchlist 自選股清單
 *   bull-bear 多空 ／ target-price 法人目標 ／ earnings 獲利
 *   industry-live 大盤產業即時 ／ us-markets 大盤美股行情
 *   portfolio-institutions 庫存三大法人 ／ portfolio-main-force 庫存主力籌碼 ／ portfolio-news 庫存新聞
 *   infographic-institution 三大法人速覽圖（自製圖）
 * 順序 = 優先序：越專一的越前面，泛的（industry-list 的「股票+走勢」）放最後。
 */
const PAGE_SIGNATURES_V2 = [
  // ── 個股詳情頁的各 tab（共同標頭：總量／估量／屬性）──
  { page: 'chip-daily',     label: '籌碼日報',       all: ['統計天數'] },
  { page: 'big-holder',     label: '大戶',           all: ['大戶持股'] },
  { page: 'margin',         label: '資券',           all: ['融資餘額'] },
  { page: 'revenue',        label: '營收',           all: ['月營收'] },
  { page: 'legal-person',   label: '法人',           all: ['八大行庫'] },
  { page: 'main-force',     label: '主力',           all: ['買賣家數差'] },
  { page: 'bull-bear',      label: '多空',           all: ['多方', '空方', '符合'] },
  { page: 'target-price',   label: '法人目標',       all: ['目標價', '潛在報酬'] },
  { page: 'earnings',       label: '獲利',           all: ['EPS'], none: ['目標價'] },
  { page: 'realtime',       label: '個股即時五檔',   all: ['委買量'] },
  { page: 'realtime',       label: '個股即時五檔',   all: ['買價', '賣價'] },
  { page: 'realtime-trend', label: '個股即時走勢',   all: ['大戶累積買超'] },
  { page: 'kline',          label: 'K線',            all: ['乖離率'] },
  // 兜底：有個股共同標頭（總量／屬性）但上面沒一個 tab 對到（討論／新聞／健檢／產業鏈…或 OCR 沒讀到下半）。
  // 排在所有個股 tab 之後。歸到個股至少能讀股名、memKey 也不會掉進 unknown-* 大雜燴。
  { page: 'stock-other',    label: '個股（其他分頁）', all: ['總量', '屬性'] },
  { page: 'stock-other',    label: '個股（其他分頁）', all: ['總量', '估量'] },   // 「屬性」有時被 OCR 讀成「蟨性」，改抓同一列的「估量」
  { page: 'stock-other',    label: '個股（其他分頁）', all: ['總量', '蟨性'] },
  // ── 庫存股（底部導覽）──
  { page: 'portfolio-institutions', label: '庫存三大法人', all: ['庫存股', '今日合計'] },
  { page: 'portfolio-main-force',   label: '庫存主力籌碼', all: ['庫存股', '買賣超', '佔比'] },   // 「成交量佔比」OCR 讀成「或交量佔比」，改抓同一列的「買賣超」+「佔比」
  { page: 'portfolio-news',         label: '庫存事件新聞', all: ['今日頭條'] },
  // ── 大盤（底部導覽）──
  { page: 'market',         label: '大盤',           all: ['加權指數', '櫃買指數', '台指期貨'] },
  { page: 'industry-live',  label: '大盤產業即時',   all: ['產業排行'] },
  { page: 'us-markets',     label: '大盤美股行情',   all: ['那斯達克'], none: ['證交所'] },
  // ── 指數詳情頁（點進加權／櫃買）──
  { page: 'contrib-rank',   label: '加權貢獻排行',   all: ['貢獻排行', '股票', '漲跌幅'], none: ['開高低收'] },
  // 不能用「單量」（OCR 常讀成「單二量」）也不能用「開高低收」（圖上是 開45157 高45878…被數字隔開）。
  // 用「指數名 + 成交量」：K線頁下方一定有成交量副圖標籤；貢獻排行頁沒有成交量、且有「股票」→ 排除；
  // 三磚頁有「台指期貨」→ 排除；個股頁有「屬性」→ 排除。
  { page: 'index-kline',    label: '指數K線',        all: ['加權指數', '成交量'], none: ['台指期貨', '股票', '屬性', '蟨性'] },
  { page: 'index-kline',    label: '指數K線',        all: ['櫃買指數', '成交量'], none: ['台指期貨', '股票', '屬性', '蟨性'] },
  // ── 其他 ──
  { page: 'infographic-institution', label: '三大法人速覽圖', all: ['三大法人', '數據速覽'] },
  { page: 'us-kline',       label: '美股個股K線',    all: ['證交所'] },
  { page: 'watchlist',      label: '自選股清單',     all: ['自選股清單'] },
  { page: 'focus-list',     label: '焦點股清單',     all: ['持股變動'] },
  { page: 'focus-rank',     label: '焦點股排行',     all: ['周成交量'] },
  { page: 'industry-list',  label: '族群清單',       all: ['股票', '走勢'], none: ['自選股清單', '貢獻排行'] },
];
const PAGE_RULES = (process.env.PAGE_RULES || 'v1').toLowerCase();
const PAGE_SIGNATURES = PAGE_RULES === 'v2' ? PAGE_SIGNATURES_V2 : PAGE_SIGNATURES_V1;

// 個股頁（有股名＋代號、配對時門檻要高）vs 清單/排行頁（沒有股名，只能靠關鍵字）
const STOCK_PAGES = ['chip-daily', 'big-holder', 'margin', 'revenue', 'legal-person', 'main-force', 'kline', 'realtime']
  .concat(PAGE_RULES === 'v2' ? ['realtime-trend', 'bull-bear', 'target-price', 'earnings', 'stock-other'] : []);

// 名稱沿用；實際檢查哪個引擎由 ocr-engine.js 決定（tesseract 在不在／Vision 二進位編好沒）
function ensureTesseract() {
  OCR.ensure();
}

/**
 * 讀圖片尺寸。PNG 讀 IHDR、JPEG 讀 SOF 標記（純 JS，不依賴外部工具）。
 * 都失敗才退回 ffprobe。
 * ⚠️ 一定要讀得到尺寸，否則聚焦效果算不出縮放比例、整個失效
 *（2026-08-12 踩到：使用者的截圖是 .jpeg，原本只支援 PNG 而全部回 null）。
 */
function imageSize(file) {
  const buf = fs.readFileSync(file);
  // PNG
  if (buf.length > 24 && buf.toString('ascii', 12, 16) === 'IHDR') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG：掃 SOF0~SOF15（略過 SOF4/SOF8/SOF12 這些非影格標記）
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      const isSOF =
        marker >= 0xc0 && marker <= 0xcf &&
        marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  // 退路：ffprobe（流程本來就依賴 ffmpeg）
  try {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file],
      { encoding: 'utf-8' }
    ).trim();
    const m = /^(\d+)x(\d+)/.exec(out);
    if (m) return { width: +m[1], height: +m[2] };
  } catch (_) {}
  return null;
}

/** 整頁 OCR → 逐字框 + 以行為單位的文字（實作在 ocr-engine.js，tesseract 版原碼原封搬過去） */
function ocrPage(imagePath) {
  return OCR.ocrPage(imagePath); // { words:[{t,x,y,w,h,c}], lines:[{text,x,y,...}] }，信心 <30 已濾掉
}

/**
 * 裁切一塊區域、放大 N 倍後用單行模式 OCR（整頁 OCR 讀不好大字美術字／小字灰字）。
 * 實作在 ocr-engine.js。extraArgs 是 tesseract 參數（-l／白名單），Vision 引擎會忽略它。
 */
function ocrCrop(imagePath, box, scale, extraArgs) {
  return OCR.ocrCrop(imagePath, box, scale, extraArgs);
}

/**
 * 裁出頂部股名列辨識。
 * ⚠️ 放大倍率很關鍵：同一張圖 ×3 讀成「華邦埋」、×4 讀成「華邦雷」、×6 才讀對「華邦電」
 *（2026-08-13 實測）。所以依序試 6→4→3，取第一個「像股名」的結果。
 */
function readStockName(imagePath, size) {
  if (!size) return null;
  const { width: W, height: H } = size;
  const box = [
    Math.round(W * 0.31), Math.round(H * 0.049),
    Math.round(W * 0.68), Math.round(H * 0.088),
  ];
  const cands = [];
  for (const scale of [6, 4, 3]) {
    const out = ocrCrop(imagePath, box, scale, ['-l', 'chi_tra']);
    let name = out.replace(/[^一-鿿\-A-Za-z]/g, '');
    name = name.replace(/^[QO]+/, ''); // 搜尋放大鏡圖示常被讀成 Q/O
    // 防呆：清單頁沒有股名，硬讀會得到亂碼（例「人ri一一上er基」）。
    // 合理股名 = 2~5 個中文字，可帶 -KY / -DR 後綴；夾雜其他英文字母就判定不是股名。
    const m = name.match(/^([一-鿿]{2,5})(-KY|-DR)?$/);
    if (m && !cands.includes(m[0])) cands.push(m[0]);
  }
  return cands;
}

/**
 * 股名的所有可能寫法：三種倍率的結果 ＋ 它們的「後綴」。
 *
 * 為什麼要後綴：股名左邊的搜尋圖示／箭頭常被吃成一個中文字黏在前面
 *（2026-08-17 實際踩到：友達 → 性友達，導致那張圖整支影片沒被用到）。
 * 但「砍掉第一個字」不能無條件做 —— 南亞科被讀成「亞科」時砍了就錯得更離譜。
 * 所以這裡不做選擇，把所有可能都留著，交給 auto-shot 拿腳本去對：
 * 腳本裡有出現的那個才是真的。腳本是唯一的事實來源。
 */
function nameAlternatives(cands) {
  const set = new Set();
  for (const c of cands) {
    set.add(c);
    for (let i = 1; i <= c.length - 2; i++) set.add(c.slice(i)); // 去掉左邊 i 個字
  }
  return [...set].sort((a, b) => b.length - a.length);
}

/**
 * 股票代號。先用整頁 OCR 找頂部的 4 位數（最準）；
 * 找不到再裁「股名下方那一列」用單行數字模式讀（灰色小字，整頁 OCR 常整個漏掉：
 * 2026-08-13 素材裡 友達 2409／群創 3481 都漏了）。
 * ⚠️ 這一塊對「裁切邊界」極度敏感：y 從 0.088 起裁會把 3481 讀成 3487（差 1 個 pixel 就變）。
 *   所以①裁寬一點（0.086~0.117）②三種倍率各跑一次取多數決。單跑一次不可靠。
 */
function readStockCode(imagePath, words, size) {
  if (!size) return null;
  const top = words
    .filter((w) => /^\d{4}$/.test(w.t) && w.y < size.height * 0.12 && w.c > 50)
    .sort((a, b) => a.y - b.y);
  if (top.length) return top[0].t;
  const { width: W, height: H } = size;
  // 2026-09-08 新增的中間一關：新版個股頁（realtime-trend／stock-other 那批）代號跟股名同一列
  //（「欣興 3037」，y≈4~7%），下面那條 0.086~0.117 的舊位置讀到的是「總量 31697」→ 前四碼變 3169，
  // 而且三種倍率會一致地錯 → 多數決擋不住。所以先裁「股名列」找「緊跟在中文後面的 4 位數」；
  // 舊版面股名列沒有數字 → 這關讀不到東西 → 照舊往下走，行為不變。
  // （tesseract 在整頁那關通常就抓到了、很少走到這裡；Vision 對這列偶爾整行沒讀出來，才靠這關。）
  {
    const nameRow = [
      Math.round(W * 0.28), Math.round(H * 0.030),
      Math.round(W * 0.72), Math.round(H * 0.082),
    ];
    const votes = new Map();
    for (const scale of [4, 3, 6]) {
      const txt = ocrCrop(imagePath, nameRow, scale, ['-l', 'chi_tra']);
      const m = txt.match(/[一-鿿\-A-Za-z]\s*(\d{4})(?!\d)/); // 中文／-KY 後面的 4 位數，排除 5 位以上的量
      if (!m) continue;
      votes.set(m[1], (votes.get(m[1]) || 0) + 1);
    }
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= 2) return best[0];
  }
  const box = [
    Math.round(W * 0.33), Math.round(H * 0.086),
    Math.round(W * 0.66), Math.round(H * 0.117),
  ];
  const votes = new Map();
  for (const scale of [6, 4, 8]) {
    const digits = ocrCrop(imagePath, box, scale, [
      '-l', 'eng', '-c', 'tessedit_char_whitelist=0123456789',
    ]).replace(/\D/g, '');
    if (digits.length < 4) continue;
    const c = digits.slice(0, 4); // 尾巴常多讀到旁邊的字（2344 → 23440）
    votes.set(c, (votes.get(c) || 0) + 1);
  }
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 2 ? best[0] : null; // 至少兩種倍率讀到一樣才採用
}

/**
 * 排行頁左側「被選取」的那一條篩選（噴發向上／主力連買／外資連買…）。
 * 選取中的那格是淺底深字，其餘是深底淺字 —— 用「亮度」找，不靠 OCR 認反白樣式。
 * 這是排行頁的「主題」：同一支影片可能放好幾張排行頁，沒有主題就會全部配到同一張
 *（跟族群頁踩過的坑一樣）。
 */
function detectSelectedSidebar(imagePath, size, words) {
  if (!size) return null;
  const { width: W, height: H } = size;
  const x0 = 0, x1 = Math.round(W * 0.17);
  const y0 = Math.round(H * 0.14), y1 = Math.round(H * 0.75);
  const BANDS = 64;
  let gray;
  try {
    gray = execFileSync('ffmpeg', [
      '-y', '-loglevel', 'quiet', '-i', imagePath,
      '-vf', `crop=${x1 - x0}:${y1 - y0}:${x0}:${y0},scale=1:${BANDS}`,
      '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
    ], { encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return null;
  }
  if (!gray || gray.length < BANDS) return null;
  let bi = 0;
  for (let i = 1; i < BANDS; i++) if (gray[i] > gray[bi]) bi = i;
  const median = [...gray.slice(0, BANDS)].sort((a, b) => a - b)[BANDS >> 1];
  if (gray[bi] < median + 25) return null; // 沒有明顯反白 → 放棄，不要瞎猜
  const bandH = (y1 - y0) / BANDS;
  const cy = y0 + (bi + 0.5) * bandH;
  // 取這一格裡的字（同一格是兩行，例「噴發 / 向上」，所以範圍要抓夠高）
  const inCell = words.filter(
    (w) => w.x < W * 0.17 && Math.abs(w.y + w.h / 2 - cy) < bandH * 4 && w.c > 40
  );
  if (!inCell.length) return null;
  const sorted = inCell.sort((a, b) => a.y - b.y || a.x - b.x);
  const topic = sorted.map((w) => w.t).join('');
  if (topic.length < 2) return null;
  return {
    topic,
    terms: sorted.map((w) => w.t),
    box: {
      x: Math.min(...inCell.map((w) => w.x)),
      y: Math.min(...inCell.map((w) => w.y)),
      w: Math.max(...inCell.map((w) => w.x + w.w)) - Math.min(...inCell.map((w) => w.x)),
      h: Math.max(...inCell.map((w) => w.y + w.h)) - Math.min(...inCell.map((w) => w.y)),
    },
  };
}

// 族群／清單頁沒有股名，但有「主題」（材料、散熱、PCB…）。
// 三張族群頁長得幾乎一樣，只有主題不同 —— 不抓出來就會全部配到同一張
// （2026-08-12 實際踩到）。用常見產業詞彙在頁面上半部找。
const INDUSTRY_TERMS = [
  'PCB', 'CPO', 'ABF', 'IC載板', '載板', '散熱', '材料', '矽光子', '半導體', '晶圓',
  '光電', '被動元件', '記憶體', '伺服器', '網通', '軍工', '機器人', '重電', '電源',
  '生技', '金融', '航運', '鋼鐵', '汽車', '綠能', '面板', '砷化鎵', '低軌衛星',
];
function detectTopic(words, size) {
  if (!size) return null;
  const top = words.filter((w) => w.y > size.height * 0.03 && w.y < size.height * 0.3 && w.c > 45);
  for (const t of INDUSTRY_TERMS) {
    const hit = top.find((w) => w.t.includes(t));
    // 同時回傳位置：找不到更具體的目標時，就框這個頁面標題
    //（使用者定案：「找不到更具體的目標就顯示標題吧，像是 PCB族群頁 / 材料族群頁」）
    if (!hit) continue;
    // OCR 常把標題拆開（例「PCB-」「製」「造」三個框），只框第一段會很怪。
    // 從命中的字往左右擴，把同一列、間距很小的相鄰字併成「整條標題」
    //（2026-08-12 使用者：「要圈就乾脆整個標題圈起來」）。
    const sameRow = top
      .filter((w) => Math.abs(w.y + w.h / 2 - (hit.y + hit.h / 2)) < hit.h * 0.8)
      .sort((a, b) => a.x - b.x);
    const GAP = Math.max(hit.h * 1.2, size.width * 0.03); // 容許的字間距
    const group = [hit];
    // 往右
    let right = hit;
    for (const w of sameRow) {
      if (w.x <= right.x) continue;
      if (w.x - (right.x + right.w) > GAP) break;
      group.push(w);
      right = w;
    }
    // 往左
    let left = hit;
    for (let i = sameRow.length - 1; i >= 0; i--) {
      const w = sameRow[i];
      if (w.x >= left.x) continue;
      if (left.x - (w.x + w.w) > GAP) break;
      group.push(w);
      left = w;
    }
    const x0 = Math.min(...group.map((w) => w.x));
    const x1 = Math.max(...group.map((w) => w.x + w.w));
    const y0 = Math.min(...group.map((w) => w.y));
    const y1 = Math.max(...group.map((w) => w.y + w.h));
    return { topic: t, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
  }
  return null;
}

function detectPage(fullText) {
  for (const sig of PAGE_SIGNATURES) {
    if (!sig.all.every((k) => fullText.includes(k))) continue;
    if ((sig.none || []).some((k) => fullText.includes(k))) continue; // v2 才有 none；v1 沒這欄，行為不變
    return sig;
  }
  return null;
}

// ── 主流程 ──
ensureTesseract();
if (!fs.existsSync(PUBLIC_DIR)) {
  console.error('❌ 找不到 public/');
  process.exit(1);
}
// 使用者的截圖檔名不一定叫 image1.png（實際遇到 1000090084.jpeg 這種相機命名），
// 所以改用「排除法」：public 裡的圖檔，只要不是套版素材就當成要分析的截圖。
const TEMPLATE_ASSET = /^(dapan|focusstock|institution|midday)-|^(frame|logo)\.png$|^NotoSans/i;
const files = fs
  .readdirSync(PUBLIC_DIR)
  .filter((f) => /\.(png|jpg|jpeg)$/i.test(f) && !TEMPLATE_ASSET.test(f))
  .sort();

if (files.length === 0) {
  console.log('ℹ️ public/ 沒有 image*.png，略過 APP 截圖分析');
  fs.writeFileSync(OUT_PATH, JSON.stringify({ images: [] }, null, 2));
  process.exit(0);
}

const results = [];
for (const f of files) {
  const p = path.join(PUBLIC_DIR, f);
  const size = imageSize(p);
  const { words, lines } = ocrPage(p);
  const fullText = lines.map((l) => l.text).join(' ');
  const sig = detectPage(fullText);
  const NON_STOCK_PAGES = ['focus-list', 'market', 'industry-list', 'focus-rank']
    .concat(PAGE_RULES === 'v2' ? ['index-kline', 'contrib-rank', 'us-kline', 'watchlist', 'industry-live', 'us-markets',
      'portfolio-institutions', 'portfolio-main-force', 'portfolio-news', 'infographic-institution'] : []);
  const nameCands = sig && NON_STOCK_PAGES.includes(sig.page) ? [] : readStockName(p, size);
  const name = nameCands[0] || null;              // 主要股名＝最高倍率讀到的
  const nameAlts = nameAlternatives(nameCands);   // 所有可能（含去掉左邊雜字的版本）
  // 只有「族群／清單」頁才有主題。大盤頁頂部常有廣告橫幅（例：CPO量產…），
  // 不限制的話會誤抓成主題（2026-08-12 踩到）。
  const TOPIC_PAGES = ['industry-list', 'focus-list'];
  // 排行頁的主題＝左側被選取的那條篩選（噴發向上…），用亮度找，不在 INDUSTRY_TERMS 裡
  const topicHit =
    sig && sig.page === 'focus-rank'
      ? detectSelectedSidebar(p, size, words)
      : sig && TOPIC_PAGES.includes(sig.page)
      ? detectTopic(words, size)
      : null;
  const topic = topicHit ? topicHit.topic : null;
  // 主題可能被 OCR 夾雜雜字（「噴發向上」讀成「噴發還向上」），整串比對會失敗。
  // 另外存「詞」的清單，比對時任一個詞命中就算。
  const topicTerms = topicHit
    ? [...new Set((topicHit.terms || [topicHit.topic]).filter((t) => t && t.length >= 2))]
    : null;
  // 標題框：清單頁用族群名；個股頁用「股名那一列」。
  // 找不到更具體的目標時就框這裡，比硬框某個欄位合理
  //（2026-08-12 使用者：「金居則是籌碼訊號值得關注」是鋪陳句，圈融資餘額欄很奇怪）。
  let topicBox = topicHit ? topicHit.box : null;
  // 個股頁一律要有標題框：就算 OCR 讀不出股名，也用股名列的固定比例位置。
  //（2026-08-13 踩到：華邦電那張股名讀失敗 → topicBox=null → 連「退而框標題」都沒有，
  //   整張圖直接不會出現。）
  // ⚠️ 未知頁面（規則庫還沒收錄的新頁型）也一樣要給標題框 —— 使用者要求
  //   「未知頁面也要 OCR 辨識處理」。有標題框，findCell 至少能退到「框標題＋往下滑」，
  //   不會因為認不出頁型就整張圖消失。
  if (!topicBox && size && (!sig || !NON_STOCK_PAGES.includes(sig.page))) {
    const hit = name && words.find((w) => w.t.includes(name) && w.y < size.height * 0.15);
    topicBox = hit
      ? { x: hit.x, y: hit.y, w: hit.w, h: hit.h }
      : {
          // OCR 讀不到股名時，用股名列的固定比例位置（跟裁切辨識用的同一塊）
          x: Math.round(size.width * 0.31),
          y: Math.round(size.height * 0.049),
          w: Math.round(size.width * 0.37),
          h: Math.round(size.height * 0.039),
        };
  }
  const code = readStockCode(p, words, size);
  results.push({
    file: f,
    width: size ? size.width : null,
    height: size ? size.height : null,
    page: sig ? sig.page : 'unknown',
    pageLabel: sig ? sig.label : '未知頁面',
    // 未知頁面若讀得到股名，就當個股頁看待（門檻 13，不會被一句「漲停」亂配）
    isStockPage: sig ? STOCK_PAGES.includes(sig.page) : !!name,
    stockName: name,
    stockNameAlts: nameAlts,
    stockCode: code,
    topic,
    topicTerms,
    topicBox,
    words,
  });
  console.log(
    `  ${f}：${sig ? sig.label : '（未知頁面．仍會用股名/代號/數字配對，並可框標題）'}` +
      (name ? ` ・ ${name}${code ? '(' + code + ')' : ''}` : topic ? ` ・ 主題「${topic}」` : ' ・（非個股頁）') +
      ` ・ OCR ${words.length} 字框`
  );
}

fs.writeFileSync(OUT_PATH, JSON.stringify({ images: results }, null, 2));
console.log(`\n✅ APP 截圖分析完成：${results.length} 張 → ${path.relative(ROOT, OUT_PATH)}`);
