/**
 * OCR 引擎切換層（2026-09-08）—— 三支分析腳本唯一的 OCR 入口。
 *
 * 為什麼要有這一層：analyze-app-images.js／analyze-institution-image.js／app-locator.js
 * 原本各自直接呼叫 tesseract CLI（共 8 個呼叫點）。要換引擎就得三支各改一次，
 * 而且很容易改得不一致。現在三支都只呼叫這裡的 ocrPage()／ocrCrop()，
 * 回傳格式跟原本 tesseract 版一模一樣，上層辨識邏輯一行都不用動。
 *
 * ── 開關（.env）─────────────────────────────────────────────────────
 *   OCR_ENGINE 沒設         → tesseract（＝2026-09-08 以前的行為，逐位元相同）
 *   OCR_ENGINE=vision       → Apple Vision（macOS 內建；第一次自動 swiftc 編譯 scripts/ocr-vision.swift）
 *
 *   評估報告：90_系統/研究參考/OCR引擎評估-Vision對照Tesseract.md（讀字 2.1×、IoU 0.210→0.371）
 *   ⚠️ 切到 vision 前記憶庫（90_系統/資料/shot-memory.json）要用新引擎重學 —— 見 90_系統/維護說明/OCR與配圖設定.md。
 *
 * ── 回傳格式（兩個引擎完全一致，座標一律「左上角原點、像素」）────────
 *   ocrPage(img)  → { words:[{t,x,y,w,h,c}], lines:[{text,x,y,w,h,c,words}] }
 *                    words = 「詞」粒度（tesseract 原生就是詞；Vision 在 Swift 端用
 *                    shot-memory.js mergeRuns() 同一套規則把逐字併成詞 —— findCell() 對每個
 *                    字框做 parseFloat，逐字會讓 "524.0" 變成 5,2,4,0，數字比對整個失效）
 *                    c = 信心 0~100（tesseract 原生；Vision 三級 30/50/100 在 JS 端對映成 45/75/100，見 vision.ocrPage）
 *   ocrCrop(img, box, scale, tessArgs) → string（裁切放大後的單行辨識文字）
 *
 * ── VLM 插槽（尚未實作，先把位置與契約留好）─────────────────────────
 *   之前討論過未來走「VLM + OCR」：OCR 負責「字在哪」（座標、逐字框），VLM 負責「這是哪一頁、
 *   這句旁白在講圖上哪一格」（語意）。兩件事的介面不同，所以 VLM **不是**第三個 ocrPage 引擎，
 *   而是疊在 OCR 結果之上的一層：
 *     describe(img, ocrResult) → { page?, stock?, cells?:[{text,x,y,w,h,why}] }
 *   接法：ENGINES 表加 `vlm` 條目只實作 describe()，ocrPage/ocrCrop 仍委派給 tesseract 或 vision；
 *   開關可以是 OCR_ENGINE=vision+vlm。⚠️ 附錄 A 那個教訓要帶著：VLM 會在錯的圖上畫出漂亮的框而不舉手，
 *   「圖文一致性驗算」（數字比對）要留在 OCR 這一側，不能全交給 VLM。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { workspaceRoot } = require('../../paths');
const ROOT = path.resolve(__dirname, '..');
// 單獨執行分析腳本時也要讀得到 .env（run.js 已載過的話重複載無害、不覆蓋既有值）
try { require('dotenv').config({ path: path.join(workspaceRoot(ROOT), '.env'), quiet: true }); } catch (_) {}

const ENGINE = (process.env.OCR_ENGINE || 'tesseract').toLowerCase();

// ─────────────────────────────────────────────────────────────────────
// 共用：ffmpeg 裁切＋放大（兩個引擎的 ocrCrop 都用；run.js 本來就依賴 ffmpeg）
// ─────────────────────────────────────────────────────────────────────
function cropUpscale(imagePath, box, scale, outPath) {
  const cw = box[2] - box[0];
  const ch = box[3] - box[1];
  execFileSync('ffmpeg', [
    '-y', '-i', imagePath,
    '-vf', `crop=${cw}:${ch}:${box[0]}:${box[1]},scale=${cw * scale}:${ch * scale}:flags=lanczos`,
    outPath,
  ], { stdio: 'ignore' });
}

/** 把逐字 words 依 tesseract 的 block-par-line key 分組成 lines（tesseract 專用） */
function groupTesseractLines(groups) {
  const lines = [];
  for (const ws of groups.values()) {
    ws.sort((a, b) => a.x - b.x);
    const x0 = Math.min(...ws.map((w) => w.x));
    const y0 = Math.min(...ws.map((w) => w.y));
    const x1 = Math.max(...ws.map((w) => w.x + w.w));
    const y1 = Math.max(...ws.map((w) => w.y + w.h));
    lines.push({
      text: ws.map((w) => w.t).join(''),
      words: ws,
      x: x0, y: y0, w: x1 - x0, h: y1 - y0,
      c: Math.min(...ws.map((w) => w.c)),
    });
  }
  return lines;
}

