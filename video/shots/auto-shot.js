#!/usr/bin/env node
'use strict';

/**
 * 自動配圖的命令列入口：讀參數與檔案、組合判定模組、輸出計畫或回答前台的問題。
 * 規則本體在 matcher.js（選圖、選框）、plan.js（排法）、script-units.js（切句）、annotations.js（人工標注）。
 *
 * 資料來源：src/app-images.generated.json（analyze-app-images.js 產出：頁面類型、股名、代號、逐字框）。
 * 配對由強到弱：①股名 ②股票代號 ③頁面關鍵字 ④圖上數字。手寫 (shot:) 與人工標注優先，自動不覆蓋。
 *
 * 用法：
 *   node video/shots/auto-shot.js --out <計畫檔>            預覽
 *   node video/shots/auto-shot.js --write --out <計畫檔>    寫入（產線用 --out src/<版型>/<版型>-shots.generated.json）
 *   --script=<路徑>          讀指定稿件（標注頁在講者還在生成時就要用，public/ 可能是別支工作）
 *   --sentences              只輸出句子／子句／逐字清單（標注頁用），不需要圖片分析
 *   --images=<路徑>          讀指定的圖片分析（伺服器問某支工作的快照時用）
 *   --suggest-cells=<路徑>   只回答「這句、這張圖，系統會框哪裡」（修正紀錄用），一定要搭 --out
 *   --no-annots              假裝沒有人工標注（對照組），一定要搭 --out 寫到別的檔
 *   --with-auto              自動段也進成品（預設只用人工標注，2026-08-25 使用者定案「人工沒標就不要出現」）
 */
const fs = require('node:fs');
const path = require('node:path');
const { workspaceRoot, cliPath, dataPath } = require('../../shared/paths');
const SHOT_MEMORY = require('./shot-memory');
const { buildPageKeywords, buildStockNames, enrichImages } = require('./context');
const { createMatcher } = require('./matcher');
const { analyzeScript } = require('./script-units');
const { annotationsToManual } = require('./annotations');
const { splitEnumerations, assignShots, applyTimingRules, resolveOverlaps } = require('./plan');
const { suggestCells } = require('./suggest');

const REMOTION_ROOT = path.resolve(__dirname, '..', 'remotion');
const LOCATORS_PATH = path.join(__dirname, 'app-locators.json');

class CliError extends Error {}

/** @param {string} file */
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf-8'));

/**
 * @param {string[]} argv
 * @param {{ root?: string, log?: (m: string) => void }} [options]
 * @returns {number} 結束代碼
 */
