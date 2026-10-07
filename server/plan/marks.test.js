'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { unitWorkbench } = require('../tests/unit-workbench');

describe('字幕重點詞', () => {
  test('normalizeEmphasis：排序、頭尾對調、丟掉負數與非整數、合併重疊與相鄰', (t) => {
    const { normalizeEmphasis } = unitWorkbench(t);
    expect(normalizeEmphasis([
      { startCharIdx: 10, endCharIdx: 8 }, { startCharIdx: 0, endCharIdx: 2 }, { startCharIdx: 3, endCharIdx: 4 },
      { startCharIdx: -1, endCharIdx: 5 }, { startCharIdx: 1.5, endCharIdx: 3 }, null,
    ])).toEqual([{ startCharIdx: 0, endCharIdx: 4 }, { startCharIdx: 8, endCharIdx: 10 }]);
    expect(normalizeEmphasis('不是陣列')).toEqual([]);
  });

  test('存在工作 input/、寫進工作區是兩件事', (t) => {
    const wb = unitWorkbench(t);
    const job = { id: 'job-1' };
    wb.store.directory(job.id, job);
    expect(wb.saveJobEmphasis(job, [{ startCharIdx: 5, endCharIdx: 3 }])).toEqual([{ startCharIdx: 3, endCharIdx: 5 }]);
    expect(wb.readJobEmphasis(job)).toEqual([{ startCharIdx: 3, endCharIdx: 5 }]);
    expect(fs.existsSync(path.join(wb.config.ROOT, wb.EMPHASIS_FILE))).toBe(false);
    wb.writeEmphasis([{ startCharIdx: 1, endCharIdx: 1 }]);
    expect(wb.emphasisOf(wb.config.ROOT)).toEqual([{ startCharIdx: 1, endCharIdx: 1 }]);
  });
});

describe('動態小影片設定', () => {
  test('normalizeMotion 只收一段、截短關鍵詞、保留 spec', (t) => {
    const { normalizeMotion } = unitWorkbench(t);
    expect(normalizeMotion([
      { startCharIdx: 3, endCharIdx: 1 },
      { startCharIdx: 2, endCharIdx: 9, keyword: '字'.repeat(50), spec: { template: 'quote' }, extra: 1 },
      { startCharIdx: 10, endCharIdx: 12 },
    ])).toEqual([{ startCharIdx: 2, endCharIdx: 9, keyword: '字'.repeat(40), spec: { template: 'quote' } }]);
    expect(normalizeMotion({})).toEqual([]);
  });

  test('存空的就刪掉設定檔', (t) => {
    const wb = unitWorkbench(t);
    const job = { id: 'job-2' };
    wb.store.directory(job.id, job);
    wb.saveJobMotion(job, [{ startCharIdx: 0, endCharIdx: 3 }]);
    expect(wb.readJobMotion(job)).toHaveLength(1);
    expect(wb.saveJobMotion(job, [])).toEqual([]);
    expect(fs.existsSync(wb.jobMotionFile(job))).toBe(false);
  });
});
