'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMockHeyGenClient, URL_PREFIX } = require('./mock-heygen');
const { createMockMiniMaxClient } = require('./mock-minimax');
const { createProviders, missingCredentials } = require('./index');
const { generateAnchorVideo } = require('../steps/anchor-video');

function fakeMedia() {
  const made = [];
  return {
    made,
    toneBuffer: (seconds) => Buffer.from(`tone:${seconds}`),
    video: (file, options) => { made.push({ file, ...options, audioContent: options.audio && fs.readFileSync(options.audio, 'utf8') }); fs.writeFileSync(file, 'mp4'); },
  };
}

function workDir(ctx) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-providers-'));
  ctx.onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('createMockMiniMaxClient', () => {
  test('回傳依字數估長的占位音檔', async () => {
    const minimax = createMockMiniMaxClient({ media: fakeMedia(), log: () => {} });
    expect((await minimax.synthesize('字'.repeat(25), 'voice-1')).toString()).toBe('tone:5');
  });
});

describe('createMockHeyGenClient', () => {
  test('音訊驅動：影片的聲音就是上傳的音檔，下載後清掉暫存音檔', async (ctx) => {
    const dir = workDir(ctx);
    const media = fakeMedia();
    const heygen = createMockHeyGenClient({ media, aspectRatio: '16:9', workDir: dir, log: () => {} });
    const asset = await heygen.uploadAudio(Buffer.from('voice'));
    const id = await heygen.createAudioDrivenVideo(asset, 'avatar', 'title');
    const url = await heygen.waitForVideo(id);
    expect(url).toBe(URL_PREFIX + id);
    await heygen.downloadVideo(url, path.join(dir, 'heygen.mp4'));
    expect(media.made).toEqual([expect.objectContaining({ file: path.join(dir, 'heygen.mp4'), audioContent: 'voice', aspectRatio: '16:9' })]);
    expect(fs.readdirSync(dir)).toEqual(['heygen.mp4']);
  });

  test('文字驅動：依稿件字數估長', async (ctx) => {
    const dir = workDir(ctx);
    const media = fakeMedia();
    const heygen = createMockHeyGenClient({ media, workDir: dir, log: () => {} });
    const id = await heygen.createTextDrivenVideo('字'.repeat(30), 'avatar', 'voice', 'title');
    await heygen.downloadVideo(await heygen.waitForVideo(id), path.join(dir, 'h.mp4'));
    expect(media.made[0]).toMatchObject({ seconds: 6, aspectRatio: '9:16' });
  });

  test('不存在的音檔、影片或網址都丟錯（跟正式 API 一樣不會默默成功）', async () => {
    const heygen = createMockHeyGenClient({ media: fakeMedia(), log: () => {} });
    await expect(heygen.createAudioDrivenVideo('nope', 'a', 't')).rejects.toThrow(/沒有這個音檔/);
    await expect(heygen.waitForVideo('nope')).rejects.toThrow(/沒有這支影片/);
    await expect(heygen.downloadVideo('https://cdn/x.mp4', 'x')).rejects.toThrow(/不認得/);
  });

  test('可以直接接上 generateAnchorVideo（介面與正式 client 相同）', async (ctx) => {
    const dir = workDir(ctx);
    const media = fakeMedia();
    const tpl = { id: 'dapan', label: '大盤小報', anchor: { avatar: { id: 'a' }, voice: 'minimax', minimaxVoiceId: 'm', heygenVoiceId: 'h' } };
    const r = await generateAnchorVideo({
      tpl, rawScript: '\n===\n標題\n===\n今天台股上漲。', heygenPath: path.join(dir, 'heygen.mp4'), minimaxAudioPath: path.join(dir, 'minimax.mp3'),
      heygen: createMockHeyGenClient({ media, workDir: dir, log: () => {} }), minimax: createMockMiniMaxClient({ media, log: () => {} }), log: () => {},
    });
    expect(r.useMinimax).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'minimax.mp3'), 'utf8')).toBe('tone:2');
    expect(media.made[0].audioContent).toBe('tone:2');
  });
});

describe('missingCredentials', () => {
  test('正式模式要 HeyGen 金鑰；用 MiniMax 時還要 MiniMax 兩個值', () => {
    expect(missingCredentials({ env: {}, useMinimax: false })).toMatch(/HEYGEN_API_KEY/);
    expect(missingCredentials({ env: { HEYGEN_API_KEY: 'k' }, useMinimax: false })).toBeNull();
    expect(missingCredentials({ env: { HEYGEN_API_KEY: 'k', MINIMAX_API_KEY: 'm' }, useMinimax: true })).toMatch(/MINIMAX_GROUP_ID/);
    expect(missingCredentials({ env: { HEYGEN_API_KEY: 'k', MINIMAX_API_KEY: 'm', MINIMAX_GROUP_ID: 'g' }, useMinimax: true })).toBeNull();
  });

  test('模擬模式不需要任何金鑰', () => {
    expect(missingCredentials({ env: { WORKBENCH_MOCK: '1' }, useMinimax: true })).toBeNull();
  });
});

describe('createProviders', () => {
  const base = { aspectRatio: '9:16', engine: 'avatar_iv', emotion: 'fluent', log: () => {} };

  test('模擬模式給假 client；不用 MiniMax 時就不建', () => {
    const p = createProviders({ ...base, env: { WORKBENCH_MOCK: '1' }, useMinimax: true, media: fakeMedia() });
    expect(p.mock).toBe(true);
    expect(Object.keys(p.heygen)).toEqual(['uploadAudio', 'waitForAsset', 'createAudioDrivenVideo', 'createTextDrivenVideo', 'waitForVideo', 'downloadVideo']);
    expect(typeof p.minimax.synthesize).toBe('function');
    expect(createProviders({ ...base, env: { WORKBENCH_MOCK: '1' }, useMinimax: false, media: fakeMedia() }).minimax).toBeUndefined();
  });

  test('正式模式介面與模擬相同；缺金鑰直接丟錯', () => {
    const p = createProviders({ ...base, env: { HEYGEN_API_KEY: 'k', MINIMAX_API_KEY: 'm', MINIMAX_GROUP_ID: 'g' }, useMinimax: true });
    expect(p.mock).toBe(false);
    expect(Object.keys(p.heygen).sort()).toEqual(Object.keys(createProviders({ ...base, env: { WORKBENCH_MOCK: '1' }, useMinimax: true, media: fakeMedia() }).heygen).sort());
    expect(() => createProviders({ ...base, env: {}, useMinimax: false })).toThrow(/HEYGEN_API_KEY/);
  });
});
