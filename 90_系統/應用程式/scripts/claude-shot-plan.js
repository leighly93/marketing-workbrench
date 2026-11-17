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
 * 結尾「明天要看的事」（2026-11-16，outlook.js）：程式找位置，寫進 claude-motion.json 的一筆（kind: 'outlook'）。
 *   沒有截圖、或排配圖失敗時也照寫（只寫這一筆），除非這支有人工設的動態（public/motion.json）。
 * 截圖檔名提示（2026-11-16，shot-name-hints.js）：public/shot-names.json 記著每張 shotN 的原始檔名，
 *   對得到稿件的就一定配在那幾句。
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
const SHOT_NAMES = arg('shot-names', 'public/shot-names.json');
const MANUAL_MOTION = arg('manual-motion', 'public/motion.json');
// 重新出片時寫給 Claude 的指示（2026-11-12，只影響那一支）
const NOTE = (() => { try { return fs.readFileSync(arg('note', 'public/claude-note.txt'), 'utf-8').trim(); } catch (_) { return ''; } })();
// 「照修正重新出片」（2026-11-17）：上一支在成品頁檢查配圖時人改過的段落 —— 鎖住照人的
//   { fixed: [{ startCharIdx, endCharIdx, src, region, cell, imgW, imgH }], hints: [{ startCharIdx, endCharIdx, src }], noShot: [{ startCharIdx, endCharIdx }] }
const FIXED = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(arg('fixed', 'public/claude-fixed.json'), 'utf-8'));
    return { fixed: j.fixed || [], hints: j.hints || [], noShot: j.noShot || [] };
  } catch (_) { return { fixed: [], hints: [], noShot: [] }; }
})();

function done(msg, code = 0) {
  console.log(msg);
  process.exit(code);
}

