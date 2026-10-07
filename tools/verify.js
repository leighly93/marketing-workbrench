'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, fork } = require('node:child_process');
const { createRequire } = require('node:module');
const { applicationPath } = require('../shared/paths');
const { createSandbox } = require('./sandbox');

const root = path.resolve(__dirname, '..');
const app = applicationPath(root); // Remotion 專案 video/remotion
const requireApp = createRequire(path.join(root, 'package.json'));

function run(file, args) {
  const result = spawnSync(process.execPath, [file, ...args], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`驗證失敗：${path.basename(file)}（${result.status}）`);
}

async function smoke() {
  // 隔離工作區（tools/sandbox.js）：程式整份複製、空白 storage，不碰正式工作。
  const sandbox = createSandbox({ prefix: 'workbench-smoke-' });
  const scratch = sandbox.dir;
  let child;
  try {
    const bootstrap = path.join(scratch, 'smoke.cjs');
    fs.writeFileSync(bootstrap, `const server = require('./server/start');\nserver.on('listening', () => process.send({ port: server.address().port }));\n`);
    child = fork(bootstrap, [], {
      cwd: scratch,
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
    for (const endpoint of ['/', '/app.js', '/js/shell.js', '/styles.css', '/api/health', '/api/jobs']) {
      const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`隔離 HTTP 檢查失敗：${endpoint}`);
      if (endpoint === '/api/jobs' && (await response.json()).jobs.length !== 0) throw new Error('隔離工作台不應含正式工作');
      else await response.arrayBuffer().catch(() => {});
    }
    console.log('隔離 HTTP 檢查通過：空工作台與網頁資源可載入。');
  } finally {
    if (child && child.exitCode === null) await new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); });
    sandbox.cleanup();
  }
}

async function main() {
  run(requireApp.resolve('typescript/bin/tsc'), ['--noEmit', '--incremental', 'false']);
  run(requireApp.resolve('typescript/bin/tsc'), ['-p', 'tsconfig.checkjs.json']); // 後端 // @ts-check 的 JSDoc 型別
  run(path.join(root, 'node_modules', 'vitest', 'vitest.mjs'), ['run']);
  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-bundle-'));
  try {
    await requireApp('@remotion/bundler').bundle({ entryPoint: path.join(app, 'src/index.ts'), rootDir: root, publicDir: path.join(app, 'public'), outDir: bundleDir, enableCaching: false, gitSource: null });
    if (!fs.existsSync(path.join(bundleDir, 'index.html'))) throw new Error('打包缺少入口');
    console.log('Remotion 打包通過（不渲染影片、不呼叫付費服務）。');
  } finally { fs.rmSync(bundleDir, { recursive: true, force: true }); }
  await smoke();
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
