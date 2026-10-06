// @ts-check
'use strict';

/**
 * HeyGen v3 API（/v3/assets、/v3/videos）。只負責「送出、重試、輪詢、下載」，不決定用哪個主播或聲音。
 * v1／v2 舊端點已於 2026-10-07 移除（官方 2026-10-31 退役）。
 *
 * 外部依賴（fetch、sleep、log…）都從 createHeyGenClient 傳入，測試用假的 API 驗證重試順序。
 */

// ── 引擎（2026-08-20 使用者定案：維持 avatar_iv）────────────
// photo avatar 費率：avatar_iii $0.0433/秒、avatar_iv $0.05/秒（差 7~13%）。
// 2026-08-19 用 5 秒短片比看不出差別、一度改 III；08-20 看正式長度成品「表情有點沒對上」改回 IV。
// **III 跟 IV 的差別要在正式長度的影片上才看得出來，不要再用短片試第三次。** 要試就加 --avatar-iii。
const DEFAULT_ENGINE = 'avatar_iv';

// expressiveness：Avatar IV 專屬（送給別的引擎會 400）。官方預設 low；手不太動可以試 high。
const EXPRESSIVENESS = 'medium';

// motion_prompt：只有 photo avatar + avatar_iv 吃。對「來源照片雙手交握」的 look 幾乎無效，所以不送（null）。
// 要恢復就換成 MOTION_PROMPT_TEXT（只有 avatar_iv 會帶上）。
const MOTION_PROMPT_TEXT = '站姿自然，雙手在胸前或身側做出適度自然的手勢，配合語氣比劃，不要十指交握不動';
const MOTION_PROMPT = null;

// fit：cover＝縮放填滿。省略時 HeyGen 自己挑 contain，橫式素材塞進直式就會露白邊；比例吻合時兩者等價，所以一律 cover。
const FIT = 'cover';

// voice_settings.locale（BCP-47，例如 zh-TW）。填之前先 npm run check-voices 確認 support_locale。
// ⚠️ voice_settings.speed **刻意不做**（2026-08-21 使用者定案）：實測只短 2%、扣點一樣，
//    而且它一旦非 null，ffmpeg 加速就會被跳過、成品變接近原速 —— 加速一律由 ffmpeg 做。
const VOICE_LOCALE = null;

// 專有名詞唸法字典：GET /v3/brand-glossaries 拿 id 填進來（官方保證只影響音訊，字幕仍是原文）。
const BRAND_GLOSSARY_ID = null;

// 輪詢上限：每 10 秒一次 × 90 次 = 15 分鐘（2026-09-07 縮成 8 分鐘後尖峰時段被自己砍掉，點數已扣 → 放寬回 15 分鐘）。
const POLL_INTERVAL_MS = 10000;
const POLL_MAX = 90;

// 「剛存好查不到」的重試（2026-10-06 依 HeyGen 客服建議改成間隔漸增）：
//   asset_id 原樣送 → 等 5 秒 → 等 15 秒 → 改送 audio_url → 等 5 秒 → 等 15 秒 → 放棄
const NOT_FOUND_RETRY_DELAYS = [5000, 15000];

// 上傳後確認查得到：最多查 10 次、每次間隔 2 秒；查到後再多等 3 秒（客服說可省，保留無害）。
const ASSET_CHECK_TRIES = 10;
const ASSET_CHECK_INTERVAL_MS = 2000;
const ASSET_SETTLE_MS = 3000;

const API = 'https://api.heygen.com';

/**
 * 「剛存好查不到」：找不到音檔（400 asset_not_found），或建立影片後查不到自己剛建的記錄（404 resource_not_found）。
 * @param {number} status
 * @param {any} data
 */
function isRecordNotFound(status, data) {
  const code = data?.error?.code || '';
  const message = data?.error?.message || '';
  return (status === 400 || status === 404) &&
    (code === 'asset_not_found' || code === 'resource_not_found' || /asset not found|video\(s\) not found/i.test(message));
}

/**
 * Avatar IV 專屬欄位只在 avatar_iv 帶（送給別的引擎會被 400 擋掉）。
 * @param {Record<string, unknown>} payload
 * @param {string} engine
 */
function withEngineOptions(payload, engine) {
  if (engine !== 'avatar_iv') return payload;
  return { ...payload, expressiveness: EXPRESSIVENESS, ...(MOTION_PROMPT ? { motion_prompt: MOTION_PROMPT } : {}) };
}

