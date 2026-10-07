// @ts-check
'use strict';

/**
 * 模擬模式（.env 的 WORKBENCH_MOCK=1）：整個工作台改用本機假供應者 ——
 * HeyGen／MiniMax 用 ffmpeg 產生占位影音、字幕轉錄照稿件平均配時、OCR 不讀字、動態用固定卡片。
 * 不呼叫任何付費 API，也不需要 whisper.cpp／tesseract；ffmpeg 與 Remotion 仍是真的。
 *
 * 用途是開發與驗收流程（在沒有金鑰、沒有原生工具的機器上把整條路走完），不是出片。
 * 開著時工作台頁首會顯示「模擬模式」，工作也會標記 mock，避免正式機誤開。
 */

const FLAG = 'WORKBENCH_MOCK';

/** @param {NodeJS.ProcessEnv} [env] */
function isMockMode(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env[FLAG] || '').trim());
}

/**
 * 引擎名稱：模擬模式一律是 'mock'，否則讀各自的環境變數。
 * @param {string} envKey 例如 TRANSCRIPTION_ENGINE
 * @param {string} fallback 環境變數沒設時的預設引擎
 * @param {NodeJS.ProcessEnv} [env]
 */
function engineName(envKey, fallback, env = process.env) {
  return isMockMode(env) ? 'mock' : (env[envKey] || fallback);
}

module.exports = { FLAG, isMockMode, engineName };
