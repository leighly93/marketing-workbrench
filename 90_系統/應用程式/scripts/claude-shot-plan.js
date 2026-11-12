#!/usr/bin/env node
'use strict';

/**
 * Claude 排配圖（2026-11-12）：稿件＋截圖 → public/claude-annotations.json（跟標注頁的 annotations.json 同格式）。
 *
 * 使用者定案：「連圖片辨識都由 Claude 來，APP 截圖都像 skill 那樣呈現，先不管人工的設定了」，
 * 出片前仍停在配圖計畫頁讓人看。流程：
 *   ① planAssignments：所有截圖＋子句清單一次問 → 哪張圖配哪幾句、卡片小標題
 *   ② 每段 pick({ withCrop })：要裁哪一塊做卡片（region）、金框框哪裡（cell）
 * run.js 在 OCR 跑完後背景執行這支（跟 HeyGen 平行），auto-shot 用 --annots-file 吃它的結果；
 * 這支失敗或沒排出任何一段 → 不寫檔，auto-shot 照舊吃人工標注。
 *
 * 用法：node scripts/claude-shot-plan.js [--script=public/script.txt] [--images=src/app-images.generated.json]
 *        [--public=public] [--motion=public/motion.json] [--out=public/claude-annotations.json]
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { workspaceRoot } = require('../../paths');

const ROOT = path.resolve(__dirname, '..');
try { require('dotenv').config({ path: path.join(workspaceRoot(ROOT), '.env'), quiet: true }); } catch (_) {}

const { imageSize, pickImageSize } = require('./image-size');
const engine = require('./cell-picker-engine');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return path.resolve(ROOT, hit ? hit.slice(name.length + 3) : fallback);
}

const SCRIPT = arg('script', 'public/script.txt');
const IMAGES = arg('images', 'src/app-images.generated.json');
const PUBLIC = arg('public', 'public');
const OUT = arg('out', 'public/claude-annotations.json');

function done(msg, code = 0) {
  console.log(msg);
  process.exit(code);
}

function main() {
  // 上一支留下的結果一定先清掉：沒排出來的時候，auto-shot 不能吃到別支的配圖
  try { fs.unlinkSync(OUT); } catch (_) {}
  if (!engine.enabled()) done('Claude 排配圖：已關閉（CELL_PICKER=off），照舊用人工標注');

  let units = [];
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'auto-shot.js'), '--sentences', `--script=${SCRIPT}`, `--images=${IMAGES}`],
      { cwd: ROOT, encoding: 'utf-8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    units = (JSON.parse(out).units || []).filter((u) => u.startCharIdx != null && u.endCharIdx != null);
  } catch (e) {
    done(`Claude 排配圖：讀不到稿件子句（${e.message.slice(0, 120)}），照舊用人工標注`);
  }

  // 已經設了動態小影片的句子不配圖：動態會蓋在截圖上面，配了也看不到（2026-11-12 實測「縮量反彈」那段）
  const MOTION = arg('motion', 'public/motion.json');
  let motion = [];
  try { motion = JSON.parse(fs.readFileSync(MOTION, 'utf-8')); } catch (_) {}
  const inMotion = (u) => (Array.isArray(motion) ? motion : []).some((m) => m
    && typeof m.startCharIdx === 'number' && typeof m.endCharIdx === 'number'
    && !(u.endCharIdx < m.startCharIdx || u.startCharIdx > m.endCharIdx));
  const before = units.length;
  units = units.filter((u) => !inMotion(u));
  if (units.length < before) console.log(`（${before - units.length} 個子句已經有動態小影片，不配圖）`);

  let analysis = { images: [] };
  try { analysis = JSON.parse(fs.readFileSync(IMAGES, 'utf-8')); } catch (_) {}
  const images = [];
  for (const im of analysis.images || []) {
    const file = path.join(PUBLIC, im.file);
    if (!fs.existsSync(file)) continue;
    const real = imageSize(file) || {};
    const size = pickImageSize(im, { imgW: real.width, imgH: real.height });
    // 分析檔是別張同名圖留下的（尺寸對不上）→ 圖照送，但 OCR 字不能用
    images.push({ file: im.file, path: file, width: size.width, height: size.height, words: size.stale ? [] : (im.words || []), page: im.page });
  }
  if (!images.length) done('Claude 排配圖：沒有截圖，照舊用人工標注');

  const plan = engine.planAssignments({ units, images });
  if (plan.status !== 'planned') done(`Claude 排配圖：第一步失敗（${plan.error || plan.status}），照舊用人工標注`);
  if (!plan.segments.length) done('Claude 排配圖：Claude 判斷沒有句子適合配圖，照舊用人工標注');

  const shots = [];
  let boxed = 0;
  for (const seg of plan.segments) {
    const im = images.find((x) => x.file === seg.src);
    const phrase = units.filter((u) => u.startCharIdx >= seg.startCharIdx && u.endCharIdx <= seg.endCharIdx)
      .map((u) => u.text).join('');
    const r = engine.pick({
      imagePath: im.path, words: im.words, width: im.width, height: im.height, phrase, page: im.page, withCrop: true,
    });
    const cell = r.status === 'picked' ? r.cell : null;
    if (cell) boxed++;
    shots.push({
      src: seg.src,
      startCharIdx: seg.startCharIdx,
      endCharIdx: seg.endCharIdx,
      title: seg.title,
      // region＝卡片要裁的那一塊；第二步失敗就整張
      region: r.crop || { x: 0, y: 0, w: im.width, h: im.height },
      ...(cell ? { cell } : {}),
      imgW: im.width,
      imgH: im.height,
      _claude: { why: seg.why, cellStatus: r.status, cellSource: r.source || null, cellWhy: r.why || r.error || '' },
    });
  }

  fs.writeFileSync(OUT, JSON.stringify({ by: 'claude', at: new Date().toISOString(), shots }, null, 2));
  const lines = shots.map((s) => `   ${s.src}「${s.title}」字 ${s.startCharIdx}–${s.endCharIdx}${s.cell ? '' : '（不框）'}`);
  done(`Claude 排配圖：${shots.length} 段（${boxed} 段有金框）→ ${path.relative(ROOT, OUT)}\n${lines.join('\n')}`);
}

main();
