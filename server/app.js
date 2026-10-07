'use strict';

/**
 * 工作台的組裝點（composition root）：建立設定與共用依賴，依序建立各功能模組，最後組成路由。
 *
 * 每個模組都是 `create(ctx) → { 函式… }`，只從 ctx 取依賴、不自己 require fs／child_process，
 * 所以測試可以整組換掉：fs 鎖在暫存目錄、子程序換成假的、計時器排進佇列。
 * 順序就是依賴方向 —— 後面的模組只能用前面的（例如佇列要用到出片，出片要用到工作區）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { outputPath, dataPath, resolveDataReference } = require('../shared/paths');
const { createJobStore, outputName } = require('../shared/job-store');
const { isMockMode } = require('../shared/mock-mode');
const { serverTemplates, TEMPLATE_ASSET_PATTERN } = require('../video/templates/registry');
// 「你教過的東西」記憶庫。memKeyOf／mergeRuns 一定要跟 auto-shot.js 共用同一份實作 ——
// 這裡負責寫、auto-shot 負責讀，鍵值算法漂掉的話學到的東西下次就對不上（2026-08-21）。
const SHOT_MEMORY = require('../video/shots/shot-memory');
const { resolveManualOverlaps } = require('../video/pipeline/script-utils');
const { imageSize, pickImageSize } = require('../video/shots/image-size');
const { createConfig } = require('./config');
const { createRouter } = require('./http/router');

/** 依賴方向排好的模組；每個回傳的函式都會掛進 ctx 給後面的模組用。 */
const MODULES = [
  './lib/files',
  './jobs/store',
  './jobs/processes',
  './jobs/registry',
  './plan/marks',
  './jobs/workspace',
  './jobs/delivery',
  './messages/store',
  './voice/rules',
  './plan/view',
  './plan/edits',
  './corrections/log',
  './corrections/record',
  './corrections/learn',
  './uploads/images',
  './jobs/production',
  './jobs/queue',
  './system/status',
  './http/auth',
  './http/respond',
];

/** 路由的順序：管理者暗號轉址一定要在最前面，靜態檔在最後。 */
const ROUTES = [
  './routes/system',
  './routes/messages',
  './routes/pronounce',
  './routes/jobs',
  './routes/job-content',
  './routes/review',
  './routes/static',
];

/**
 * 模組拿不存在的依賴就當場報錯（名字打錯、順序排錯），不要等到某條路徑跑到才發現是 undefined。
 * @param {Record<string, any>} ctx @param {string} owner
 */
function strict(ctx, owner) {
  return new Proxy(ctx, {
    get(target, key) {
      if (typeof key === 'string' && !(key in target)) throw new Error(`${owner} 需要的依賴「${key}」不存在（檢查 server/app.js 的模組順序）`);
      return target[/** @type {string} */ (key)];
    },
  });
}

/**
 * @param {{
 *   root?: string,
 *   env?: NodeJS.ProcessEnv,
 *   fs?: typeof fs,
 *   childProcess?: Partial<typeof childProcess>,
 *   process?: { env: NodeJS.ProcessEnv, kill: (pid: number, signal?: string | number) => unknown },
 *   timers?: { setTimeout: (fn: () => void, ms: number) => unknown, setImmediate: (fn: () => void) => unknown },
 * }} [options]
 */
function createWorkbench({
  root = path.resolve(__dirname, '..'),
  env = process.env,
  fs: fileSystem = fs,
  childProcess: processes = childProcess,
  process: proc = process,
  timers = { setTimeout, setImmediate },
} = {}) {
  const config = createConfig({ root, env });
  const store = createJobStore(root, fileSystem);
  /** @type {Record<string, any>} */
  const ctx = {
    fs: fileSystem, path, os, crypto, childProcess: processes, process: proc, timers,
    config, store, JOBS_DIR: store.base,
    // 版型設定在 video/templates/registry.js（顯示順序、標題規則、輸出檔名都在那裡）。
    TEMPLATES: serverTemplates(), TEMPLATE_ASSET_PATTERN,
    outputName, outputPath, dataPath, resolveDataReference, isMockMode,
    SHOT_MEMORY, resolveManualOverlaps, imageSize, pickImageSize,
  };
  for (const name of MODULES) Object.assign(ctx, require(name)(strict(ctx, name)));
  const route = createRouter({
    handlers: ROUTES.map((name) => require(name)(strict(ctx, name))),
    isAdmin: ctx.isAdmin, send: ctx.send, BadRequest: ctx.BadRequest,
  });
  return Object.assign(ctx, { route });
}

module.exports = { createWorkbench, MODULES, ROUTES };
