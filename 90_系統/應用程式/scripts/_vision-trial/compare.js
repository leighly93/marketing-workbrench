#!/usr/bin/env node
/**
 * Tesseract vs Apple Vision 對照測試 —— 完全不碰產線。
 *
 * ⚠️ 這支只能在 macOS 上跑（Vision 是 macOS 框架）。
 * ⚠️ 只讀不寫：不會動到 src/app-images.generated.json 或任何產線檔案。
 *    所有輸出都寫在 scripts/_vision-trial/out/ 底下。
 *
 * 用法：
 *   node scripts/_vision-trial/compare.js              # 全部歷史截圖
 *   node scripts/_vision-trial/compare.js --limit 20   # 只跑 20 張
 *   node scripts/_vision-trial/compare.js --only public # 只跑 public/
 */
const fs = require('fs');
const path = require('path');
const { workspaceRoot, dataPath } = require('../../../paths');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const WORKSPACE_ROOT = workspaceRoot(ROOT);
const HERE = __dirname;
const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });

const argv = process.argv.slice(2);
const getArg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const LIMIT = parseInt(getArg('--limit', '0'), 10) || 0;
const ONLY = getArg('--only', null);

// ── 1. 收集測試用截圖 ──
function collectImages() {
  const out = [];
  const push = (p) => { if (/\.(jpg|jpeg|png)$/i.test(p) && fs.existsSync(p)) out.push(p); };
  if (!ONLY || ONLY === 'public') {
    for (const f of fs.readdirSync(path.join(ROOT, 'public'))) push(path.join(ROOT, 'public', f));
  }
  if (!ONLY || ONLY === 'jobs') {
    const jobsDir = path.join(WORKSPACE_ROOT, '工作紀錄');
    if (fs.existsSync(jobsDir)) {
      for (const j of fs.readdirSync(jobsDir)) {
        const inp = path.join(jobsDir, j, '素材');
        if (!fs.existsSync(inp)) continue;
        for (const f of fs.readdirSync(inp)) push(path.join(inp, f));
      }
    }
  }
  return LIMIT ? out.slice(0, LIMIT) : out;
}

// ── 2. Tesseract（跟 analyze-app-images.js 的 ocrPage() 同一套參數）──
function tesseractPage(imagePath) {
  const base = path.join(os.tmpdir(), 'vt_' + process.pid + '_' + Date.now());
  const t0 = Date.now();
  try {
    execFileSync('tesseract', [imagePath, base, '-l', 'chi_tra', 'tsv'], { stdio: ['ignore','ignore','ignore'] });
    const tsv = fs.readFileSync(base + '.tsv', 'utf-8');
    const words = [];
    for (const line of tsv.split('\n').slice(1)) {
      const c = line.split('\t');
      if (c.length < 12) continue;
      const conf = parseFloat(c[10]);
      const t = (c[11] || '').replace(/\s+/g, '');
      if (!t || isNaN(conf) || conf < 30) continue;
      words.push({ t, x: +c[6], y: +c[7], w: +c[8], h: +c[9], c: Math.round(conf) });
    }
    return { words, ms: Date.now() - t0 };
  } catch (e) {
    return { words: [], ms: Date.now() - t0, err: e.message };
  } finally {
    try { fs.unlinkSync(base + '.tsv'); } catch (_) {}
  }
}

// ── 3. Vision（一次跑完所有圖）──
function visionAll(images) {
  const src = path.join(HERE, 'ocr-vision.swift');
  const bin = path.join(HERE, 'ocr-vision');
  const needBuild = !fs.existsSync(bin) || fs.statSync(bin).mtimeMs < fs.statSync(src).mtimeMs;
  if (needBuild) {
    process.stderr.write('編譯 ocr-vision.swift…\n');
    execFileSync('swiftc', ['-O', src, '-o', bin], { stdio: 'inherit' });
  }
  const t0 = Date.now();
  const raw = execFileSync(bin, images, { maxBuffer: 1024 * 1024 * 512 }).toString();
  process.stderr.write(`Vision 全部跑完 ${Date.now() - t0} ms\n`);
  return JSON.parse(raw);
}

// ── 4. 評分用的答案 ──
const stockNames = (() => {
  try { return JSON.parse(fs.readFileSync(dataPath(WORKSPACE_ROOT, 'stock-names.json'), 'utf-8')); }
  catch (_) { return {}; }
})();
const NAME_SET = new Set(Object.values(stockNames).filter((n) => typeof n === 'string' && n.length >= 2));
const CODE_BY_NAME = {};
for (const [code, nm] of Object.entries(stockNames)) if (typeof nm === 'string') CODE_BY_NAME[nm] = code;

const fullText = (words) => words.map((w) => w.t).join('');

/**
 * 「可用數字框」—— 直接模擬 findCell() 的解析方式，數這張圖上有幾個
 * **能被拿來跟旁白數字比對**的框。這是最貼近實際效果的指標：
 * 圖上印著 524.0，但如果 OCR 把它拆成 5/2/4/0 五個框，findCell 就配不到。
 */
function numCells(words) {
  const vals = new Set();
  for (const w of words) {
    const v = parseFloat(String(w.t).replace(/,/g, '').replace(/[^0-9.]/g, ''));
    if (!isNaN(v) && v >= 10) vals.add(v);
  }
  return [...vals];
}
function foundNames(words) {
  const txt = fullText(words);
  const hit = [];
  for (const nm of NAME_SET) if (txt.includes(nm)) hit.push(nm);
  return hit;
}
function foundCodes(words) {
  const txt = fullText(words);
  return [...new Set((txt.match(/\d{4}/g) || []).filter((c) => stockNames[c]))];
}

