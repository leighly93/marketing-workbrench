'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, write } = require('../../server/tests/isolated-server');
const { initialize, generated } = require('../init');
const { applicationPath, dataPath } = require('../../shared/paths');

test('初始化建立可載入的空結構與私有設定，但不建立任何工作或正式影片', (t) => {
  const root = fixture(t);
  write(path.join(root, '.env.example'), 'HOST=127.0.0.1\nADMIN_KEY=\n');
  initialize(root);
  for (const name of Object.keys(generated)) assert.doesNotThrow(() => JSON.parse(fs.readFileSync(applicationPath(root, 'src', name), 'utf8')));
  assert.deepEqual(fs.readdirSync(path.join(root, 'storage', 'jobs')), []);
  assert.deepEqual(fs.readdirSync(applicationPath(root, 'public')), []);
  assert.match(fs.readFileSync(path.join(root, '.env'), 'utf8'), /ADMIN_KEY=[a-f0-9]{48}/);
  // Windows 沒有 POSIX 權限位元；正式環境是 macOS。
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(root, '.env')).mode & 0o777, 0o600);
});

test('重複初始化不覆寫字幕、詞庫、金鑰或已有工作，且不重設管理金鑰', (t) => {
  const root = fixture(t);
  write(path.join(root, '.env.example'), 'ADMIN_KEY=\n');
  const protectedFiles = [applicationPath(root, 'src/subtitles.json'), dataPath(root, 'pronounce.json'), path.join(root, '.env'), path.join(root, 'storage/jobs/既有工作/_meta/job.json')];
  for (const file of protectedFiles) write(file, '既有內容必須逐字保留');
  initialize(root);
  const second = initialize(root);
  assert.equal(second.created.length, 0);
  for (const file of protectedFiles) assert.equal(fs.readFileSync(file, 'utf8'), '既有內容必須逐字保留');
});

test('初始化定義涵蓋所有靜態 JSON import，新增依賴時會要求同步更新', () => {
  const app = applicationPath(path.resolve(__dirname, '..', '..'));
  const imported = new Set();
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.tsx?$/.test(entry.name)) {
        for (const match of fs.readFileSync(file, 'utf8').matchAll(/from\s+['"]([^'"]+\.json)['"]/g)) imported.add(path.relative(path.join(app, 'src'), path.resolve(path.dirname(file), match[1])).split(path.sep).join('/'));
      }
    }
  }
  walk(path.join(app, 'src'));
  assert.deepEqual([...imported].sort(), Object.keys(generated).sort());
});
