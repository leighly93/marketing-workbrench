// @ts-nocheck
'use strict';

/**
 * 儀表板（/api/dashboard）：從真實的工作清單算出目前狀況、區間內的產量與成功率、每日趨勢、
 * 各版型／各人的統計，以及「要人處理」的清單。全部是讀取、不改任何工作。
 *
 * 純算法在 computeDashboard()（測試直接餵合成工作），create(ctx) 只是把 allJobs 與版型接上。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得。
 */

const RANGES = { today: 1, '7d': 7, '30d': 30, all: null };
/** 'all' 沒有邊界，趨勢只畫最近 30 天。 */
const TREND_DAYS_FOR_ALL = 30;
const ATTENTION_LIMIT = 30;
const OWNER_LIMIT = 12;

const FINISHED = new Set(['done', 'failed', 'cancelled']);
/** 正在跑：準備中、渲染中，或伺服器重開後還在背景跑的 */
const RUNNING = new Set(['preparing', 'rendering', 'detached']);

const pad = (n) => String(n).padStart(2, '0');
/** 本機時區的日期鍵（伺服器時區；工作是在這台機器上建的）。 */
function localDay(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
/** 本機午夜，往前推 daysBack 天。 */
function startOfLocalDay(now, daysBack = 0) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack);
}
function parseTime(value) {
  const t = Date.parse(value || '');
  return Number.isNaN(t) ? null : t;
}
/** 兩個時間戳之間的秒數；缺任一個或倒過來就是 null（不要讓壞資料拉歪平均）。 */
function secondsBetween(from, to) {
  const a = parseTime(from);
  const b = parseTime(to);
  if (a === null || b === null || b < a) return null;
  return (b - a) / 1000;
}
function average(values) {
  const list = values.filter((v) => typeof v === 'number');
  if (!list.length) return null;
  return Math.round((list.reduce((s, v) => s + v, 0) / list.length) * 10) / 10;
}
function rate(done, failed) {
  const basis = done + failed;
  return basis ? Math.round((done / basis) * 1000) / 1000 : null;
}
const oneLine = (title) => String(title || '').replace(/\r?\n/g, ' ').trim();

/** 工作需要人處理的理由；不需要就是 null。 */
function attentionReason(job) {
  if (job.status === 'review') return { reason: 'review', since: job.preparedAt || job.startedAt || job.createdAt };
  if (job.status === 'failed') return { reason: 'failed', since: job.failedAt || job.startedAt || job.createdAt };
  if (job.status === 'draft') return { reason: 'draft', since: job.createdAt };
  if (job.status === 'detached-done') return { reason: 'detached-done', since: job.startedAt || job.createdAt };
  if (job.status === 'done' && !(job.outputs || []).length && !job.pruned) {
    return { reason: 'missing-output', since: job.finishedAt || job.createdAt };
  }
  return null;
}

/**
 * @param {{ jobs: object[], templates?: Record<string, { label?: string }>, range?: string, now?: Date }} input
 */
function computeDashboard({ jobs, templates = {}, range = '7d', now = new Date() }) {
  if (!(range in RANGES)) range = '7d';
  const days = RANGES[range];
  const since = days ? startOfLocalDay(now, days - 1).getTime() : null;
  const inRange = jobs.filter((j) => {
    if (since === null) return true;
    const t = parseTime(j.createdAt);
    return t !== null && t >= since;
  });

  const count = (list, pred) => list.filter(pred).length;
  const snapshot = {
    running: count(jobs, (j) => RUNNING.has(j.status)),
    queued: count(jobs, (j) => j.status === 'queued' || j.status === 'approved'),
    review: count(jobs, (j) => j.status === 'review'),
    draft: count(jobs, (j) => j.status === 'draft'),
    total: jobs.length,
  };

  const done = count(inRange, (j) => j.status === 'done');
  const failed = count(inRange, (j) => j.status === 'failed');
  const cancelled = count(inRange, (j) => j.status === 'cancelled');
  const success = rate(done, failed);
  const rates = { success, failure: success === null ? null : Math.round((1 - success) * 1000) / 1000, basis: done + failed };

  // 每日趨勢：區間裡每一天都要有一筆（沒工作的日子是 0，不然折線會把空日跳過）。
  const trendDays = days || TREND_DAYS_FOR_ALL;
  const byDay = new Map();
  for (let i = trendDays - 1; i >= 0; i--) {
    const day = localDay(startOfLocalDay(now, i));
    byDay.set(day, { day, created: 0, done: 0, failed: 0, cancelled: 0, totals: [] });
  }
  for (const j of inRange) {
    const t = parseTime(j.createdAt);
    if (t === null) continue;
    const row = byDay.get(localDay(new Date(t)));
    if (!row) continue;
    row.created += 1;
    if (j.status === 'done') { row.done += 1; row.totals.push(secondsBetween(j.createdAt, j.finishedAt)); }
    else if (j.status === 'failed') row.failed += 1;
    else if (j.status === 'cancelled') row.cancelled += 1;
  }
  const trend = [...byDay.values()].map(({ totals, ...row }) => ({ ...row, avgTotalSec: average(totals) }));

  const doneJobs = inRange.filter((j) => j.status === 'done');
  const durations = {
    avgPrepareSec: average(doneJobs.map((j) => secondsBetween(j.startedAt, j.preparedAt))),
    avgRenderSec: average(doneJobs.map((j) => secondsBetween(j.approvedAt, j.finishedAt))),
    avgTotalSec: average(doneJobs.map((j) => secondsBetween(j.createdAt, j.finishedAt))),
    basis: doneJobs.length,
  };

  const groupBy = (key) => {
    const groups = new Map();
    for (const j of inRange) {
      const k = String(j[key] || '');
      if (!groups.has(k)) groups.set(k, { total: 0, done: 0, failed: 0 });
      const g = groups.get(k);
      g.total += 1;
      if (j.status === 'done') g.done += 1;
      if (j.status === 'failed') g.failed += 1;
    }
    return [...groups.entries()]
      .map(([k, g]) => ({ key: k, ...g, successRate: rate(g.done, g.failed) }))
      .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
  };
  const byTemplate = groupBy('template').map(({ key, ...g }) => ({
    template: key, label: (templates[key] && templates[key].label) || key, ...g,
  }));
  const byOwner = groupBy('owner').slice(0, OWNER_LIMIT).map(({ key, ...g }) => ({ owner: key, ...g }));

  // 要人處理的清單看全部工作，不受區間限制 —— 上個月卡在待確認的也還是卡著。
  const attention = jobs
    .map((j) => {
      const hit = attentionReason(j);
      return hit && {
        id: j.id, title: oneLine(j.title), template: j.template, owner: j.owner, status: j.status,
        reason: hit.reason, since: hit.since || null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (parseTime(b.since) || 0) - (parseTime(a.since) || 0))
    .slice(0, ATTENTION_LIMIT);

  return {
    range,
    generatedAt: now.toISOString(),
    snapshot,
    inRange: { created: inRange.length, done, failed, cancelled, pending: count(inRange, (j) => !FINISHED.has(j.status)) },
    rates,
    trend,
    durations,
    byTemplate,
    byOwner,
    attention,
  };
}

function create(ctx) {
  const { allJobs, TEMPLATES } = ctx;
  function buildDashboard(range) {
    return computeDashboard({ jobs: allJobs(), templates: TEMPLATES, range });
  }
  return { buildDashboard };
}

module.exports = create;
module.exports.computeDashboard = computeDashboard;
module.exports.RANGES = RANGES;
