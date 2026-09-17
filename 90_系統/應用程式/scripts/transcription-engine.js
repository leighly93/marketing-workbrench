'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// 所有字幕供應者都須輸出秒制 segments / words；校正與版型不依賴供應者。
function validate(result) {
  if (!result || !Array.isArray(result.segments)) throw new Error('字幕供應者未回傳 segments');
  for (const segment of result.segments) {
    if (typeof segment.text !== 'string' || !Array.isArray(segment.words)) throw new Error('字幕缺少文字或逐字時間');
    for (const item of [segment, ...segment.words]) {
      if (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end < item.start) throw new Error('字幕時間格式錯誤');
    }
    if (segment.words.some((word) => typeof word.word !== 'string')) throw new Error('字幕逐字文字格式錯誤');
  }
  return result;
}

function cppConfig(env = process.env, root = path.resolve(__dirname, '../../..')) {
  return {
    binary: env.WHISPER_CPP_BIN || path.join(root, '.cache/whisper-cpp/source/build/bin/whisper-cli'),
    model: path.resolve(root, env.WHISPER_CPP_MODEL || '.cache/whisper-cpp/ggml-base-q5_1.bin'),
  };
}

function normalizeCpp(raw) {
  if (!Array.isArray(raw?.transcription)) throw new Error('whisper.cpp 缺少 transcription');
  const segments = raw.transcription.map((segment, id) => {
    if (!Array.isArray(segment.tokens)) throw new Error('whisper.cpp 缺少 token 時間，需 --output-json-full');
    // 特殊 token 一律不當成字：whisper.cpp 除了 [_BEG_]／[_EOT_] 這種前後都有底線的，
    // 還會吐時間戳 token [_TT_305] 與語言 token [_LANG_zh]（結尾是數字／語言碼，沒有底線）。
    // 原本的 /^\[_.*_\]$/ 漏掉後兩種，它們就帶著 start === end 的零長度時間混進 words，
    // 而且 [_TT_n] 的 offsets 剛好是 segment 結尾 → correct-subtitles.js 的全域對齊
    // 在 whisper 聽錯整句時（0911「月線失而復得」被聽成「越限適合負責」，同代價路徑）
    // 會把整串正確字元判給那顆零長度 token：字幕只剩 1 frame 一閃而過，
    // 配圖的 _scriptCharTimes 也變成零長度 → dapan-timeline.js 直接丟掉那張圖。
    // 所以改成只要是 [_...] 包起來的 token 就濾掉（真人講話不會產生這種字）。
    const words = segment.tokens.filter((token) => typeof token.text === 'string' && !/^\[_.*\]$/.test(token.text) && token.text.trim()).map((token) => ({
      word: token.text, start: token.offsets?.from / 1000, end: token.offsets?.to / 1000,
      probability: token.p,
    }));
    if (segment.text?.trim() && !words.length) throw new Error('非空字幕缺少 token 時間');
    return { id, text: segment.text, start: segment.offsets?.from / 1000, end: segment.offsets?.to / 1000, words };
  });
  return validate({ language: raw.result?.language || 'zh', text: segments.map((s) => s.text).join(''), segments });
}

/**
 * 把時間戳整體往前移 padSec 秒（負值 clamp 成 0）。
 *
 * 給「音檔前面墊了靜音再轉」用：墊靜音會讓 whisper 的 30 秒 window 邊界落在不同位置，
 * 藉此避開它在某些切點上的解碼失敗（2026-09-16 實測：某支 46.8 秒的音檔，whisper 把
 * 24.72 秒那句的結束時間誤報成 36.56 秒，之後整條時間軸落後 8 秒、結尾 49 個字全擠在
 * 最後 0.19 秒；同一個音檔重跑三次結果完全相同 —— whisper.cpp 在這裡是確定性的，
 * 原樣重跑一定再壞一次。改 beam-size／threads／max-len 都無效，墊 0.5 秒靜音一次就正常）。
 * 墊多少就得減回多少，不然字幕會整體慢 padSec 秒。
 */
function shiftTimes(result, padSec) {
  if (!padSec) return result;
  const back = (t) => Math.max(0, Number((t - padSec).toFixed(3)));
  for (const segment of result.segments) {
    segment.start = back(segment.start);
    segment.end = back(segment.end);
    for (const word of segment.words) {
      word.start = back(word.start);
      word.end = back(word.end);
    }
  }
  return validate(result);
}

function createEngine(name = 'whisper-cpp', execute = execFileSync, config = cppConfig()) {
  if (name !== 'whisper-cpp') throw new Error(`不支援的字幕引擎：${name}；可用：whisper-cpp`);
  return {
    ensure() {
      execute(config.binary, ['--help'], { stdio: 'ignore' });
      if (!fs.existsSync(config.model)) throw new Error('缺少 ggml-base-q5_1.bin；請執行 npm run setup:whisper');
    },
    /**
     * @param {object} [options]
     * @param {number} [options.padSec] 這個音檔前面墊了幾秒靜音；輸出時間戳會自動減回去。
     *   墊靜音本身由呼叫端做（transcribe.sh 抽音檔時就墊好），這裡只負責把時間軸還原。
     */
    transcribe(audio, outputDir, options = {}) {
      this.ensure();
      const padSec = Number(options.padSec) || 0;
      if (padSec < 0) throw new Error('padSec 不能是負數');
      fs.mkdirSync(outputDir, { recursive: true });
      // 每次使用獨立目錄，CLI 失敗或漏寫輸出時不能讀到上次結果。
      const scratch = fs.mkdtempSync(path.join(outputDir, '.whisper-cpp-'));
      try {
        const prefix = path.join(scratch, 'transcription');
        execute(config.binary, ['--model', config.model, '--file', audio, '--language', 'zh', '--threads', '4', '--processors', '1', '--no-gpu', '--output-json-full', '--output-file', prefix], { stdio: 'inherit' });
        const result = shiftTimes(normalizeCpp(JSON.parse(fs.readFileSync(prefix + '.json', 'utf8'))), padSec);
        const temp = path.join(scratch, 'normalized.json');
        fs.writeFileSync(temp, JSON.stringify(result, null, 2));
        fs.renameSync(temp, path.join(outputDir, path.parse(audio).name + '.json'));
        return result;
      } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
    },
  };
}

if (require.main === module) {
  try {
    require('dotenv').config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
    const engine = createEngine(process.env.TRANSCRIPTION_ENGINE || 'whisper-cpp');
    if (process.argv[2] === '--check') engine.ensure();
    else {
      const args = process.argv.slice(2);
      const padArg = args.find((a) => a.startsWith('--pad='));
      const [audio, outputDir] = args.filter((a) => !a.startsWith('--'));
      if (!audio || !outputDir) throw new Error('需要音檔與輸出目錄');
      engine.transcribe(audio, outputDir, { padSec: padArg ? Number(padArg.slice(6)) : 0 });
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { createEngine, validate, normalizeCpp, cppConfig, shiftTimes };
