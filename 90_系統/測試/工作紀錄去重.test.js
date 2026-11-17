'use strict';

// 工作紀錄去重（2026-11-17 使用者：「💾 14728 MB 不是太多了」「多的刪掉」）：
// 內容相同的大檔併成同一份（hard link），每個路徑都還在；寫入前先拆開，不會連備份一起改。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applicationPath } = require('../paths');

const APP = applicationPath(path.resolve(__dirname, '../..'));
const dd = require(path.join(APP, 'scripts/job-dedupe'));

const MB = 1024 * 1024;
function put(root, rel, buf) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, buf);
  return f;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dedupe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const heygen = Buffer.alloc(2 * MB, 7);
  const font = Buffer.alloc(MB + 10, 3);
  const f = {
    input: put(root, 'A/素材/heygen.mp4', heygen),
    backup: put(root, 'A/_製作資料/備份/工作備份/input/heygen.mp4', heygen),
    snap: put(root, 'A/_製作資料/備份/產線快照/1-dapan/heygen.mp4', heygen),
    fontA: put(root, 'A/_製作資料/快照/public/NotoSansTC-VF.ttf', font),
    fontB: put(root, 'B/_製作資料/快照/public/NotoSansTC-VF.ttf', font),
    other: put(root, 'B/素材/heygen.mp4', Buffer.alloc(2 * MB, 9)),       // 同大小、不同內容
    json: put(root, 'A/_製作資料/job.json', Buffer.alloc(2 * MB, 7)),     // 不是媒體檔，不碰
  };
  return { root, f };
}

test('只列出不改檔；--apply 才併成同一份，內容與路徑都不變', (t) => {
  const { root, f } = fixture(t);
  const before = dd.diskBytes(root);
  const dry = dd.dedupe(root);
  assert.equal(dry.linked, 0);
  assert.equal(dry.savedBytes, 2 * 2 * MB + (MB + 10));
  assert.equal(fs.statSync(f.backup).nlink, 1, 'dry run 不改檔');

  const r = dd.dedupe(root, { apply: true });
  assert.equal(r.linked, 3);
  assert.equal(fs.statSync(f.input).ino, fs.statSync(f.backup).ino);
  assert.equal(fs.statSync(f.input).ino, fs.statSync(f.snap).ino);
  assert.equal(fs.statSync(f.fontA).ino, fs.statSync(f.fontB).ino);
  assert.notEqual(fs.statSync(f.other).ino, fs.statSync(f.input).ino, '同大小不同內容不能併');
  assert.equal(fs.statSync(f.json).nlink, 1, 'job.json 這類檔不碰');
  for (const p of Object.values(f)) assert.ok(fs.existsSync(p));
  const idx = fs.statSync(path.join(root, dd.INDEX_FILE)).size;   // 雜湊紀錄檔本身
  assert.equal(dd.diskBytes(root) - idx, before - r.savedBytes, '實際佔用只算一次');
  // 再跑一次沒有東西可併
  assert.equal(dd.dedupe(root, { apply: true }).linked, 0);
});

test('detach：寫入共用的路徑前先拆開，備份保持原內容', (t) => {
  const { root, f } = fixture(t);
  dd.dedupe(root, { apply: true });
  dd.detach(f.input);
  fs.writeFileSync(f.input, 'new upload');
  assert.equal(fs.readFileSync(f.backup).length, 2 * MB, '備份不受影響');
  assert.equal(fs.readFileSync(f.snap)[0], 7);
  // 沒有共用的檔 detach 不刪
  dd.detach(f.other);
  assert.ok(fs.existsSync(f.other));
});

test('server：寫入工作資料的地方都先 detach、收尾去重、容量只算一次', () => {
  const src = fs.readFileSync(path.join(APP, 'server/index.js'), 'utf8');
  assert.match(src, /detach\(dest\);\n\s+if \(auto\) fs\.writeFileSync\(dest, ''\);/, '上傳');
  assert.match(src, /ensureDir\(path\.dirname\(to\)\);\n\s+detach\(to\);\n\s+fs\.copyFileSync\(from, to\);/, 'copyRecursive／工作備份');
  assert.match(src, /backupJobArtifacts\(job\); \} catch \(_\) \{\}.*\n\s+try \{ dedupeJobs\(job\); \} catch/, '備份完才去重');
  assert.match(src, /return jobDedupe\.diskBytes\(p\);/);
});