/**
 * @param {{ avatarId: string, audio: { audio_asset_id: string } | { audio_url: string | undefined }, aspectRatio: string, title: string, engine: string }} o
 */
function audioDrivenPayload({ avatarId, audio, aspectRatio, title, engine }) {
  return withEngineOptions({
    type: 'avatar', avatar_id: avatarId, ...audio, aspect_ratio: aspectRatio, fit: FIT,
    resolution: '1080p', engine: { type: engine }, title,
  }, engine);
}

/**
 * @param {{ avatarId: string, script: string, voiceId: string, aspectRatio: string, title: string, engine: string }} o
 */
function textDrivenPayload({ avatarId, script, voiceId, aspectRatio, title, engine }) {
  const payload = withEngineOptions({
    type: 'avatar', avatar_id: avatarId, script, voice_id: voiceId, aspect_ratio: aspectRatio, fit: FIT,
    resolution: '1080p', engine: { type: engine }, title,
  }, engine);
  if (VOICE_LOCALE) payload.voice_settings = { locale: VOICE_LOCALE };
  if (BRAND_GLOSSARY_ID) payload.brand_glossary_id = BRAND_GLOSSARY_ID;
  return payload;
}

/**
 * @param {{
 *   apiKey: string, aspectRatio: string, engine?: string,
 *   fetch?: typeof globalThis.fetch, sleep?: (ms: number) => Promise<void>, randomUUID?: () => string,
 *   log?: (m: string) => void, error?: (...m: unknown[]) => void, status?: (m: string) => void,
 *   writeFile?: (file: string, data: Buffer) => void,
 * }} options
 */
