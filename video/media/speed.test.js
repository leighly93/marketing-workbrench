'use strict';

const path = require('node:path');
const { createSpeedUp, SPED_TAG } = require('./speed');

function fakeTools({ tagged = false } = {}) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'ffprobe') return tagged ? `${SPED_TAG}=1.25\n` : '\n';
    return '';
  };
  const renames = [];
  return { calls, renames, deps: { exec, rename: (a, b) => renames.push([a, b]), log: () => {} } };
}

const file = path.join('/work', 'public', 'heygen.mp4');

describe('createSpeedUp', () => {
  test('加速 1.25 倍、保持音調，蓋上記號後覆蓋原檔', () => {
    const { calls, renames, deps } = fakeTools();
    expect(createSpeedUp(deps).speedUp(file, '固定主播版型')).toBe(true);
    const ffmpeg = calls.find((c) => c[0] === 'ffmpeg');
    expect(ffmpeg).toContain('[0:v]setpts=PTS/1.25[v];[0:a]atempo=1.25[a]');
    expect(ffmpeg).toContain(`comment=${SPED_TAG}=1.25`);
    expect(renames).toEqual([[path.join('/work', 'public', 'heygen_fast.mp4'), file]]);
  });

  test('同一輪第二次呼叫被擋下（不會變 1.5625 倍）', () => {
    const { calls, deps } = fakeTools();
    const s = createSpeedUp(deps);
    s.speedUp(file, '第一次');
    expect(s.speedUp(file, '第二次')).toBe(false);
    expect(calls.filter((c) => c[0] === 'ffmpeg')).toHaveLength(1);
  });

  test('檔案已有記號（之前加速過）就不再加速', () => {
    const { calls, deps } = fakeTools({ tagged: true });
    expect(createSpeedUp(deps).speedUp(file, 'skip-generate')).toBe(false);
    expect(calls.some((c) => c[0] === 'ffmpeg')).toBe(false);
  });

  test('ffprobe 讀不到就當成沒加速過', () => {
    const deps = { exec: (cmd) => { if (cmd === 'ffprobe') throw new Error('no ffprobe'); return ''; }, rename: () => {}, log: () => {} };
    expect(createSpeedUp(deps).alreadySpedUp(file)).toBe(false);
  });
});
