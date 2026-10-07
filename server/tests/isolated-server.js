'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { Readable, Writable } = require('node:stream');
const { createWorkbench } = require('../app');

const repository = path.resolve(__dirname, '..', '..');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-資料測試 '));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
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

// 用 server/app.js 的 createWorkbench 組一個指向合成副本的工作台：
//   fs 鎖在 fixture、子程序預設全面封鎖、不開 port。
// options.childProcess：需要觀察 spawn 出去的子程序時才給（例如「系統框選建議」那一次 execFileSync）；
//   不給就維持預設的全面封鎖。options.idleTimers：tick() 排隊會呼叫 setTimeout，
//   走到那條路的測試才放行成 no-op，其餘測試仍然禁止計時器。
// options.env：給 server 看的環境變數；options.remoteAddress：模擬區網連線（預設本機）。
function loadServer(root, options = {}) {
  // setImmediate 不是計時器，是「回應先出去、出片工作下一輪才啟動」（見 routes/review.js 的
  // /approve）。排進佇列、等回應寫完才跑，順序就跟正式服務一樣；同步跑掉的話這裡測到的
  // 會是它原本那個「同步 tick() 把回應擋住」的舊行為。
  const immediates = [];
  const env = { ...options.env };
  const workbench = createWorkbench({
    root,
    env,
    fs: confinedFs(root),
    childProcess: options.childProcess || new Proxy({}, { get: () => blocked }),
    process: { env, kill: blocked },
    timers: {
      setTimeout: options.idleTimers ? () => 0 : blocked,
      setImmediate: (fn) => { immediates.push(fn); return 0; },
    },
  });
  const route = workbench.route;
  assert.equal(typeof route, 'function');
  const request = async (method, url, body, headers = {}) => {
    // 跟真的 IncomingMessage 一樣是有緩衝的串流：路由晚一點才掛 listener 也讀得到本文。
    const payload = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))];
    const req = Readable.from(payload, { objectMode: false });
    Object.assign(req, { method, url, headers, socket: { remoteAddress: options.remoteAddress || '127.0.0.1' } });
    const chunks = [];
    let status, responseHeaders;
    const res = new Writable({ write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    res.writeHead = (code, values) => { status = code; responseHeaders = values; };
    const finished = once(res, 'finish');
    const pending = route(req, res);
    await pending;
    await finished;
    // 回應寫完才輪到 setImmediate 排的工作（tick）—— 測試讀到的狀態跟正式服務一致。
    while (immediates.length) immediates.shift()();
    assert.ok(status, '路由必須完成回應');
    const bytes = Buffer.concat(chunks);
    const isJson = (responseHeaders['Content-Type'] || '').startsWith('application/json');
    return { status, headers: responseHeaders, bytes, body: isJson ? JSON.parse(bytes.toString()) : bytes };
  };
  return Object.assign(request, workbench);
}

// 舊測試的邏輯名稱對應到明確的合成工作目錄；不呼叫正式儲存解析器。
function workFile(root, id, ...parts) {
  const dir = path.join(root, 'storage', 'jobs', id);
  if (parts[0] === 'input') {
    if (parts[1] === 'script.txt') return path.join(dir, 'script.txt');
    return path.join(dir, 'inputs', ...parts.slice(1));
  }
  if (parts[0] === 'state') return path.join(dir, '_meta', 'state', ...parts.slice(1));
  return path.join(dir, '_meta', ...parts);
}
// 原始碼層級的檢查（呼叫順序、白名單）要看整個 server/，不能只看入口檔。
function serverSource() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) { if (e.name !== 'tests') walk(path.join(dir, e.name)); }
      else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) out.push(fs.readFileSync(path.join(dir, e.name), 'utf8'));
    }
  };
  walk(path.join(repository, 'server'));
  return out.join('\n');
}

// 前台原始碼（入口 app.js ＋ js/ 底下的模組，不含測試）：拆成多個模組後，原始碼層級的檢查要看全部。
function webSource() {
  const dir = path.join(repository, 'app');
  const files = ['app.js', ...fs.readdirSync(path.join(dir, 'js')).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')).sort().map((f) => path.join('js', f))];
  return files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
}

module.exports = { repository, fixture, write, confinedFs, loadServer, workFile, serverSource, webSource };