function createHeyGenClient({
  apiKey, aspectRatio, engine: defaultEngine = DEFAULT_ENGINE,
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  randomUUID = () => require('node:crypto').randomUUID(),
  log = console.log, error = console.error,
  status = (m) => process.stdout.write(m),
  writeFile = (file, data) => require('node:fs').writeFileSync(file, data),
}) {
  /** 上傳回應裡的公開 url（asset_id → url），「找不到」時改送 audio_url 用。 */
  const audioUrls = new Map();

  /** 出錯時把回應標頭留進執行記錄：request ID 在標頭裡，當下沒存就查不回來。不含金鑰；cookie 類略過。 */
  function logResponseHeaders(/** @type {Response} */ res) {
    /** @type {Record<string, string>} */
    const headers = {};
    res.headers.forEach((value, key) => { if (!/cookie/i.test(key)) headers[key] = value; });
    error(`HeyGen 回應標頭（回報客服用，${new Date().toISOString()}）：`, JSON.stringify(headers));
  }

  /**
   * 上傳音檔：POST /v3/assets（multipart，欄位名 file，上限 32MB）。
   * @param {Buffer} audio mp3
   * @returns {Promise<string>} asset_id
   */
  async function uploadAudio(audio) {
    log(`上傳音檔到 HeyGen（/v3/assets，${audio.length} bytes）`);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/mpeg' }), 'audio.mp3');
    // ⚠️ 不要自己設 Content-Type —— multipart 的 boundary 要讓 fetch 自己帶
    const res = await fetch(`${API}/v3/assets`, { method: 'POST', headers: { 'X-Api-Key': apiKey }, body: form });
    const data = await res.json().catch(() => null);
    const assetId = data?.data?.asset_id || data?.data?.id;
    if (!res.ok || !assetId) {
      error(`HeyGen /v3/assets 回應（HTTP ${res.status}）：`, JSON.stringify(data, null, 2));
      logResponseHeaders(res);
      throw new Error('HeyGen 音檔上傳失敗（v3）');
    }
    log(`音檔已上傳：asset_id = ${assetId}`);
    if (data?.data?.url) audioUrls.set(assetId, data.data.url);
    await waitForAsset(assetId);
    return assetId;
  }

  /**
   * 上傳後確認 HeyGen 查得到（2026-10-05 平台事故：剛上傳的 asset 同一秒拿去建立影片被回「找不到」）。
   * 查不到也照樣往下走，交給建立影片的重試處理。
   * @param {string} assetId
   */
  async function waitForAsset(assetId) {
    for (let i = 0; i < ASSET_CHECK_TRIES; i++) {
      try {
        const res = await fetch(`${API}/v3/assets/${assetId}`, { headers: { 'X-Api-Key': apiKey } });
        if (res.ok) { await sleep(ASSET_SETTLE_MS); return; }
        // 404 是「還沒好」；其他狀態查不出結果，直接往下走
        if (res.status !== 404) { log(`⚠️ 查音檔狀態回 HTTP ${res.status}，略過等待`); return; }
      } catch {
        return;
      }
      await sleep(ASSET_CHECK_INTERVAL_MS);
    }
    log(`⚠️ 等了約 20 秒 HeyGen 仍查不到音檔 ${assetId}，照樣送出（失敗會改用 audio_url）`);
  }

  /**
   * 音訊驅動：MiniMax 配好的音檔 → HeyGen 對嘴。
   *
   * Idempotency-Key：同一把 key 24 小時內重送會回放第一次的回應。同一份內容的重試共用一把 key
   * （避免「草稿已建好才報錯」重試後多出重複草稿）；換引擎或改送 audio_url 時內容變了，換新 key。
   *
   * @param {string} assetId
   * @param {string} avatarId
   * @param {string} title
   * @param {string} [engine] 被拒時自動退回 avatar_iv 用，正常呼叫不要傳
   * @param {{ useAudioUrl?: boolean, attempt?: number, idempotencyKey?: string }} [retry] 內部重試用
   * @returns {Promise<string>} video_id
   */
  async function createAudioDrivenVideo(assetId, avatarId, title, engine = defaultEngine, retry = {}) {
    const { useAudioUrl = false, attempt = 0, idempotencyKey = randomUUID() } = retry;
    const audioUrl = audioUrls.get(assetId);
    const audio = useAudioUrl ? { audio_url: audioUrl } : { audio_asset_id: assetId };
    log(`呼叫 HeyGen /v3/videos ${engine}（avatar: ${avatarId}、${useAudioUrl ? `audio_url: ${audioUrl}` : `audio_asset_id: ${assetId}`}、Idempotency-Key: ${idempotencyKey}）`);

    const res = await fetch(`${API}/v3/videos`, {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(audioDrivenPayload({ avatarId, audio, aspectRatio, title, engine })),
    });
    const data = await res.json().catch(() => null);
    const videoId = data?.data?.video_id || data?.data?.id;
    if (res.ok && videoId) return videoId;

    error(`HeyGen /v3/videos 回應（HTTP ${res.status}）：`, JSON.stringify(data, null, 2));
    logResponseHeaders(res);
    // 查不到（或同一把 key 的上一個請求還在處理中：409 request_in_progress）跟引擎無關，先處理。
    if (isRecordNotFound(res.status, data) || data?.error?.code === 'request_in_progress') {
      if (attempt < NOT_FOUND_RETRY_DELAYS.length) {
        const delay = NOT_FOUND_RETRY_DELAYS[attempt];
        log(`⚠️ HeyGen 回「${data?.error?.code || '找不到'}」，等 ${delay / 1000} 秒用同樣內容、同一把 Idempotency-Key 再試（第 ${attempt + 1} 次，建立失敗不扣點）`);
        await sleep(delay);
        return createAudioDrivenVideo(assetId, avatarId, title, engine, { useAudioUrl, attempt: attempt + 1, idempotencyKey });
      }
      if (!useAudioUrl && audioUrl) {
        log('⚠️ HeyGen 用 asset_id 還是找不到，改送上傳時拿到的 audio_url、換新的 Idempotency-Key 重試（建立失敗不扣點）');
        return createAudioDrivenVideo(assetId, avatarId, title, engine, { useAudioUrl: true });
      }
      error(useAudioUrl
        ? '   → asset_id 跟 audio_url 兩種都被 HeyGen 回「找不到」，問題在 HeyGen 那邊（上面的回應標頭可附給客服）'
        : '   → 上傳回應沒有 url，沒辦法改用 audio_url 重試');
      throw new Error('HeyGen 一直回「找不到」（音訊驅動 v3）');
    }
    // 建立失敗不扣點：非 avatar_iv 被拒就用 avatar_iv 重試一次（引擎不同＝內容不同，換新 key）。
    if (engine !== 'avatar_iv') {
      log(`⚠️ ${engine} 被拒，自動改用 avatar_iv 重試一次（建立失敗不扣點）`);
      return createAudioDrivenVideo(assetId, avatarId, title, 'avatar_iv', { useAudioUrl });
    }
    throw new Error('HeyGen 建立影片失敗（音訊驅動 v3）');
  }

  /**
   * 文字驅動：腳本＋HeyGen 內建語音，由 HeyGen 自己配音並對嘴（--heygen-voice 的退路）。
   * script 欄位吃 <break time="0.3s"/>（但 cleanBodyWithIndex 沒遮罩它，直接寫在稿件會漏進字幕）。
   * @param {string} script
   * @param {string} avatarId
   * @param {string} voiceId
   * @param {string} title
   * @param {string} [engine]
   * @returns {Promise<string>} video_id
   */
  async function createTextDrivenVideo(script, avatarId, voiceId, title, engine = defaultEngine) {
    log(`呼叫 HeyGen /v3/videos ${engine}（avatar: ${avatarId}，voice_id: ${voiceId}，文字驅動、不經 MiniMax）`);
    const res = await fetch(`${API}/v3/videos`, {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(textDrivenPayload({ avatarId, script, voiceId, aspectRatio, title, engine })),
    });
    const data = await res.json().catch(() => null);
    const videoId = data?.data?.video_id || data?.data?.id;
    if (res.ok && videoId) return videoId;

    error(`HeyGen /v3/videos 回應（HTTP ${res.status}）：`, JSON.stringify(data, null, 2));
    logResponseHeaders(res);
    if (engine !== 'avatar_iv') {
      log(`⚠️ ${engine} 被拒，自動改用 avatar_iv 重試一次（建立失敗不扣點）`);
      log(`   若這支 avatar 長期不吃 ${engine}，用 node tools/experiments/ab-endpoints.js --template=<版型> --probe 查支援的引擎（不扣點）`);
      return createTextDrivenVideo(script, avatarId, voiceId, title, 'avatar_iv');
    }
    throw new Error('HeyGen 建立影片失敗（文字驅動 v3）');
  }

  /**
   * 輪詢 GET /v3/videos/{id} 直到有 video_url。網路錯誤、非 2xx、非 JSON 都印一行再繼續等，
   * 不提早放棄（使用者定案：早放棄＝點數白扣）。
   * @param {string} videoId
   * @returns {Promise<string>} video_url
   */
  async function waitForVideo(videoId) {
    log(`等待 HeyGen 完成（v3，video_id: ${videoId}）`);
    for (let i = 0; i < POLL_MAX; i++) {
      await sleep(POLL_INTERVAL_MS);
      let res;
      try {
        res = await fetch(`${API}/v3/videos/${videoId}`, { headers: { 'X-Api-Key': apiKey } });
      } catch (e) {
        const err = /** @type {any} */ (e);
        status(`\n  第 ${i + 1} 次輪詢網路錯誤：${err.code || err.message}（下一輪再試）\n`);
        continue;
      }
      const raw = await res.text();
      let data = null;
      try { data = JSON.parse(raw); } catch {}
      if (!res.ok || data === null) {
        status(`\n  第 ${i + 1} 次輪詢 HTTP ${res.status}：${raw.slice(0, 120).replace(/\s+/g, ' ')}（下一輪再試）\n`);
        continue;
      }
      const d = data.data || data;
      if (d.failure_code || d.failure_message) {
        error('HeyGen 回應：', JSON.stringify(data, null, 2));
        throw new Error(`HeyGen 生成失敗：${d.failure_code || ''} ${d.failure_message || ''}`.trim());
      }
      if (d.video_url) {
        status('\n');
        // 對帳看這一行：計費按 HeyGen 生成的秒數，不是加速後的成品秒數。
        if (d.duration) log(`HeyGen 原始輸出時長：${d.duration} 秒（加速前；${Math.floor(d.duration) * 3} 單位就是這一支的扣點）`);
        return d.video_url;
      }
      status(`\r  狀態：${d.status || d.state || 'processing'}            `);
    }
    throw new Error(`HeyGen 等待超時（${POLL_MAX / 6} 分鐘）；影片可能仍在 HeyGen 生成中，可到 HeyGen 網站確認並下載後用「現有影片」重跑`);
  }

  /**
   * @param {string} url
   * @param {string} destination
   */
  async function downloadVideo(url, destination) {
    log(`下載影片到 ${destination}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下載失敗：${res.status}`);
    writeFile(destination, Buffer.from(await res.arrayBuffer()));
    log('下載完成！');
  }

  return { uploadAudio, waitForAsset, createAudioDrivenVideo, createTextDrivenVideo, waitForVideo, downloadVideo };
}

module.exports = {
  createHeyGenClient, isRecordNotFound, audioDrivenPayload, textDrivenPayload,
  DEFAULT_ENGINE, NOT_FOUND_RETRY_DELAYS, POLL_MAX, MOTION_PROMPT_TEXT,
};
