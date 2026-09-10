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
    const words = segment.tokens.filter((token) => typeof token.text === 'string' && !/^\[_.*_\]$/.test(token.text) && token.text.trim()).map((token) => ({
      word: token.text, start: token.offsets?.from / 1000, end: token.offsets?.to / 1000,
      probability: token.p,
    }));
    if (segment.text?.trim() && !words.length) throw new Error('非空字幕缺少 token 時間');
    return { id, text: segment.text, start: segment.offsets?.from / 1000, end: segment.offsets?.to / 1000, words };
  });
  return validate({ language: raw.result?.language || 'zh', text: segments.map((s) => s.text).join(''), segments });
}

function createEngine(name = 'whisper-cpp', execute = execFileSync, config = cppConfig()) {
  if (name !== 'whisper-cpp') throw new Error(`不支援的字幕引擎：${name}；可用：whisper-cpp`);
  return {
    ensure() {
      execute(config.binary, ['--help'], { stdio: 'ignore' });
      if (!fs.existsSync(config.model)) throw new Error('缺少 ggml-base-q5_1.bin；請執行 npm run setup:whisper');
    },
    transcribe(audio, outputDir) {
      this.ensure();
      fs.mkdirSync(outputDir, { recursive: true });
      // 每次使用獨立目錄，CLI 失敗或漏寫輸出時不能讀到上次結果。
      const scratch = fs.mkdtempSync(path.join(outputDir, '.whisper-cpp-'));
      try {
        const prefix = path.join(scratch, 'transcription');
        execute(config.binary, ['--model', config.model, '--file', audio, '--language', 'zh', '--threads', '4', '--processors', '1', '--no-gpu', '--output-json-full', '--output-file', prefix], { stdio: 'inherit' });
        const result = normalizeCpp(JSON.parse(fs.readFileSync(prefix + '.json', 'utf8')));
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
      const [audio, outputDir] = process.argv.slice(2);
      if (!audio || !outputDir) throw new Error('需要音檔與輸出目錄');
      engine.transcribe(audio, outputDir);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { createEngine, validate, normalizeCpp, cppConfig };