/** 人工設的動態有幾段（public/motion.json）。有的話，排配圖沒成功時不寫明日觀察 —— run.js 會改吃 claude-motion.json、把人工的蓋掉 */
function manualMotionCount() {
  try { const j = JSON.parse(fs.readFileSync(MANUAL_MOTION, 'utf-8')); return Array.isArray(j) ? j.length : 0; } catch (_) { return 0; }
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

  // 結尾「明天要看的事」：程式找，不交給 Claude（2026-11-16）
  const planner = require('./shot-planner');
  const outlook = require('./outlook').findOutlook(units);
  if (outlook) {
    const said = units.slice(outlook.from, outlook.to + 1).map((u) => u.text).join('');
    console.log(`（結尾明日觀察：U${units[outlook.from].i}～U${units[outlook.to].i}「${said.slice(0, 30)}${said.length > 30 ? '…' : ''}」`
      + `${outlook.markers.length ? `，序號 ${outlook.markers.join('、')}` : ''}）`);
  }
  /** 排配圖沒排成時的退路：只寫明日觀察那一段（人工設過動態就不寫，見 manualMotionCount） */
  const doneWithOutlook = (msg) => {
    if (outlook && !manualMotionCount()) {
      fs.writeFileSync(MOTION_OUT, JSON.stringify([planner.outlookMotion(outlook, units)], null, 2) + '\n');
      msg += '；結尾明日觀察動畫照做';
    }
    done(msg);
  };

  let analysis = { images: [] };
  try { analysis = JSON.parse(fs.readFileSync(IMAGES, 'utf-8')); } catch (_) {}
  const images = [];
  for (const im of analysis.images || []) {
    const file = path.join(PUBLIC, im.file);
    if (!fs.existsSync(file)) continue;
    const real = imageSize(file) || {};
    const size = pickImageSize(im, { imgW: real.width, imgH: real.height });
    // 分析檔是別張同名圖留下的（尺寸對不上）→ 圖照送，但 OCR 字不能用
    images.push({ file: im.file, path: file, width: size.width, height: size.height, words: size.stale ? [] : (im.words || []),
      page: size.stale ? 'unknown' : im.page, stockCode: size.stale ? null : im.stockCode });
  }
  // 分析檔裡沒有的截圖（事後補上傳、或沿用了不完整的舊分析）也要給 Claude 看：圖照送，只是沒有 OCR 字。
  // 2026-11-13 j2ps：shot12～14.jpg 不在分析檔裡，整理好的營收表一張都沒用到。
  const TEMPLATE_ASSET = /^(dapan|focusstock|institution|midday|usstock)-|^(frame|logo)\.png$|^NotoSans|^NotoSerif/i;
  const listed = new Set(images.map((im) => im.file));
  let extra = [];
  try {
    extra = fs.readdirSync(PUBLIC).filter((f) => /\.(png|jpe?g)$/i.test(f) && !TEMPLATE_ASSET.test(f) && !listed.has(f));
  } catch (_) {}
  for (const f of extra.sort((x, y) => x.localeCompare(y, undefined, { numeric: true }))) {
    const real = imageSize(path.join(PUBLIC, f));
    if (!real) continue;
    images.push({ file: f, path: path.join(PUBLIC, f), width: real.width, height: real.height, words: [], page: 'unknown' });
  }
  if (extra.length) console.log(`（分析檔裡沒有、照樣給 Claude 看的截圖：${extra.join('、')}）`);
  // 照檔名的數字順序排（shot1、shot2…shot10），不照字串排（shot1、shot10、shot11、shot2…）。
  // 2026-11-13 j2ps 14 張圖：清單寫「圖3（shot11.png）」，Claude 把「圖3」當成 shot3 回，整排錯位。
  images.sort((x, y) => x.file.localeCompare(y.file, undefined, { numeric: true }));
  if (!images.length) doneWithOutlook('Claude 排配圖：沒有截圖，照舊用人工標注');

  // 截圖原始檔名提示（上傳時記在 shot-names.json）
  let shotNames = {};
  try { shotNames = JSON.parse(fs.readFileSync(SHOT_NAMES, 'utf-8')) || {}; } catch (_) {}
  const present = Object.fromEntries(Object.entries(shotNames).filter(([f]) => images.some((im) => im.file === f)));
  const { hints, notes } = require('./shot-name-hints').resolveHints(present, units);
  for (const im of images) if (hints[im.file]) im.hint = hints[im.file];
  for (const [f, h] of Object.entries(hints)) {
    const where = h.from === h.to ? `U${units[h.from].i}` : `U${units[h.from].i}～U${units[h.to].i}`;
    const inOutlook = outlook && h.to >= outlook.from && h.from <= outlook.to;
    console.log(`（檔名提示：${f}「${h.name}」→ ${where}${h.how === 'fuzzy' ? '（字不完全一樣，取最像的那句）' : ''}`
      + `${inOutlook ? '；⚠️ 落在結尾明日觀察動畫裡，動畫優先、這張不會出現' : ''}）`);
  }
  for (const n of notes) console.log(`（檔名提示：${n}）`);
  // 人工修正鎖住的：只換了圖、沒畫框 → 跟檔名提示一樣處理（那張圖一定配在這幾句），蓋過檔名提示
  const unitSpan = (r) => {
    const from = units.findIndex((u) => u.endCharIdx >= r.startCharIdx);
    let to = -1;
    units.forEach((u, k) => { if (u.startCharIdx <= r.endCharIdx) to = k; });
    return from >= 0 && to >= from ? { from, to } : null;
  };
  for (const h of FIXED.hints) {
    const im = images.find((x) => x.file === h.src);
    const span = unitSpan(h);
    if (!im || !span) continue;
    im.hint = { ...span, name: '人工修正', how: 'exact' };
    console.log(`（人工修正：${h.src} 固定配在字 ${h.startCharIdx}–${h.endCharIdx}，框交給 Claude）`);
  }
  const fixedShots = FIXED.fixed.filter((f) => images.some((x) => x.file === f.src) && unitSpan(f));
  if (fixedShots.length || FIXED.noShot.length) {
    console.log(`（人工修正：${fixedShots.length} 段照人改的框鎖住、${FIXED.noShot.length} 段不放截圖）`);
  }

  if (NOTE) console.log(`（這支有給 Claude 的指示：${NOTE.slice(0, 80)}${NOTE.length > 80 ? '…' : ''}）`);
  const plan = engine.planAssignments({ units, images, note: NOTE, outlook });
  if (plan.status !== 'planned') doneWithOutlook(`Claude 排配圖：第一步失敗（${plan.error || plan.status}），照舊用人工標注`);
  for (const d of plan.dropped || []) console.log(`（${d.src} 原本配在字 ${d.startCharIdx}–${d.endCharIdx}，落在結尾明日觀察動畫裡，拿掉）`);
  // 人工鎖住的段落與「不放截圖」的句子：Claude 排的讓開
  for (const r of [...fixedShots, ...FIXED.noShot]) {
    const { kept, dropped } = planner.clipSegments(plan.segments, r, units);
    plan.segments = kept;
    for (const d of dropped) console.log(`（${d.src} 原本配在字 ${d.startCharIdx}–${d.endCharIdx}，那裡有人工修正，拿掉）`);
  }
  if (!plan.segments.length && !fixedShots.length) doneWithOutlook('Claude 排配圖：Claude 判斷沒有句子適合配圖，照舊用人工標注');

  // 人工示範（90_系統/資料/shot-memory.json 的 pagesMulti）：同一種頁面以前人怎麼裁、怎麼框，給 Claude 參考
  const memory = require('./shot-memory');
  const pagesMulti = memory.read(workspaceRoot(ROOT)).pagesMulti;
  let exampled = 0;

  const shots = [];
  let boxed = 0;
  for (const seg of plan.segments) {
    const im = images.find((x) => x.file === seg.src);
    const segUnits = units.filter((u) => u.startCharIdx >= seg.startCharIdx && u.endCharIdx <= seg.endCharIdx);
    const steps = segUnits.map((u) => ({ id: `U${u.i}`, text: u.text, startCharIdx: u.startCharIdx, endCharIdx: u.endCharIdx }));
    const r = steps.length
      ? engine.pickCard({ imagePath: im.path, words: im.words, width: im.width, height: im.height, steps, page: im.page, note: NOTE,
        examples: (() => {
          const ex = memory.examplesFor(pagesMulti, memory.memKeyOf({ page: im.page, width: im.width, height: im.height, stockCode: im.stockCode }),
            steps.map((x) => x.text).join(''));
          if (ex.length) exampled++;
          return ex;
        })() })
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

  // 人工鎖住的段落原樣放進去（框、裁切照人的，不再問 Claude）
  for (const f of fixedShots) {
    const im = images.find((x) => x.file === f.src);
    const region = f.region || { x: 0, y: 0, w: im.width, h: im.height };
    shots.push({ src: f.src, title: '', region, imgW: im.width, imgH: im.height,
      startCharIdx: f.startCharIdx, endCharIdx: f.endCharIdx, ...(f.cell ? { cell: f.cell } : {}),
      _claude: { why: '人工修正（上一支檢查配圖時改的）', cellSource: 'manual-review' } });
    if (f.cell) boxed++;
  }
  shots.sort((a, b) => a.startCharIdx - b.startCharIdx);

  // 一句話裡最後一張圖留到那句講完（shot-planner.js 的 extendToSentenceEnd）
  const finalShots = require('./shot-planner').extendToSentenceEnd(shots, units, plan.motions || []);
  shots.length = 0;
  shots.push(...finalShots);

  if (plan.motions && plan.motions.length) {
    fs.writeFileSync(MOTION_OUT, JSON.stringify(plan.motions.map((m) => ({ startCharIdx: m.startCharIdx, endCharIdx: m.endCharIdx,
      ...(m.kind ? { kind: m.kind } : {}), ...(m.markers ? { markers: m.markers } : {}), ...(m.count ? { count: m.count } : {}) })), null, 2) + '\n');
  }
  // 補充字卡：避開最終的截圖段（已延到句尾）與動態段
  const facts = planner.parseFacts(plan.reply || '', { units, taken: shots.concat(plan.motions || []) });
  if (facts.length) fs.writeFileSync(FACTS_OUT, JSON.stringify(facts, null, 2) + '\n');
  fs.writeFileSync(OUT, JSON.stringify({ by: 'claude', at: new Date().toISOString(), shots }, null, 2));
  const lines = shots.map((s) => `   ${s.src}「${s.title}」字 ${s.startCharIdx}–${s.endCharIdx}${s.cell ? '' : '（不框）'}`);
  const mlines = (plan.motions || []).map((m) => `   動態 字 ${m.startCharIdx}–${m.endCharIdx}（${m.why}）`);
  const hinted = plan.segments.filter((s) => s.hinted).length;
  if (hinted) console.log(`（${hinted} 張照檔名提示配位置）`);
  if (exampled) console.log(`（${exampled} 張卡片附上了人工示範：同一種頁面以前剪輯師怎麼裁、怎麼框）`);
  const flines = facts.map((f) => `   字卡 字 ${f.startCharIdx}–${f.endCharIdx}：${f.items.map((it) => `${it.label} ${it.value}`).join('｜')}`);
  done(`Claude 排配圖：${plan.segments.length} 張卡片、${shots.length} 段金框位置（${boxed} 段有框）、`
    + `${(plan.motions || []).length} 段動態、${facts.length} 張補充字卡 → ${path.relative(ROOT, OUT)}\n${lines.concat(mlines, flines).join('\n')}`);
}

main();
