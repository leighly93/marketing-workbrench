'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createSandbox, isCopied } = require('./sandbox');

describe('isCopied', () => {
  test('帶程式與字型，不帶產線產物、編譯物與套件', () => {
    expect(isCopied('video/run.js')).toBe(true);
    expect(isCopied('video/remotion/src/Root.tsx')).toBe(true);
    expect(isCopied('video/remotion/public/NotoSansTC-VF.ttf')).toBe(true);
    expect(isCopied('video/remotion/public/heygen.mp4')).toBe(false);
    expect(isCopied('video/remotion/src/subtitles.json')).toBe(false);
    expect(isCopied('video/remotion/src/MiddayFocus/midday-shots.generated.json')).toBe(false);
    expect(isCopied('video/shots/ocr-vision')).toBe(false);
    expect(isCopied('app/node_modules/x.js')).toBe(false);
  });
});

describe('createSandbox', () => {
  test('建好可執行的隔離工作區，清掉時不會刪到原本的 node_modules', () => {
    const sb = createSandbox({ env: { WORKBENCH_MOCK: '1' } });
    try {
      expect(fs.readFileSync(sb.path('.env'), 'utf8')).toBe('WORKBENCH_MOCK=1\n');
      expect(fs.existsSync(sb.path('video', 'run.js'))).toBe(true);
      expect(fs.existsSync(sb.path('storage', 'jobs'))).toBe(true);
      expect(fs.existsSync(sb.path('video', 'remotion', 'src', 'subtitles.json'))).toBe(true); // init 補的空結構
      expect(fs.existsSync(sb.path('node_modules', 'vitest'))).toBe(true);
    } finally { sb.cleanup(); }
    expect(fs.existsSync(sb.dir)).toBe(false);
    expect(fs.existsSync(path.join(__dirname, '..', 'node_modules', 'vitest'))).toBe(true);
    expect(fs.existsSync(path.join(__dirname, '..', 'storage', 'shared-assets'))).toBe(true);
  });
});
