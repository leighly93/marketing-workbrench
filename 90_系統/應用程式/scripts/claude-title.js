#!/usr/bin/env node
'use strict';

/**
 * Claude 拆標題（2026-11-12，大盤小報）：稿件標題段只有一行 → 問 Claude 切成白、黃兩行 → public/claude-title.txt。
 *
 * 使用者定案：「建立工作那標題改一行就好，之後給 Claude 自己辨識」。
 * run.js 在一開始就背景執行（跟 HeyGen 平行，不多花時間）；parse-dapan-script.js 寫 titleText 時
 * 看到這個檔就用它。失敗、標題本來就兩行、或 CELL_PICKER=off → 不寫檔，渲染端照標點自己切（title-layout.ts）。
 * 不寫字幕、不碰其他欄位；回覆一定要跟原標題一字不差（title-splitter.js 的 parseReply 驗證）。
 *
 * 用法：node scripts/claude-title.js [--script=public/script.txt] [--out=public/claude-title.txt]
 */

const fs = require('node:fs');
const path = require('node:path');
const { workspaceRoot } = require('../../paths');

const ROOT = path.resolve(__dirname, '..');
try { require('dotenv').config({ path: path.join(workspaceRoot(ROOT), '.env'), quiet: true }); } catch (_) {}

const splitter = require('./title-splitter');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return path.resolve(ROOT, hit ? hit.slice(name.length + 3) : fallback);
}

const SCRIPT = arg('script', 'public/script.txt');
const OUT = arg('out', 'public/claude-title.txt');

function done(msg) {
  console.log(msg);
  process.exit(0);
}

/** 跟 parse-dapan-script.js 同一個取法：「body 前一段」 */
function titleOf(raw) {
  const parts = raw.split('===');
  return parts.length >= 3 ? parts[parts.length - 2].trim() : '';
}

function main() {
  try { fs.unlinkSync(OUT); } catch (_) {}   // 上一支留下的一定先清，不能套到別支的標題
  if ((process.env.CELL_PICKER || 'claude-cli').toLowerCase() === 'off') done('Claude 拆標題：已關閉（CELL_PICKER=off），照標點切');
  let title = '';
  try { title = titleOf(fs.readFileSync(SCRIPT, 'utf-8')); } catch (e) { done(`Claude 拆標題：讀不到稿件（${e.message}）`); }
  if (!title) done('Claude 拆標題：稿件沒有標題段');
  if (!splitter.needsSplit(title)) done('Claude 拆標題：標題本來就分好行，照原樣');
  const { runClaude } = require('./claude-cli');
  const r = runClaude({ prompt: splitter.buildPrompt(title), system: splitter.SYSTEM_PROMPT, timeoutMs: 120000 });
  if (!r.ok) done(`Claude 拆標題：失敗（${r.error}），照標點切`);
  const lines = splitter.parseReply(r.text, title);
  if (!lines) done(`Claude 拆標題：回覆不合格（要一字不差、剛好兩行）：${r.text.slice(0, 160)}，照標點切`);
  fs.writeFileSync(OUT, lines.join('\n') + '\n');
  done(`Claude 拆標題：${lines[0]} ／ ${lines[1]}`);
}

main();
