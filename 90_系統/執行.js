#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { applicationPath } = require('./paths');

const root = path.resolve(__dirname, '..');
const app = applicationPath(root);
const [action, ...args] = process.argv.slice(2);
const scripts = require(path.join(app, 'package.json')).scripts;
if (action !== '--install' && !Object.hasOwn(scripts, action || '')) {
  console.error('請透過根目錄 package.json 中的 npm 命令執行。');
  process.exit(1);
}

const npmArgs = action === '--install' ? ['ci', ...args] : ['run', action, '--', ...args];
const npmCli = process.env.npm_execpath;
const child = npmCli
  ? spawn(process.execPath, [npmCli, ...npmArgs], options())
  : spawn('npm', npmArgs, options());

function options() {
  return {
    cwd: app,
    stdio: 'inherit',
    env: { ...process.env, npm_config_cache: process.env.npm_config_cache || path.join(root, '.cache', 'npm'), WORKBENCH_CALLER_CWD: process.env.WORKBENCH_CALLER_CWD || process.cwd() },
  };
}

child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code === null ? 1 : code; });
