#!/usr/bin/env node
/**
 * 第二階段：框位置 IoU 對照（Tesseract vs Vision）—— 不碰產線。
 *
 * 原理：完全走你 server 已經在用的那條路 ——
 *   auto-shot.js --suggest-cells=<in> --images=<某個引擎的 OCR 結果> --out=<out>
 * 它回答的正是「這張圖、這一句，系統會框哪裡」，跟 corrections.jsonl 裡
 * 人親手畫的 manualCell 直接可比。
 *
 * ⚠️ auto-shot.js 原檔一行都不改（--images / --script / --suggest-cells / --out 都是現成參數）
 * ⚠️ 所有輸出寫在 scripts/_vision-trial/out/
 * ⚠️ 記憶庫（shot-memory.json）兩個引擎讀的是同一份，對雙方一樣，不影響公平性
 *
 * 用法：node scripts/_vision-trial/iou.js
 */
const fs = require('fs');
const path = require('path');
const { workspaceRoot, dataPath } = require('../../../paths');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const WORKSPACE_ROOT = workspaceRoot(ROOT);
const STORE = require('../../../工作儲存').createJobStore(WORKSPACE_ROOT);
const HERE = __dirname;
const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });

const rows = fs.readFileSync(dataPath(WORKSPACE_ROOT, 'corrections.jsonl'), 'utf-8')
  .trim().split('\n').map((l) => JSON.parse(l));

// 只留「人親手畫了框」而且該 job 的素材還在的
const byJob = {};
for (const r of rows) {
  if (!r.manualCell || !(r.manualCell.w > 0) || !r.manualChars || !r.to) continue;
  let dir;
  try { dir = STORE.path(r.job, 'input'); } catch (_) { continue; }
  if (!fs.existsSync(dir) || !fs.existsSync(STORE.path(r.job, 'input', 'script.txt'))) continue;
  if (!fs.existsSync(path.join(dir, r.to))) continue;
  (byJob[r.job] = byJob[r.job] || []).push(r);
}
const jobs = Object.keys(byJob).sort();
console.log(`可測 job：${jobs.length} 支，人工框 ${Object.values(byJob).reduce((a, b) => a + b.length, 0)} 個\n`);

function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return i / (a.w * a.h + b.w * b.h - i);
}
const run = (args, label) => {
  try { execFileSync('node', args, { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] }); return true; }
  catch (e) { console.error(`   ⚠️ ${label} 失敗：${String(e.stderr || e.message).slice(0, 160)}`); return false; }
};

const results = [];
for (const job of jobs) {
  const dir = STORE.path(job, 'input');
  const script = STORE.path(job, 'input', 'script.txt');
  process.stdout.write(`${job} `);

  // ① 兩個引擎各分析一次這支 job 的截圖
  const imgOut = {};
  for (const eng of ['tesseract', 'vision']) {
    const rel = `out/img-${eng}-${job}.json`;
    imgOut[eng] = path.join(HERE, rel);
    if (!run([path.join(HERE, 'analyze.js'), '--dir', dir, '--engine', eng, '--out', rel], `analyze/${eng}`)) imgOut[eng] = null;
    process.stdout.write(eng === 'tesseract' ? 'T' : 'V');
  }

  // ② 用人工框的位置當提問，問系統「你會框哪裡」
  const want = byJob[job].map((r) => {
    const [a, b] = String(r.manualChars).split('~').map((n) => parseInt(n, 10));
    return { src: r.to, startCharIdx: Math.min(a, b), endCharIdx: Math.max(a, b) };
  });
  const inF = path.join(OUT, `suggest-in-${job}.json`);
  fs.writeFileSync(inF, JSON.stringify(want, null, 2));

  for (const eng of ['tesseract', 'vision']) {
    if (!imgOut[eng]) continue;
    const outF = path.join(OUT, `suggest-${eng}-${job}.json`);
    if (!run([path.join(ROOT, 'scripts', 'auto-shot.js'), `--script=${script}`,
              `--images=${imgOut[eng]}`, `--suggest-cells=${inF}`, '--out', outF], `suggest/${eng}`)) continue;
    let got = [];
    try { got = JSON.parse(fs.readFileSync(outF, 'utf-8')); } catch (_) {}
    got.forEach((g, i) => {
      const man = byJob[job][i];
      results.push({
        job, engine: eng, src: g.src, phrase: g.phrase,
        why: g.why || '(無)',
        iou: g.cell ? +iou(g.cell, man.manualCell).toFixed(4) : 0,
        hasCell: !!g.cell,
      });
    });
    process.stdout.write('.');
  }
  process.stdout.write('\n');
}

// ── 報表 ──
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
console.log('\n' + '═'.repeat(66));
const tab = {};
for (const e of ['tesseract', 'vision']) {
  const rs = results.filter((r) => r.engine === e);
  const v = rs.map((r) => r.iou);
  tab[e] = { n: rs.length, med: med(v), avg: v.reduce((a, b) => a + b, 0) / Math.max(1, v.length),
             zero: v.filter((x) => x === 0).length, half: v.filter((x) => x > 0.5).length,
             noCell: rs.filter((r) => !r.hasCell).length };
}
console.log('指標'.padEnd(22) + 'Tesseract'.padEnd(14) + 'Vision');
console.log('-'.repeat(66));
const row = (k, f) => console.log(k.padEnd(22) + String(f(tab.tesseract)).padEnd(14) + String(f(tab.vision)));
row('比對筆數', (t) => t.n);
row('★IoU 中位數', (t) => t.med.toFixed(3));
row('IoU 平均', (t) => t.avg.toFixed(3));
row('IoU > 0.5 的筆數', (t) => t.half);
row('完全沒重疊 (IoU=0)', (t) => t.zero);
row('系統框不出來', (t) => t.noCell);
console.log('-'.repeat(66));
console.log(`\n基準線：現況 IoU 中位數 0.301（先前用 corrections 的 systemCell 算的）`);

// 逐筆勝負
const key = (r) => r.job + '|' + r.src + '|' + r.phrase;
const T = {}, V = {};
for (const r of results) (r.engine === 'tesseract' ? T : V)[key(r)] = r;
let win = 0, tie = 0, lose = 0; const loseList = [];
for (const k of Object.keys(T)) {
  if (!V[k]) continue;
  const d = V[k].iou - T[k].iou;
  if (d > 0.02) win++; else if (d < -0.02) { lose++; loseList.push(`${T[k].phrase} T:${T[k].iou} V:${V[k].iou} (${V[k].why})`); }
  else tie++;
}
console.log(`逐筆：Vision 較好 ${win}　持平 ${tie}　較差 ${lose}`);
loseList.slice(0, 10).forEach((l) => console.log('   ✗ ' + l));

// 命中規則分布
console.log('\n命中規則分布：');
for (const e of ['tesseract', 'vision']) {
  const m = {};
  for (const r of results.filter((x) => x.engine === e)) m[r.why] = (m[r.why] || 0) + 1;
  console.log(`  [${e}]`);
  Object.entries(m).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`     ${v}\t${k}`));
}

fs.writeFileSync(path.join(OUT, 'iou.json'), JSON.stringify(results, null, 2));
console.log(`\n明細：scripts/_vision-trial/out/iou.json`);
