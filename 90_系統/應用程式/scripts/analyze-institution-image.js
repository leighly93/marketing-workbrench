#!/usr/bin/env node
/**
 * 三大法人資訊圖「版面偵測」：用 OCR 找出圖上①②③④四個區塊的位置，
 * 產生 src/Institution/institution-regions.generated.json。
 *
 * 為什麼要 OCR：使用者不想把區塊座標寫死（改版就要改座標）。這張速覽圖的四個區塊
 * 左上角都有一個大大的編號「1 / 2 / 3 / 4」，OCR 對這種大字、孤立、高對比的數字辨識
 * 很穩（實測信心 91–96%）。我們就用「編號數字的 y 位置」當每個區塊的頂端，
 * 下一個編號的 y 當底端 → 得到四條區塊帶（band）。這比去比對「外資期貨」這種
 * 容易被 OCR 併字/拆字的標題可靠得多。
 *
 * 另外把整張圖的 OCR 逐字框（含座標）一起 dump 出來，之後 timeline 端要「高亮某個數字格」
 * （例如 89,201）時，就從這份逐字框裡找那個字串的位置畫黃框——一樣不寫死座標。
 *
 * OCR 引擎：走 scripts/ocr-engine.js（2026-09-08 起）。預設 tesseract（brew install tesseract tesseract-lang，
 *   tesseract --list-langs 應看到 chi_tra）；.env 設 OCR_ENGINE=vision 改用 Apple Vision。
 *   ⚠️ 這支的 Vision 路徑還沒實測過（_vision-trial 只量了 analyze-app-images），第一次開 vision 出三大法人要看區塊帶對不對。
 *
 * 用法：node scripts/analyze-institution-image.js [圖片路徑，預設 public/image.png]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const OCR = require('./ocr-engine');

const { cliPath } = require('../../paths');
const ROOT = path.resolve(__dirname, '..');
// 資訊圖檔名不挑：使用者常直接丟 0812.png 這種日期命名。
// 優先 image.png，其次 public/ 裡任何一張「不是套版素材」的圖。
function findInfographic() {
  const dir = path.join(ROOT, 'public');
  const preferred = path.join(dir, 'image.png');
  if (fs.existsSync(preferred)) return preferred;
  const TEMPLATE_ASSET = /^(dapan|focusstock|institution|midday)-|^(frame|logo)\.png$|^NotoSans/i;
  const cand = fs
    .readdirSync(dir)
    .filter((f) => /\.(png|jpg|jpeg)$/i.test(f) && !TEMPLATE_ASSET.test(f))
    .sort();
  return cand.length ? path.join(dir, cand[0]) : preferred;
}
const IMG = process.argv[2] ? cliPath(ROOT, process.argv[2]) : findInfographic();
const OUT_DIR = path.join(ROOT, 'src', 'Institution');
const OUT_PATH = path.join(OUT_DIR, 'institution-regions.generated.json');

function fail(msg) {
  console.error('❌ ' + msg);
  process.exit(1);
}

if (!fs.existsSync(IMG)) fail('找不到圖片：' + IMG);
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ── 確認 OCR 引擎可用（tesseract 在不在／Vision 二進位編好沒）──
try {
  OCR.ensure();
} catch (e) {
  fail(e.message + '\n（tesseract：brew install tesseract tesseract-lang，之後 tesseract --list-langs 應看到 chi_tra）');
}

// ── 取得圖片尺寸（用 tesseract 的 tsv 第一列 page，或退而求其次讀 PNG header）──
function readPngSize(file) {
  const buf = fs.readFileSync(file);
  // PNG: 8-byte sig, then IHDR (width @16, height @20, big-endian)
  if (buf.length > 24 && buf.toString('ascii', 12, 16) === 'IHDR') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return null;
}

// ── 跑 OCR → 逐字框（實作在 ocr-engine.js；這支跟另兩支不同：不過濾信心、錯誤訊息要印出來）──
let words;
try {
  words = OCR.ocrPage(IMG, { minConf: null, stderr: 'inherit' }).words;
} catch (e) {
  fail('OCR 執行失敗（' + OCR.engine + '）：' + e.message);
}

const size = readPngSize(IMG) || { width: 0, height: 0 };
const imgW = size.width || Math.max(...words.map((w) => w.x + w.w), 0);
const imgH = size.height || Math.max(...words.map((w) => w.y + w.h), 0);

// ── 找區塊編號 1/2/3/4（左欄大字、孤立）──
// 條件：文字剛好是 1~4、靠左（x < 圖寬的 12%）、字夠高（h > 圖高的 1.8%）、信心夠。
const digitAnchors = {};
for (const w of words) {
  if (!/^[1-4]$/.test(w.t)) continue;
  if (w.x > imgW * 0.12) continue;
  if (w.h < imgH * 0.018) continue;
  if (w.c < 55) continue;
  const n = w.t;
  // 同一編號若多次命中，取最靠上的那個（區塊編號在區塊頂端）
  if (!digitAnchors[n] || w.y < digitAnchors[n].y) digitAnchors[n] = w;
}

const foundNums = Object.keys(digitAnchors).sort();
if (foundNums.length < 2) {
  fail(
    '只偵測到 ' +
      foundNums.length +
      ' 個區塊編號（需要至少 2 個才能推區塊帶）。' +
      '請確認這是三大法人速覽圖，且左上角有 1/2/3/4 編號。'
  );
}

// ── 補回「全頁 OCR 漏掉」的編號 ──
// 這幾個編號是深藍圓角框裡的白色大字，全頁 OCR 偶爾整個漏掉一個
//（2026-08-18 實際踩到：漏了「3 外資台指期」→ sec2 一路吃到底、壓黑範圍變超小、
//  看起來像沒壓黑）。做法：用已偵測到的編號「內插」出漏掉那個的大概 y，
//  再把左欄那一小塊裁下來放大單獨重讀。這種裁切單字辨識比全頁可靠得多。
function recoverMissingDigit(n) {
  // 內插估 y：找數字比 n 小的最近一個、比 n 大的最近一個，線性推算
  const known = [1, 2, 3, 4]
    .filter((k) => digitAnchors[String(k)])
    .map((k) => ({ k, y: digitAnchors[String(k)].y }));
  const lo = [...known].reverse().find((o) => o.k < n);
  const hi = known.find((o) => o.k > n);
  let estY;
  if (lo && hi) estY = lo.y + ((n - lo.k) / (hi.k - lo.k)) * (hi.y - lo.y);
  else if (lo) estY = lo.y + (n - lo.k) * 350; // 只有上界：用相鄰區塊的典型間距
  else if (hi) estY = hi.y - (hi.k - n) * 350;
  else return null;

  // 裁切窗口：對準「編號」那個字。編號 top 約在 estY，但 tesseract 的 estY 是「上緣」，
  // 編號實際落在框內偏下，所以往下偏一點點。窗口寬 ≈ 圖寬 7.5%、高 ≈ 圖高 4.5%
  //（2026-08-18 實測這組幾何能穩定讀到白字大編號）。
  const cropX = Math.round(imgW * 0.04);
  const cropW = Math.round(imgW * 0.075);
  const cropY = Math.max(0, Math.round(estY + imgH * 0.01));
  const cropH = Math.round(imgH * 0.045);
  const crop = path.join(os.tmpdir(), 'inst_dig_' + process.pid + '_' + n + '.png');
  try {
    execFileSync(
      'ffmpeg',
      ['-y', '-i', IMG, '-vf',
        `crop=${cropW}:${cropH}:${cropX}:${cropY},scale=${cropW * 8}:${cropH * 8}:flags=lanczos`,
        crop],
      { stdio: 'ignore' }
    );
    // 用 tsv 拿到「編號在裁切圖裡的實際位置」，換算回原圖座標當錨點 ——
    // 比用估算的 estY 準（估算常差一二十 px，會讓區塊邊界切到相鄰列）。
    // 在裁切圖上找到那個編號的字框，換算回原圖座標當錨點。
    // tesseract：原本的 --psm 10（單字模式）＋白名單 1234，一字不改；
    // vision：沒有這兩個參數，直接整張裁切圖 ocrPage 再挑 t === n 的框。
    const hits = OCR.ocrDigits(crop);
    for (const hw of hits) {
      if (hw.t !== String(n)) continue;
      // 裁切時放大了 8 倍，換算回原圖
      const realY = cropY + hw.y / 8;
      const realH = hw.h / 8;
      return { t: String(n), x: cropX, y: Math.round(realY), w: cropW, h: Math.round(realH) || Math.round(imgH * 0.03), c: 60, _recovered: true };
    }
  } catch (_) {
  } finally {
    try { fs.unlinkSync(crop); } catch (_) {}
  }
  return null;
}

for (let n = 1; n <= 4; n++) {
  if (digitAnchors[String(n)]) continue;
  const rec = recoverMissingDigit(n);
  if (rec) {
    digitAnchors[String(n)] = rec;
    console.log('   ↻ 編號 ' + n + ' 全頁 OCR 漏掉，已用裁切重讀補回（y≈' + rec.y + '）');
  }
}

// ── 由編號 y 推每個區塊的上下界（band）──
// 區塊 N 頂 = 編號 N 的 top - 一點 padding；底 = 編號 N+1 的 top - gap；最後一區塊底 = 圖底。
const GAP = Math.round(imgH * 0.012); // 區塊間留白，避免帶到下一區塊標題
const TOP_PAD = Math.round(imgH * 0.014);
// ── 底部「重點」摘要框的頂端 ──
// 這張圖最底下有一個「重點1/2/3/4」的摘要框，裡面的數字是上面各表格數字的
// 「四捨五入重複版」（例：表格 +407.88 → 摘要 407.9）。這些重複值會干擾聚焦比對
//（2026-08-18 踩到：外資大買408億 被框到摘要框的 407.9，而不是表格的 +407.88）。
// 標出它的頂端 y，讓 auto-focus 把摘要框的數字退到最後、優先框表格；
// 也讓最後一個區塊的底不要吃進摘要框。
const summaryWords = words.filter((w) => w.t.includes('重點') && w.c >= 70);
const summaryTop = summaryWords.length
  ? Math.min(...summaryWords.map((w) => w.y)) - TOP_PAD
  : null;

const sections = {};
for (let n = 1; n <= 4; n++) {
  const a = digitAnchors[String(n)];
  if (!a) continue;
  const next = digitAnchors[String(n + 1)];
  const top = Math.max(0, a.y - TOP_PAD);
  let bottom = next ? next.y - GAP : imgH;
  // 最後一個區塊的底不要吃進底部摘要框
  if (!next && summaryTop && summaryTop > top) bottom = summaryTop;
  sections['sec' + n] = { top, bottom, anchorY: a.y };
}

const out = {
  _generatedFrom: path.relative(ROOT, IMG),
  imageFile: path.basename(IMG), // composition 用這個檔名載圖（不再寫死 image.png）
  imageWidth: imgW,
  imageHeight: imgH,
  summaryTop, // 底部重點摘要框頂端 y（null 表示沒偵測到）
  sections,
  words,
};

fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
console.log('\n✅ 版面偵測完成 → ' + path.relative(ROOT, OUT_PATH));
console.log('   圖片尺寸：' + imgW + '×' + imgH + '，OCR 逐字框 ' + words.length + ' 個');
for (let n = 1; n <= 4; n++) {
  const s = sections['sec' + n];
  if (s) console.log('   sec' + n + '：y ' + s.top + ' → ' + s.bottom);
  else console.log('   sec' + n + '：⚠️ 未偵測到編號，此區塊略過');
}
