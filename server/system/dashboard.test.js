'use strict';

const { computeDashboard, RANGES } = require('./dashboard');

// 固定「現在」：2026-10-08 本機中午。工作的時間全部相對它建，跟測試跑在哪個時區無關。
const NOW = new Date(2026, 9, 8, 12, 0, 0);
const at = (daysAgo, hour = 9, minute = 0) => new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - daysAgo, hour, minute).toISOString();
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (daysAgo) => {
  const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - daysAgo);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const TEMPLATES = { dapan: { label: '大盤小報' }, midday: { label: '午盤' } };

/** 合成工作：各種狀態各一支，散在今天／7 天／30 天／更早。 */
const JOBS = [
  // 今天出完的：準備 2 分、渲染 5 分、全程 10 分
  { id: 'a', template: 'dapan', owner: 'Ryan', title: '今天\n第二行', status: 'done', createdAt: at(0, 9, 0), startedAt: at(0, 9, 1),
    preparedAt: at(0, 9, 3), approvedAt: at(0, 9, 5), finishedAt: at(0, 9, 10), outputs: [{ name: 'portrait.mp4' }], ip: '10.0.0.1', pid: 1 },
  { id: 'b', template: 'midday', owner: 'Ryan', title: '三天前失敗', status: 'failed', createdAt: at(3), failedAt: at(3, 9, 30) },
  { id: 'c', template: 'dapan', owner: 'Amy', title: '十天前沒成品', status: 'done', createdAt: at(10), finishedAt: at(10, 10), outputs: [] },
  { id: 'd', template: 'dapan', owner: 'Amy', title: '二十天前待確認', status: 'review', createdAt: at(20), startedAt: at(20, 9, 1), preparedAt: at(20, 9, 5) },
  { id: 'e', template: 'midday', owner: 'Ben', title: '今天的草稿', status: 'draft', createdAt: at(0, 11) },
  { id: 'f', template: 'dapan', owner: 'Ryan', title: '昨天取消', status: 'cancelled', createdAt: at(1), cancelledAt: at(1, 9, 2) },
  { id: 'g', template: 'dapan', owner: 'Ben', title: '正在準備', status: 'preparing', createdAt: at(0, 11, 30), startedAt: at(0, 11, 31) },
  { id: 'h', template: 'legacy', owner: 'Amy', title: '四十天前背景跑完', status: 'detached-done', createdAt: at(40), startedAt: at(40, 9, 1) },
];

const build = (range) => computeDashboard({ jobs: JOBS, templates: TEMPLATES, range, now: NOW });

describe('computeDashboard', () => {
  test('區間用本機日期切：today／7d／30d／all 各看到幾支', () => {
    expect(build('today').inRange).toEqual({ created: 3, done: 1, failed: 0, cancelled: 0, pending: 2 });
    expect(build('7d').inRange).toEqual({ created: 5, done: 1, failed: 1, cancelled: 1, pending: 2 });
    expect(build('30d').inRange.created).toBe(7);
    expect(build('all').inRange.created).toBe(8);
    expect(build('nonsense').range).toBe('7d');
    expect(Object.keys(RANGES)).toEqual(['today', '7d', '30d', 'all']);
  });

  test('目前狀況不受區間限制', () => {
    for (const range of ['today', 'all']) {
      expect(build(range).snapshot).toEqual({ running: 1, queued: 0, review: 1, draft: 1, total: 8 });
    }
  });

  test('成功率只算 done／failed；沒有基礎就是 null', () => {
    expect(build('7d').rates).toEqual({ success: 0.5, failure: 0.5, basis: 2 });
    expect(build('today').rates).toEqual({ success: 1, failure: 0, basis: 1 });
    expect(computeDashboard({ jobs: [], range: '7d', now: NOW }).rates).toEqual({ success: null, failure: null, basis: 0 });
  });

  test('趨勢每天一筆（沒工作的日子是 0），all 只畫最近 30 天', () => {
    const trend = build('7d').trend;
    expect(trend).toHaveLength(7);
    expect(trend.map((r) => r.day)).toEqual([6, 5, 4, 3, 2, 1, 0].map(dayKey));
    expect(trend.at(-1)).toEqual({ day: dayKey(0), created: 3, done: 1, failed: 0, cancelled: 0, avgTotalSec: 600 });
    expect(trend.find((r) => r.day === dayKey(3))).toMatchObject({ created: 1, failed: 1, avgTotalSec: null });
    expect(trend.find((r) => r.day === dayKey(1))).toMatchObject({ cancelled: 1 });
    expect(trend.find((r) => r.day === dayKey(5))).toEqual({ day: dayKey(5), created: 0, done: 0, failed: 0, cancelled: 0, avgTotalSec: null });
    expect(build('today').trend).toHaveLength(1);
    expect(build('all').trend).toHaveLength(30);
  });

  test('耗時：準備＝preparedAt−startedAt、渲染＝finishedAt−approvedAt、全程＝finishedAt−createdAt', () => {
    expect(build('7d').durations).toEqual({ avgPrepareSec: 120, avgRenderSec: 300, avgTotalSec: 600, basis: 1 });
    // 30 天內多一支缺時間戳的 done：缺的欄位不拉歪平均，但算進 basis
    expect(build('30d').durations).toEqual({ avgPrepareSec: 120, avgRenderSec: 300, avgTotalSec: 2100, basis: 2 });
  });

  test('各版型（標籤來自版型設定、沒有就用 id）與各人，都按總數排序', () => {
    const all = build('all');
    expect(all.byTemplate.map((t) => [t.template, t.label, t.total])).toEqual([
      ['dapan', '大盤小報', 5], ['midday', '午盤', 2], ['legacy', 'legacy', 1],
    ]);
    expect(all.byTemplate[0]).toMatchObject({ done: 2, failed: 0, successRate: 1 });
    expect(all.byTemplate[1]).toMatchObject({ done: 0, failed: 1, successRate: 0 });
    expect(all.byTemplate[2].successRate).toBe(null);
    expect(all.byOwner.map((o) => [o.owner, o.total])).toEqual([['Amy', 3], ['Ryan', 3], ['Ben', 2]]);
  });

  test('要人處理的清單看全部工作、新的在前、標題去掉換行、不帶 ip／pid', () => {
    const { attention } = build('today');
    expect(attention.map((a) => [a.id, a.reason])).toEqual([
      ['e', 'draft'], ['b', 'failed'], ['c', 'missing-output'], ['d', 'review'], ['h', 'detached-done'],
    ]);
    expect(attention[1].since).toBe(JOBS[1].failedAt);
    expect(attention[3].since).toBe(JOBS[3].preparedAt);
    for (const row of attention) {
      expect(Object.keys(row).sort()).toEqual(['id', 'owner', 'reason', 'since', 'status', 'template', 'title']);
      expect(row.title).not.toContain('\n');
    }
    // 出完而且有成品的、正在跑的、取消的都不用人處理
    expect(attention.some((a) => ['a', 'f', 'g'].includes(a.id))).toBe(false);
    // 標成已清理的缺成品工作不算
    const pruned = computeDashboard({ jobs: [{ ...JOBS[2], pruned: true }], now: NOW });
    expect(pruned.attention).toEqual([]);
  });
});