/**
 * 「代號↔股名 自洽」—— 這張圖上同時讀到 2455 和「全新」（2455 就是全新）。
 * 為什麼要這個指標：單看「找到幾個股名」會被灌水 ——
 * 1,986 個股名拿去比對全文，讀出越多字的引擎越容易矇中。
 * 但「代號跟股名互相對得上」是隨機雜訊做不到的，讀錯任一邊就不成立。
 * 這是這份報表裡最可信的一欄。
 */
function pairedHits(words) {
  const txt = fullText(words);
  const out = [];
  // ⚠️ 必須用「重疊掃描」逐位置試，不能用 txt.match(/\d{4}/g) ——
  //    那是不重疊比對，遇到黏在一起的長數字串（…0199032347…）會先吃掉 0323，
  //    真正的代號 3234 就永遠掃不到。2026-09-01 實測因此低估了兩邊的分數。
  const seen = new Set();
  for (let i = 0; i + 4 <= txt.length; i++) {
    const code = txt.slice(i, i + 4);
    if (!/^\d{4}$/.test(code) || seen.has(code)) continue;
    seen.add(code);
    const nm = stockNames[code];
    if (nm && txt.includes(nm)) out.push(code + nm);
  }
  return out;
}

// ── 5. 跑 ──
const images = collectImages();
if (!images.length) { console.error('找不到測試截圖'); process.exit(1); }
console.error(`測試 ${images.length} 張截圖\n`);

const vis = visionAll(images);

const rows = [];
for (const img of images) {
  const t = tesseractPage(img);
  const v = vis[img] || { words: [], lines: [], ms: 0 };
  rows.push({
    file: path.relative(WORKSPACE_ROOT, img),
    tess: { n: t.words.length, names: foundNames(t.words), codes: foundCodes(t.words), pairs: pairedHits(t.words), nums: numCells(t.words), ms: t.ms, text: fullText(t.words) },
    vis:  { n: v.words.length, names: foundNames(v.words), codes: foundCodes(v.words), pairs: pairedHits(v.words), nums: numCells(v.words), ms: v.ms, text: fullText(v.words), lines: (v.lines||[]).length },
  });
  process.stderr.write('.');
}
process.stderr.write('\n\n');

// ── 6. 報表 ──
const pad = (s, n) => String(s).padEnd(n);
console.log('檔案'.padEnd(36) + '詞框(T/V)'.padEnd(13) + '★數字(T/V)'.padEnd(13) + '★自洽(T/V)'.padEnd(13) + '毫秒(T/V)');
console.log('-'.repeat(110));
let tN=0,vN=0,tNm=0,vNm=0,tC=0,vC=0,tP=0,vP=0,tD=0,vD=0,tMs=0,vMs=0;
for (const r of rows) {
  console.log(
    pad(r.file.slice(-34), 36) +
    pad(`${r.tess.n} / ${r.vis.n}`, 13) +
    pad(`${r.tess.nums.length} / ${r.vis.nums.length}`, 13) +
    pad(`${r.tess.pairs.length} / ${r.vis.pairs.length}`, 13) +
    `${r.tess.ms} / ${r.vis.ms}`
  );
  tN+=r.tess.n; vN+=r.vis.n; tNm+=r.tess.names.length; vNm+=r.vis.names.length;
  tC+=r.tess.codes.length; vC+=r.vis.codes.length; tP+=r.tess.pairs.length; vP+=r.vis.pairs.length; tD+=r.tess.nums.length; vD+=r.vis.nums.length; tMs+=r.tess.ms; vMs+=r.vis.ms;
}
console.log('-'.repeat(110));
console.log(pad('合計', 36) + pad(`${tN} / ${vN}`, 13) + pad(`${tD} / ${vD}`, 13) + pad(`${tP} / ${vP}`, 13) + `${tMs} / ${vMs}`);
console.log('\n（T = Tesseract 現況，V = Apple Vision）');
console.log(`股名命中：Tesseract ${tNm} 個 → Vision ${vNm} 個`);
console.log(`代號命中：Tesseract ${tC} 個 → Vision ${vC} 個`);
console.log(`★代號↔股名自洽：Tesseract ${tP} 個 → Vision ${vP} 個　（最可信的指標，矇不到）`);
console.log(`★可用數字框　：Tesseract ${tD} 個 → Vision ${vD} 個　（模擬 findCell 的解析，直接預測數字比對成功率）`);
console.log(`總耗時　：Tesseract ${(tMs/1000).toFixed(1)}s → Vision ${(vMs/1000).toFixed(1)}s`);

fs.writeFileSync(path.join(OUT, 'compare.json'), JSON.stringify(rows, null, 2));
const txt = rows.map((r) => `━━━ ${r.file}\n[T] ${r.tess.text}\n[V] ${r.vis.text}\n`).join('\n');
fs.writeFileSync(path.join(OUT, 'fulltext.txt'), txt);
console.log(`\n明細：scripts/_vision-trial/out/compare.json`);
console.log(`全文並排：scripts/_vision-trial/out/fulltext.txt`);
