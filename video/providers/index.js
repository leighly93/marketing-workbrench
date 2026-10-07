// @ts-check
'use strict';

/**
 * 供應者工廠：run.js 只跟這裡要 HeyGen／MiniMax client，不知道背後是正式 API 還是模擬。
 * 模擬模式（WORKBENCH_MOCK=1）不需要金鑰，占位影音由 media/placeholder.js 產生。
 */
const { isMockMode } = require('../../shared/mock-mode');
const { createHeyGenClient } = require('./heygen');
const { createMiniMaxClient } = require('./minimax');
const { createMockHeyGenClient } = require('./mock-heygen');
const { createMockMiniMaxClient } = require('./mock-minimax');
const { createPlaceholderMedia } = require('../media/placeholder');

/**
 * 呼叫付費 API 前要有的金鑰；缺什麼就回傳要給人看的說明，齊全或模擬模式回 null。
 * @param {{ env?: NodeJS.ProcessEnv, useMinimax: boolean }} input
 * @returns {string | null}
 */
function missingCredentials({ env = process.env, useMinimax }) {
  if (isMockMode(env)) return null;
  if (!env.HEYGEN_API_KEY) return '缺少 HEYGEN_API_KEY（請填到 .env）';
  if (useMinimax && (!env.MINIMAX_API_KEY || !env.MINIMAX_GROUP_ID)) {
    return '缺少 MINIMAX_API_KEY 或 MINIMAX_GROUP_ID（請填到 .env）\n'
      + '   固定主播預設用 MiniMax 配音；不想加 key 的話，指令加 --heygen-voice 改用 HeyGen 內建語音。';
  }
  return null;
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   useMinimax: boolean,
 *   aspectRatio: string,
 *   engine: string,
 *   emotion: string,
 *   log: (m: string) => void,
 *   media?: ReturnType<typeof createPlaceholderMedia>,
 * }} input
 */
function createProviders({ env = process.env, useMinimax, aspectRatio, engine, emotion, log, media }) {
  if (isMockMode(env)) {
    const placeholder = media || createPlaceholderMedia();
    return {
      mock: true,
      heygen: createMockHeyGenClient({ media: placeholder, aspectRatio, log }),
      minimax: useMinimax ? createMockMiniMaxClient({ media: placeholder, log }) : undefined,
    };
  }
  const missing = missingCredentials({ env, useMinimax });
  if (missing) throw new Error(missing);
  return {
    mock: false,
    heygen: createHeyGenClient({ apiKey: /** @type {string} */ (env.HEYGEN_API_KEY), aspectRatio, engine, log }),
    minimax: useMinimax
      ? createMiniMaxClient({ apiKey: /** @type {string} */ (env.MINIMAX_API_KEY), groupId: /** @type {string} */ (env.MINIMAX_GROUP_ID), emotion, log })
      : undefined,
  };
}

module.exports = { createProviders, missingCredentials };
