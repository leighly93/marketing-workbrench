// @vitest-environment jsdom
'use strict';

// 新的建立流程在 jsdom 裡走一遍：新增任務建草稿 → 工作頁 pipeline → 截圖面板上傳 → 唸法 → 講者 → 送出。
// fetch 接到真的伺服器路由（跟 app.test.js 同一套），上傳的 File 會真的寫進暫存目錄。
// 另外盯著 console.error／warn：Vue 的 runtime 警告（props 型別、找不到元件、render 丟錯）不能有。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { once } = require('node:events');
const { createWorkbench } = require('../../server/app');

function serverFetch(workbench) {
  return async (url, options = {}) => {
    let raw = options.body;
    if (raw && typeof raw.arrayBuffer === 'function') raw = Buffer.from(await raw.arrayBuffer());   // File／Blob
    const body = raw == null ? [] : [Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw))];
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

async function settle(n = 40) { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); }
const $ = (s) => document.querySelector(s);
const button = (re, root = document) => [...root.querySelectorAll('button')].find((b) => re.test(b.textContent));

// 1×1 PNG（伺服器會嗅探內容，不是 PNG 會退件）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let errors;
async function boot(t, { env = { WORKBENCH_MOCK: '1' }, path: start = '/' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-flow-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const workbench = createWorkbench({
    root, env, childProcess: new Proxy({}, { get: () => () => { throw new Error('前台測試不跑子程序'); } }),
    process: { env, kill() { throw new Error('沒有程序'); } },
    timers: { setTimeout() {}, setImmediate() {} },
  });
  document.body.innerHTML = '<div id="app"></div>';
  globalThis.fetch = serverFetch(workbench);
  window.alert = vi.fn((m) => { throw new Error('alert：' + m); });
  window.confirm = vi.fn(() => true);
  vi.useFakeTimers({ toFake: ['setInterval'] });
  t.onTestFinished(() => vi.useRealTimers());
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.map(String).join(' ')));
  vi.spyOn(console, 'warn').mockImplementation((...a) => errors.push(a.map(String).join(' ')));
  const { mountApp } = await import('./main.js');
  const { createAppRouter } = await import('./router.js');
  const router = createAppRouter({ memory: true });
  await router.push(start);
  const { app } = mountApp('#app', router);
  app.config.errorHandler = (e) => errors.push('vue error: ' + (e && e.stack || e));
  t.onTestFinished(() => app.unmount());
  await settle();
  return { workbench, router, root };
}

test('新增任務 → 草稿 → pipeline 補截圖／唸法／講者 → 送出，過程沒有任何 runtime 警告', async (t) => {
  const { workbench, router, root } = await boot(t, { path: '/new' });
  // 建草稿
  $('#owner').value = '小明'; $('#owner').dispatchEvent(new Event('input'));
  const titles = document.querySelectorAll('#v-new .tline input');
  titles[0].value = '盤中'; titles[0].dispatchEvent(new Event('input'));
  $('#body').value = '今天台股上漲。外資買超。'; $('#body').dispatchEvent(new Event('input'));
  button(/建立草稿/).click();
  await settle();
  expect(router.currentRoute.value.name).toBe('job');
  const id = router.currentRoute.value.params.id;
  expect(workbench.getJob(id).status).toBe('draft');
  expect($('[data-node="shots"]').classList.contains('todo')).toBe(true);
  expect($('[data-node="shots"]').classList.contains('on')).toBe(true);   // 一進來先開缺的那一格

  // 截圖面板：上傳兩張 → 刪一張
  const { uploadNamed } = await import('./lib/uploads.js');
  const job = workbench.getJob(id);
  await uploadNamed(job, new File([PNG], 'a.png', { type: 'image/png' }), 'shot1.png');
  await uploadNamed(job, new File([PNG], 'b.png', { type: 'image/png' }), 'shot2.png');
  expect(workbench.getJob(id).files).toEqual(expect.arrayContaining(['shot1.png', 'shot2.png']));
  await (await fetch(`/api/jobs/${id}/upload?name=shot2.png`, { method: 'DELETE' })).json();
  expect(workbench.getJob(id).files).not.toContain('shot2.png');
  // 輪詢一次（setInterval 是假的）→ 畫面跟著更新
  await vi.advanceTimersByTimeAsync(3000);
  await settle();
  expect($('[data-node="shots"]').classList.contains('ok')).toBe(true);
  expect($('[data-panel] .slot.filled')).not.toBeNull();

  // 唸法面板：填一條、儲存 → script.txt 帶發音段，pipeline 節點變成已填
  $('[data-node="voice"]').click(); await settle();
  const inputs = document.querySelectorAll('[data-panel] .sayrow input');
  inputs[0].value = '外資'; inputs[0].dispatchEvent(new Event('input'));
  inputs[1].value = '外姿'; inputs[1].dispatchEvent(new Event('input'));
  button(/^儲存$/, $('[data-panel]')).click(); await settle();
  expect(workbench.getJob(id).voiceRules.own).toEqual(['外資→外姿']);
  const script = fs.readFileSync(path.join(root, 'storage', 'jobs', fs.readdirSync(path.join(root, 'storage', 'jobs')).find((d) => d.includes(id)), 'script.txt'), 'utf8');
  expect(script).toMatch(/外資→外姿/);
  await vi.advanceTimersByTimeAsync(3000); await settle();
  expect($('[data-node="voice"]').classList.contains('ok')).toBe(true);

  // 講者面板：切「用現成的」→ 送出變成待辦（還沒 heygen.mp4）；切回重新生成
  $('[data-node="anchor"]').click(); await settle();
  [...document.querySelectorAll('[data-panel] .modes div')].find((d) => /用現成的/.test(d.textContent)).click(); await settle();
  expect(workbench.getJob(id).skipGenerate).toBe(true);
  await vi.advanceTimersByTimeAsync(3000); await settle();
  expect($('[data-node="submit"]').classList.contains('todo')).toBe(true);
  expect($('[data-panel] .modes.off')).not.toBeNull();   // 語氣那組變灰但還在
  [...document.querySelectorAll('[data-panel] .modes div')].find((d) => /重新生成/.test(d.textContent)).click(); await settle();
  [...document.querySelectorAll('[data-panel] .modes div')].find((d) => /開心/.test(d.textContent)).click(); await settle();
  expect(workbench.getJob(id).emotion).toBe('happy');

  // 送出：確認視窗（confirm 回 true）→ queued
  await vi.advanceTimersByTimeAsync(3000); await settle();
  $('[data-node="submit"]').click(); await settle();
  const go = button(/開始出片：盤中焦點/, $('[data-panel]'));
  expect(go.disabled).toBe(false);
  go.click(); await settle();
  expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/【盤中焦點】[\s\S]*開心/));
  expect(workbench.getJob(id).status).toBe('queued');
  await vi.advanceTimersByTimeAsync(3000); await settle();
  expect($('[data-job-head]').textContent).toMatch(/排隊中/);
  expect($('[data-node="annotate"]').classList.contains('on')).toBe(true);
  expect($('[data-panel]').textContent).toMatch(/手動標記/);

  // 儀表板看得到這支
  await router.push('/'); await settle();
  expect($('[data-stats]').textContent).toMatch(/排隊中/);
  expect($('[data-attention]').textContent).not.toMatch(/草稿還沒送出/);

  expect(errors).toEqual([]);
});

