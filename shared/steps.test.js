'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStepsWriter } = require('./steps');

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-steps-'));
  t.onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, '_meta', 'steps.json'); // 上層目錄故意不先建：寫入器要自己 mkdir -p
}

describe('createStepsWriter', () => {
  test('沒給檔名就是空作業：什麼都不寫、read 回空結構', () => {
    for (const file of [undefined, '', null]) {
      const w = createStepsWriter(file);
      w.start('a'); w.end('a', { ok: true }); w.skip('b', { note: 'x' }); w.cancelRunning(); w.failRunning('e');
      expect(w.read()).toEqual({ version: 1, steps: [] });
      expect(w.file).toBe(null);
    }
  });

  test('start／end 記下時間與結果，同名步驟重跑時 attempt 遞增', (t) => {
    const file = tmpFile(t);
    const w = createStepsWriter(file);
    w.start('transcribe', { label: '字幕轉錄' });
    let [entry] = w.read().steps;
    expect(entry).toMatchObject({ id: 'transcribe', label: '字幕轉錄', status: 'running', attempt: 1 });
    expect(Date.parse(entry.startedAt)).not.toBeNaN();

    w.end('transcribe', { ok: false, error: '時間軸壞掉' });
    [entry] = w.read().steps;
    expect(entry).toMatchObject({ status: 'failed', error: '時間軸壞掉' });
    expect(typeof entry.ms).toBe('number');
    expect(Date.parse(entry.endedAt)).toBeGreaterThanOrEqual(Date.parse(entry.startedAt));

    w.start('transcribe');
    w.end('transcribe', { ok: true, note: '墊 0.8 秒' });
    const steps = w.read().steps;
    expect(steps).toHaveLength(2);
    expect(steps[1]).toMatchObject({ id: 'transcribe', status: 'ok', attempt: 2, note: '墊 0.8 秒' });
    expect(steps[0].status).toBe('failed'); // 第一筆不受影響

    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(data.version).toBe(1);
    expect(Date.parse(data.updatedAt)).not.toBeNaN();
  });

  test('成功但備註以 ⚠️ 開頭 → warning；沒有在跑的同名步驟時 end 也會補一筆', (t) => {
    const w = createStepsWriter(tmpFile(t));
    w.start('shots');
    w.end('shots', { ok: true, note: '⚠️ 自動配圖失敗（不影響出片）' });
    expect(w.read().steps[0].status).toBe('warning');

    w.end('backup', { ok: true });
    const backup = w.read().steps[1];
    expect(backup).toMatchObject({ id: 'backup', status: 'ok', attempt: 1 });
    expect(backup.endedAt).toBe(backup.startedAt);
  });

  test('skip 是一筆已結束的紀錄', (t) => {
    const w = createStepsWriter(tmpFile(t));
    w.skip('generate', { label: '生成講者影片', note: '用現成的講者影片' });
    const [entry] = w.read().steps;
    expect(entry).toMatchObject({ id: 'generate', label: '生成講者影片', status: 'skipped', note: '用現成的講者影片', ms: 0, attempt: 1 });
    expect(entry.endedAt).toBe(entry.startedAt);
  });

  test('cancelRunning／failRunning 只動還在跑的那些', (t) => {
    const w = createStepsWriter(tmpFile(t));
    w.start('a'); w.end('a', { ok: true });
    w.start('b'); w.start('c');
    w.cancelRunning('人工取消');
    let steps = w.read().steps;
    expect(steps.map((s) => s.status)).toEqual(['ok', 'cancelled', 'cancelled']);
    expect(steps[1].note).toBe('人工取消');

    w.start('d');
    w.failRunning('run.js 結束碼 1');
    steps = w.read().steps;
    expect(steps.map((s) => s.status)).toEqual(['ok', 'cancelled', 'cancelled', 'failed']);
    expect(steps[3].error).toBe('run.js 結束碼 1');
  });

  test('已被取消的步驟，之後回報失敗不再補一筆（取消是最後定論）', (t) => {
    const w = createStepsWriter(tmpFile(t));
    w.start('transcribe');
    w.cancelRunning('人工取消');
    w.end('transcribe', { ok: false, error: 'Command failed' });
    expect(w.read().steps).toHaveLength(1);
    expect(w.read().steps[0].status).toBe('cancelled');
  });

  test('檔案壞掉當成空的，寫入後是原子的（不留 .tmp）', (t) => {
    const file = tmpFile(t);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    const w = createStepsWriter(file);
    expect(w.read()).toEqual({ version: 1, steps: [] });
    w.start('assets');
    expect(w.read().steps).toHaveLength(1);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    fs.writeFileSync(file, JSON.stringify({ version: 1, steps: 'nope' }));
    expect(w.read().steps).toEqual([]);
  });

  test('fs 出錯不丟出（記帳不能讓產線死掉）', () => {
    const broken = new Proxy({}, { get: () => () => { throw new Error('EACCES'); } });
    const w = createStepsWriter('/nowhere/steps.json', broken);
    expect(() => { w.start('a'); w.end('a', { ok: true }); w.skip('b'); w.cancelRunning(); w.failRunning('x'); }).not.toThrow();
    expect(w.read()).toEqual({ version: 1, steps: [] });
  });
});
