// @ts-check
'use strict';

/**
 * 模擬字幕轉錄（WORKBENCH_MOCK=1）：不跑 whisper，把「配音實際念的文字」（稿件清洗＋發音替換，
 * 跟送 TTS 的那份相同）照字數平均攤在音檔長度上，輸出格式與 whisper-cpp Adapter 一致。
 *
 * 之後的 correct-subtitles（對齊稿件、還原發音替換、時間軸檢查）照常跑在這份結果上，
 * 所以字幕校正與配圖計時的程式碼路徑跟正式出片相同，只是時間是估的。
 */
const fs = require('node:fs');
const path = require('node:path');
const { ttsText } = require('../pipeline/tts-text');

/** 句讀：切 segment 的位置（標點歸前一句）。 */
const BREAK = /[。！？；，、,!?;]/;
/** 英數連續字串當一個詞（股票代號、英文縮寫），其餘一字一詞。 */
const TOKEN = /[A-Za-z0-9.%]+|\S/g;

/** @param {string} text */
function tokenize(text) {
  /** @type {string[]} */
  const tokens = [];
  for (const t of String(text).match(TOKEN) || []) {
    // 標點不自成一詞（零長度的字會讓對齊把字判給它），黏在前一個詞後面
    if (BREAK.test(t) && tokens.length) tokens[tokens.length - 1] += t;
    else tokens.push(t);
  }
  return tokens;
}

/** @param {string} token */
const weightOf = (token) => token.replace(new RegExp(BREAK.source, 'g'), '').length || 1;

/**
 * 稿件文字 → whisper 格式的 segments（秒）。
 * @param {string} text 配音念的文字
 * @param {number} durationSec 音檔長度
 * @returns {{ language: string, text: string, segments: { id: number, text: string, start: number, end: number, words: { word: string, start: number, end: number, probability: number }[] }[] }}
 */
function scriptTranscript(text, durationSec) {
  if (!(durationSec > 0)) throw new Error('音檔長度要大於 0');
  const tokens = tokenize(text);
  const total = tokens.reduce((n, t) => n + weightOf(t), 0) || 1;
  const perUnit = durationSec / total;
  const round = (/** @type {number} */ t) => Number(t.toFixed(3));

  /** @type {ReturnType<typeof scriptTranscript>['segments']} */
  const segments = [];
  /** @type {{ word: string, start: number, end: number, probability: number }[]} */
  let words = [];
  let clock = 0;
  const flush = () => {
    if (!words.length) return;
    segments.push({ id: segments.length, text: words.map((w) => w.word).join(''), start: words[0].start, end: words[words.length - 1].end, words });
    words = [];
  };
  for (const token of tokens) {
    const start = clock;
    clock += weightOf(token) * perUnit;
    words.push({ word: token, start: round(start), end: round(clock), probability: 1 });
    if (BREAK.test(token.slice(-1))) flush();
  }
  flush();
  return { language: 'zh', text: segments.map((s) => s.text).join(''), segments };
}

/**
 * @param {{
 *   execute: (cmd: string, args: string[], options?: object) => string | Buffer,
 *   scriptPath: string,
 * }} deps
 */
function createMockEngine({ execute, scriptPath }) {
  return {
    ensure() {
      if (!fs.existsSync(scriptPath)) throw new Error(`模擬轉錄要讀稿件，但找不到 ${scriptPath}`);
    },
    /**
     * @param {string} audio
     * @param {string} outputDir
     * @param {{ padSec?: number }} [options] 前面墊的靜音秒數：模擬時直接從長度扣掉
     */
    transcribe(audio, outputDir, options = {}) {
      this.ensure();
      const padSec = Number(options.padSec) || 0;
      if (padSec < 0) throw new Error('padSec 不能是負數');
      const out = execute('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audio], { encoding: 'utf-8' });
      const duration = Number(String(out).trim()) - padSec;
      const result = scriptTranscript(ttsText(fs.readFileSync(scriptPath, 'utf8')), duration);
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, path.parse(audio).name + '.json'), JSON.stringify(result, null, 2));
      return result;
    },
  };
}

module.exports = { createMockEngine, scriptTranscript, tokenize };
