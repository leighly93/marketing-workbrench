'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main, CliError } = require('./auto-shot');

/** 假的 repository：<tmp>/video/remotion 是 Remotion 專案。 */
function workspace(ctx, { images } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-shot-'));
  ctx.onTestFinished(() => fs.rmSync(repo, { recursive: true, force: true }));
  const root = path.join(repo, 'video', 'remotion');
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public', 'script.txt'), '\n===\n標題\n===\n健鼎營收創新高，月增兩成。');
  if (images) fs.writeFileSync(path.join(root, 'src', 'app-images.generated.json'), JSON.stringify({ images }));
  return root;
}

describe('auto-shot CLI', () => {
  test('--sentences 不需要圖片分析（舊版在沒有分析檔或分析檔是空的時候會失敗）', (ctx) => {
    for (const images of [undefined, []]) {
      const root = workspace(ctx, { images });
      const out = [];
      expect(main(['--sentences'], { root, log: (m) => out.push(m) })).toBe(0);
      const parsed = JSON.parse(out.join('\n'));
      expect(parsed.sentences.map((s) => s.text)).toEqual(['健鼎營收創新高，月增兩成。']);
      expect(parsed.chars.length).toBeGreaterThan(0);
    }
  });

  test('排計畫一定要有圖片分析', (ctx) => {
    expect(() => main([], { root: workspace(ctx), log: () => {} })).toThrow(CliError);
    expect(() => main([], { root: workspace(ctx, { images: [] }), log: () => {} })).toThrow(/裡沒有圖片/);
  });

  test('--write 沒給 --out 要擋下來（舊版會寫到已移除版型的資料夾）', (ctx) => {
    const root = workspace(ctx, { images: [{ file: 'a.png', words: [] }] });
    expect(() => main(['--write'], { root, log: () => {} })).toThrow(/--write 一定要給 --out/);
  });

  test('--write --out：沒有人工標注時寫出空計畫，並提醒整支都是講者', (ctx) => {
    const root = workspace(ctx, { images: [{ file: 'a.png', words: [] }] });
    const out = [];
    main(['--write', '--out', 'src/plan.json'], { root, log: (m) => out.push(m) });
    expect(JSON.parse(fs.readFileSync(path.join(root, 'src', 'plan.json'), 'utf8'))).toEqual([]);
    expect(out.join('\n')).toMatch(/整支都是講者/);
  });
});
