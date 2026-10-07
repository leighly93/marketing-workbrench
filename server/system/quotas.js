// @ts-nocheck
'use strict';

/**
 * 額度（/api/quotas）：各供應者還剩多少，加上本機狀態（磁碟、鎖、佇列）。
 *
 * 供應者是一張「adapter 登錄表」：{ heygen: async (ctx) => provider, minimax: … }。
 * 要接真的查詢（HeyGen 有 /v2/user/remaining_quota；MiniMax 沒有公開餘額 API）時換掉對應那一支就好，
 * 路由與回應形狀都不用動。目前兩支都是假資料，但**由真實工作數決定**：
 * 每出完一支真的（非模擬、有呼叫生成）就扣一點，數字會跟著動，前台才看得出接法對不對。
 * 一支 adapter 壞掉只影響它自己那一列（error 欄），不能讓整頁空白。
 *
 * 由 server/app.js 組裝；依賴一律從 ctx 取得。
 */

/** 假額度的參數（之後接真 API 就用不到）。 */
const MOCK = {
  heygen: { total: 1000, perJob: 37.5 },
  minimax: { balance: 50, perJob: 0.8 },
};

/** 真的花過錢的工作：出完、不是模擬模式、而且有呼叫 HeyGen／MiniMax（不是沿用現成講者影片）。 */
function paidJobs(jobs) {
  return jobs.filter((j) => j.status === 'done' && !j.mock && !j.skipGenerate);
}

/** 下個月 1 號（本機時區）—— HeyGen 點數按月重置。 */
function nextMonthStart(now) {
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
}

const round = (n, digits) => Math.round(n * 10 ** digits) / 10 ** digits;

/** 每支 adapter：(ctx, now) → 一列額度資料。 */
const ADAPTERS = {
  async heygen(ctx, now) {
    const used = paidJobs(ctx.allJobs()).length * MOCK.heygen.perJob;
    return {
      id: 'heygen', label: 'HeyGen', kind: 'credits', unit: 'credits',
      remaining: Math.max(0, round(MOCK.heygen.total - used, 1)), total: MOCK.heygen.total,
      resetAt: nextMonthStart(now), updatedAt: now.toISOString(), source: 'mock',
      note: '尚未接上 HeyGen 額度查詢（/v2/user/remaining_quota），目前是假資料',
    };
  },
  async minimax(ctx, now) {
    const used = paidJobs(ctx.allJobs()).length * MOCK.minimax.perJob;
    return {
      id: 'minimax', label: 'MiniMax', kind: 'balance', unit: 'USD',
      remaining: Math.max(0, round(MOCK.minimax.balance - used, 2)), total: null,
      resetAt: null, updatedAt: now.toISOString(), source: 'mock',
      note: 'MiniMax 沒有公開餘額 API，目前是假資料',
    };
  },
};

function create(ctx) {
  const { localStatus } = ctx;

  async function buildQuotas(now = new Date()) {
    const providers = await Promise.all(Object.entries(ADAPTERS).map(async ([id, adapter]) => {
      try { return await adapter(ctx, now); }
      catch (e) {
        return { id, label: id, kind: null, unit: null, remaining: null, total: null, resetAt: null,
          updatedAt: now.toISOString(), source: 'error', note: `額度查詢失敗：${e.message}` };
      }
    }));
    return {
      generatedAt: now.toISOString(),
      mock: providers.every((p) => p.source === 'mock'),
      providers,
      local: localStatus(),
    };
  }

  return { buildQuotas, QUOTA_ADAPTERS: ADAPTERS };
}

module.exports = create;
module.exports.ADAPTERS = ADAPTERS;
module.exports.MOCK = MOCK;
module.exports.paidJobs = paidJobs;
