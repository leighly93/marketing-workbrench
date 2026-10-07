// @vitest-environment jsdom
'use strict';

// 前台整體載入：Vue 應用在 jsdom 裡掛起來，fetch 直接接到真的伺服器路由
//（server/app.js 的 createWorkbench，指向暫存目錄）。驗的是元件之間接得起來、跟 API 的契約一致。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { once } = require('node:events');
const { createWorkbench } = require('../../server/app');

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
    return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text), text: async () => text };
  };
}

async function boot(t, { env = {}, setup, path: start = '/' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-app-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const workbench = createWorkbench({
    root, env, childProcess: new Proxy({}, { get: () => () => { throw new Error('前台測試不跑子程序'); } }),
    process: { env, kill() { throw new Error('沒有程序'); } },
    timers: { setTimeout() {}, setImmediate() {} },
  });
  if (setup) setup(workbench);
  document.body.innerHTML = '<div id="app"></div>';
  globalThis.fetch = serverFetch(workbench);
  window.alert = vi.fn();
  window.confirm = vi.fn(() => true);
  vi.useFakeTimers({ toFake: ['setInterval'] });
  t.onTestFinished(() => vi.useRealTimers());
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const { mountApp } = await import('./main.js');
  const { createAppRouter } = await import('./router.js');
  const router = createAppRouter({ memory: true });
  await router.push(start);
  const { app } = mountApp('#app', router);
  t.onTestFinished(() => app.unmount());
  await settle();
  return { workbench, router };
}

/** 等畫面上的非同步（fetch → 重畫）跑完。 */
async function settle() {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
}

const $ = (s) => document.querySelector(s);

test('啟動：新增任務頁的版型清單照設定表順序畫出來，預設選第一個；伺服器狀態顯示閒置', async (t) => {
  await boot(t, { path: '/new' });
  expect([...document.querySelectorAll('#tpl div')].map((d) => d.dataset.k)).toEqual(['midday', 'dapan', 'usstock']);
  expect($('#v-new').dataset.tpl).toBe('midday');
  expect($('#status').textContent).toBe('○ 閒置');
  expect($('#mockMode')).toBeNull();
  expect($('[data-nav="/fix"]')).not.toBeNull(); // 本機連線＝管理者
  document.querySelector('#tpl div[data-k="dapan"]').click();
  await settle();
  expect($('#v-new').dataset.tpl).toBe('dapan');
  expect($('#titleLabel').textContent).toMatch(/大盤小報/);
});

test('模擬模式：頁首掛警示；儀表板讀得到統計與額度', async (t) => {
  await boot(t, { env: { WORKBENCH_MOCK: '1' } });
  expect($('#mockMode')).not.toBeNull();
  expect($('[data-stats]')).not.toBeNull();
  expect($('[data-quotas]').textContent).toMatch(/HeyGen/);
  expect($('[data-attention]').textContent).toMatch(/沒有東西卡著/);
});

test('列表 → 點一筆 → 工作頁的 pipeline，失敗的節點與重新出片', async (t) => {
  const { router } = await boot(t, {
    path: '/jobs',
    setup(wb) {
      const job = { id: '20261007-090000-abcd', template: 'dapan', owner: '小明', title: '今日盤勢', status: 'failed',
        error: '合成錯誤', createdAt: '2026-10-07T01:00:00.000Z', mock: true };
      wb.addJob(job);
      wb.saveJob(job);
    },
  });
  const row = $('#jobs tr.jobrow');
  expect(row.textContent).toMatch(/大盤小報.*🧪 今日盤勢.*小明.*失敗/);
  row.click();
  await settle();
  expect(router.currentRoute.value.name).toBe('job');
  expect($('[data-job-head]').textContent).toMatch(/今日盤勢/);
  expect($('[data-job-head]').textContent).toMatch(/模擬模式產生/);
  expect($('[data-job-head]').textContent).toMatch(/合成錯誤/);
  expect($('[data-pipeline] .node.failed')).not.toBeNull();
  expect($('[data-node="redo"]').classList.contains('ready')).toBe(true);
  $('[data-node="redo"]').click();
  await settle();
  expect($('[data-panel]').textContent).toMatch(/重新出片/);
});

test('待確認的工作：pipeline 停在「配圖計畫確認」，右側畫出計畫與確認按鈕', async (t) => {
  const chars = [...'今天台股上漲。'].map((c, i) => ({ c, i }));
  await boot(t, {
    path: '/jobs/20261007-090100-wxyz',
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
  expect($('[data-job-head]').textContent).toMatch(/待確認/);
  expect($('[data-node="review"]').classList.contains('on')).toBe(true);
  const panel = $('[data-panel]');
  expect(panel.textContent).toMatch(/shot1\.png/);
  expect(panel.textContent).toMatch(/今天台股上漲/);
  const approve = [...panel.querySelectorAll('button')].find((b) => /確認，開始出片/.test(b.textContent));
  expect(approve).toBeTruthy();
  expect(approve.disabled).toBe(false);
});

test('草稿：建立後停在 pipeline 的建立階段，截圖是待辦、送出可以按', async (t) => {
  await boot(t, {
    path: '/jobs/20261007-090200-dddd',
    setup(wb) {
      const job = { id: '20261007-090200-dddd', template: 'dapan', owner: '小美', title: '草稿', status: 'draft',
        createdAt: '2026-10-07T01:02:00.000Z', scriptBody: '今天台股上漲。', files: ['script.txt'], voiceRules: { own: [], shared: [], hit: [] } };
      wb.addJob(job);
      wb.saveJob(job);
    },
  });
  expect($('[data-job-head]').textContent).toMatch(/草稿/);
  expect($('[data-node="shots"]').classList.contains('todo')).toBe(true);
  expect($('[data-node="submit"]').classList.contains('ready')).toBe(true);
  $('[data-node="submit"]').click();
  await settle();
  const go = [...document.querySelectorAll('[data-panel] button')].find((b) => /開始出片/.test(b.textContent));
  expect(go).toBeTruthy();
  expect(go.disabled).toBe(false);
});
