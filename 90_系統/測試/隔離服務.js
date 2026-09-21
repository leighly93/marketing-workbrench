'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter, once } = require('node:events');
const { Writable } = require('node:stream');
const { createRequire } = require('node:module');
const { applicationPath } = require('../paths');

const repository = path.resolve(__dirname, '../..');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-資料測試 '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
}

function blocked() {
  throw new Error('隔離測試禁止啟動服務、子程序、計時器或對其他程序操作');
}

// fs 的所有使用都限制在 fixture，路徑回歸不能偷偷讀寫開發者的正式資料。
function confinedFs(root) {
  const dualPaths = new Set(['copyFileSync', 'renameSync']);
  return new Proxy(fs, {
    get(target, key) {
      const value = target[key];
      if (typeof value !== 'function') return value;
      return (...args) => {
        for (const argument of args.slice(0, dualPaths.has(key) ? 2 : 1)) {
          if (typeof argument !== 'string' && !Buffer.isBuffer(argument) && !(argument instanceof URL)) continue;
          const relative = path.relative(root, path.resolve(String(argument)));
          assert.ok(relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)),
            '測試程式只能存取 fixture 內的檔案');
        }
        return value.apply(target, args);
      };
    },
  });
}

// server 尚未分離啟動與路由；載入真實程式至合成副本、攔截監聽與程序操作。
// options.childProcess：需要觀察 spawn 出去的子程序時才給（例如「系統框選建議」那一次 execFileSync）；
//   不給就維持預設的全面封鎖。options.idleTimers：tick() 排隊會呼叫 setTimeout，
//   走到那條路的測試才放行成 no-op，其餘測試仍然禁止計時器。
function loadServer(root, options = {}) {
  const sourceFile = applicationPath(repository, 'server/index.js');
  const source = fs.readFileSync(sourceFile, 'utf8');
  const cut = source.indexOf('\nserver.listen(');
  assert.ok(cut > 0, '啟動入口變更時應先更新隔離載入方式');
  const localRequire = createRequire(sourceFile);
  let route;
  const modules = {
    fs: confinedFs(root),
    os,
    path,
    // 只做 md5（重新出片比對截圖有沒有換過），沒有副作用，給真的就好
    crypto: localRequire('node:crypto'),
    http: { createServer(handler) { route = handler; return { on() {}, listen: blocked }; } },
    child_process: options.childProcess || new Proxy({}, { get: () => blocked }),
    '../scripts/shot-memory': localRequire('../scripts/shot-memory'),
    '../scripts/image-size': localRequire('../scripts/image-size'),
    '../scripts/script-utils': localRequire('../scripts/script-utils'),
    '../../paths': localRequire('../../paths'),
    '../../工作儲存': localRequire('../../工作儲存'),
  };
  // setImmediate 排進來的工作（見下面 context 那段）
  const immediates = [];
  const context = {
    __dirname: applicationPath(root, 'server'),
    __filename: applicationPath(root, 'server/index.js'),
    require(name) {
      const key = name.replace(/^node:/, '');
      assert.ok(Object.hasOwn(modules, key), `隔離載入未允許的模組：${key}`);
      return modules[key];
    },
    process: { env: {}, on() {}, cwd: () => applicationPath(root), exit: blocked, kill: blocked },
    Buffer, URL, console,
    setTimeout: options.idleTimers ? () => 0 : blocked,
    // setImmediate 不是計時器，是「回應先出去、出片工作下一輪才啟動」（見 index.js 的
    // /approve）。排進佇列、等回應寫完才跑，順序就跟正式服務一樣；同步跑掉的話這裡測到的
    // 會是它原本那個「同步 tick() 把回應擋住」的舊行為。
    setImmediate: (fn) => { immediates.push(fn); return 0; },
    setInterval: options.idleTimers ? () => 0 : blocked,
  };
  const operations = vm.runInNewContext(
    source.slice(0, cut) + '\n;({ snapshotWorkspace, restoreWorkspace, pruneOldJobs, archivePath, backupJobArtifacts, stageJobInputs, writeEmphasis, emphasisOf, clearWorkspaceInputs, readJobEmphasis, saveJobEmphasis, normalizeMotion, readJobMotion, saveJobMotion, collectMotionAssets, getJob, doRender });',
    context, { filename: sourceFile, timeout: 5000 },
  );
  assert.equal(typeof route, 'function');
  const request = async (method, url, body, headers = {}) => {
    const req = new EventEmitter();
    Object.assign(req, { method, url, headers, socket: { remoteAddress: '127.0.0.1' } });
    const chunks = [];
    let status, responseHeaders;
    const res = new Writable({ write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    res.writeHead = (code, values) => { status = code; responseHeaders = values; };
    const finished = once(res, 'finish');
    const pending = route(req, res);
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
    await pending;
    await finished;
    // 回應寫完才輪到 setImmediate 排的工作（tick）—— 測試讀到的狀態跟正式服務一致。
    while (immediates.length) immediates.shift()();
    assert.ok(status, '路由必須完成回應');
    const bytes = Buffer.concat(chunks);
    const isJson = (responseHeaders['Content-Type'] || '').startsWith('application/json');
    return { status, headers: responseHeaders, bytes, body: isJson ? JSON.parse(bytes.toString()) : bytes };
  };
  return Object.assign(request, operations);
}

// 舊測試的邏輯名稱對應到明確的合成工作目錄；不呼叫正式儲存解析器。
function workFile(root, id, ...parts) {
  const dir = path.join(root, '工作紀錄', id);
  if (parts[0] === 'input') {
    if (parts[1] === 'script.txt') return path.join(dir, '稿件.txt');
    return path.join(dir, '素材', ...parts.slice(1));
  }
  if (parts[0] === 'state') return path.join(dir, '_製作資料', '快照', ...parts.slice(1));
  return path.join(dir, '_製作資料', ...parts);
}
module.exports = { repository, fixture, write, confinedFs, loadServer, workFile };
