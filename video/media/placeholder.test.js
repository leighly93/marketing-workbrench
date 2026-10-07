'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createPlaceholderMedia, estimateSpeechSeconds, frameSize } = require('./placeholder');

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch (_) { return false; } })();

describe('estimateSpeechSeconds', () => {
  test('每秒 5 字、空白不算、至少 2 秒', () => {
    expect(estimateSpeechSeconds('一二三四五六七八九十')).toBe(2);
    expect(estimateSpeechSeconds('字'.repeat(53))).toBe(10.6);
    expect(estimateSpeechSeconds('  字 字  '.repeat(20))).toBe(8);
    expect(estimateSpeechSeconds('')).toBe(2);
  });
});

describe('frameSize', () => {
  test('直式預設，16:9 給橫式', () => {
    expect(frameSize()).toEqual({ width: 720, height: 1280 });
    expect(frameSize('16:9')).toEqual({ width: 1280, height: 720 });
  });
});

describe('createPlaceholderMedia（假 exec）', () => {
  function recorder(out = '') {
    const calls = [];
    return { calls, exec: (cmd, args) => { calls.push([cmd, args]); return out; } };
  }

  test('有音檔就用它並以音檔長度為準；沒有就用指定秒數的正弦波', () => {
    const { calls: all, exec } = recorder('3.5\n');
    const media = createPlaceholderMedia({ exec });
    media.video('/o/a.mp4', { audio: '/i/a.mp3', aspectRatio: '16:9' });
    media.video('/o/b.mp4', { seconds: 7 });
    expect(all.filter((c) => c[0] === 'ffprobe').map((c) => c[1].at(-1))).toEqual(['/i/a.mp3']);
    const calls = all.filter((c) => c[0] === 'ffmpeg');
    const [a, b] = calls.map((c) => c[1].join(' '));
    expect(a).toMatch(/s=1280x720/);
    expect(a).toMatch(/-i \/i\/a\.mp3 -t 3\.5/);
    expect(b).toMatch(/s=720x1280/);
    expect(b).toMatch(/sine=.*duration=7 -t 7/);
    expect(calls.every((c) => c[0] === 'ffmpeg' && c[1].at(-1).endsWith('.mp4'))).toBe(true);
  });

  test('toneBuffer 讀回產生的檔並清掉暫存', (ctx) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'placeholder-'));
    ctx.onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
    const exec = (_cmd, args) => fs.writeFileSync(args.at(-1), 'mp3');
    const media = createPlaceholderMedia({ exec, tmpDir: () => fs.mkdtempSync(path.join(dir, 't-')) });
    expect(media.toneBuffer(3).toString()).toBe('mp3');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test('durationOf 解析 ffprobe；讀不到就丟錯', () => {
    expect(createPlaceholderMedia({ exec: () => '12.34\n' }).durationOf('x')).toBe(12.34);
    expect(() => createPlaceholderMedia({ exec: () => 'N/A' }).durationOf('x')).toThrow(/讀不到長度/);
  });
});

describe.skipIf(!hasFfmpeg)('createPlaceholderMedia（真的 ffmpeg）', () => {
  test('產生的音檔與影片長度符合要求', (ctx) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'placeholder-real-'));
    ctx.onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
    const media = createPlaceholderMedia();
    const mp3 = path.join(dir, 'a.mp3');
    fs.writeFileSync(mp3, media.toneBuffer(2.5));
    expect(media.durationOf(mp3)).toBeCloseTo(2.5, 0);
    const mp4 = path.join(dir, 'a.mp4');
    media.video(mp4, { audio: mp3 });
    expect(media.durationOf(mp4)).toBeCloseTo(2.5, 0);
  });
});
