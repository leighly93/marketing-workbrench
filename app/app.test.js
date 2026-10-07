// @vitest-environment jsdom
'use strict';

// 前台整體載入：index.html ＋ ES modules 在 jsdom 裡啟動，fetch 直接接到真的伺服器路由
//（server/app.js 的 createWorkbench，指向暫存目錄）。驗的是模組之間接得起來、跟 API 的契約一致。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { once } = require('node:events');
const { createWorkbench } = require('../server/app');

const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function serverFetch(workbench) {
  return async (url, options = {}) => {
    const body = options.body == null ? [] : [Buffer.isBuffer(options.body) ? options.body : Buffer.from(String(options.body))];
    const req = Readable.from(body, { objectMode: false });
    Object.assign(req, { method: options.method || 'GET', url, headers: { ...(options.headers || {}) }, socket: { remoteAddress: '127.0.0.1' } });
    const chunks = [];
    let status = 0;
    const res = new Writable({ write(c, _e, done) { chunks.push(Buffer.from(c)); done(); } });
    res.writeHead = (code) => { status = code; };
    const finished = once(res, 'finish');
    await workbench.route(req, res);
    await finished;
    const text = Buffer.concat(chunks).toString();
    return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text) };
  };
}

async function boot(t, { env = {}, setup } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-app-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const workbench = createWorkbench({
    root, env, childProcess: new Proxy({}, { get: () => () => { throw new Error('前台測試不跑子程序'); } }),
    process: { env, kill() { throw new Error('沒有程序'); } },
    timers: { setTimeout() {}, setImmediate() {} },
  });
  if (setup) setup(workbench);
  document.documentElement.innerHTML = HTML.replace(/<script[\s\S]*?<\/script>/g, '');
  globalThis.fetch = serverFetch(workbench);
  window.alert = vi.fn();
  window.confirm = vi.fn(() => true);
  vi.useFakeTimers({ toFake: ['setInterval'] });
  t.onTestFinished(() => vi.useRealTimers());
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await import('./app.js');
  await settle();
  return workbench;
}

/** 等畫面上的非同步（fetch → 重畫）跑完。 */
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

const $ = (s) => document.querySelector(s);

test('啟動：版型清單照設定表順序畫出來，預設選第一個；伺服器狀態顯示閒置', async (t) => {
  await boot(t);
  expect([...document.querySelectorAll('#tpl div')].map((d) => d.dataset.k)).toEqual(['midday', 'dapan', 'usstock']);
  expect($('#v-new').dataset.tpl).toBe('midday');
  expect($('#status').textContent).toBe('○ 閒置');
  expect($('#mockMode').hidden).toBe(true);
  expect($('#navFix').hidden).toBe(false); // 本機連線＝管理者
  // 換版型：標題輸入框的數量跟著版型設定
  document.querySelector('#tpl div[data-k="dapan"]').click();
  expect($('#v-new').dataset.tpl).toBe('dapan');
  expect($('#titleLabel').textContent).toMatch(/大盤小報/);
});

test('模擬模式：頁首掛警示', async (t) => {
  await boot(t, { env: { WORKBENCH_MOCK: '1' } });
  expect($('#mockMode').hidden).toBe(false);
});

test('列表 → 點一筆 → 工作頁', async (t) => {
  await boot(t, {
    setup(wb) {
      const job = { id: '20261007-090000-abcd', template: 'dapan', owner: '小明', title: '今日盤勢', status: 'failed',
        error: '合成錯誤', createdAt: '2026-10-07T01:00:00.000Z', mock: true };
      wb.addJob(job);
      wb.saveJob(job);
    },
  });
  $('nav button[data-v="list"]').click();
  await settle();
  const row = $('#jobs tr.jobrow');
  expect(row.textContent).toMatch(/大盤小報.*🧪 今日盤勢.*小明.*失敗/);
  row.querySelector('td').click();
  await settle();
  expect($('#v-job').hidden).toBe(false);
  expect($('#v-job').textContent).toMatch(/今日盤勢/);
  expect($('#v-job').textContent).toMatch(/模擬模式產生/);
});

test('待確認的工作：畫出配圖計畫與確認按鈕', async (t) => {
  const chars = [...'今天台股上漲。'].map((c, i) => ({ c, i }));
  await boot(t, {
    setup(wb) {
      const job = { id: '20261007-090100-wxyz', template: 'midday', owner: '小華', title: '盤中', status: 'review',
        createdAt: '2026-10-07T01:01:00.000Z', files: ['shot1.png', 'script.txt'],
        planView: { editable: true, rows: [{ i: 0, src: 'shot1.png', phrase: '今天台股上漲', start: 0, end: 1.2, dur: 1.2,
          cellText: '', wholePage: true, cell: null, region: null, arrow: null, startCharIdx: 0, endCharIdx: 5, thumb: null }],
        images: ['shot1.png'], totalSec: 1.4, emphasis: [], pages: {}, pendingAnnots: [],
        units: [{ i: 0, text: '今天台股上漲。', startCharIdx: 0, endCharIdx: 6 }], chars, unused: [] } };
      wb.addJob(job);
      wb.saveJob(job);
    },
  });
  $('nav button[data-v="list"]').click();
  await settle();
  $('#jobs tr.jobrow td').click();
  await settle();
  const page = $('#v-job').textContent;
  expect(page).toMatch(/待確認/);
  expect(page).toMatch(/shot1\.png/);
  const approve = [...document.querySelectorAll('#v-job button')].find((b) => /確認，開始出片/.test(b.textContent));
  expect(approve).toBeTruthy();
});
