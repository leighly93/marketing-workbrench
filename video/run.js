#!/usr/bin/env node
'use strict';

/**
 * 出片主流程（只做編排）：
 *   素材 → 講者影片（HeyGen／MiniMax，與截圖分析平行）→ 備份 → 加速 → 字幕 → 配圖計畫 → 動態 → 渲染
 *
 *   node video/run.js --template=<版型> [--skip-generate] [--no-speed] [--stop-before-render | --render-only]
 *                     [--heygen-voice] [--emotion=<值>] [--avatar-iii]
 *
 * 參數說明在 run-options.js；供應者在 providers/；各步驟在 steps/、media/。
 * 前台的兩段式出片：先跑到 --stop-before-render（算完配圖計畫給人確認），確認後再用 --render-only 出片。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync, exec } = require('node:child_process');
const { workspaceRoot } = require('../shared/paths');

// Remotion 專案（src/、public/）在 video/remotion；npm 命令從 repository 根執行。
const PROJECT_DIR = path.join(__dirname, 'remotion');
const WORKSPACE_ROOT = workspaceRoot(PROJECT_DIR);
require('dotenv').config({ path: path.join(WORKSPACE_ROOT, '.env'), quiet: true });

const { parseRunOptions } = require('./run-options');
const { planPath } = require('./templates/registry');
const { cleanStaleStaging, backupJob } = require('./pipeline/public-utils');
const { createProviders, missingCredentials } = require('./providers');
const { isMockMode } = require('../shared/mock-mode');
const { createStepsWriter } = require('../shared/steps');
const { createSpeedUp } = require('./media/speed');
const { transcribeWithRetry } = require('./steps/transcribe');
const { startImageAnalysis, screenshotsIn } = require('./steps/image-analysis');
const { renderMotionClips } = require('./steps/motion');
const { generateAnchorVideo, planVoice, AnchorConfigError } = require('./steps/anchor-video');

const TEMPLATE_CLI = path.join(__dirname, 'templates', 'cli.js');
const AUTO_SHOT = path.join(__dirname, 'shots', 'auto-shot.js');
const PUBLIC_DIR = path.join(PROJECT_DIR, 'public');
const HEYGEN_PATH = path.join(PUBLIC_DIR, 'heygen.mp4');

/** 使用者要自己處理的問題（缺 key、缺檔、參數不對）：印成「❌ 原因」並結束，不印堆疊。 */
class RunError extends Error {}

/** @param {string} msg */
function log(msg) {
  console.log(`\n[${new Date().toLocaleTimeString()}] ${msg}`);
}

// 步驟記錄（_meta/steps.json）：工作台起 run.js 時用 WORKBENCH_STEPS_FILE 指定檔案；
// 手動在終端機跑沒有這個變數 → 空作業，什麼都不寫。記錄本身永不丟出，見 shared/steps.js。
const steps = createStepsWriter(process.env.WORKBENCH_STEPS_FILE);

/** 警告備註只留前面一段：錯誤訊息可能帶整段子程序輸出，前台只要看得出「哪一步、為什麼」。 */
const NOTE_LIMIT = 300;

/**
 * 跑一步並記錄：丟出的錯記成 failed 後原樣往上丟（log 行一字不改）；
 * 步驟自己吞掉、只用「⚠️」log 出來的問題（自動配圖、動態、備份都是這種）記成 warning。
 * fn 拿到的 log 就是上面那個 log，只是多盯著 ⚠️ 開頭的訊息。
 * @template T
 * @param {string} id @param {string} label
 * @param {(log: (msg: string) => void) => T} fn
 * @returns {T}
 */
function step(id, label, fn) {
  let warning = '';
  /** @param {string} msg */
  const watch = (msg) => {
    if (!warning && /^\s*⚠️/.test(String(msg))) warning = String(msg).trim().slice(0, NOTE_LIMIT);
    log(msg);
  };
  steps.start(id, { label });
  const done = () => steps.end(id, warning ? { ok: true, note: warning } : { ok: true });
  /** @param {unknown} e */
  const fail = (e) => steps.end(id, { ok: false, error: e instanceof Error ? e.message : String(e) });
  try {
    const out = fn(watch);
    if (out && typeof (/** @type {any} */ (out)).then === 'function') {
      return /** @type {T} */ (/** @type {any} */ (out).then(
        (/** @type {unknown} */ v) => { done(); return v; },
        (/** @type {unknown} */ e) => { fail(e); throw e; },
      ));
    }
    done();
    return out;
  } catch (e) {
    fail(e);
    throw e;
  }
}

// Windows（只用於開發）：工作台把 append 模式開的 log 檔直接交給 run.js 當 stdout，
// 而 MSYS bash（npm run transcribe）寫不進這種檔案控制代碼（echo: write error: Bad file descriptor）。
// 所以 Windows 上先接住子程序輸出再轉印；macOS 照舊直接繼承，長步驟能即時看到進度。
const CAPTURE_CHILD_OUTPUT = process.platform === 'win32';

