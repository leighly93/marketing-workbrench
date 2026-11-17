'use strict';

/**
 * 工作紀錄去重（2026-11-17 使用者：「💾 14728 MB 不是太多了」「多的刪掉」）。
 *
 * 一支大盤小報約 300MB，其中同一支 HeyGen 原始影片存了三份（素材/、備份/工作備份/input/、
 * 備份/產線快照/），每筆快照又各帶一份字型、片尾、背景音樂。這裡把**內容完全相同**的檔案
 * 併成磁碟上的一份（hard link）：每個路徑都還在、讀起來一模一樣，重新出片、下載、備份全不受影響，
 * 只是不再重複佔空間。
 *
 * 安全規則：
 *   - 只動 ≥ MIN_BYTES 的媒體／字型檔（EXTS）；job.json、log、標注這類會一直改的小檔不碰。
 *   - 內容用 SHA-1 比對（大小相同才算雜湊），不是看檔名。
 *   - 換成連結用「先建暫存連結再 rename 蓋過去」，中途失敗原檔不受影響。
 *   - 共用之後，任何要**就地覆寫**這些路徑的程式都要先呼叫 detach()，把那個路徑拆出來再寫，
 *     否則改一個會連備份一起改掉（server/index.js 的寫入點都已經接上）。
 *   - 雜湊記在 <root>/.dedupe-index.json（照 dev/ino/大小/修改時間 判斷還能不能沿用），之後每支片收尾只算新檔。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIN_BYTES = 1024 * 1024;
const EXTS = new Set(['.mp4', '.mov', '.m4a', '.mp3', '.wav', '.png', '.jpg', '.jpeg', '.webp', '.ttf', '.otf', '.woff2']);
const INDEX_FILE = '.dedupe-index.json';

/** 要寫入 p 之前呼叫：p 跟別的路徑共用同一份資料時，先拆掉這個路徑（資料還在別的路徑上） */
function detach(p) {
  try {
    if (fs.lstatSync(p).nlink > 1) fs.unlinkSync(p);
  } catch (_) {}
}

function sha1(file) {
  const h = crypto.createHash('sha1');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(4 * 1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

function walk(root) {
  const out = [];
  const go = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) go(f);
      else if (e.isFile() && EXTS.has(path.extname(e.name).toLowerCase())) out.push(f);
    }
  };
  go(root);
  return out;
}

/** 目錄實際佔用：同一份資料（同 inode）只算一次 */
function diskBytes(root) {
  const seen = new Set();
  let n = 0;
  const go = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { go(f); continue; }
      try {
        const st = fs.statSync(f);
        const key = `${st.dev}:${st.ino}`;
        if (st.nlink > 1) {
          if (seen.has(key)) continue;
          seen.add(key);
        }
        n += st.size;
      } catch (_) {}
    }
  };
  go(root);
  return n;
}

/**
 * 整個 root（工作紀錄）去重。apply=false 只算可以省多少、不動檔案。
 * 回傳 { groups, linked, savedBytes, plan: [{ keep, dups: [路徑] , size }] }
 */
