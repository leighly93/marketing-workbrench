'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { applicationPath } = require('../paths');

const sourceFile = path.resolve(__dirname, '../執行.js');
const root = path.resolve('/tmp', '合成 工作台');
const app = applicationPath(root);

function forward(action, args = [], env = {}) {
  const spawned = [];
  const caller = path.resolve('/tmp', '合成 呼叫者');
  const processFixture = {
    argv: ['/synthetic/node', sourceFile, action, ...args],
    execPath: '/synthetic/node', env: { ...env }, cwd: () => caller,
    exit(code) { const error = new Error('synthetic-exit'); error.code = code; throw error; },
  };
  const context = {
    __dirname: path.join(root, '90_系統'),
    process: processFixture,
    console: { error() {} },
    require(name) {
      if (name === 'node:path') return path;
      if (name === './paths') return { applicationPath };
      if (name === path.join(app, 'package.json')) return { scripts: { typecheck: 'synthetic-typecheck' } };
      if (name === 'node:child_process') return {
        spawn(command, argv, options) {
          const child = new EventEmitter();
          spawned.push({ command, args: Array.from(argv), options, child });
          return child;
        },
      };
      throw new Error(`測試未允許的 require：${name}`);
    },
  };
  let exit;
  try {
    vm.runInNewContext(fs.readFileSync(sourceFile, 'utf8'), context, { filename: sourceFile, timeout: 5000 });
  } catch (error) {
    if (error.message !== 'synthetic-exit') throw error;
    exit = error.code;
  }
  return { spawned, process: processFixture, caller, exit };
}

test('根目錄 npm 入口在程式區執行並完整傳遞參數與呼叫者 CWD', () => {
  const npmCli = '/synthetic/npm path/npm-cli.js';
  const args = ['--incremental', 'false', '含 空白的稿件.txt'];
  const run = forward('typecheck', args, { npm_execpath: npmCli, SYNTHETIC_OPTION: 'retained' });
  assert.equal(run.spawned.length, 1);
  const child = run.spawned[0];
  assert.equal(child.command, '/synthetic/node');
  assert.deepEqual(child.args, [npmCli, 'run', 'typecheck', '--', ...args]);
  assert.equal(child.options.cwd, app);
  assert.equal(child.options.env.WORKBENCH_CALLER_CWD, run.caller);
  assert.equal(child.options.env.npm_config_cache, path.join(root, '.cache', 'npm'));
  assert.equal(child.options.env.SYNTHETIC_OPTION, 'retained');
  assert.equal(child.options.stdio, 'inherit');
  child.child.emit('exit', 3);
  assert.equal(run.process.exitCode, 3);
});

test('安裝入口仍指向程式套件，巢狀呼叫保留最初 CWD 並回報程序錯誤', () => {
  const originalCaller = '/synthetic/original caller';
  const run = forward('--install', ['--ignore-scripts'], { WORKBENCH_CALLER_CWD: originalCaller });
  const child = run.spawned[0];
  assert.equal(child.command, 'npm');
  assert.deepEqual(child.args, ['ci', '--ignore-scripts']);
  assert.equal(child.options.cwd, app);
  assert.equal(child.options.env.WORKBENCH_CALLER_CWD, originalCaller);
  child.child.emit('error', new Error('synthetic-spawn-failure'));
  assert.equal(run.process.exitCode, 1);
  child.child.emit('exit', null);
  assert.equal(run.process.exitCode, 1);
});

test('未知 npm 動作在啟動任何子程序前結束', () => {
  const run = forward('不存在的動作');
  assert.equal(run.exit, 1);
  assert.equal(run.spawned.length, 0);
});
