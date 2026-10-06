#!/usr/bin/env node
// @ts-check
'use strict';

/**
 * 字幕校正的命令列入口：讀 public/script.txt 與 src/subtitles.json，校正後寫回。
 *
 *   npm run correct-subtitles
 *
 * 結束代碼：0 成功；1 缺檔；3 時間軸判定失敗（沒有寫回，run.js 靠這個 code 決定要不要墊靜音重轉）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { correctSubtitles } = require('./correct');
const { MIN_SEC_PER_CHAR } = require('./gap-fill');

const REMOTION_ROOT = path.resolve(__dirname, '..', 'remotion');
const REPLACEMENTS_PATH = path.join(__dirname, 'replacements.json');
const EXIT_TIMELINE_BROKEN = 3;

/**
 * @param {{ root?: string, replacementsPath?: string, log?: (m: string) => void, error?: (m: string) => void }} [options]
 * @returns {number} 結束代碼
 */
function run({ root = REMOTION_ROOT, replacementsPath = REPLACEMENTS_PATH, log = console.log, error = console.error } = {}) {
  const scriptPath = path.join(root, 'public', 'script.txt');
  const subsPath = path.join(root, 'src', 'subtitles.json');
  const backupPath = path.join(root, 'src', 'subtitles.original.json');
  if (!fs.existsSync(scriptPath)) { error(`❌ 找不到 ${scriptPath}`); return 1; }
  if (!fs.existsSync(subsPath)) { error(`❌ 找不到 ${subsPath}（請先跑 npm run transcribe）`); return 1; }

  const scriptRaw = fs.readFileSync(scriptPath, 'utf-8');
  const subs = JSON.parse(fs.readFileSync(subsPath, 'utf-8'));
  const replacements = fs.existsSync(replacementsPath) ? JSON.parse(fs.readFileSync(replacementsPath, 'utf-8')) : [];
  let heygenDurationSec;
  try { heygenDurationSec = JSON.parse(fs.readFileSync(path.join(root, 'src', 'video-meta.json'), 'utf-8')).heygenDurationSec; }
  catch (_) { /* 沒有 meta 就用最後一顆 word 的時間 */ }

  const result = correctSubtitles({ scriptRaw, subs, replacements, heygenDurationSec });

  for (const g of result.filledGaps) {
    const text = g.text || '';
    log(`🩹 whisper 漏聽 ${g.from}～${g.to} 秒（${g.chars} 個字「${text.slice(0, 12)}${text.length > 12 ? '…' : ''}」）`
      + ` → 已用稿件字數把時間攤平（每字 ${g.secPerChar} 秒）`);
  }
  if (result.midWordCuts > 0) log(`✂️  ${result.midWordCuts} 個斷句點原本落在 whisper word 中間，已把該 word 切開`);
  if (replacements.length) log(`🔄 套用 ${replacements.length} 條自訂替換規則（fallback）`);

  if (result.problems.length) {
    // 故意不寫回：留著 whisper 原始輸出，不讓半成品混進後面的配圖與 render。
    error('\n❌ 字幕時間軸壞掉，已停在出片前（沒有寫回 subtitles.json）\n');
    for (const p of result.problems) error(`  ・${p}\n`);
    error('  這是 whisper 在 30 秒 window 邊界的解碼失敗，不是稿件或配音的問題。');
    error('  同一個音檔原樣重跑會得到一模一樣的結果（實測跑三次完全相同），');
    error('  所以重跑時會在音檔前面墊一段靜音，換一個 window 邊界再轉；\n');
    error('  墊多少是逐支音檔碰運氣（壞掉的 pad 值每支不同），所以會依序試幾個間距拉開的值。\n');
    // 想補但補不起來的洞：是「時間軸歪掉」而不是「單純漏聽」的直接證據。
    for (const g of result.skippedGaps) {
      error(`  （${g.from}～${g.to} 秒要放 ${g.chars} 個字、每字只有 ${g.secPerChar} 秒 —— `
        + `低於可攤平的下限 ${MIN_SEC_PER_CHAR} 秒，所以沒有補它。）`);
    }
    if (result.skippedGaps.length) error('');
    return EXIT_TIMELINE_BROKEN;
  }

  if (!fs.existsSync(backupPath)) {
    fs.writeFileSync(backupPath, fs.readFileSync(subsPath, 'utf-8'));
    log(`📦 備份原始字幕 → ${path.relative(root, backupPath)}`);
  }
  fs.writeFileSync(subsPath, JSON.stringify(result.subs, null, 2));

  log(`\n✅ Forced alignment 完成！共重組 ${result.reports.length} 個 whisper word：\n`);
  for (const r of result.reports.slice(0, 40)) log(`  ${r.time}  ${r.from || '(空)'}  →  ${r.to || '(空)'}`);
  if (result.reports.length > 40) log(`  ... 還有 ${result.reports.length - 40} 筆`);
  const out = /** @type {{ _scriptBreaks: unknown[], _scriptCharTimes: unknown[] }} */ (/** @type {unknown} */ (result.subs));
  log(`\n📌 ${out._scriptBreaks.length} 個強制換幕點 / ${out._scriptCharTimes.length} 個 script char 時間戳`);
  log(`   字幕已寫回 → ${path.relative(root, subsPath)}\n`);
  log(`   想還原？刪掉 subtitles.json 改名 subtitles.original.json → subtitles.json\n`);
  return 0;
}

if (require.main === module) process.exitCode = run();

module.exports = { run, EXIT_TIMELINE_BROKEN };
