'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createEngine, validate } = require('../應用程式/scripts/transcription-engine');

test('字幕 Adapter 保留 CLI 參數、秒制逐字資料與供應者原始檔案', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcription-contract-'));
  try {
    const result = { segments: [{ start: 0, end: 1, text: '測試', words: [{ start: 0, end: 1, word: '測試' }] }] };
    const raw = JSON.stringify(result);
    const calls = [];
    const engine = createEngine('whisper', (command, args) => {
      calls.push([command, args]);
      if (args[0] !== '--help') fs.writeFileSync(path.join(dir, 'input.json'), raw);
    });
    engine.ensure();
    assert.deepEqual(engine.transcribe('/synthetic/input.wav', dir), result);
    assert.deepEqual(calls[1], ['whisper', ['/synthetic/input.wav', '--language', 'zh', '--model', 'small', '--word_timestamps', 'True', '--output_format', 'json', '--output_dir', dir, '--verbose', 'False']]);
    assert.equal(fs.readFileSync(path.join(dir, 'input.json'), 'utf8'), raw);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('字幕 Adapter 拒絕未知供應者、不完整輸出與非法時間，傳遞工具失敗', () => {
  assert.throws(() => createEngine('other'), /不支援/);
  assert.throws(() => validate({}), /segments/);
  assert.throws(() => validate({ segments: [{ text: 'x' }] }), /逐字/);
  assert.throws(() => validate({ segments: [{ text: 'x', start: 2, end: 1, words: [] }] }), /時間/);
  const engine = createEngine('whisper', () => { throw new Error('tool failed'); });
  assert.throws(() => engine.transcribe('/unused.wav', '/unused'), /tool failed/);
});

test('OCR 編號 Adapter 封裝 Tesseract 白名單並保留 Vision 路徑', () => {
  const calls = [];
  const fixture = 'header\n5\t1\t1\t1\t1\t1\t0\t24\t8\t12\t95\t 2\n';
  const module = { exports: {} };
  const script = path.resolve(__dirname, '../應用程式/scripts/ocr-engine.js');
  vm.runInNewContext(fs.readFileSync(script, 'utf8'), {
    module, __dirname: path.dirname(script), process: { env: {}, pid: 123 },
    require(name) {
      if (name === 'fs') return { readFileSync: () => fixture, unlinkSync: () => {} };
      if (name === 'child_process') return { execFileSync: (...args) => calls.push(args) };
      if (name === 'dotenv') return { config() {} };
      if (name === '../../paths') return { workspaceRoot: () => '/synthetic' };
      return require(name);
    },
  });
  const api = module.exports;
  assert.deepEqual(JSON.parse(JSON.stringify(api.ocrDigits('/synthetic/crop.png'))), [{ t: '2', y: 24, h: 12 }]);
  assert.equal(calls[0][0], 'tesseract');
  assert.deepEqual(Array.from(calls[0][1]).slice(2), ['--psm', '10', '-c', 'tessedit_char_whitelist=1234', 'tsv']);
  api.ENGINES.vision.ocrPage = (image, opts) => {
    assert.equal(image, '/synthetic/crop.png');
    assert.equal(opts.minConf, null);
    return { words: [{ t: '2', y: 24, h: 12 }] };
  };
  assert.equal(api.ENGINES.vision.ocrDigits('/synthetic/crop.png')[0].t, '2');
});
