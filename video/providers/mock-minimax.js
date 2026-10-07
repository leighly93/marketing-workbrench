// @ts-check
'use strict';

/**
 * 模擬 MiniMax（WORKBENCH_MOCK=1）：介面與 createMiniMaxClient 相同，回傳依字數估長的占位音檔。
 * 不連網、不扣額度。
 */
const { estimateSpeechSeconds } = require('../media/placeholder');

/**
 * @param {{
 *   media: { toneBuffer: (seconds: number) => Buffer },
 *   log?: (m: string) => void,
 * }} deps
 */
function createMockMiniMaxClient({ media, log = console.log }) {
  /** @param {string} text @param {string} voiceId @returns {Promise<Buffer>} */
  async function synthesize(text, voiceId) {
    const seconds = estimateSpeechSeconds(text);
    log(`🧪 模擬 MiniMax：voice ${voiceId}，${text.length} 字 → ${seconds} 秒占位音檔`);
    return media.toneBuffer(seconds);
  }
  return { synthesize };
}

module.exports = { createMockMiniMaxClient };
