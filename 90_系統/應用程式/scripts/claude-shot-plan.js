#!/usr/bin/env node
'use strict';

/**
 * Claude 排配圖（2026-11-12）：稿件＋截圖 → public/claude-annotations.json（跟標注頁的 annotations.json 同格式）。
 *
 * 使用者定案：「連圖片辨識都由 Claude 來，APP 截圖都像 skill 那樣呈現，先不管人工的設定了」，
 * 出片前仍停在配圖計畫頁讓人看。流程：
 *   ① planAssignments：所有截圖＋子句清單一次問 → 哪張圖配哪幾句、卡片小標題、動態小影片放哪（開頭＋結尾各一段）
 *   ② 每段 pickCard：卡片要裁哪一塊（region，整段共用），每一句的金框（cell）—— 金框跟著旁白往下移，
 *      所以一段會寫成好幾筆標注：同一張圖、同一個 region、各自的 cell 與字元範圍
 * 動態寫在 public/claude-motion.json（render-motion 的輸入格式）；人工設的動態這支不用。
 * run.js 在 OCR 跑完後背景執行這支（跟 HeyGen 平行），auto-shot 用 --annots-file 吃它的結果；
 * 這支失敗或沒排出任何一段 → 不寫檔，auto-shot 照舊吃人工標注。
 *
 * 用法：node scripts/claude-shot-plan.js [--script=public/script.txt] [--images=src/app-images.generated.json]
 *        [--public=public] [--out=public/claude-annotations.json] [--motion-out=public/claude-motion.json]
 *        [--note=public/claude-note.txt] [--facts-out=public/claude-facts.json]
 * 補充字卡（2026-11-13）寫在 public/claude-facts.json：[{ startCharIdx, endCharIdx, items:[{label,value,tone}] }]，
 * parse-dapan-script.js 把它寫進 video-meta.json.factCards，渲染端（FactCards.tsx）照字元位置換算時間。
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
const MOTION_OUT = arg('motion-out', 'public/claude-motion.json');
const FACTS_OUT = arg('facts-out', 'public/claude-facts.json');
// 重新出片時寫給 Claude 的指示（2026-11-12，只影響那一支）
const NOTE = (() => { try { return fs.readFileSync(arg('note', 'public/claude-note.txt'), 'utf-8').trim(); } catch (_) { return ''; } })();

function done(msg, code = 0) {
  console.log(msg);
  process.exit(code);
}

function main() {
  // 上一支留下的結果一定先清掉：沒排出來的時候，auto-shot 不能吃到別支的配圖
  try { fs.unlinkSync(OUT); } catch (_) {}
  try { fs.unlinkSync(MOTION_OUT); } catch (_) {}
  try { fs.unlinkSync(FACTS_OUT); } catch (_) {}
  if (!engine.enabled()) done('Claude 排配圖：已關閉（CELL_PICKER=off），照舊用人工標注');

  let units = [];
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'auto-shot.js'), '--sentences', `--script=${SCRIPT}`, `--images=${IMAGES}`],
      { cwd: ROOT, encoding: 'utf-8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    units = (JSON.parse(out).units || []).filter((u) => u.startCharIdx != null && u.endCharIdx != null);
  } catch (e) {
    done(`Claude 排配圖：讀不到稿件子句（${e.message.slice(0, 120)}），照舊用人工標注`);
  }

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

  if (NOTE) console.log(`（這支有給 Claude 的指示：${NOTE.slice(0, 80)}${NOTE.length > 80 ? '…' : ''}）`);
  const plan = engine.planAssignments({ units, images, note: NOTE });
  if (plan.status !== 'planned') done(`Claude 排配圖：第一步失敗（${plan.error || plan.status}），照舊用人工標注`);
  if (!plan.segments.length) done('Claude 排配圖：Claude 判斷沒有句子適合配圖，照舊用人工標注');

  const shots = [];
  let boxed = 0;
  for (const seg of plan.segments) {
    const im = images.find((x) => x.file === seg.src);
    const segUnits = units.filter((u) => u.startCharIdx >= seg.startCharIdx && u.endCharIdx <= seg.endCharIdx);
    const steps = segUnits.map((u) => ({ id: `U${u.i}`, text: u.text, startCharIdx: u.startCharIdx, endCharIdx: u.endCharIdx }));
    const r = steps.length
      ? engine.pickCard({ imagePath: im.path, words: im.words, width: im.width, height: im.height, steps, page: im.page, note: NOTE })
      : { status: 'failed', error: '這段沒有完整的子句' };
    const region = r.status === 'picked' ? r.crop : { x: 0, y: 0, w: im.width, h: im.height };
    const base = { src: seg.src, title: seg.title, region, imgW: im.width, imgH: im.height };
    if (r.status !== 'picked') {
      shots.push({ ...base, startCharIdx: seg.startCharIdx, endCharIdx: seg.endCharIdx,
        _claude: { why: seg.why, cellStatus: r.status, cellWhy: r.error || '' } });
      continue;
    }
    // 連續幾句框同一個地方（或都不框）就併成一筆；第一筆從段落開頭、最後一筆到段落結尾
    const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
    const groups = [];
    r.steps.forEach((st, k) => {
      const last = groups[groups.length - 1];
      if (last && same(last.cell, st.cell)) { last.end = steps[k].endCharIdx; return; }
      groups.push({ cell: st.cell, start: steps[k].startCharIdx, end: steps[k].endCharIdx, why: st.why, source: st.source });
    });
    groups[0].start = seg.startCharIdx;
    groups[groups.length - 1].end = seg.endCharIdx;
    for (const g of groups) {
      if (g.cell) boxed++;
      shots.push({ ...base, startCharIdx: g.start, endCharIdx: g.end, ...(g.cell ? { cell: g.cell } : {}),
        _claude: { why: seg.why, cellSource: g.source, cellWhy: g.why } });
    }
  }

  // 一句話裡最後一張圖留到那句講完（shot-planner.js 的 extendToSentenceEnd）
  const finalShots = require('./shot-planner').extendToSentenceEnd(shots, units, plan.motions || []);
  shots.length = 0;
  shots.push(...finalShots);

  if (plan.motions && plan.motions.length) {
    fs.writeFileSync(MOTION_OUT, JSON.stringify(plan.motions.map((m) => ({ startCharIdx: m.startCharIdx, endCharIdx: m.endCharIdx })), null, 2) + '\n');
  }
  // 補充字卡：避開最終的截圖段（已延到句尾）與動態段
  const planner = require('./shot-planner');
  const facts = planner.parseFacts(plan.reply || '', { units, taken: shots.concat(plan.motions || []) });
  if (facts.length) fs.writeFileSync(FACTS_OUT, JSON.stringify(facts, null, 2) + '\n');
  fs.writeFileSync(OUT, JSON.stringify({ by: 'claude', at: new Date().toISOString(), shots }, null, 2));
  const lines = shots.map((s) => `   ${s.src}「${s.title}」字 ${s.startCharIdx}–${s.endCharIdx}${s.cell ? '' : '（不框）'}`);
  const mlines = (plan.motions || []).map((m) => `   動態 字 ${m.startCharIdx}–${m.endCharIdx}（${m.why}）`);
  const flines = facts.map((f) => `   字卡 字 ${f.startCharIdx}–${f.endCharIdx}：${f.items.map((it) => `${it.label} ${it.value}`).join('｜')}`);
  done(`Claude 排配圖：${plan.segments.length} 張卡片、${shots.length} 段金框位置（${boxed} 段有框）、`
    + `${(plan.motions || []).length} 段動態、${facts.length} 張補充字卡 → ${path.relative(ROOT, OUT)}\n${lines.concat(mlines, flines).join('\n')}`);
}

main();
