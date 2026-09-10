'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { workspaceRoot, applicationPath, cliPath, dataPath, dataRelativePath, resolveDataReference } = require('../paths');

const root = path.resolve('/tmp', '隔離 測試副本');

test('程式根與資料根分離，既有 CLI 路徑仍指向原本用途', () => {
  const app = applicationPath(root);
  assert.equal(workspaceRoot(app), root);
  for (const name of ['工作紀錄', '共用素材', 'jobs', '成品', 'backups', '90_系統', '99_封存', '.dual-tmp', '.cache']) {
    assert.equal(cliPath(app, `./${name}/合成檔案`), path.join(root, name, '合成檔案'));
  }
  assert.equal(cliPath(app, 'assets/測試.png'), path.join(root, '共用素材/測試.png'));
  assert.equal(cliPath(app, 'out/測試.mp4'), path.join(root, '90_系統/暫存/產線輸出/測試.mp4'));
  for (const name of ['src', 'public', 'scripts']) {
    assert.equal(cliPath(app, `${name}/合成檔案`), path.join(app, name, '合成檔案'));
  }
  assert.equal(cliPath(app, 'ab-test.txt'), path.join(app, 'ab-test.txt'));
  const external = path.resolve(root, '..', '外部稿件.txt');
  assert.equal(cliPath(app, external), external);
});

test('自訂 CLI 檔案依呼叫者工作目錄解析，不影響明確的程式與資料路徑', () => {
  const original = process.env.WORKBENCH_CALLER_CWD;
  const caller = path.resolve(root, '..', '呼叫者 資料夾');
  const app = applicationPath(root);
  try {
    delete process.env.WORKBENCH_CALLER_CWD;
    assert.equal(cliPath(app, '自訂稿件.txt'), path.join(app, '自訂稿件.txt'));
    process.env.WORKBENCH_CALLER_CWD = caller;
    assert.equal(cliPath(app, '自訂稿件.txt'), path.join(caller, '自訂稿件.txt'));
    assert.equal(cliPath(app, 'public/script.txt'), path.join(app, 'public/script.txt'));
    assert.equal(cliPath(app, 'jobs/fixture/input/script.txt'), path.join(root, 'jobs/fixture/input/script.txt'));
  } finally {
    if (original === undefined) delete process.env.WORKBENCH_CALLER_CWD;
    else process.env.WORKBENCH_CALLER_CWD = original;
  }
});

test('歷史頁型樣本的相對與絕對引用解析到同一份正式資料', () => {
  const sample = path.join('_pinned', 'fixture-job__shot1.png');
  const expected = dataPath(root, 'page-samples', sample);
  assert.equal(resolveDataReference(root, path.join('docs', 'page-samples', sample)), expected);
  assert.equal(resolveDataReference(root, path.join(root, 'docs', 'page-samples', sample)), expected);
  assert.equal(resolveDataReference(root, 'docs/page-samples'), dataPath(root, 'page-samples'));
  assert.equal(resolveDataReference(root, path.join('./docs/page-samples', '分類', '..', sample)), expected);
});

test('正式資料引用與其他用途路徑不被重新改寫', () => {
  const reference = dataRelativePath('page-samples', '測試圖.png');
  assert.equal(resolveDataReference(root, reference), dataPath(root, 'page-samples', '測試圖.png'));
  assert.equal(resolveDataReference(root, dataPath(root, 'page-samples', '測試圖.png')), path.join(root, reference));
  for (const other of [
    'docs/page-samples-old/shot1.png',
    'docs/page-samples/../其他資料.json',
    'backups/docs/page-samples/shot1.png',
    'jobs/fixture/input/shot1.png',
    path.resolve(root, '..', '另一副本', 'docs/page-samples/shot1.png'),
  ]) {
    assert.equal(resolveDataReference(root, other), path.resolve(root, other));
  }
});
