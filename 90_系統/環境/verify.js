'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, fork } = require('node:child_process');
const { createRequire } = require('node:module');
const { applicationPath } = require('../paths');
const { initialize } = require('./init');

const root = path.resolve(__dirname, '../..');
const app = applicationPath(root);
const requireApp = createRequire(path.join(app, 'package.json'));

function run(file, args) {
  const result = spawnSync(process.execPath, [file, ...args], { cwd: app, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`驗證失敗：${path.basename(file)}（${result.status}）`);
}

async function smoke() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-smoke-'));
  let child;
  try {
    const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(from, to, { recursive: true }); };
    copy(path.join(root, '.env.example'), path.join(scratch, '.env.example'));
    for (const name of ['paths.js', '工作儲存.js']) copy(path.join(root, '90_系統', name), path.join(scratch, '90_系統', name));
    for (const name of ['server/index.js', 'server/start.js', 'server/public', 'scripts/shot-memory.js', 'scripts/script-utils.js']) copy(path.join(app, name), applicationPath(scratch, name));
    fs.symlinkSync(path.join(app, 'node_modules'), applicationPath(scratch, 'node_modules'), 'dir');
    initialize(scratch);
    const bootstrap = applicationPath(scratch, 'smoke.cjs');
    fs.writeFileSync(bootstrap, `const server = require('./server/start');\nserver.on('listening', () => process.send({ port: server.address().port }));\n`);
    child = fork(bootstrap, [], {
      cwd: applicationPath(scratch),
      env: { PATH: process.env.PATH, PORT: '0', HOST: '127.0.0.1', ADMIN_KEY: '' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let errors = '';
    child.stderr.on('data', (chunk) => { errors += chunk.toString(); });
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('隔離工作台啟動逾時')), 10000);
      child.once('message', (message) => { clearTimeout(timer); resolve(message.port); });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`隔離工作台提前結束：${code} ${errors}`)); });
    });
    for (const endpoint of ['/', '/app.js', '/styles.css', '/api/health', '/api/jobs']) {
      const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`隔離 HTTP 檢查失敗：${endpoint}`);
      if (endpoint === '/api/jobs' && (await response.json()).jobs.length !== 0) throw new Error('隔離工作台不應含正式工作');
      else await response.arrayBuffer().catch(() => {});
    }
    console.log('隔離 HTTP 檢查通過：空工作台與網頁資源可載入。');
  } finally {
    if (child && child.exitCode === null) await new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function main() {
  run(requireApp.resolve('typescript/bin/tsc'), ['--noEmit', '--incremental', 'false']);
  const tests = fs.readdirSync(path.join(root, '90_系統/測試')).filter((n) => n.endsWith('.test.js')).map((n) => path.join(root, '90_系統/測試', n));
  run('--test', tests);
  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-bundle-'));
  try {
    await requireApp('@remotion/bundler').bundle({ entryPoint: path.join(app, 'src/index.ts'), rootDir: app, publicDir: path.join(app, 'public'), outDir: bundleDir, enableCaching: false, gitSource: null });
    if (!fs.existsSync(path.join(bundleDir, 'index.html'))) throw new Error('打包缺少入口');
    console.log('Remotion 打包通過（不渲染影片、不呼叫付費服務）。');
  } finally { fs.rmSync(bundleDir, { recursive: true, force: true }); }
  await smoke();
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
