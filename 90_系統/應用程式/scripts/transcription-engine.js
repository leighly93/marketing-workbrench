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

function createEngine(name = 'whisper', execute = execFileSync) {
  const providers = {
    whisper: {
      ensure() { execute('whisper', ['--help'], { stdio: 'ignore' }); },
      transcribe(audio, outputDir) {
        // 保留原產線的 small / zh / word_timestamps 及 CLI 預設裝置行為。
        execute('whisper', [audio, '--language', 'zh', '--model', 'small', '--word_timestamps', 'True', '--output_format', 'json', '--output_dir', outputDir, '--verbose', 'False'], { stdio: 'inherit' });
        return validate(JSON.parse(fs.readFileSync(path.join(outputDir, path.parse(audio).name + '.json'), 'utf8')));
      },
    },
  };
  if (!Object.hasOwn(providers, name)) throw new Error(`不支援的字幕引擎：${name}；可用：whisper`);
  return providers[name];
}

if (require.main === module) {
  try {
    require('dotenv').config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
    const engine = createEngine(process.env.TRANSCRIPTION_ENGINE || 'whisper');
    if (process.argv[2] === '--check') engine.ensure();
    else {
      const [audio, outputDir] = process.argv.slice(2);
      if (!audio || !outputDir) throw new Error('需要音檔與輸出目錄');
      engine.transcribe(audio, outputDir);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { createEngine, validate };