function main(argv, { root = REMOTION_ROOT, log = console.log } = {}) {
  const workspace = workspaceRoot(root);
  // 被 server 直接 spawn 時也要讀得到 .env 的 PAGE_RULES／SHOT_MEMORY。
  // quiet：dotenv 預設會在 stdout 印一行，server 是 JSON.parse --sentences 的 stdout，會炸。
  try { require('dotenv').config({ path: path.join(workspace, '.env'), quiet: true }); } catch (_) {}

  const valueOf = (/** @type {string} */ name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const has = (/** @type {string} */ flag) => argv.includes(flag);
  const outAt = argv.indexOf('--out');
  const scriptPath = valueOf('script') ? cliPath(root, /** @type {string} */ (valueOf('script'))) : path.join(root, 'public', 'script.txt');
  const imagesPath = valueOf('images') ? cliPath(root, /** @type {string} */ (valueOf('images'))) : path.join(root, 'src', 'app-images.generated.json');
  const suggestPath = valueOf('suggest-cells') ? cliPath(root, /** @type {string} */ (valueOf('suggest-cells'))) : null;
  const sentencesOnly = has('--sentences');
  const noAnnots = has('--no-annots');
  // --no-annots 一定要保留自動段：那是「假裝沒有人工標注」的對照組，濾掉就沒有東西可比。
  const withAuto = has('--with-auto') || noAnnots;
  const outPath = outAt >= 0 ? cliPath(root, argv[outAt + 1]) : null;

  if (!fs.existsSync(scriptPath)) throw new CliError('找不到 public/script.txt');
  if (!sentencesOnly && !fs.existsSync(imagesPath)) throw new CliError('找不到 src/app-images.generated.json，請先跑：npm run analyze:app-images');

  const imgs = fs.existsSync(imagesPath) ? (readJson(imagesPath).images || []) : [];
  let regions = {};
  try { regions = readJson(LOCATORS_PATH).regions || {}; } catch (_) {}
  // 股票代號 ↔ 官方簡稱（npm run stocks）。沒有這張表，OCR 讀到代號、股名讀壞的個股頁就永遠配不到句子。
  let stockNames = {};
  try { stockNames = readJson(dataPath(workspace, 'stock-names.json')); } catch (_) { /* 還沒跑過 npm run stocks：退回原本的行為 */ }
  // 你教過的東西（前台按「確認，開始出片」時累積）：codeNames 覆寫官方簡稱、pages 是同型頁面的框位置。
  const memory = SHOT_MEMORY.read(workspace);
  const { codeName, list: stockNameList } = buildStockNames(stockNames, memory.codeNames);
  enrichImages(imgs, codeName);
  const matcher = createMatcher({
    regions, pageKeywords: buildPageKeywords(regions), stockNameList, memory,
    memoryMode: (process.env.SHOT_MEMORY || 'single').toLowerCase(), shotMemory: SHOT_MEMORY,
  });

  /** @type {Array<{ start: number, end: number }>} */
  let charTimes = [];
  try { charTimes = readJson(path.join(root, 'src', 'subtitles.json'))._scriptCharTimes || []; } catch (_) {}

  const script = analyzeScript(fs.readFileSync(scriptPath, 'utf-8'));

  // 句子怎麼切一定要由這支決定，前台自己切一套就會對不上。
  if (sentencesOnly) {
    log(JSON.stringify({
      sentences: script.sentenceList.map(({ i, text }) => ({ i, text })),
      units: script.unitList.map(({ i, sid, text, startCharIdx, endCharIdx }) => ({ i, sid, text, startCharIdx, endCharIdx })),
      chars: script.chars,
    }, null, 2));
    return 0;
  }
  if (imgs.length === 0) throw new CliError('app-images.generated.json 裡沒有圖片');

  if (suggestPath) {
    if (!outPath) throw new CliError('--suggest-cells 一定要同時給 --out，否則會寫到預設的計畫檔');
    let want = [];
    try { want = readJson(suggestPath) || []; } catch (_) {}
    fs.writeFileSync(outPath, JSON.stringify(suggestCells(want, { imgs, origPhrase: script.origPhrase, matcher }), null, 2));
    return 0;
  }

  const manual = [...script.marks];
  const annotationsPath = path.join(root, 'public', 'annotations.json');
  if (noAnnots && fs.existsSync(annotationsPath)) log('\n🔬 --no-annots：這一輪刻意忽略手動標注（對照組）\n');
  if (!noAnnots && fs.existsSync(annotationsPath)) {
    let ann = [];
    try { ann = readJson(annotationsPath).shots || []; } catch (_) {}
    manual.push(...annotationsToManual(ann, { imgs, ...script }));
    if (ann.length) log(`✋ 讀到 ${manual.filter((m) => m._annotated).length} 筆人工標注（自動判定不會碰這些句子）`);
  }

  const clauses = splitEnumerations(script.clauses, imgs, matcher.namesOf);
  const { auto, preview, used } = assignShots({ clauses, imgs, manual, toCleaned: script.toCleaned, matcher });
  applyTimingRules(auto, charTimes);

  const overlaps = resolveOverlaps(manual, charTimes);
  if (overlaps.notes.length) {
    log('\n🔀 人工標注重疊，後標的為主：');
    overlaps.notes.forEach((n) => log('   ' + n));
    manual.length = 0;
    manual.push(...overlaps.items);
  }

  log('\n📋 自動配圖預覽（哪一段旁白 → 哪一張截圖）\n');
  preview.forEach((l) => log(l));
  const unused = imgs.filter((i) => !used.has(i.file));
  if (unused.length) log(`\n  ⚠️ 沒被用到的圖：${unused.map((u) => u.file + '(' + (u.stockName || u.pageLabel) + ')').join('、')}`);
  log(`\n  手動 ${manual.length} 段 ＋ 自動 ${auto.length} 段`
    + (withAuto ? '' : `（--with-auto 才會用自動段，這次只用手動 ${manual.length} 段）`));
  if (!withAuto && manual.length === 0) log('\n  ⚠️ 這支沒有任何人工標注 —— 成品不會有任何截圖，整支都是講者。');

  if (has('--write')) {
    if (!outPath) throw new CliError('--write 一定要給 --out（例：src/DapanXiaobao/dapan-shots.generated.json）');
    const merged = [...manual, ...(withAuto ? auto : [])].sort((a, b) => a.startCharIdx - b.startCharIdx);
    fs.writeFileSync(outPath, JSON.stringify(merged, null, 2));
    log(`\n✅ 已寫入 ${path.relative(root, outPath)}\n`);
  } else {
    log('\n👉 預覽而已，沒寫檔。確認後加 --write --out <計畫檔>\n');
  }
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (e) {
    if (!(e instanceof CliError)) throw e;
    console.error('❌ ' + e.message);
    process.exitCode = 1;
  }
}

module.exports = { main, CliError };
