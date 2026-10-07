// @ts-check
'use strict';

/**
 * 模擬模式的占位影音（ffmpeg 產生）：取代 MiniMax 配音與 HeyGen 講者影片。
 *
 * 長度照稿件字數估（中文約每秒 5 字），之後的加速、轉錄、字幕對齊、渲染都吃這份真的影音，
 * 所以整條產線除了「內容是假的」以外跟正式出片走同一條路。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 中文旁白語速：每秒約幾個字（MiniMax fluent 實測 588 字符約 56 秒，取整數）。 */
const CHARS_PER_SECOND = 5;
const MIN_SECONDS = 2;

/** 依字數估旁白長度（秒）；空白不算字。 @param {string} text */
function estimateSpeechSeconds(text) {
  const chars = String(text || '').replace(/\s+/g, '').length;
  return Math.max(MIN_SECONDS, Math.round((chars / CHARS_PER_SECOND) * 100) / 100);
}

/** HeyGen aspect_ratio → 占位影片尺寸（偶數寬高，libx264 需要）。 @param {string} [aspectRatio] */
function frameSize(aspectRatio = '9:16') {
  return aspectRatio === '16:9' ? { width: 1280, height: 720 } : { width: 720, height: 1280 };
}

/**
 * @param {{
 *   exec?: (cmd: string, args: string[], options?: object) => string | Buffer,
 *   tmpDir?: () => string,
 * }} [deps]
 */
function createPlaceholderMedia({
  exec = require('node:child_process').execFileSync,
  tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-mock-')),
} = {}) {
  /** @param {string[]} args */
  const ffmpeg = (args) => exec('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'ignore' });

  /** 低音量正弦波 mp3（聽得出是假的）。 @param {string} file @param {number} seconds */
  function tone(file, seconds) {
    ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${seconds}`,
      '-af', 'volume=0.05', '-c:a', 'libmp3lame', '-q:a', '6', file]);
  }

  /** 同上，回傳 Buffer（取代 MiniMax 回傳的音檔）。 @param {number} seconds */
  function toneBuffer(seconds) {
    const dir = tmpDir();
    try {
      const file = path.join(dir, 'tone.mp3');
      tone(file, seconds);
      return fs.readFileSync(file);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  /**
   * 單色畫面＋聲音的 mp4。有 audio 就用它（音訊驅動），沒有就用 seconds 長度的正弦波（文字驅動）。
   * @param {string} file
   * @param {{ seconds?: number, audio?: string, aspectRatio?: string }} options
   */
  function video(file, { seconds = MIN_SECONDS, audio, aspectRatio } = {}) {
    const { width, height } = frameSize(aspectRatio);
    const sound = audio
      ? ['-i', audio]
      : ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${seconds}`];
    // 有音檔就量它的長度、明確指定 -t：-shortest 遇到編碼器緩衝會多出一兩秒（實測 2.5 秒音檔出 3.8 秒影片）
    const length = ['-t', String(audio ? durationOf(audio) : seconds)];
    ffmpeg(['-f', 'lavfi', '-i', `color=c=0x1f3a5f:s=${width}x${height}:r=30`, ...sound, ...length,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '44100', file]);
  }

  /** 影音長度（秒）。 @param {string} file */
  function durationOf(file) {
    const out = exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf-8' });
    const seconds = Number(String(out).trim());
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`讀不到長度：${file}`);
    return seconds;
  }

  return { tone, toneBuffer, video, durationOf };
}

module.exports = { createPlaceholderMedia, estimateSpeechSeconds, frameSize, CHARS_PER_SECOND };
