// @ts-check
'use strict';

/**
 * 模擬 HeyGen（WORKBENCH_MOCK=1）：介面與 createHeyGenClient 相同，下載時用 ffmpeg 產生占位講者影片。
 *   音訊驅動 → 影片聲音就是上傳的那份音檔（長度一致，跟正式流程一樣）
 *   文字驅動 → 依稿件字數估長的正弦波
 * 不連網、不扣點數；狀態只存在這個 client 物件裡。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { estimateSpeechSeconds } = require('../media/placeholder');

const URL_PREFIX = 'mock://heygen/';

/**
 * @param {{
 *   media: { video: (file: string, options: { seconds?: number, audio?: string, aspectRatio?: string }) => void },
 *   aspectRatio?: string,
 *   workDir?: string,
 *   log?: (m: string) => void,
 * }} deps
 */
function createMockHeyGenClient({ media, aspectRatio = '9:16', workDir = os.tmpdir(), log = console.log }) {
  /** @type {Map<string, string>} assetId → 暫存音檔 */
  const assets = new Map();
  /** @type {Map<string, { audio?: string, seconds?: number }>} videoId → 生成方式 */
  const videos = new Map();
  let seq = 0;
  const nextId = (/** @type {string} */ kind) => `mock-${kind}-${process.pid}-${++seq}`;

  /** @param {Buffer} audio */
  async function uploadAudio(audio) {
    const id = nextId('asset');
    const file = path.join(workDir, `${id}.mp3`);
    fs.writeFileSync(file, audio);
    assets.set(id, file);
    log(`🧪 模擬 HeyGen：收下音檔 ${audio.length} bytes → ${id}`);
    return id;
  }

  /** @param {string} assetId */
  async function waitForAsset(assetId) {
    if (!assets.has(assetId)) throw new Error(`模擬 HeyGen：沒有這個音檔 ${assetId}`);
  }

  /** @param {string} assetId @param {string} avatarId @param {string} title */
  async function createAudioDrivenVideo(assetId, avatarId, title) {
    await waitForAsset(assetId);
    const id = nextId('video');
    videos.set(id, { audio: assets.get(assetId) });
    log(`🧪 模擬 HeyGen：音訊驅動 avatar ${avatarId}（${title}）→ ${id}`);
    return id;
  }

  /** @param {string} script @param {string} avatarId @param {string} voiceId @param {string} title */
  async function createTextDrivenVideo(script, avatarId, voiceId, title) {
    const id = nextId('video');
    videos.set(id, { seconds: estimateSpeechSeconds(script) });
    log(`🧪 模擬 HeyGen：文字驅動 avatar ${avatarId}、voice ${voiceId}（${title}）→ ${id}`);
    return id;
  }

  /** @param {string} videoId */
  async function waitForVideo(videoId) {
    if (!videos.has(videoId)) throw new Error(`模擬 HeyGen：沒有這支影片 ${videoId}`);
    return URL_PREFIX + videoId;
  }

  /** @param {string} url @param {string} destination */
  async function downloadVideo(url, destination) {
    const job = videos.get(url.startsWith(URL_PREFIX) ? url.slice(URL_PREFIX.length) : '');
    if (!job) throw new Error(`模擬 HeyGen：不認得的下載網址 ${url}`);
    media.video(destination, { ...job, aspectRatio });
    for (const file of assets.values()) fs.rmSync(file, { force: true });
    assets.clear();
    log(`🧪 模擬 HeyGen：占位講者影片 → ${destination}`);
  }

  return { uploadAudio, waitForAsset, createAudioDrivenVideo, createTextDrivenVideo, waitForVideo, downloadVideo };
}

module.exports = { createMockHeyGenClient, URL_PREFIX };
