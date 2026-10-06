'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { copyTemplateAssets } = require('./assets');

const template = { assets: { dir: 'demo', files: { 'bgm.wav': 'demo-bgm.wav', 'frame.png': 'demo-frame.png' } } };

function sandbox(ctx) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-'));
  ctx.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  return { assetsRoot: path.join(root, 'shared-assets'), publicDir: path.join(root, 'public') };
}
const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };

describe('copyTemplateAssets', () => {
  test('依對照表複製並改成版型前綴的檔名，內容逐位元相同', (ctx) => {
    const dirs = sandbox(ctx);
    put(path.join(dirs.assetsRoot, 'demo/bgm.wav'), Buffer.from([0, 1, 2, 255]));
    put(path.join(dirs.assetsRoot, 'demo/frame.png'), 'frame');
    const { copied, empty } = copyTemplateAssets(template, dirs);
    expect(copied.map((c) => c.to)).toEqual(['demo-bgm.wav', 'demo-frame.png']);
    expect(empty).toEqual([]);
    expect(fs.readFileSync(path.join(dirs.publicDir, 'demo-bgm.wav'))).toEqual(Buffer.from([0, 1, 2, 255]));
  });

  test('缺任何一個來源檔就整批不複製，避免留下半套素材', (ctx) => {
    const dirs = sandbox(ctx);
    put(path.join(dirs.assetsRoot, 'demo/bgm.wav'), 'bgm');
    expect(() => copyTemplateAssets(template, dirs)).toThrow(/缺少檔案：frame\.png/);
    expect(fs.existsSync(path.join(dirs.publicDir, 'demo-bgm.wav'))).toBe(false);
  });

  test('來源資料夾不存在要講清楚', (ctx) => {
    expect(() => copyTemplateAssets(template, sandbox(ctx))).toThrow(/找不到資料夾/);
  });

  test('0 byte 的檔照樣複製但回報', (ctx) => {
    const dirs = sandbox(ctx);
    put(path.join(dirs.assetsRoot, 'demo/bgm.wav'), '');
    put(path.join(dirs.assetsRoot, 'demo/frame.png'), 'frame');
    expect(copyTemplateAssets(template, dirs).empty).toEqual(['bgm.wav']);
  });
});
