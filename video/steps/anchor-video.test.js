'use strict';

const { generateAnchorVideo, planVoice, ttsTextOf, AnchorConfigError } = require('./anchor-video');

const tpl = (anchor = {}) => ({
  id: 'dapan', label: '大盤小報',
  anchor: { avatar: { id: 'avatar-1' }, voice: 'minimax', minimaxVoiceId: 'mm-1', heygenVoiceId: 'hg-1', ...anchor },
});

function fakeHeyGen() {
  const calls = [];
  const rec = (name, value) => async (...args) => { calls.push([name, ...args]); return value; };
  return {
    calls,
    client: {
      uploadAudio: rec('uploadAudio', 'asset-1'),
      createAudioDrivenVideo: rec('createAudioDrivenVideo', 'vid-a'),
      createTextDrivenVideo: rec('createTextDrivenVideo', 'vid-t'),
      waitForVideo: rec('waitForVideo', 'https://cdn/v.mp4'),
      downloadVideo: rec('downloadVideo', undefined),
    },
  };
}

describe('planVoice', () => {
  test('預設 MiniMax；--heygen-voice 或版型設 voice: heygen 時改 HeyGen 內建語音', () => {
    expect(planVoice(tpl())).toEqual({ useMinimax: true });
    expect(planVoice(tpl(), { heygenVoice: true })).toEqual({ useMinimax: false });
    expect(planVoice(tpl({ voice: 'heygen' }))).toEqual({ useMinimax: false });
  });

  test('缺設定時在呼叫付費 API 前擋下，並指出 registry 的哪個欄位', () => {
    expect(() => planVoice(tpl({ avatar: { id: '' } }))).toThrow(/dapan\.anchor\.avatar\.id/);
    expect(() => planVoice(tpl({ minimaxVoiceId: '' }))).toThrow(AnchorConfigError);
    expect(() => planVoice(tpl({ heygenVoiceId: '' }), { heygenVoice: true })).toThrow(/heygenVoiceId 是空值/);
    expect(() => planVoice(tpl({ heygenVoiceId: '' }))).not.toThrow();
  });
});

describe('ttsTextOf', () => {
  test('清洗稿件後套發音替換（字幕不走這條路）', () => {
    expect(ttsTextOf('台積電→台基電\n===\n標題\n===\n台積電(image1)上漲(image1)。')).toBe('台基電上漲。');
  });
});

describe('generateAnchorVideo', () => {
  const rawScript = '\n===\n標題\n===\n今天台股上漲。';

  test('MiniMax 配音 → 留一份音檔 → 上傳 → 音訊驅動 → 等待 → 下載', async () => {
    const { calls, client } = fakeHeyGen();
    const written = [];
    const minimax = { synthesize: async (text, voice) => { calls.push(['synthesize', text, voice]); return Buffer.from('mp3'); } };
    const r = await generateAnchorVideo({ tpl: tpl(), rawScript, heygenPath: '/p/heygen.mp4', minimaxAudioPath: '/p/minimax.mp3',
      heygen: client, minimax, writeFile: (f) => written.push(f), log: () => {} });
    expect(r).toEqual({ useMinimax: true, videoId: 'vid-a' });
    expect(calls.map((c) => c[0])).toEqual(['synthesize', 'uploadAudio', 'createAudioDrivenVideo', 'waitForVideo', 'downloadVideo']);
    expect(calls[0].slice(1)).toEqual(['今天台股上漲。', 'mm-1']);
    expect(calls[2].slice(1)).toEqual(['asset-1', 'avatar-1', 'marketing-auto-dapan']);
    expect(calls[4].slice(1)).toEqual(['https://cdn/v.mp4', '/p/heygen.mp4']);
    expect(written).toEqual(['/p/minimax.mp3']);
  });

  test('--heygen-voice：文字驅動，不經 MiniMax', async () => {
    const { calls, client } = fakeHeyGen();
    await generateAnchorVideo({ tpl: tpl(), rawScript, heygenPath: '/p/h.mp4', minimaxAudioPath: '/p/m.mp3', heygenVoice: true, heygen: client, log: () => {} });
    expect(calls.map((c) => c[0])).toEqual(['createTextDrivenVideo', 'waitForVideo', 'downloadVideo']);
    expect(calls[0].slice(1)).toEqual(['今天台股上漲。', 'avatar-1', 'hg-1', 'marketing-auto-dapan']);
  });

  test('要用 MiniMax 卻沒有 MiniMax 設定就擋下', async () => {
    const { client } = fakeHeyGen();
    await expect(generateAnchorVideo({ tpl: tpl(), rawScript, heygenPath: 'h', minimaxAudioPath: 'm', heygen: client, log: () => {} }))
      .rejects.toThrow(AnchorConfigError);
  });
});
