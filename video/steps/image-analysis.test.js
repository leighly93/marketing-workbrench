'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { startImageAnalysis, reuseAppImages, screenshotsIn } = require('./image-analysis');

function project(ctx, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-analysis-'));
  ctx.onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'public'));
  fs.mkdirSync(path.join(dir, 'src'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'public', name), content);
  return dir;
}
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

describe('screenshotsIn', () => {
  test('檔名不限，排除套版素材與非圖片', (ctx) => {
    const dir = project(ctx, { 'IMG_0001.JPG': '', 'shot1.png': '', 'dapan-intro-frame.jpg': '', 'frame.png': '', 'heygen.mp4': '' });
    expect(screenshotsIn(path.join(dir, 'public')).sort()).toEqual(['IMG_0001.JPG', 'shot1.png']);
  });
});

describe('reuseAppImages（重新出片沿用上一支的 OCR 結果）', () => {
  const cache = (sources) => JSON.stringify({ from: 'job-1', sources, images: [{ file: 'a.png', page: 'revenue' }] });

  test('每一張都對得上（檔名集合與 md5）才沿用', (ctx) => {
    const dir = project(ctx, { 'a.png': 'A', 'app-images.reuse.json': cache({ 'a.png': md5('A') }) });
    const out = path.join(dir, 'src', 'app-images.generated.json');
    expect(reuseAppImages(['a.png'], { publicDir: path.join(dir, 'public'), outputFile: out, log: () => {} })).toBe(true);
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).images[0].page).toBe('revenue');
  });

  test('換過內容、少一張或多一張都不沿用；沒有沿用檔也不沿用', (ctx) => {
    const dir = project(ctx, { 'a.png': '換過', 'b.png': 'B', 'app-images.reuse.json': cache({ 'a.png': md5('A') }) });
    const o = { publicDir: path.join(dir, 'public'), outputFile: path.join(dir, 'out.json'), log: () => {} };
    expect(reuseAppImages(['a.png'], o)).toBe(false);
    expect(reuseAppImages(['a.png', 'b.png'], o)).toBe(false);
    expect(reuseAppImages(['a.png'], { ...o, publicDir: path.join(dir, 'src') })).toBe(false);
  });
});

describe('startImageAnalysis', () => {
  test('沒有截圖就不跑；有截圖就在背景跑 analyze:app-images', (ctx) => {
    const calls = [];
    const runBackground = (cmd) => { calls.push(cmd); return Promise.resolve({ ok: true }); };
    expect(startImageAnalysis({ projectDir: project(ctx), runBackground, log: () => {} })).toBeNull();
    expect(startImageAnalysis({ projectDir: project(ctx, { 'shot1.png': 'x' }), runBackground, log: () => {} })).toBeInstanceOf(Promise);
    expect(calls).toEqual(['npm run analyze:app-images']);
  });
});
