'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { applicationPath } = require('../paths');

test('公開字型是完整 TrueType 可變字型，包含字元映射、可變字重與授權', () => {
  const root = path.resolve(__dirname, '../..');
  const font = fs.readFileSync(applicationPath(root, 'public/NotoSansTC-VF.ttf'));
  assert.equal(font.readUInt32BE(0), 0x00010000, '不可把下載錯誤的 HTML 當字型');
  const count = font.readUInt16BE(4);
  assert.ok(count > 0 && 12 + count * 16 <= font.length);
  const tables = new Set();
  for (let i = 0; i < count; i++) {
    const entry = 12 + i * 16;
    tables.add(font.toString('ascii', entry, entry + 4));
    assert.ok(font.readUInt32BE(entry + 8) + font.readUInt32BE(entry + 12) <= font.length, '字型表不可截斷');
  }
  for (const name of ['cmap', 'name', 'head', 'fvar']) assert.ok(tables.has(name), name);
  assert.match(fs.readFileSync(path.join(root, '90_系統/第三方授權/NotoSansTC-OFL.txt'), 'utf8'), /SIL OPEN FONT LICENSE/);
});
