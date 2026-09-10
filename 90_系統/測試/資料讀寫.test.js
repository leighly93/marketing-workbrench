'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { applicationPath, dataPath, dataRelativePath, resolveDataReference } = require('../paths');
const shotMemory = require('../應用程式/scripts/shot-memory');
const { repository, fixture, write, confinedFs, loadServer } = require('./隔離服務');
const { workFile } = require('./隔離服務');

test('發音詞庫 API 從新位置讀寫、保留既有規則且不重建 docs', async (t) => {
  const root = fixture(t);
  const existing = { from: '測試原文甲', to: '測試唸法甲', why: '合成規則', enabled: true };
  write(dataPath(root, 'pronounce.json'), { rules: [existing] });
  const request = loadServer(root);
  const before = await request('GET', '/api/pronounce');
  assert.equal(before.status, 200);
  assert.deepEqual(before.body.rules, [existing]);

  const added = await request('POST', '/api/pronounce', { from: '測試詞彙乙', to: '另一個唸法', by: '合成測試' });
  assert.equal(added.status, 200);
  assert.equal(added.body.rules.length, 2);
  const disabled = await request('PATCH', '/api/pronounce', { from: existing.from, enabled: false });
  assert.equal(disabled.status, 200);
  const persisted = JSON.parse(fs.readFileSync(dataPath(root, 'pronounce.json'), 'utf8'));
  assert.deepEqual(persisted[0], { ...existing, enabled: false });
  assert.equal(persisted[1].from, '測試詞彙乙');
  assert.equal(fs.existsSync(path.join(root, 'docs')), false);
});

test('留言保留舊 pinned 原文與 append-only 歷史，回應及新圖片使用正式樣本區', async (t) => {
  const root = fixture(t);
  const legacyPin = { id: 'old-pin', by: '合成測試', kind: 'page-pin', job: 'old-job', src: 'shot1.png',
    pinned: 'docs/page-samples/_pinned/old-job__shot1.png', status: 'new' };
  const original = JSON.stringify(legacyPin) + '\n';
  const log = dataPath(root, 'messages.jsonl');
  write(log, original);
  const oldImage = Buffer.from('synthetic-old-sample');
  write(resolveDataReference(root, legacyPin.pinned), oldImage);
  const newImage = Buffer.from('synthetic-new-sample');
  write(workFile(root, 'new-job', 'job.json'), { id: 'new-job', status: 'done', createdAt: '2000-01-01' });
  write(workFile(root, 'new-job', 'input', 'shot2.png'), newImage);
  const request = loadServer(root);

  const migratedPin = { ...legacyPin, pinned: dataRelativePath('page-samples', '_pinned', 'old-job__shot1.png') };
  assert.deepEqual((await request('GET', '/api/messages')).body.messages, [migratedPin]);
  assert.equal((await request('POST', '/api/messages/status', { id: legacyPin.id, status: 'done' })).status, 200);
  const created = await request('POST', '/api/messages', {
    by: '合成測試', kind: 'page-pin', job: 'new-job', src: 'shot2.png', text: '合成頁型',
  });
  assert.equal(created.status, 200);
  const messages = (await request('GET', '/api/messages')).body.messages;
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], { ...migratedPin, status: 'done' });
  const fresh = messages.find((message) => message.id === created.body.id);
  assert.equal(fresh.pinError, undefined);
  assert.equal(fresh.pinned, dataRelativePath('page-samples', '_pinned', 'new-job__shot2.png'));
  assert.deepEqual(fs.readFileSync(resolveDataReference(root, fresh.pinned)), newImage);
  assert.deepEqual(fs.readFileSync(resolveDataReference(root, legacyPin.pinned)), oldImage);
  assert.equal(fs.readFileSync(log, 'utf8').startsWith(original), true);
  assert.equal(fs.existsSync(path.join(root, 'docs')), false);
});

