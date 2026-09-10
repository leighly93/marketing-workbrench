'use strict';

const path = require('node:path');

const DATA_PARTS = ['90_系統', '資料'];
const APP_PARTS = ['90_系統', '應用程式'];

function workspaceRoot(applicationRoot) {
  return path.resolve(applicationRoot, '..', '..');
}

function applicationPath(root, ...segments) {
  return path.join(root, ...APP_PARTS, ...segments);
}

function cliPath(applicationRoot, reference) {
  if (path.isAbsolute(reference)) return resolveDataReference(workspaceRoot(applicationRoot), reference);
  const normalized = path.normalize(reference);
  const first = normalized.split(path.sep)[0];
  if (['工作紀錄', '共用素材', 'jobs', '成品', 'assets', 'backups', 'out', '90_系統', '99_封存', '.dual-tmp', '.cache'].includes(first)) {
    return resolveDataReference(workspaceRoot(applicationRoot), normalized);
  }
  if (['src', 'public', 'scripts', 'ab-test.txt'].includes(first)) {
    return path.resolve(applicationRoot, normalized);
  }
  return path.resolve(process.env.WORKBENCH_CALLER_CWD || applicationRoot, normalized);
}

function dataPath(root, ...segments) {
  return path.join(root, ...DATA_PARTS, ...segments);
}

function dataRelativePath(...segments) {
  return path.join(...DATA_PARTS, ...segments);
}

// 歷史留言與頁型樣本中的路徑保留原文，只在讀取時轉到正式資料位置。
function resolveDataReference(root, reference) {
  const absolute = path.resolve(root, reference);
  const parts = path.relative(root, absolute).split(path.sep);
  if (parts[0] === 'assets') return path.join(root, '共用素材', ...parts.slice(1));
  if (parts[0] === 'out') return path.join(root, '90_系統', '暫存', '產線輸出', ...parts.slice(1));
  if (parts[0] === 'jobs' && parts[1]) {
    const { createJobStore } = require('./工作儲存');
    try { return createJobStore(root).path(parts[1], ...parts.slice(2)); }
    catch (e) { if (!e.message.startsWith('找不到工作位置：')) throw e; }
  }
  const legacySamples = path.resolve(root, 'docs', 'page-samples');
  const relative = path.relative(legacySamples, absolute);
  if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
    return dataPath(root, 'page-samples', relative);
  }
  return absolute;
}

module.exports = { workspaceRoot, applicationPath, cliPath, dataPath, dataRelativePath, resolveDataReference };
