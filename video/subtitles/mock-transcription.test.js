'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMockEngine, scriptTranscript, tokenize } = require('./mock-transcription');
const { createEngine, validate } = require('./transcription-engine');
const { correctSubtitles } = require('./correct');

describe('tokenize', () => {
  test('中文一字一詞、英數連成一詞、標點黏在前一詞', () => {
    expect(tokenize('台積電2330漲，AI強！')).toEqual(['台', '積', '電', '2330', '漲，', 'AI', '強！']);
  });
});

describe('scriptTranscript', () => {
  test('依句讀切 segment，時間照字數攤滿整段音檔，格式通過 Adapter 驗證', () => {
    const r = scriptTranscript('今天上漲，明天下跌。', 4);
    expect(validate(r)).toBe(r);
    expect(r.segments.map((s) => s.text)).toEqual(['今天上漲，', '明天下跌。']);
    expect(r.segments[0]).toMatchObject({ start: 0, end: 2 });
    expect(r.segments[1]).toMatchObject({ start: 2, end: 4 });
    expect(r.segments[1].words.map((w) => w.end)).toEqual([2.5, 3, 3.5, 4]);
  });

  test('長度要大於 0', () => {
    expect(() => scriptTranscript('字', 0)).toThrow(/大於 0/);
  });
});

describe('createMockEngine', () => {
  function setup(ctx, script) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-transcribe-'));
    ctx.onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
    const scriptPath = path.join(dir, 'script.txt');
    if (script !== undefined) fs.writeFileSync(scriptPath, script);
    return { dir, scriptPath };
  }

  test('念的是發音替換後的文字；墊的靜音從長度扣掉；輸出檔名跟音檔同名', (ctx) => {
    const { dir, scriptPath } = setup(ctx, '台積電→台基電\n===\n標題\n===\n台積電(image1)上漲(image1)。');
    const engine = createMockEngine({ execute: () => '3.5\n', scriptPath });
    const r = engine.transcribe('/x/heygen.wav', path.join(dir, 'out'), { padSec: 0.5 });
    expect(r.text).toBe('台基電上漲。');
    expect(r.segments.at(-1).end).toBe(3);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'out', 'heygen.json'), 'utf8'))).toEqual(r);
  });

  test('沒有稿件就在 ensure 擋下；padSec 不能是負數', (ctx) => {
    const { scriptPath, dir } = setup(ctx);
    expect(() => createMockEngine({ execute: () => '1', scriptPath }).ensure()).toThrow(/找不到/);
    fs.writeFileSync(scriptPath, '字');
    expect(() => createMockEngine({ execute: () => '1', scriptPath }).transcribe('a.wav', dir, { padSec: -1 })).toThrow(/負數/);
  });

  test('transcription-engine 認得 mock，也照樣擋掉不認得的名稱', (ctx) => {
    const { scriptPath } = setup(ctx, '字');
    expect(typeof createEngine('mock', () => '1', { scriptPath }).transcribe).toBe('function');
    expect(() => createEngine('nope')).toThrow(/whisper-cpp、mock/);
  });

  test('模擬結果交給字幕校正：對齊稿件、發音替換還原成原字', (ctx) => {
    const raw = '台積電→台基電\n===\n標題\n===\n今天台積電上漲，外資買超。';
    const { dir, scriptPath } = setup(ctx, raw);
    const subs = createMockEngine({ execute: () => '4', scriptPath }).transcribe('a.wav', dir);
    const result = correctSubtitles({ scriptRaw: raw, subs, heygenDurationSec: 4 });
    expect(result.problems).toEqual([]);
    expect(result.subs.segments.map((s) => s.text).join('')).toContain('台積電');
  });
});
