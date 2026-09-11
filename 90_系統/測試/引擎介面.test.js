'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createEngine, validate } = require('../應用程式/scripts/transcription-engine');

const { normalizeCpp } = require('../應用程式/scripts/transcription-engine');
// [_TT_n]（時間戳）與 [_LANG_zh]（語言）結尾沒有底線，而且 offsets 就是 segment 邊界：
// 一旦漏濾，它們會變成零長度的 word，字幕與配圖的強制對齊可能整串字落在上面（只閃 1 frame）。
const rawCpp = { result: { language: 'zh' }, transcription: [{ text: '測試', offsets: { from: 100, to: 1100 }, tokens: [
  { text: '[_BEG_]', id: 50364 },
  { text: '[_LANG_zh]', id: 50260, offsets: { from: 100, to: 100 } },
  { text: '測試', offsets: { from: 100, to: 1100 }, p: 0.9 },
  { text: '[_TT_110]', id: 50474, offsets: { from: 1100, to: 1100 } },
  { text: '[_EOT_]', id: 50257 },
] }] };

test('whisper.cpp 使用 CPU／4 threads／中文，毫秒轉秒並濾除特殊 token', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-contract-'));
  try {
    const model = path.join(dir, 'ggml-base-q5_1.bin');
    fs.writeFileSync(model, 'synthetic-model');
    const calls = [];
    const engine = createEngine('whisper-cpp', (cmd, args) => {
      calls.push([cmd, args]);
      if (args.includes('--output-file')) fs.writeFileSync(args[args.indexOf('--output-file') + 1] + '.json', JSON.stringify(rawCpp));
    }, { binary: 'whisper-cli', model });
    const result = engine.transcribe('/synthetic/input.wav', dir);
    assert.equal(result.segments[0].words.length, 1);
    assert.equal(result.segments[0].words[0].start, 0.1);
    assert.equal(result.segments[0].words[0].end, 1.1);
    assert.equal(result.segments[0].words[0].word, '測試');
    assert.deepEqual(calls[1][1].slice(0, 11), ['--model', model, '--file', '/synthetic/input.wav', '--language', 'zh', '--threads', '4', '--processors', '1', '--no-gpu']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'input.json'))), result);
    fs.writeFileSync(path.join(dir, 'input.json'), 'old-output');
    const failed = createEngine('whisper-cpp', () => {}, { binary: 'whisper-cli', model });
    assert.throws(() => failed.transcribe('/synthetic/input.wav', dir), /ENOENT/);
    assert.equal(fs.readFileSync(path.join(dir, 'input.json'), 'utf8'), 'old-output');
    assert.equal(fs.readdirSync(dir).some((name) => name.startsWith('.whisper-cpp-')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('字幕 Adapter 不回退舊引擎，缺時間或無效時間即失敗', () => {
  assert.throws(() => createEngine('whisper'), /不支援/);
  assert.throws(() => validate({}), /segments/);
  assert.throws(() => normalizeCpp({ transcription: [{ text: 'x', tokens: [] }] }), /缺少/);
  assert.throws(() => normalizeCpp({ transcription: [{ text: 'x', offsets: { from: 0, to: 100 }, tokens: [{ text: 'x' }] }] }), /時間/);
  assert.throws(() => validate({ segments: [{ text: 'x', start: 2, end: 1, words: [] }] }), /時間/);
});

test('本機與容器 Node 版本一致', () => {
  const root = path.resolve(__dirname, '../..');
  const version = fs.readFileSync(path.join(root, '.node-version'), 'utf8').trim();
  assert.equal(fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim(), version);
  assert.ok(fs.readFileSync(path.join(root, '90_系統/環境/Dockerfile'), 'utf8').includes('FROM node:' + version + '-'));
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