/** @param {string} cmd */
function run(cmd) {
  log(`執行：${cmd}`);
  if (!CAPTURE_CHILD_OUTPUT) {
    execSync(cmd, { cwd: PROJECT_DIR, stdio: 'inherit' });
    return;
  }
  try {
    process.stdout.write(execSync(cmd, { cwd: PROJECT_DIR, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 * 64 }));
  } catch (e) {
    const err = /** @type {{ stdout?: Buffer, stderr?: Buffer }} */ (e);
    if (err.stdout) process.stdout.write(err.stdout);
    if (err.stderr) process.stderr.write(err.stderr);
    throw e;
  }
}

/**
 * 背景執行（不擋主流程），失敗不丟出，由呼叫端決定怎麼處理。
 * @param {string} cmd
 * @param {string} label
 * @returns {Promise<{ ok: boolean, label: string, cmd: string, stdout: string, stderr: string, err: Error | null }>}
 */
function runBackground(cmd, label) {
  log(`背景執行：${cmd}`);
  return new Promise((resolve) => {
    exec(cmd, { cwd: PROJECT_DIR, maxBuffer: 1024 * 1024 * 32 }, (err, stdout, stderr) => {
      resolve({ ok: !err, label, cmd, stdout: stdout || '', stderr: stderr || '', err });
    });
  });
}

/**
 * 同一時間只跑一支（.run.lock）。程序結束或被終止（關終端機、Ctrl+C、kill）都會清掉鎖。
 * 被終止不會讓生成繼續 —— 只是死得乾淨、不留鎖卡住下一次。
 */
function acquireLock() {
  const lockFile = path.join(WORKSPACE_ROOT, '.run.lock');
  if (fs.existsSync(lockFile)) {
    throw new RunError(`偵測到腳本已在執行中！請等待完成再跑。\n   鎖檔位置：${lockFile}（確認沒有產線執行後才移除）`);
  }
  fs.writeFileSync(lockFile, String(Date.now()));
  process.on('exit', () => { try { fs.unlinkSync(lockFile); } catch (_) {} });
  for (const sig of /** @type {NodeJS.Signals[]} */ (['SIGHUP', 'SIGINT', 'SIGTERM'])) {
    process.on(sig, () => {
      console.error(`\n⚠️ 收到 ${sig}（終端機被關/手動中斷），本次生成中止，清理 .run.lock`);
      process.exit(1);
    });
  }
}

/**
 * 呼叫付費 API 前先確認金鑰與版型設定都在，缺了就在這裡停（不要等素材都複製完才發現）。
 * @param {ReturnType<typeof parseRunOptions>} opts
 */
function checkGenerateConfig(opts) {
  const { useMinimax } = planVoice(opts.tpl, { heygenVoice: opts.heygenVoice });
  const missing = missingCredentials({ useMinimax });
  if (missing) throw new RunError(missing);
  return { useMinimax };
}

/** @param {ReturnType<typeof parseRunOptions>} opts @param {(msg: string) => void} [say] 步驟記錄要盯的 log */
function prepareShots(opts, say = log) {
  // 手寫標記與人工標注優先，自動配圖不碰它們標到的段落；自動配圖失敗不影響出片。
  run(`node "${TEMPLATE_CLI}" parse --template=${opts.template}`);
  try {
    run(`node "${AUTO_SHOT}" --write --out ${planPath(opts.template)}`);
  } catch (e) {
    say('⚠️ 自動配圖失敗（不影響出片，只是這支不會插圖）：' + /** @type {Error} */ (e).message);
  }
}

/** @param {ReturnType<typeof parseRunOptions>} opts */
function renderTemplate(opts) {
  // 大盤小報同一份 heygen／字幕／腳本出直式＋橫式（直式先出）；其他版型只出直式。
  run(`node "${TEMPLATE_CLI}" render --template=${opts.template}`);
}

