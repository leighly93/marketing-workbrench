'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { unitWorkbench } = require('../tests/unit-workbench');

const HEADERS = {
  png: Buffer.from('89504e470d0a1a0a', 'hex'),
  jpeg: Buffer.from('ffd8ffe0', 'hex'),
  webp: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]),
  heic: Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic')]),
  gif: Buffer.from('GIF89a'),
  bmp: Buffer.from('BM'),
  tiff: Buffer.from('49492a00', 'hex'),
};

describe('圖片格式', () => {
  test('sniffImageKind 看內容不看副檔名', (t) => {
    const wb = unitWorkbench(t);
    for (const [kind, head] of Object.entries(HEADERS)) {
      const file = path.join(wb.root, `x-${kind}.png`);
      fs.writeFileSync(file, Buffer.concat([head, Buffer.alloc(16)]));
      expect(wb.sniffImageKind(file)).toBe(kind);
    }
    fs.writeFileSync(path.join(wb.root, 'text.png'), 'hello world, not an image');
    expect(wb.sniffImageKind(path.join(wb.root, 'text.png'))).toBeNull();
    expect(wb.sniffImageKind(path.join(wb.root, '不存在.png'))).toBeNull();
  });

  test('ensureUsableImage：格式對就不動；認不出來擋下；轉不過來說清楚怎麼辦', (t) => {
    const calls = [];
    const wb = unitWorkbench(t, { childProcess: { execFileSync: (cmd) => { calls.push(cmd); throw new Error('沒裝'); } } });
    const file = (name, head) => { const f = path.join(wb.root, name); fs.writeFileSync(f, Buffer.concat([head, Buffer.alloc(16)])); return f; };
    expect(wb.ensureUsableImage(file('ok.png', HEADERS.png))).toBeNull();
    expect(wb.ensureUsableImage(path.join(wb.root, 'heygen.mp4'))).toBeNull();
    expect(wb.ensureUsableImage(file('bad.png', Buffer.from('nope')))).toEqual({ error: expect.stringMatching(/認不出格式/) });
    expect(wb.ensureUsableImage(file('webp.png', HEADERS.webp))).toEqual({ error: expect.stringMatching(/WebP.*轉存/) });
    expect(calls).toEqual(['sips', 'ffmpeg']);
  });

  test('轉檔成功就原地換掉，回報用了哪個工具', (t) => {
    const wb = unitWorkbench(t, { childProcess: { execFileSync: (cmd, args) => { if (cmd === 'sips') throw new Error('不是 Mac'); fs.writeFileSync(args.at(-1), 'png'); } } });
    const f = path.join(wb.root, 'gif.png');
    fs.writeFileSync(f, Buffer.concat([HEADERS.gif, Buffer.alloc(16)]));
    expect(wb.ensureUsableImage(f)).toEqual({ converted: 'gif', tool: 'ffmpeg' });
    expect(fs.readFileSync(f, 'utf8')).toBe('png');
  });
});

describe('事後補圖', () => {
  test('nextShotName 取現有最大編號 +1，不是數量 +1', (t) => {
    const wb = unitWorkbench(t);
    const j = { id: 'job-1' };
    wb.store.directory(j.id, j);
    const input = wb.jobPath(j.id, 'input');
    fs.mkdirSync(input, { recursive: true });
    for (const f of ['shot1.png', 'shot7.jpg', 'image3.png']) fs.writeFileSync(path.join(input, f), '');
    expect(wb.nextShotName(j, '.png')).toBe('shot8.png');
  });
});