test('工作頁每一種狀態都畫得出來，沒有 runtime 警告', { timeout: 180000 }, async (t) => {
  const chars = [...'今天台股上漲。'].map((c, i) => ({ c, i }));
  const base = { template: 'dapan', owner: '小華', title: '盤勢', createdAt: '2026-10-07T01:01:00.000Z', files: ['shot1.png', 'script.txt'], scriptBody: '今天台股上漲。' };
  const statuses = ['draft', 'queued', 'preparing', 'review', 'approved', 'rendering', 'done', 'failed', 'cancelled', 'detached', 'detached-done'];
  const { workbench, router } = await boot(t, { path: '/jobs' });
  for (const [n, status] of statuses.entries()) {
    const job = { ...base, id: `20261007-0901${String(n).padStart(2, '0')}-wxyz`, status,
      ...(status === 'review' ? { planView: { editable: true, rows: [{ i: 0, src: 'shot1.png', phrase: '今天台股上漲', start: 0, end: 1.2, dur: 1.2, cellText: '', wholePage: true, cell: null, region: null, arrow: null, startCharIdx: 0, endCharIdx: 5, thumb: null }], images: ['shot1.png'], totalSec: 1.4, emphasis: [], pages: {}, pendingAnnots: [], units: [{ i: 0, text: '今天台股上漲。', startCharIdx: 0, endCharIdx: 6 }], chars, unused: [] } } : {}),
      ...(status === 'done' ? { outputs: [{ name: 'portrait.mp4', size: 1000 }], motionClips: [{ name: 'motion1.mp4', size: 10 }], archived: ['x'], voiceRules: { own: [], shared: [], hit: [{ from: 'a', to: 'b', times: 2, src: 'own' }] } } : {}),
      ...(status === 'failed' ? { error: '壞了' } : {}),
      ...(status === 'approved' ? { approvedBy: '小華' } : {}) };
    workbench.addJob(job); workbench.saveJob(job);
    await router.push('/jobs/' + job.id); await settle();
    expect($('[data-pipeline]'), status).not.toBeNull();
    // 右側每個節點都點一遍
    for (const node of document.querySelectorAll('[data-pipeline] .node')) { node.click(); await settle(4); expect($('[data-panel] .card'), `${status}/${node.dataset.node}`).not.toBeNull(); }
    expect(errors, status).toEqual([]);
  }
  // 列表頁與過濾
  await router.push('/jobs'); await settle();
  expect(document.querySelectorAll('#jobs tr.jobrow').length).toBe(statuses.length);
  button(/^完成/).click(); await settle();
  expect(document.querySelectorAll('#jobs tr.jobrow').length).toBe(1);
  expect(errors).toEqual([]);
});