test('修正紀錄讀取新彙總檔並保留未入檔的歷史工作修正', async (t) => {
  const root = fixture(t);
  const correction = { at: '2000-01-01T00:00:00Z', job: 'logged-job', type: '合成位置修正' };
  const original = JSON.stringify(correction) + '\n';
  write(dataPath(root, 'corrections.jsonl'), original);
  write(workFile(root, 'logged-job', 'job.json'), {
    id: 'logged-job', status: 'done', corrections: [{ type: '不應重複計算' }],
  });
  write(workFile(root, 'unlogged-job', 'job.json'), {
    id: 'unlogged-job', status: 'failed', approvedAt: '2000-01-02T00:00:00Z', corrections: [{ type: '合成配圖修正' }],
  });
  const response = await loadServer(root)('GET', '/api/corrections');
  assert.equal(response.status, 200);
  assert.equal(response.body.logged, true);
  assert.equal(response.body.total, 2);
  assert.deepEqual(response.body.rows.map((row) => row.job).sort(), ['logged-job', 'unlogged-job']);
  assert.deepEqual(response.body.byType, { 合成配圖修正: 1, 合成位置修正: 1 });
  assert.equal(fs.readFileSync(dataPath(root, 'corrections.jsonl'), 'utf8'), original);
  assert.equal(fs.existsSync(path.join(root, 'docs')), false);
});

test('記憶腳本沿用新位置既有資料，並讀取官方股名限制學習', (t) => {
  const root = fixture(t);
  const historical = { codeNames: { fixture: '合成別名' }, pages: {}, pagesMulti: {} };
  write(dataPath(root, 'shot-memory.json'), historical);
  write(dataPath(root, 'stock-names.json'), { '9999': '合成正式名稱' });
  assert.deepEqual(shotMemory.read(root), historical);
  shotMemory.learn(root, [{ src: 'shot1.png', phrase: '測試公司上漲', cell: { x: 10, y: 20, w: 30, h: 40 } }], [{
    file: 'shot1.png', page: 'fixture-page', width: 100, height: 200, stockCode: '9999',
    words: [{ t: '測試公司', x: 0, y: 0, w: 40, h: 10, c: 100 }],
  }], '2000-01-01T00:00:00Z');
  const memory = shotMemory.read(root);
  assert.deepEqual(memory.codeNames, historical.codeNames);
  assert.deepEqual(memory.pages['fixture-page@0.50'].cell, { x: 0.1, y: 0.1, w: 0.3, h: 0.2 });
  assert.equal(memory.pagesMulti['fixture-page@0.50'].length, 1);
  assert.equal(fs.existsSync(path.join(root, 'docs')), false);
});

test('頁型整理 CLI 可以列出搬移後的歷史 pinned 圖片，且不改寫留言原文', (t) => {
  const root = fixture(t);
  const message = { id: 'fixture-pin', kind: 'page-pin', by: '合成測試', status: 'new',
    pinned: 'docs/page-samples/_pinned/fixture.png', fingerprint: { words: ['合成頁型'] } };
  const original = JSON.stringify(message) + '\n';
  write(dataPath(root, 'messages.jsonl'), original);
  write(resolveDataReference(root, message.pinned), 'synthetic-sample');
  const sourceFile = applicationPath(repository, 'scripts/page-pins.js');
  const localRequire = createRequire(sourceFile);
  const output = [];
  const exited = {};
  try {
    vm.runInNewContext(fs.readFileSync(sourceFile, 'utf8'), {
      __dirname: applicationPath(root, 'scripts'),
      require(name) { return name === 'fs' ? confinedFs(root) : localRequire(name); },
      process: { argv: ['node', 'page-pins.js', '--all', '--json'], exit(code) { assert.equal(code, 0); throw exited; } },
      console: { log(value) { output.push(value); } },
    }, { filename: sourceFile, timeout: 5000 });
  } catch (error) { if (error !== exited) throw error; }
  const groups = JSON.parse(output.join('\n'));
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].ids, [message.id]);
  assert.equal(groups[0].samples[0], dataRelativePath('page-samples', '_pinned', 'fixture.png'));
  assert.equal(fs.existsSync(path.resolve(root, groups[0].samples[0])), true);
  assert.equal(fs.readFileSync(dataPath(root, 'messages.jsonl'), 'utf8'), original);
  assert.equal(fs.existsSync(path.join(root, 'docs')), false);
});
