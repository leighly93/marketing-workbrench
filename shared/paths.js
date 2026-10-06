'use strict';

const path = require('node:path');

// 專案配置：
//   app/            網頁前台
//   server/         工作台 API
//   video/          出片：run.js、pipeline/ 產線腳本、remotion/ 模板
//   shared/         本檔與 job-store.js
//   storage/        jobs/、shared-assets/、data/、tmp/、archive/（只有 shared-assets 進 Git）
//
// 「application root」指 Remotion 專案資料夾 video/remotion —— 出片時讀寫的 src/ 與 public/ 都在這裡。
// 各模組依自己的 __dirname 算出 application root，再用 workspaceRoot() 回到 repository 根。
const REMOTION_PARTS = ['video', 'remotion'];
const STORAGE_PARTS = ['storage'];

function workspaceRoot(applicationRoot) {
  return path.resolve(applicationRoot, '..', '..');
}

function applicationPath(root, ...segments) {
  return path.join(root, ...REMOTION_PARTS, ...segments);
}

function storagePath(root, ...segments) {
  return path.join(root, ...STORAGE_PARTS, ...segments);
}

function dataPath(root, ...segments) {
  return storagePath(root, 'data', ...segments);
}

function dataRelativePath(...segments) {
  return path.join(...STORAGE_PARTS, 'data', ...segments);
}

function outputPath(root, ...segments) {
  return storagePath(root, 'tmp', 'pipeline-output', ...segments);
}

function sharedAssetsPath(root, ...segments) {
  return storagePath(root, 'shared-assets', ...segments);
}

// CLI 參數：storage/ 與 jobs/<完整 ID>/... 以 repository 根解析；src/、public/ 以 Remotion 專案解析；
// 其餘以呼叫者 CWD 解析（npm 會把下命令時的目錄放在 INIT_CWD，執行時 CWD 一律是 repository 根）。
function cliPath(applicationRoot, reference) {
  const root = workspaceRoot(applicationRoot);
  if (path.isAbsolute(reference)) return resolveDataReference(root, reference);
  const normalized = path.normalize(reference);
  const first = normalized.split(path.sep)[0];
  if (['jobs', 'storage', '.cache'].includes(first)) return resolveDataReference(root, normalized);
  if (['src', 'public'].includes(first)) return path.resolve(applicationRoot, normalized);
  return path.resolve(process.env.WORKBENCH_CALLER_CWD || process.env.INIT_CWD || applicationRoot, normalized);
}

// jobs/<完整 job ID>/... 是邏輯位置，交給 job-store 找到 storage/jobs/ 底下實際的工作資料夾。
function resolveDataReference(root, reference) {
  const absolute = path.resolve(root, reference);
  const parts = path.relative(root, absolute).split(path.sep);
  if (parts[0] === 'jobs' && parts[1]) {
    const { createJobStore } = require('./job-store');
    try { return createJobStore(root).path(parts[1], ...parts.slice(2)); }
    catch (e) { if (!e.message.startsWith('找不到工作位置：')) throw e; }
    return storagePath(root, ...parts);
  }
  return absolute;
}

module.exports = {
  workspaceRoot, applicationPath, storagePath, dataPath, dataRelativePath, outputPath, sharedAssetsPath,
  cliPath, resolveDataReference,
};
