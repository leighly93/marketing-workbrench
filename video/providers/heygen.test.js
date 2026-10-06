'use strict';

const { createHeyGenClient, isRecordNotFound, audioDrivenPayload, textDrivenPayload, NOT_FOUND_RETRY_DELAYS, POLL_MAX } = require('./heygen');

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const notFound = () => json(400, { error: { code: 'asset_not_found', message: 'Voice audio asset not found' } }, { 'x-request-id': 'req-1' });
const created = (id = 'vid-1') => json(200, { data: { video_id: id } });

/** 依序回應的假 fetch；記下每次呼叫。 */
function fakeFetch(responses) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
    const next = responses.shift();
    if (!next) throw new Error(`沒有預期的請求：${url}`);
    return typeof next === 'function' ? next(url, init) : next;
  };
  return { fetch, calls };
}

function client(responses, extra = {}) {
  const { fetch, calls } = fakeFetch(responses);
  const sleeps = [];
  let n = 0;
  const logs = [];
  const errors = [];
  const c = createHeyGenClient({
    apiKey: 'test-key', aspectRatio: '16:9', fetch,
    sleep: async (ms) => { sleeps.push(ms); },
    randomUUID: () => `key-${++n}`,
    log: (m) => logs.push(m), error: (...m) => errors.push(m.join(' ')), status: () => {},
    writeFile: extra.writeFile || (() => {}),
  });
  return { c, calls, sleeps, logs, errors };
}

describe('payloads', () => {
  test('音訊驅動：v3 必填 type、fit cover、Avatar IV 才帶 expressiveness', () => {
    expect(audioDrivenPayload({ avatarId: 'a', audio: { audio_asset_id: 'x' }, aspectRatio: '9:16', title: 't', engine: 'avatar_iv' }))
      .toEqual({ type: 'avatar', avatar_id: 'a', audio_asset_id: 'x', aspect_ratio: '9:16', fit: 'cover', resolution: '1080p',
        engine: { type: 'avatar_iv' }, title: 't', expressiveness: 'medium' });
    expect(audioDrivenPayload({ avatarId: 'a', audio: { audio_url: 'u' }, aspectRatio: '9:16', title: 't', engine: 'avatar_iii' }))
      .not.toHaveProperty('expressiveness');
  });

  test('文字驅動帶 script 與 voice_id，不送 voice_settings.speed（加速一律 ffmpeg）', () => {
    const p = textDrivenPayload({ avatarId: 'a', script: '稿', voiceId: 'v', aspectRatio: '16:9', title: 't', engine: 'avatar_iv' });
    expect(p).toMatchObject({ script: '稿', voice_id: 'v', aspect_ratio: '16:9' });
    expect(p.voice_settings).toBeUndefined();
  });

  test('「剛存好查不到」的判斷', () => {
    expect(isRecordNotFound(400, { error: { code: 'asset_not_found' } })).toBe(true);
    expect(isRecordNotFound(404, { error: { message: 'Video(s) not found' } })).toBe(true);
    expect(isRecordNotFound(500, { error: { code: 'asset_not_found' } })).toBe(false);
    expect(isRecordNotFound(400, { error: { code: 'invalid_parameter', message: 'bad avatar' } })).toBe(false);
  });
});

describe('uploadAudio', () => {
  test('上傳後確認查得到再多等 3 秒，並記下 audio_url', async () => {
    const { c, calls, sleeps } = client([
      json(200, { data: { asset_id: 'as-1', url: 'https://cdn/a.mp3' } }),
      json(404, {}), json(200, {}),
    ]);
    await expect(c.uploadAudio(Buffer.from('mp3'))).resolves.toBe('as-1');
    expect(calls.map((x) => x.url)).toEqual(['https://api.heygen.com/v3/assets', 'https://api.heygen.com/v3/assets/as-1', 'https://api.heygen.com/v3/assets/as-1']);
    expect(calls[0].init.headers).toEqual({ 'X-Api-Key': 'test-key' }); // multipart：不能自己設 Content-Type
    expect(sleeps).toEqual([2000, 3000]);
  });

  test('上傳失敗要丟錯並把回應標頭（request ID）記進錯誤輸出', async () => {
    const { c, errors } = client([json(500, { error: 'boom' }, { 'x-request-id': 'req-9', 'set-cookie': 'secret' })]);
    await expect(c.uploadAudio(Buffer.from('mp3'))).rejects.toThrow('HeyGen 音檔上傳失敗');
    const headerLine = errors.find((e) => e.includes('回應標頭'));
    expect(headerLine).toContain('req-9');
    expect(headerLine).not.toContain('secret');
  });

  test('查狀態回 404 以外的錯誤就不等了，照樣往下走', async () => {
    const { c, sleeps } = client([json(200, { data: { asset_id: 'as-1' } }), json(403, {})]);
    await c.uploadAudio(Buffer.from('mp3'));
    expect(sleeps).toEqual([]);
  });
});