// ─────────────────────────────────────────────────────────────────────
// 引擎一：tesseract（原本三支腳本裡的程式碼原封搬過來，行為不變）
// ─────────────────────────────────────────────────────────────────────
const tesseract = {
  name: 'tesseract',

  ensure() {
    try {
      execFileSync('tesseract', ['--version'], { stdio: 'ignore' });
    } catch (e) {
      throw new Error('找不到 tesseract。Mac 請先安裝：brew install tesseract tesseract-lang');
    }
  },

  /**
   * opts.lang     預設 chi_tra
   * opts.minConf  預設 30（analyze-app-images／app-locator 原本的門檻）；
   *               傳 null 表示不過濾（analyze-institution-image 原本沒過濾、NaN→0）
   * opts.stderr   'ignore'（預設）或 'inherit'（institution 原本讓錯誤印出來）
   */
  ocrPage(imagePath, opts = {}) {
    const lang = opts.lang || 'chi_tra';
    const minConf = opts.minConf === undefined ? 30 : opts.minConf;
    const base = path.join(os.tmpdir(), 'ocr_' + process.pid + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
    try {
      execFileSync('tesseract', [imagePath, base, '-l', lang, 'tsv'], {
        stdio: ['ignore', 'ignore', opts.stderr || 'ignore'],
      });
      const tsv = fs.readFileSync(base + '.tsv', 'utf-8');
      const words = [];
      const groups = new Map();
      for (const line of tsv.split('\n').slice(1)) {
        const c = line.split('\t');
        if (c.length < 12) continue;
        const conf = parseFloat(c[10]);
        const t = (c[11] || '').replace(/\s+/g, '');
        if (!t) continue;
        if (minConf !== null && (isNaN(conf) || conf < minConf)) continue;
        const w = {
          t,
          x: parseInt(c[6], 10),
          y: parseInt(c[7], 10),
          w: parseInt(c[8], 10),
          h: parseInt(c[9], 10),
          c: Math.round(isNaN(conf) ? 0 : conf),
        };
        words.push(w);
        const key = c[2] + '-' + c[3] + '-' + c[4]; // block-par-line
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(w);
      }
      return { words, lines: groupTesseractLines(groups) };
    } finally {
      try { fs.unlinkSync(base + '.tsv'); } catch (_) {}
    }
  },

  /** 裁切一塊區域、放大 N 倍後用單行模式 OCR（整頁 OCR 讀不好大字美術字／小字灰字） */
  ocrCrop(imagePath, box, scale, extraArgs = []) {
    const crop = path.join(os.tmpdir(), 'cr_' + process.pid + '_' + scale + '.png');
    try {
      cropUpscale(imagePath, box, scale, crop);
      return execFileSync('tesseract', [crop, '-', '--psm', '7', ...extraArgs], {
        encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (e) {
      return '';
    } finally {
      try { fs.unlinkSync(crop); } catch (_) {}
    }
  },
};

// ─────────────────────────────────────────────────────────────────────
// 引擎二：Apple Vision（scripts/ocr-vision.swift，輸出格式在 Swift 端就對齊 tesseract）
// ─────────────────────────────────────────────────────────────────────
const VISION_SRC = path.join(__dirname, 'ocr-vision.swift');
const VISION_BIN = path.join(__dirname, 'ocr-vision'); // 編譯產物，已進 .gitignore

// tesseract 語言代碼 → Vision 語言代碼（app-locators.json 的 recipe.lang 沿用 tesseract 寫法）
const VISION_LANGS = { chi_tra: 'zh-Hant,en-US', eng: 'en-US', chi_sim: 'zh-Hans,en-US' };

let visionReady = false;
const vision = {
  name: 'vision',

  ensure() {
    if (visionReady) return;
    if (process.platform !== 'darwin') {
      throw new Error('OCR_ENGINE=vision 只能在 macOS 上跑（Apple Vision 是 macOS 框架）。Linux／Cowork VM 請拿掉 OCR_ENGINE 退回 tesseract。');
    }
    const needBuild = !fs.existsSync(VISION_BIN) ||
      fs.statSync(VISION_BIN).mtimeMs < fs.statSync(VISION_SRC).mtimeMs;
    if (needBuild) {
      process.stderr.write('🔧 編譯 scripts/ocr-vision.swift（第一次約 10 秒）…\n');
      // 先編到暫存檔再 rename：兩支 job 平行跑分析時不會互相寫壞同一個二進位
      const tmp = VISION_BIN + '.tmp-' + process.pid;
      try {
        execFileSync('swiftc', ['-O', VISION_SRC, '-o', tmp], { stdio: ['ignore', 'ignore', 'inherit'] });
        fs.renameSync(tmp, VISION_BIN);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        if (fs.existsSync(VISION_BIN)) {
          process.stderr.write('⚠️ 重新編譯失敗，沿用舊的 ocr-vision：' + e.message + '\n');
        } else {
          throw new Error('編譯 ocr-vision.swift 失敗（需要 Xcode Command Line Tools：xcode-select --install）：' + e.message);
        }
      }
    }
    visionReady = true;
  },

  /** 跑 ocr-vision 二進位，回傳 { words, lines }（Swift 端已把逐字併成詞、座標轉成左上角像素） */
  _run(imagePath, lang) {
    this.ensure();
    const args = ['--lang', VISION_LANGS[lang] || VISION_LANGS.chi_tra, imagePath];
    const raw = execFileSync(VISION_BIN, args, { maxBuffer: 1024 * 1024 * 64, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const j = JSON.parse(raw);
    return j[imagePath] || Object.values(j)[0] || { words: [], lines: [] };
  },

  ocrPage(imagePath, opts = {}) {
    const minConf = opts.minConf === undefined ? 30 : opts.minConf;
    try {
      const r = this._run(imagePath, opts.lang || 'chi_tra');
      // Vision 的信心只有三級：1.0／0.5／0.3 → 100／50／30。上層門檻是照 tesseract 的連續刻度寫的
      //（>50 代號、>=55 三大法人編號、>=70 重點、>40 側欄…），Vision「中等」＝50 剛好全部卡在門檻外 ——
      // 2026-09-08 實測「欣興 3037」讀對了但 c=50 過不了 >50，退回裁切路徑去讀總量，五張個股頁代號全錯。
      // 對映：高 100 → 100、中 50 → 75、低 30 → 45（低只過 25/30/40 那些寬鬆用途，不會被拿去當代號）。
      const remap = (c) => (c >= 100 ? 100 : c >= 50 ? 75 : c >= 30 ? 45 : c);
      const words = (r.words || []).map((w) => ({ ...w, c: remap(w.c) }))
        .filter((w) => w.t && (minConf === null || w.c >= minConf));
      // Vision 原生就是整行框；把該行範圍內的詞掛回去，app-locator 的 findAnchor 要用 line.words
      const lines = (r.lines || []).map((L) => {
        const inLine = words.filter((w) =>
          w.y + w.h > L.y && w.y < L.y + L.h && w.x + w.w > L.x && w.x < L.x + L.w);
        return { text: L.text, x: L.x, y: L.y, w: L.w, h: L.h, c: remap(L.c), words: inLine };
      });
      return { words, lines };
    } catch (e) {
      // 跟 tesseract 版不同：tesseract 失敗會 throw，讓上層決定；Vision 這裡先吞掉印警告，
      // 因為 _vision-trial 實測就是這樣跑出 IoU 0.371 的，行為要一致。
      process.stderr.write('   ⚠️ vision 失敗: ' + imagePath + ' ' + e.message + '\n');
      return { words: [], lines: [] };
    }
  },

  /**
   * 裁切放大後辨識。Vision 沒有 --psm 7／字元白名單／語言參數的對應，所以 tesseract 的 extraArgs
   * 在這裡整個忽略：直接把裁切圖丟進去（zh-Hant+en-US）、詞接起來回傳。上層本來就會自己過濾
   *（readStockName 只留中文、readStockCode 只留數字）。這跟 _vision-trial/analyze.js 的
   * visionCrop() 一字不差 —— IoU 0.371 就是這樣量出來的，別自作聰明改。
   */
  ocrCrop(imagePath, box, scale, _extraArgs = []) {
    const crop = path.join(os.tmpdir(), 'vcr_' + process.pid + '_' + scale + '_' + Date.now() + '.png');
    try {
      cropUpscale(imagePath, box, scale, crop);
      const r = this._run(crop, 'chi_tra');
      return (r.words || []).map((w) => w.t).join('');
    } catch (e) {
      return '';
    } finally {
      try { fs.unlinkSync(crop); } catch (_) {}
    }
  },
};

// ─────────────────────────────────────────────────────────────────────
// 引擎表。VLM 之後加在這裡（見檔頭「VLM 插槽」）。
// ─────────────────────────────────────────────────────────────────────
const ENGINES = { tesseract, vision };

const active = ENGINES[ENGINE];
if (!active) {
  throw new Error(`OCR_ENGINE=${ENGINE} 不認得，可用：${Object.keys(ENGINES).join(' / ')}`);
}

module.exports = {
  engine: active.name,
  ensure: () => active.ensure(),
  ocrPage: (img, opts) => active.ocrPage(img, opts),
  ocrCrop: (img, box, scale, extraArgs) => active.ocrCrop(img, box, scale, extraArgs),
  /** 除錯用：直接拿某個引擎（例如 A/B 對照時兩個都要） */
  ENGINES,
};
