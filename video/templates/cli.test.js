'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assetsCommand, parseCommand, renderCommand, main } = require('./cli');

/** 假的 repository：<tmp>/video/remotion 是 Remotion 專案，<tmp>/storage 是資料。 */
function workspace(ctx) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'templates-cli-'));
  ctx.onTestFinished(() => fs.rmSync(repo, { recursive: true, force: true }));
  const root = path.join(repo, 'video', 'remotion');
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  return { repo, root };
}
const silent = () => {};

describe('templates cli', () => {
  test('parse：寫配圖計畫，video-meta 只更新日期與標題、保留其他欄位', (ctx) => {
    const { root } = workspace(ctx);
    fs.writeFileSync(path.join(root, 'public/script.txt'), '===\n今日標題\n===\n(shot:圖)大盤上漲(shot:圖)');
    fs.writeFileSync(path.join(root, 'public/圖.jpg'), '');
    fs.writeFileSync(path.join(root, 'src/video-meta.json'), JSON.stringify({ heygenDurationSec: 12 }));
    parseCommand({ template: 'midday', root, now: new Date('2026-10-06T17:00:00Z'), log: silent });
    const plan = JSON.parse(fs.readFileSync(path.join(root, 'src/MiddayFocus/midday-shots.generated.json'), 'utf8'));
    expect(plan).toMatchObject([{ src: '圖.jpg', _phrase: '大盤上漲' }]);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'src/video-meta.json'), 'utf8')))
      .toEqual({ heygenDurationSec: 12, headerDate: '1007', titleText: '今日標題' });
  });

  test('parse：沒有 script.txt 要報錯', (ctx) => {
    const { root } = workspace(ctx);
    expect(() => parseCommand({ template: 'dapan', root, log: silent })).toThrow(/找不到 .*script\.txt/);
  });

  test('assets：從 storage/shared-assets 複製到 Remotion public/', (ctx) => {
    const { repo, root } = workspace(ctx);
    for (const name of ['intro-frame.jpg', 'header-overlay.png', 'bgm.wav']) {
      const file = path.join(repo, 'storage/shared-assets/usstock', name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, name);
    }
    assetsCommand({ template: 'usstock', root, log: silent });
    expect(fs.readFileSync(path.join(root, 'public/usstock-bgm.wav'), 'utf8')).toBe('bgm.wav');
  });

  test('render：每個輸出各渲染一次，從 repository 根執行並指定設定檔', (ctx) => {
    const { repo, root } = workspace(ctx);
    const calls = [];
    const exec = (cmd, args, opts) => { calls.push({ cmd, args, opts }); };
    const files = renderCommand({ template: 'dapan', root, exec, log: silent });
    expect(calls.map((c) => c.args[2])).toEqual(['DapanXiaobao', 'DapanXiaobaoLandscape']);
    expect(files).toEqual([
      path.join(repo, 'storage/tmp/pipeline-output/output-dapan.mp4'),
      path.join(repo, 'storage/tmp/pipeline-output/output-dapan-landscape.mp4'),
    ]);
    expect(calls[0].opts.cwd).toBe(repo);
    expect(calls[0].args).toContain(`--config=${path.join(root, 'remotion.config.ts')}`);
  });

  test('main：不認得的指令或版型要擋下來', () => {
    expect(() => main(['oops'])).toThrow(/用法/);
    expect(() => main(['render', '--template=institution'])).toThrow(/不認得的版型/);
  });
});
