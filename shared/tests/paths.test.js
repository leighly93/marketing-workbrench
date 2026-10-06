'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  workspaceRoot, applicationPath, storagePath, outputPath, sharedAssetsPath, cliPath, dataPath, dataRelativePath, resolveDataReference,
} = require('../paths');

const root = path.resolve('/tmp', '隔離 測試副本');

test('Remotion 專案在 video/remotion，資料在 storage/', () => {
  const app = applicationPath(root);
  assert.equal(app, path.join(root, 'video', 'remotion'));
  assert.equal(workspaceRoot(app), root);
  assert.equal(dataPath(root, 'pronounce.json'), path.join(root, 'storage/data/pronounce.json'));
  assert.equal(outputPath(root, '測試.mp4'), path.join(root, 'storage/tmp/pipeline-output/測試.mp4'));
  assert.equal(sharedAssetsPath(root, 'dapan'), path.join(root, 'storage/shared-assets/dapan'));
  assert.equal(storagePath(root, 'jobs'), path.join(root, 'storage/jobs'));
});

test('CLI：storage/ 以 repository 根解析，src/、public/ 以 Remotion 專案解析', () => {
  const app = applicationPath(root);
  for (const name of ['storage', '.cache']) {
    assert.equal(cliPath(app, `./${name}/合成檔案`), path.join(root, name, '合成檔案'));
  }
  for (const name of ['src', 'public']) {
    assert.equal(cliPath(app, `${name}/合成檔案`), path.join(app, name, '合成檔案'));
  }
  const external = path.resolve(root, '..', '外部稿件.txt');
  assert.equal(cliPath(app, external), external);
});

test('自訂 CLI 檔案依呼叫者工作目錄解析，npm 的 INIT_CWD 也算', () => {
  const original = process.env.WORKBENCH_CALLER_CWD;
  const originalInit = process.env.INIT_CWD;
  const caller = path.resolve(root, '..', '呼叫者 資料夾');
  const app = applicationPath(root);
  try {
    delete process.env.WORKBENCH_CALLER_CWD;
    delete process.env.INIT_CWD;
    assert.equal(cliPath(app, '自訂稿件.txt'), path.join(app, '自訂稿件.txt'));
    process.env.WORKBENCH_CALLER_CWD = caller;
    assert.equal(cliPath(app, '自訂稿件.txt'), path.join(caller, '自訂稿件.txt'));
    delete process.env.WORKBENCH_CALLER_CWD;
    process.env.INIT_CWD = caller;
    assert.equal(cliPath(app, '自訂稿件.txt'), path.join(caller, '自訂稿件.txt'));
    assert.equal(cliPath(app, 'public/script.txt'), path.join(app, 'public/script.txt'));
  } finally {
    if (original === undefined) delete process.env.WORKBENCH_CALLER_CWD;
    else process.env.WORKBENCH_CALLER_CWD = original;
    if (originalInit === undefined) delete process.env.INIT_CWD;
    else process.env.INIT_CWD = originalInit;
  }
});

test('jobs/<ID>/... 是邏輯位置：找不到工作時落在 storage/jobs/ 底下', () => {
  const app = applicationPath(root);
  assert.equal(cliPath(app, 'jobs/fixture/input/script.txt'), path.join(root, 'storage/jobs/fixture/input/script.txt'));
  assert.equal(resolveDataReference(root, 'jobs/fixture/input/shot1.png'), path.join(root, 'storage/jobs/fixture/input/shot1.png'));
});

test('資料引用照原路徑解析，不做舊路徑轉換', () => {
  const reference = dataRelativePath('page-samples', '測試圖.png');
  assert.equal(resolveDataReference(root, reference), dataPath(root, 'page-samples', '測試圖.png'));
  for (const other of ['docs/page-samples/shot1.png', path.resolve(root, '..', '另一副本', 'storage/data/x.png')]) {
    assert.equal(resolveDataReference(root, other), path.resolve(root, other));
  }
});