/** @param {string[]} argv */
async function main(argv) {
  let opts;
  try { opts = parseRunOptions(argv); } catch (e) { throw new RunError(/** @type {Error} */ (e).message); }
  acquireLock();
  if (isMockMode()) log('🧪 模擬模式（WORKBENCH_MOCK=1）：HeyGen／MiniMax／字幕轉錄／OCR／動態都用本機假資料，成品不能發布');

  if (opts.renderOnly) {
    log('▶️  --render-only：沿用現有 public/ 與配圖計畫，直接 render');
    step('render', 'Remotion 渲染', () => renderTemplate(opts));
    return;
  }

  const generate = opts.skipGenerate ? null : checkGenerateConfig(opts);
  const scriptPath = path.join(PUBLIC_DIR, 'script.txt');
  if (!fs.existsSync(scriptPath)) throw new RunError('找不到 public/script.txt');

  log(`版型：${opts.tpl.emoji} ${opts.tpl.label}${opts.skipGenerate ? '（跳過生成，用現有 public/heygen.mp4）' : ''}`);
  step('assets', '複製套版素材', () => {
    // 清掉 public/ 裡非當前版型的殘留素材（源頭都在 storage/shared-assets/，可再複製回來）
    cleanStaleStaging(PROJECT_DIR, opts.template);
    log(`複製${opts.tpl.label}套版素材`);
    run(`node "${TEMPLATE_CLI}" assets --template=${opts.template}`);
  });

  // 截圖分析不需要講者影片，先啟動，跟生成平行跑。
  const imageAnalysis = startImageAnalysis({ projectDir: PROJECT_DIR, runBackground, log });
  if (imageAnalysis) {
    // 平行跑的這一步在它自己的 promise 結束時記錄，不等主流程 await 它。偵測失敗不是致命的（沿用 regions）。
    steps.start('image-analysis', { label: '截圖分析' });
    imageAnalysis.then((r) => steps.end('image-analysis', r.ok ? { ok: true } : { ok: true, note: '⚠️ 版面偵測失敗，沿用既有 regions' }));
  } else {
    // null 有兩種：沒截圖可分析，或重新出片沿用了上一支的結果（startImageAnalysis 的 reuseAppImages）。
    const reused = screenshotsIn(PUBLIC_DIR).length > 0;
    steps.skip('image-analysis', { label: '截圖分析', note: reused ? '沿用上一支的版面偵測結果' : '沒有截圖' });
  }

  if (!generate) {
    if (!fs.existsSync(HEYGEN_PATH)) throw new RunError('--skip-generate 但找不到 public/heygen.mp4，請先手動放好影片檔');
    log('✅ 找到現有 public/heygen.mp4，跳過 HeyGen/MiniMax 生成');
    steps.skip('generate', { label: '生成講者影片', note: '用現成的講者影片' });
  } else {
    log('讀取 script.txt');
    await step('generate', '生成講者影片', () => generateAnchorVideo({
      tpl: opts.tpl,
      rawScript: fs.readFileSync(scriptPath, 'utf-8'),
      heygenPath: HEYGEN_PATH,
      minimaxAudioPath: path.join(PUBLIC_DIR, 'minimax.mp3'),
      heygenVoice: opts.heygenVoice,
      ...createProviders({ useMinimax: generate.useMinimax, aspectRatio: opts.tpl.anchor.aspectRatio, engine: opts.engine, emotion: opts.emotion, log }),
      log,
    }));
  }

  // 備份一定在加速之前：原速的講者影片永遠救得回來（2026-08-12 排在加速之後，重跑兩次就把原檔洗掉了）。
  step('backup', '備份講者影片', (say) => {
    try {
      backupJob(PROJECT_DIR, opts.template, WORKSPACE_ROOT);
    } catch (e) {
      say('⚠️ 自動備份失敗（不影響出片）：' + /** @type {Error} */ (e).message);
    }
  });

  // 125% 加速（保持音調）。無論影片是現生的還是 --skip-generate 手動放的都要加速（使用者定案）；
  // 這是全流程唯一的加速點，speed.js 另外擋同一輪與跨輪的重複加速。
  if (opts.noSpeed) {
    log('⏩ 已指定 --no-speed，跳過 125% 加速（保留原始速度）');
    steps.skip('speed', { label: '加速 125%', note: '已指定 --no-speed，保留原始速度' });
  } else step('speed', '加速 125%', () => createSpeedUp({ log }).speedUp(HEYGEN_PATH, '固定主播版型'));

  if (imageAnalysis) {
    const r = await imageAnalysis;
    if (r.ok) log('✅ 版面偵測完成（與生成平行）：\n' + r.stdout.trim().split('\n').slice(-6).join('\n'));
    else {
      log('⚠️ 版面偵測失敗，沿用既有 regions（影片照樣出）。');
      log('   若要聚焦/高亮對位正確，Mac 請先安裝一次：brew install tesseract tesseract-lang');
    }
  }

  log('開始 Remotion 後製');
  step('transcribe', '字幕轉錄', () => transcribeWithRetry({ run, log }));
  step('shots', '配圖計畫', (say) => prepareShots(opts, say));
  // 動態排在字幕之後（要用字幕時間軸）、配圖之後（配圖是主、動態是補）；失敗一律降級成這支沒有動態。
  step('motion-clips', '動態小影片', (say) => renderMotionClips({ projectDir: PROJECT_DIR, template: opts.template, run, log: say }));

  if (opts.stopBeforeRender) {
    log('⏸  已指定 --stop-before-render：配圖計畫算好了，這裡停下不 render。');
    log('   前台會把計畫拿去給人看，確認後再用 --render-only 接著跑。');
    return;
  }
  step('render', 'Remotion 渲染', () => renderTemplate(opts));
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    // 還在跑的步驟（例如與生成平行的截圖分析）一併記成失敗，前台才看得出是在哪一步斷掉的。
    steps.failRunning(err.message);
    if (err instanceof RunError || err instanceof AnchorConfigError) console.error(`❌ ${err.message}`);
    else console.error('\n❌ 錯誤：', err.message);
    process.exit(1);
  });
}

module.exports = { main, RunError };
