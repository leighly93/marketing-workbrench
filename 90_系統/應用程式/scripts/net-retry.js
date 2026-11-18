'use strict';

/**
 * 斷線自動重試（2026-11-18 使用者：MiniMax 配音「斷線自動重試，最多三次」）。純邏輯，測試在 90_系統/測試/斷線重試.test.js。
 *
 * 只重試「網路層」失敗：連線被重設、DNS、逾時、回應讀到一半斷掉 —— Node 的 fetch 一律丟 TypeError
 * （「fetch failed」「terminated」）。對方有回應的錯誤（金鑰錯、額度不足、字數超過、回傳不是 JSON）不重試，
 * 照舊直接失敗，重送也不會好，還可能重複扣費。
 * ⚠️ 請求已經送到、只是回應在路上斷掉時，重試可能會被收兩次費（一段配音的錢），這是使用者知道後選的。
 *
 *   withNetworkRetry(attempt, { retries, delayMs, onRetry, sleep }) → attempt() 的結果
 *     attempt   async () => 結果；fetch 和讀 body 都要放在裡面，讀到一半斷掉也算斷線
 *     retries   最多重試幾次（不含第一次），預設 3
 *     delayMs   第 n 次重試前等 delayMs × n
 */
function isNetworkError(e) {
  return !!e && e.name === 'TypeError';
}

async function withNetworkRetry(attempt, {
  retries = 3,
  delayMs = 3000,
  onRetry = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  for (let n = 0; ; n++) {
    try {
      return await attempt();
    } catch (e) {
      if (!isNetworkError(e) || n >= retries) throw e;
      const cause = e.cause && (e.cause.code || e.cause.message);
      onRetry({ n: n + 1, retries, error: `${e.message}${cause ? `（${cause}）` : ''}` });
      await sleep(delayMs * (n + 1));
    }
  }
}

module.exports = { withNetworkRetry, isNetworkError };