function dedupe(root, { apply = false } = {}) {
  const indexPath = path.join(root, INDEX_FILE);
  let index = {};
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch (_) {}
  const nextIndex = {};

  const bySize = new Map();
  for (const f of walk(root)) {
    let st;
    try { st = fs.statSync(f); } catch (_) { continue; }
    if (st.size < MIN_BYTES) continue;
    const item = { f, st, rel: path.relative(root, f) };
    if (!bySize.has(st.size)) bySize.set(st.size, []);
    bySize.get(st.size).push(item);
  }

  const plan = [];
  for (const [size, items] of bySize) {
    if (new Set(items.map((x) => `${x.st.dev}:${x.st.ino}`)).size < 2) continue;
    const byHash = new Map();
    const hashOfIno = new Map();
    for (const it of items) {
      const key = `${it.st.dev}:${it.st.ino}`;
      const sig = `${it.st.dev}:${it.st.ino}:${size}:${it.st.mtimeMs}`;
      let h = hashOfIno.get(key);
      if (!h) h = index[it.rel] && index[it.rel].sig === sig ? index[it.rel].hash : null;
      if (!h) {
        try { h = sha1(it.f); } catch (_) { continue; }
      }
      hashOfIno.set(key, h);
      nextIndex[it.rel] = { sig, hash: h };
      if (!byHash.has(h)) byHash.set(h, []);
      byHash.get(h).push(it);
    }
    for (const same of byHash.values()) {
      // 留最早的那一份（通常是素材/ 裡上傳的原檔），其他路徑改指向它
      same.sort((a, b) => b.st.nlink - a.st.nlink || a.st.mtimeMs - b.st.mtimeMs || a.f.localeCompare(b.f));
      const keep = same[0];
      const keepKey = `${keep.st.dev}:${keep.st.ino}`;
      const dups = same.filter((x) => `${x.st.dev}:${x.st.ino}` !== keepKey && x.st.dev === keep.st.dev);
      if (!dups.length) continue;
      // 同一個 inode 的多個路徑只省一次空間
      const freed = new Set(dups.map((x) => `${x.st.dev}:${x.st.ino}`)).size * size;
      plan.push({ keep: keep.f, dups: dups.map((x) => x.f), size, freed });
    }
  }

  let linked = 0;
  let savedBytes = 0;
  const errors = [];
  for (const g of plan) {
    if (!apply) { savedBytes += g.freed; continue; }
    for (const d of g.dups) {
      const tmp = `${d}.dedupe-tmp-${process.pid}`;
      try {
        fs.linkSync(g.keep, tmp);
        fs.renameSync(tmp, d);
        linked++;
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        errors.push(`${path.relative(root, d)}：${e.message}`);
      }
    }
    savedBytes += g.freed;
  }
  if (apply) {
    // 改成連結後 inode 換了 —— 重記一次，下次就不用再算雜湊
    for (const g of plan) {
      for (const f of [g.keep, ...g.dups]) {
        try {
          const st = fs.statSync(f);
          const rel = path.relative(root, f);
          const old = nextIndex[rel];
          if (old) nextIndex[rel] = { sig: `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`, hash: old.hash };
        } catch (_) {}
      }
    }
    // 沒進比對（大小獨一無二）的檔也保留舊紀錄，免得下次重算
    for (const [rel, v] of Object.entries(index)) if (!nextIndex[rel] && fs.existsSync(path.join(root, rel))) nextIndex[rel] = v;
    try { fs.writeFileSync(indexPath, JSON.stringify(nextIndex) + '\n'); } catch (_) {}
  }
  return { groups: plan.length, linked, savedBytes, errors, plan };
}

module.exports = { dedupe, detach, diskBytes, MIN_BYTES, EXTS, INDEX_FILE };

// ── CLI：node scripts/job-dedupe.js [--apply] [工作紀錄路徑] ──
if (require.main === module) {
  const { workspaceRoot } = require('../../paths');
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const root = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(workspaceRoot(path.resolve(__dirname, '..')), '工作紀錄'));
  const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
  const before = diskBytes(root);
  console.log(`工作紀錄：${root}\n目前實際佔用：${mb(before)}`);
  const r = dedupe(root, { apply });
  for (const g of r.plan.slice(0, 30)) {
    console.log(`  ${path.relative(root, g.keep)}（${mb(g.size)}）`);
    for (const d of g.dups) console.log(`    = ${path.relative(root, d)}`);
  }
  if (r.plan.length > 30) console.log(`  …另外 ${r.plan.length - 30} 組`);
  if (!apply) {
    console.log(`\n可以省下 ${mb(r.savedBytes)}（${r.groups} 組相同檔案）。這次只列出、沒有改檔；確認後加 --apply 執行。`);
  } else {
    console.log(`\n✅ 併成同一份：${r.linked} 個路徑，省下 ${mb(r.savedBytes)}；現在實際佔用 ${mb(diskBytes(root))}`);
    if (r.errors.length) console.log(`⚠️ ${r.errors.length} 個沒處理到：\n  ${r.errors.join('\n  ')}`);
  }
}
