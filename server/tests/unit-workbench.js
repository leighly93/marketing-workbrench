'use strict';

// 單元測試用：在暫存目錄組一個工作台（子程序封鎖、計時器記錄下來），直接拿各模組的函式來測。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkbench } = require('../app');

function blocked() {
  throw new Error('單元測試不啟動子程序');
}

/**
 * @param {{ onTestFinished: (fn: () => void) => void }} t
 * @param {{ env?: Record<string, string>, childProcess?: object }} [options]
 */
function unitWorkbench(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-unit-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const timers = { calls: [], setTimeout: (fn, ms) => timers.calls.push(['timeout', ms]), setImmediate: (fn) => timers.calls.push(['immediate', fn]) };
  const env = { ...options.env };
  const wb = createWorkbench({
    root, env, timers,
    childProcess: options.childProcess || new Proxy({}, { get: () => blocked }),
    process: { env, kill: blocked },
  });
  return Object.assign(wb, { root, timers });
}

module.exports = { unitWorkbench };
