'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkbench, MODULES, ROUTES } = require('./app');
const { createConfig } = require('./config');

describe('createConfig', () => {
  test('所有路徑都從 root 算出來；port 與暗號讀環境變數', () => {
    const root = path.join(os.tmpdir(), 'x');
    const c = createConfig({ root, env: { PORT: '0', ADMIN_KEY: 'k' } });
    expect(c.ROOT).toBe(path.join(root, 'video', 'remotion'));
    expect(c.WEB_DIR).toBe(path.join(root, 'app'));
    expect(c.CORRECTIONS_LOG).toBe(path.join(root, 'storage', 'data', 'corrections.jsonl'));
    expect([c.PORT, c.HOST, c.ADMIN_KEY]).toEqual([0, '127.0.0.1', 'k']);
    expect(createConfig({ root, env: {} }).PORT).toBe(4000);
  });
});

describe('createWorkbench', () => {
  test('每個模組與路由都存在；同一個 root 開兩次是兩份獨立狀態', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-app-'));
    t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const m of [...MODULES, ...ROUTES]) expect(fs.existsSync(path.join(__dirname, `${m}.js`))).toBe(true);
    const opts = { root, env: {}, childProcess: {}, process: { env: {}, kill() {} }, timers: { setTimeout() {}, setImmediate() {} } };
    const a = createWorkbench(opts);
    const b = createWorkbench(opts);
    a.addJob({ id: 'only-a', status: 'draft' });
    expect(b.getJob('only-a')).toBeUndefined();
    expect(typeof a.route).toBe('function');
  });
});
