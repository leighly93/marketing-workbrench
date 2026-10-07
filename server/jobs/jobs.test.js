'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { unitWorkbench } = require('../tests/unit-workbench');

const job = (id, status, extra = {}) => ({ id, status, createdAt: `2026-10-07T00:00:0${id.slice(-1)}Z`, ...extra });

describe('佇列', () => {
  test('pickNext：已確認要出片的優先（依確認時間），其次才是新工作（依建立時間）', (t) => {
    const wb = unitWorkbench(t);
    for (const j of [job('q2', 'queued'), job('q1', 'queued'), job('a2', 'approved', { approvedAt: '2' }), job('a1', 'approved', { approvedAt: '1' }), job('r1', 'review')]) wb.addJob(j);
    expect(wb.pickNext().id).toBe('a1');
    expect(wb.queuePosition(wb.getJob('q1'))).toBe(2);
    expect(wb.queuePosition(wb.getJob('r1'))).toBe(0);
  });

  test('publicJob 拿掉內部欄位；IP 只給管理者', (t) => {
    const wb = unitWorkbench(t);
    const j = job('x1', 'done', { pid: 1, pendingEdits: [], pendingEmphasis: [], autoPlan: [], ip: '10.0.0.1', title: 't' });
    wb.addJob(j);
    expect(wb.publicJob(j, false)).toEqual({ id: 'x1', status: 'done', createdAt: j.createdAt, title: 't', queuePosition: 0 });
    expect(wb.publicJob(j, true).ip).toBe('10.0.0.1');
  });

  test('tick：沒工作不動；.run.lock 被外部佔著就排隊等（5 秒後再看），不標失敗', (t) => {
    const wb = unitWorkbench(t);
    wb.tick();
    expect(wb.timers.calls).toEqual([]);
    const j = job('w1', 'queued');
    wb.addJob(j);
    wb.store.directory(j.id, j);
    fs.writeFileSync(wb.LOCK, '1');
    wb.tick();
    wb.tick();
    expect(wb.timers.calls).toEqual([['timeout', 5000], ['timeout', 5000]]);
    expect(j.status).toBe('queued');
    expect(fs.readFileSync(wb.jobPath(j.id, 'log.txt'), 'utf8').match(/排隊等它結束/g)).toHaveLength(1);
    expect(wb.isBusy()).toBe(false);
  });
});

describe('工作清單', () => {
  test('啟動時把「上次跑到一半」的工作判成失敗（run.js 不在了），新的排在前面', (t) => {
    const root = unitWorkbench(t).root;
    // 用同一個 root 再開一次：模擬伺服器重開
    const { createJobStore } = require('../../shared/job-store');
    const store = createJobStore(root, fs);
    for (const j of [job('old1', 'preparing'), job('old2', 'done')]) {
      const dir = store.directory(j.id, j);
      fs.mkdirSync(path.join(dir, '_meta'), { recursive: true });
      fs.writeFileSync(path.join(dir, '_meta', 'job.json'), JSON.stringify(j));
    }
    const { createWorkbench } = require('../app');
    const wb = createWorkbench({ root, env: {}, process: { env: {}, kill: () => { throw new Error('沒有這個程序'); } },
      childProcess: {}, timers: { setTimeout() {}, setImmediate() {} } });
    expect(wb.allJobs().map((j) => [j.id, j.status])).toEqual([['old2', 'done'], ['old1', 'failed']]);
    wb.removeJob('old2');
    expect(wb.getJob('old2')).toBeUndefined();
  });

  test('newId 是「日期-時間-亂碼」', (t) => {
    expect(unitWorkbench(t).newId()).toMatch(/^\d{8}-\d{6}-[a-z0-9]{4}$/);
  });
});

describe('工作區', () => {
  test('clearWorkspaceInputs 清上一支的輸入、保留套版素材，並清空重點詞與動態產出', (t) => {
    const wb = unitWorkbench(t);
    const pub = path.join(wb.config.ROOT, 'public');
    fs.mkdirSync(pub, { recursive: true });
    fs.mkdirSync(path.join(wb.config.ROOT, 'src', 'MotionClip'), { recursive: true });
    for (const f of ['heygen.mp4', 'shot1.png', 'script.txt', 'annotations.json', 'midday-bgm.wav', 'NotoSansTC-VF.ttf', 'deeplinks.json']) fs.writeFileSync(path.join(pub, f), 'x');
    wb.writeEmphasis([{ startCharIdx: 0, endCharIdx: 1 }]);
    wb.clearWorkspaceInputs();
    expect(fs.readdirSync(pub).sort()).toEqual(['NotoSansTC-VF.ttf', 'deeplinks.json', 'midday-bgm.wav']);
    expect(wb.emphasisOf(wb.config.ROOT)).toEqual([]);
    expect(fs.readFileSync(path.join(wb.config.ROOT, wb.MOTION_FILE), 'utf8')).toBe('[]\n');
  });
});

describe('系統狀態', () => {
  test('codeChangedAt 看得到 server/ 底下任一模組的修改', (t) => {
    const wb = unitWorkbench(t);
    expect(wb.codeChangedAt()).toBe(0);
    const file = path.join(wb.config.SERVER_DIR, 'jobs', 'x.js');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    expect(wb.codeChangedAt()).toBeGreaterThan(0);
  });
});
