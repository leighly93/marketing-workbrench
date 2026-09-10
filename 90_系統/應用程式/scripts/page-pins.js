#!/usr/bin/env node
/**
 * 📌「記下這種頁」的批次命名工具。
 *
 * 前台審核頁上，系統判不出頁型（unknown）的截圖旁邊有一顆 📌；按下去 server 會把
 *   { kind:'page-pin', job, src, systemPage, fingerprint, pinned } 追加進 90_系統/資料/messages.jsonl，
 *   並把截圖複製一份到 90_系統/資料/page-samples/_pinned/（jobs/ 會被 prune，指紋還在圖沒了就白搭）。
 * 使用者定案（2026-09-03）：按的當下**不命名**，累積一批後用這支分群、一次命名 ——
 *   逐張手打會長出「多空／個股多空／個股-多空」三種寫法，批次命名快很多也不打斷審核節奏。
 *
 * 用法：
 *   node scripts/page-pins.js            # 列出所有 📌 分群（預設）
 *   node scripts/page-pins.js --all      # 連已經命名過（status=done）的也列
 *   node scripts/page-pins.js --json     # 機器可讀輸出
 *
 * 分群法跟 2026-09-02 整理 26 群用的一樣：中文雙字組 Jaccard ≥ 0.55 就算同一群。
 * 只讀不寫。命名結果要進 90_系統/資料/page-samples/page-types.json 與 PAGE_SIGNATURES_V2，另外處理。
 */
const fs = require('fs');
const path = require('path');
const { workspaceRoot, dataPath, resolveDataReference } = require('../../paths');

const ROOT = workspaceRoot(path.resolve(__dirname, '..'));
const LOG = dataPath(ROOT, 'messages.jsonl');
const ALL = process.argv.includes('--all');
const AS_JSON = process.argv.includes('--json');

// 讀留言檔並摺疊 { op:'status' }（跟 server/index.js readMessages 同一套規則）
function readPins() {
  if (!fs.existsSync(LOG)) return [];
  const byId = new Map();
  for (const line of fs.readFileSync(LOG, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch (_) { continue; }
    if (m.op === 'status') { const t = byId.get(m.id); if (t) t.status = m.status; continue; }
    if (m.kind === 'page-pin') byId.set(m.id, m);
  }
  return [...byId.values()].filter((m) => ALL || m.status !== 'done');
}

const grams = (words) => {
  const g = new Set();
  for (const w of words || []) { const c = String(w).replace(/[^一-鿿]/g, ''); for (let i = 0; i + 2 <= c.length; i++) g.add(c.slice(i, i + 2)); }
  return g;
};
const jac = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i || 1); };

const pins = readPins();
if (!pins.length) {
  console.log(ALL ? '沒有任何 📌 紀錄。' : '沒有待命名的 📌（用 --all 看全部）。');
  process.exit(0);
}

// 貪婪分群
const clusters = [];
for (const p of pins) {
  const g = grams((p.fingerprint || {}).words);
  let best = null, bs = 0;
  for (const c of clusters) { const s = jac(g, c.g); if (s > bs) { bs = s; best = c; } }
  if (best && bs >= 0.55) best.items.push(p); else clusters.push({ g, items: [p] });
}
clusters.sort((a, b) => b.items.length - a.items.length);

// 每群的共同關鍵字：出現在 ≥ 半數成員裡的詞（這是拿去寫 PAGE_SIGNATURES 的候選）
const summarize = (c) => {
  const cnt = {};
  for (const p of c.items) for (const w of new Set((p.fingerprint || {}).words || [])) cnt[w] = (cnt[w] || 0) + 1;
  const half = Math.ceil(c.items.length / 2);
  const common = Object.entries(cnt).filter(([, n]) => n >= half).sort((a, b) => b[1] - a[1]).map(([w]) => w).slice(0, 12);
  const sysPages = [...new Set(c.items.map((p) => p.systemPage || '?'))];
  const memKeys = [...new Set(c.items.map((p) => (p.fingerprint || {}).memKey).filter(Boolean))];
  return { n: c.items.length, common, sysPages, memKeys,
    samples: c.items.map((p) => p.pinned ? path.relative(ROOT, resolveDataReference(ROOT, p.pinned)) : `${p.job}/${p.src}`).slice(0, 5),
    by: [...new Set(c.items.map((p) => p.by))], ids: c.items.map((p) => p.id) };
};
const out = clusters.map(summarize);

if (AS_JSON) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

console.log(`📌 共 ${pins.length} 筆，分成 ${clusters.length} 群\n`);
out.forEach((s, i) => {
  console.log(`━━━ 群 ${i + 1}　${s.n} 張　系統原判：${s.sysPages.join('/')}　memKey：${s.memKeys.join('/') || '-'}`);
  console.log(`    共同關鍵字：${s.common.join('　') || '（太少，看圖）'}`);
  console.log(`    標的人：${s.by.join('、')}`);
  s.samples.forEach((p) => console.log(`    圖：${p}`));
  console.log();
});
console.log('下一步：看每群的圖決定頁型名稱 → 加進 90_系統/資料/page-samples/page-types.json 與 PAGE_SIGNATURES_V2（關鍵字用上面的「共同關鍵字」挑）。');
