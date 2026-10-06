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
const { createHeyGenClient } = require('./providers/heygen');
const { createMiniMaxClient } = require('./providers/minimax');
const { createSpeedUp } = require('./media/speed');
const { transcribeWithRetry } = require('./steps/transcribe');
const { startImageAnalysis } = require('./steps/image-analysis');
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

/** @param {string} cmd */
function run(cmd) {
  log(`執行：${cmd}`);
  execSync(cmd, { cwd: PROJECT_DIR, stdio: 'inherit' });
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
  if (!process.env.HEYGEN_API_KEY) throw new RunError('缺少 HEYGEN_API_KEY（請填到 .env）');
  const { useMinimax } = planVoice(opts.tpl, { heygenVoice: opts.heygenVoice });
  if (useMinimax && (!process.env.MINIMAX_API_KEY || !process.env.MINIMAX_GROUP_ID)) {
    throw new RunError('缺少 MINIMAX_API_KEY 或 MINIMAX_GROUP_ID（請填到 .env）\n'
      + '   固定主播預設用 MiniMax 配音；不想加 key 的話，指令加 --heygen-voice 改用 HeyGen 內建語音。');
  }
  return { useMinimax };
}

/** @param {ReturnType<typeof parseRunOptions>} opts */
function prepareShots(opts) {
  // 手寫標記與人工標注優先，自動配圖不碰它們標到的段落；自動配圖失敗不影響出片。
  run(`node "${TEMPLATE_CLI}" parse --template=${opts.template}`);
  try {
    run(`node "${AUTO_SHOT}" --write --out ${planPath(opts.template)}`);
  } catch (e) {
    log('⚠️ 自動配圖失敗（不影響出片，只是這支不會插圖）：' + /** @type {Error} */ (e).message);
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

  if (opts.renderOnly) {
    log('▶️  --render-only：沿用現有 public/ 與配圖計畫，直接 render');
    renderTemplate(opts);
    return;
  }

  const generate = opts.skipGenerate ? null : checkGenerateConfig(opts);
  const scriptPath = path.join(PUBLIC_DIR, 'script.txt');
  if (!fs.existsSync(scriptPath)) throw new RunError('找不到 public/script.txt');

  log(`版型：${opts.tpl.emoji} ${opts.tpl.label}${opts.skipGenerate ? '（跳過生成，用現有 public/heygen.mp4）' : ''}`);
  // 清掉 public/ 裡非當前版型的殘留素材（源頭都在 storage/shared-assets/，可再複製回來）
  cleanStaleStaging(PROJECT_DIR, opts.template);
  log(`複製${opts.tpl.label}套版素材`);
  run(`node "${TEMPLATE_CLI}" assets --template=${opts.template}`);

  // 截圖分析不需要講者影片，先啟動，跟生成平行跑。
  const imageAnalysis = startImageAnalysis({ projectDir: PROJECT_DIR, runBackground, log });

  if (!generate) {
    if (!fs.existsSync(HEYGEN_PATH)) throw new RunError('--skip-generate 但找不到 public/heygen.mp4，請先手動放好影片檔');
    log('✅ 找到現有 public/heygen.mp4，跳過 HeyGen/MiniMax 生成');
  } else {
    log('讀取 script.txt');
    await generateAnchorVideo({
      tpl: opts.tpl,
      rawScript: fs.readFileSync(scriptPath, 'utf-8'),
      heygenPath: HEYGEN_PATH,
      minimaxAudioPath: path.join(PUBLIC_DIR, 'minimax.mp3'),
      heygenVoice: opts.heygenVoice,
      heygen: createHeyGenClient({ apiKey: /** @type {string} */ (process.env.HEYGEN_API_KEY), aspectRatio: opts.tpl.anchor.aspectRatio, engine: opts.engine, log }),
      minimax: generate.useMinimax
        ? createMiniMaxClient({ apiKey: /** @type {string} */ (process.env.MINIMAX_API_KEY), groupId: /** @type {string} */ (process.env.MINIMAX_GROUP_ID), emotion: opts.emotion, log })
        : undefined,
      log,
    });
  }

  // 備份一定在加速之前：原速的講者影片永遠救得回來（2026-08-12 排在加速之後，重跑兩次就把原檔洗掉了）。
  try {
    backupJob(PROJECT_DIR, opts.template, WORKSPACE_ROOT);
  } catch (e) {
    log('⚠️ 自動備份失敗（不影響出片）：' + /** @type {Error} */ (e).message);
  }

  // 125% 加速（保持音調）。無論影片是現生的還是 --skip-generate 手動放的都要加速（使用者定案）；
  // 這是全流程唯一的加速點，speed.js 另外擋同一輪與跨輪的重複加速。
  if (opts.noSpeed) log('⏩ 已指定 --no-speed，跳過 125% 加速（保留原始速度）');
  else createSpeedUp({ log }).speedUp(HEYGEN_PATH, '固定主播版型');

  if (imageAnalysis) {
    const r = await imageAnalysis;
    if (r.ok) log('✅ 版面偵測完成（與生成平行）：\n' + r.stdout.trim().split('\n').slice(-6).join('\n'));
    else {
      log('⚠️ 版面偵測失敗，沿用既有 regions（影片照樣出）。');
      log('   若要聚焦/高亮對位正確，Mac 請先安裝一次：brew install tesseract tesseract-lang');
    }
  }

  log('開始 Remotion 後製');
  transcribeWithRetry({ run, log });
  prepareShots(opts);
  // 動態排在字幕之後（要用字幕時間軸）、配圖之後（配圖是主、動態是補）；失敗一律降級成這支沒有動態。
  renderMotionClips({ projectDir: PROJECT_DIR, template: opts.template, run, log });

  if (opts.stopBeforeRender) {
    log('⏸  已指定 --stop-before-render：配圖計畫算好了，這裡停下不 render。');
    log('   前台會把計畫拿去給人看，確認後再用 --render-only 接著跑。');
    return;
  }
  renderTemplate(opts);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    if (err instanceof RunError || err instanceof AnchorConfigError) console.error(`❌ ${err.message}`);
    else console.error('\n❌ 錯誤：', err.message);
    process.exit(1);
  });
}

module.exports = { main, RunError };
