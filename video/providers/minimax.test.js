'use strict';

const { createMiniMaxClient, ttsPayload, emotionError, PRONUNCIATION_DICT, EMOTIONS } = require('./minimax');

describe('emotionError', () => {
  test('預設 fluent、九個合法值、空值（自動挑）都可以', () => {
    for (const e of ['', 'fluent', 'happy', 'calm']) expect(emotionError(e)).toBeNull();
    expect(EMOTIONS).toHaveLength(9);
  });
  test('neutral／auto 不是合法值；speech-2.8 不支援 whisper', () => {
    expect(emotionError('neutral')).toMatch(/不認得的 --emotion=neutral/);
    expect(emotionError('whisper')).toMatch(/不支援 --emotion=whisper/);
    expect(emotionError('whisper', 'speech-02-hd')).toBeNull();
  });
});

describe('ttsPayload', () => {
  test('釘住普通話、帶發音字典；空情緒就不送 emotion 欄位', () => {
    const p = ttsPayload({ text: '台股上漲', voiceId: 'v1', emotion: '' });
    expect(p).toMatchObject({ model: 'speech-2.8-hd', language_boost: 'Chinese', output_format: 'hex', stream: false,
      voice_setting: { voice_id: 'v1', speed: 1 }, pronunciation_dict: { tone: PRONUNCIATION_DICT } });
    expect(p.voice_setting).not.toHaveProperty('emotion');
    expect(ttsPayload({ text: 'x', voiceId: 'v', emotion: 'happy' }).voice_setting.emotion).toBe('happy');
    expect(ttsPayload({ text: 'x', voiceId: 'v', dict: [] })).not.toHaveProperty('pronunciation_dict');
  });

  test('字典排序規則：詞級在單字級前面（單字條目蓋不到詞，2026-09-01 實測）', () => {
    const firstSingle = PRONUNCIATION_DICT.findIndex((e) => e.split('/')[0].length === 1);
    expect(PRONUNCIATION_DICT.slice(firstSingle).every((e) => e.split('/')[0].length === 1)).toBe(true);
  });
});

describe('synthesize', () => {
  test('送出 Bearer 金鑰與 GroupId，回傳 hex 解碼後的 mp3', async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: { audio: Buffer.from('mp3!').toString('hex') } }));
    };
    const { synthesize } = createMiniMaxClient({ apiKey: 'k', groupId: 'g1', fetch, log: () => {} });
    expect((await synthesize('稿', 'voice-1')).toString()).toBe('mp3!');
    expect(calls[0].url).toBe('https://api.minimax.io/v1/t2a_v2?GroupId=g1');
    expect(calls[0].init.headers.Authorization).toBe('Bearer k');
    expect(JSON.parse(calls[0].init.body).voice_setting.voice_id).toBe('voice-1');
  });

  test('沒有音訊就丟錯並印出回應', async () => {
    const errors = [];
    const fetch = async () => new Response(JSON.stringify({ base_resp: { status_code: 2013 } }));
    const { synthesize } = createMiniMaxClient({ apiKey: 'k', groupId: 'g', fetch, log: () => {}, error: (...m) => errors.push(m.join(' ')) });
    await expect(synthesize('稿', 'v')).rejects.toThrow('MiniMax T2A 生成失敗');
    expect(errors[0]).toMatch(/2013/);
  });
});