describe('createAudioDrivenVideo：「找不到」的重試順序', () => {
  async function uploaded(responses, { url = 'https://cdn/a.mp3' } = {}) {
    const ctx = client([json(200, { data: { asset_id: 'as-1', ...(url ? { url } : {}) } }), json(200, {}), ...responses]);
    await ctx.c.uploadAudio(Buffer.from('mp3'));
    ctx.calls.length = 0;
    ctx.sleeps.length = 0;
    return ctx;
  }

  test('asset_id → 等 5 秒 → 等 15 秒（同一把 key）→ 改送 audio_url（新 key）', async () => {
    const { c, calls, sleeps } = await uploaded([notFound(), notFound(), notFound(), created('vid-9')]);
    await expect(c.createAudioDrivenVideo('as-1', 'avatar-1', 't')).resolves.toBe('vid-9');
    expect(sleeps).toEqual(NOT_FOUND_RETRY_DELAYS);
    const keys = calls.map((x) => x.init.headers['Idempotency-Key']);
    expect(keys.slice(0, 3)).toEqual(['key-1', 'key-1', 'key-1']);
    expect(keys[3]).not.toBe('key-1');
    expect(calls.slice(0, 3).every((x) => x.body.audio_asset_id === 'as-1')).toBe(true);
    expect(calls[3].body).toMatchObject({ audio_url: 'https://cdn/a.mp3' });
    expect(calls[3].body).not.toHaveProperty('audio_asset_id');
  });

  test('409 request_in_progress 也照「找不到」的方式重試', async () => {
    const { c, sleeps } = await uploaded([json(409, { error: { code: 'request_in_progress' } }), created()]);
    await expect(c.createAudioDrivenVideo('as-1', 'avatar-1', 't')).resolves.toBe('vid-1');
    expect(sleeps).toEqual([5000]);
  });

  test('audio_url 也重試完還是找不到就放棄', async () => {
    const { c, calls } = await uploaded([notFound(), notFound(), notFound(), notFound(), notFound(), notFound()]);
    await expect(c.createAudioDrivenVideo('as-1', 'avatar-1', 't')).rejects.toThrow('HeyGen 一直回「找不到」');
    expect(calls).toHaveLength(6);
  });

  test('上傳回應沒有 url 就不能改送 audio_url', async () => {
    const { c, calls, errors } = await uploaded([notFound(), notFound(), notFound()], { url: null });
    await expect(c.createAudioDrivenVideo('as-1', 'avatar-1', 't')).rejects.toThrow('一直回「找不到」');
    expect(calls).toHaveLength(3);
    expect(errors.join('\n')).toMatch(/上傳回應沒有 url/);
  });

  test('其他錯誤：非 avatar_iv 被拒時用 avatar_iv 重試一次（換新 key）', async () => {
    const { c, calls } = await uploaded([json(400, { error: { code: 'invalid_parameter' } }), created()]);
    await expect(c.createAudioDrivenVideo('as-1', 'avatar-1', 't', 'avatar_iii')).resolves.toBe('vid-1');
    expect(calls.map((x) => x.body.engine.type)).toEqual(['avatar_iii', 'avatar_iv']);
    expect(calls[0].init.headers['Idempotency-Key']).not.toBe(calls[1].init.headers['Idempotency-Key']);
  });

  test('avatar_iv 自己被拒就直接失敗', async () => {
    const { c, calls } = await uploaded([json(400, { error: { code: 'invalid_parameter' } })]);
    await expect(c.createAudioDrivenVideo('as-1', 'avatar-1', 't')).rejects.toThrow('HeyGen 建立影片失敗（音訊驅動 v3）');
    expect(calls).toHaveLength(1);
  });
});

describe('createTextDrivenVideo', () => {
  test('成功回 video_id；非 avatar_iv 被拒用 avatar_iv 重試', async () => {
    const { c, calls } = client([json(400, {}), created('vid-t')]);
    await expect(c.createTextDrivenVideo('稿', 'avatar-1', 'voice-1', 't', 'avatar_iii')).resolves.toBe('vid-t');
    expect(calls.map((x) => x.body.engine.type)).toEqual(['avatar_iii', 'avatar_iv']);
    expect(calls[1].body).toMatchObject({ script: '稿', voice_id: 'voice-1', aspect_ratio: '16:9' });
  });
});

describe('waitForVideo', () => {
  test('處理中與暫時錯誤（網路、非 2xx、非 JSON）都繼續等，拿到 video_url 才回', async () => {
    const { c, sleeps, logs } = client([
      json(200, { data: { status: 'processing' } }),
      () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); },
      new Response('<html>502</html>', { status: 502 }),
      json(200, { data: { video_url: 'https://cdn/v.mp4', duration: 41.5 } }),
    ]);
    await expect(c.waitForVideo('vid-1')).resolves.toBe('https://cdn/v.mp4');
    expect(sleeps).toEqual([10000, 10000, 10000, 10000]);
    expect(logs.join('\n')).toMatch(/41\.5 秒.*123 單位/);
  });

  test('HeyGen 回生成失敗就停', async () => {
    const { c } = client([json(200, { data: { failure_code: 'MOVIO_ERROR', failure_message: '素材有問題' } })]);
    await expect(c.waitForVideo('vid-1')).rejects.toThrow('HeyGen 生成失敗：MOVIO_ERROR 素材有問題');
  });

  test(`等滿 ${POLL_MAX} 次（15 分鐘）就超時，並提示影片可能還在生成`, async () => {
    const { c } = client(Array.from({ length: POLL_MAX }, () => json(200, { data: { status: 'processing' } })));
    await expect(c.waitForVideo('vid-1')).rejects.toThrow(/等待超時（15 分鐘）.*現有影片/);
  });
});

describe('downloadVideo', () => {
  test('寫入下載的內容；失敗要丟錯', async () => {
    const written = [];
    const { c } = client([new Response(Buffer.from('mp4-bytes')), new Response('', { status: 403 })], { writeFile: (f, d) => written.push([f, d.toString()]) });
    await c.downloadVideo('https://cdn/v.mp4', '/tmp/heygen.mp4');
    expect(written).toEqual([['/tmp/heygen.mp4', 'mp4-bytes']]);
    await expect(c.downloadVideo('https://cdn/v.mp4', '/tmp/x.mp4')).rejects.toThrow('下載失敗：403');
  });
});
