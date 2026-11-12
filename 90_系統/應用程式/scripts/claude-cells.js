#!/usr/bin/env node
'use strict';

/**
 * Claude 挑框「旁觀模式」的背景比對（2026-11-11）。
 *
 * 伺服器在「確認，開始出片」之後 spawn 這支（不等它），每一段配圖問一次 Claude 會框哪裡，
 * 跟人工最後畫的框、規則庫的建議（cell-suggest.json）一起算重疊率，
 * 一段一行附加到 90_系統/資料/claude-cells.jsonl。**不碰影片、不改配圖計畫。**
 *
 * 用法：
 *   node scripts/claude-cells.js --in=<段落.json> --state=<工作快照資料夾> --out=<結果.json>
 *        [--suggest=<cell-suggest.json>] [--job=<工作ID>] [--no-append]
 *   段落：[{ src, startCharIdx, endCharIdx, phrase, cell, region, imgW, imgH }]（cell/region 是人工最後的框）
 *
 * 最後一行印出摘要，伺服器原樣寫進工作的 log。
 */

const fs = require('node:fs');
const path = require('node:path');
const { dataPath, workspaceRoot } = require('../../paths');

const ROOT = path.resolve(__dirname, '..');
// .env 要在引擎載入前讀：CELL_PICKER 是在 cell-picker-engine.js 載入時讀的
try { require('dotenv').config({ path: path.join(workspaceRoot(ROOT), '.env'), quiet: true }); } catch (_) {}

const { pickImageSize } = require('./image-size');
const { iou } = require('./cell-picker');
const engine = require('./cell-picker-engine');

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

const box = (x) => (x && x.w > 0 && x.h > 0
  ? { x: Math.round(x.x), y: Math.round(x.y), w: Math.round(x.w), h: Math.round(x.h) } : null);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) { return fallback; }
}

/** 重疊率 ≥ 這個值算「框到同一塊」 */
const HIT = 0.5;

function main() {
  const inFile = arg('in');
  const state = arg('state');
  const outFile = arg('out');
  if (!inFile || !state || !outFile) {
    console.error('用法：node scripts/claude-cells.js --in=… --state=… --out=…');
    process.exit(2);
  }
  const items = readJson(inFile, []);
  const analysis = readJson(path.join(state, 'src', 'app-images.generated.json'), { images: [] });
  const images = new Map((analysis.images || []).map((im) => [im.file, im]));
  const suggest = new Map((readJson(arg('suggest') || '', []) || [])
    .map((r) => [`${r.src}@${r.startCharIdx}~${r.endCharIdx}`, r]));
  const jobId = arg('job');

  const results = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || !it.src || typeof it.startCharIdx !== 'number' || typeof it.endCharIdx !== 'number') continue;
    const lo = Math.min(it.startCharIdx, it.endCharIdx);
    const hi = Math.max(it.startCharIdx, it.endCharIdx);
    const img = images.get(it.src);
    const size = pickImageSize(img, it);
    const manualCell = box(it.cell);
    const sys = suggest.get(`${it.src}@${lo}~${hi}`);
    const systemCell = sys ? box(sys.cell) : null;
    let claude;
    if (!img) claude = { status: 'failed', error: '分析檔裡沒有這張圖' };
    else if (size.stale) claude = { status: 'failed', error: '分析檔的尺寸跟這張圖對不上（舊分析），不採用' };
    else {
      claude = engine.pick({
        imagePath: path.join(state, 'public', it.src),
        words: img.words || [],
        width: size.width,
        height: size.height,
        phrase: it.phrase || '',
        page: img.page,
      });
    }
    results.push({
      at: new Date().toISOString(),
      jobId,
      src: it.src,
      startCharIdx: lo,
      endCharIdx: hi,
      phrase: it.phrase || '',
      size: size.width && size.height ? { w: size.width, h: size.height } : null,
      manualCell,
      manualRegion: box(it.region),
      systemCell,
      claude,
      iouClaude: claude.status === 'picked' ? iou(claude.cell, manualCell) : null,
      iouSystem: iou(systemCell, manualCell),
    });
  }

  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  if (!process.argv.includes('--no-append') && results.length) {
    const log = dataPath(workspaceRoot(ROOT), 'claude-cells.jsonl');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.appendFileSync(log, results.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  console.log(summary(results));
}

/** 一行摘要：以「人工有畫框」的段落為分母比命中率；人工沒畫框的段落另外數 Claude 有沒有忍住不框。 */
function summary(results) {
  if (!results.length) return 'Claude 框選對照：沒有可比對的段落';
  const count = (f) => results.filter(f).length;
  const failed = count((r) => r.claude.status === 'failed');
  const withManual = results.filter((r) => r.manualCell);
  const parts = [`Claude 框選對照：${results.length} 段`];
  if (withManual.length) {
    const c = count((r) => r.manualCell && r.iouClaude != null && r.iouClaude >= HIT);
    const s = count((r) => r.manualCell && r.iouSystem != null && r.iouSystem >= HIT);
    parts.push(`你有畫框的 ${withManual.length} 段裡，Claude 框到同一塊 ${c} 段、規則庫 ${s} 段`);
  }
  const noManual = results.filter((r) => !r.manualCell && r.claude.status !== 'failed');
  if (noManual.length) {
    parts.push(`你沒畫框的 ${noManual.length} 段裡，Claude 也沒框 ${noManual.filter((r) => r.claude.status === 'none').length} 段`);
  }
  if (failed) {
    const first = results.find((r) => r.claude.status === 'failed');
    parts.push(`${failed} 段失敗（${first.claude.error}）`);
  }
  return parts.join('；');
}

if (require.main === module) main();

module.exports = { summary };
