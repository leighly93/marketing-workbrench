'use strict';

// 同事在建立頁「唸法」填的詞，出片時會順手送進收件匣，Leighly 再統一收錄進共用詞庫
// （2026-09-14 使用者定案）。
//
// 這件事最容易壞的不是「有沒有送」，而是「送太多次」：同一個詞每天出片就多一筆的話，
// 收件匣三天就被自己灌爆，真正有人特地來回報的那幾筆會被埋掉 —— 功能等於沒有。
// 所以這裡綁的是兩道去重，跟「有送出」同等重要：
//   ① 共用詞庫已經有那個原文（含**停用**的 —— 停用＝看過而且決定不要）
//   ② 收件匣裡同一個原文還沒處理

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, loadServer } = require('./隔離服務');

const 稿件 = { template: 'dapan', title: '合成標題', body: '這是合成稿件。' };

async function 唸法回報(request) {
  const res = await request('GET', '/api/messages');
  assert.equal(res.status, 200);
  return res.body.messages.filter((m) => m.kind === 'pronounce');
}

const 詞對 = (list) => list.map((m) => `${m.word}→${m.suggest}`).sort();

test('唸法填的新詞會自動進收件匣，同一個詞不會每出一支就多一筆', async (t) => {
  const root = fixture(t);
  const request = loadServer(root);

  const 第一支 = await request('POST', '/api/jobs', { ...稿件, voice: '收斂→收練\n櫃買→貴買' });
  assert.equal(第一支.status, 200);
  const 首批 = await 唸法回報(request);
  assert.deepEqual(詞對(首批), ['收斂→收練', '櫃買→貴買']);
  assert.ok(首批.every((m) => m.auto === true),
    '要標得出來是出片時順手帶上的 —— 跟同事特地跑來回報的處理優先度不一樣');
  assert.ok(首批.every((m) => m.job === 第一支.body.job.id), '要知道是哪一支工作帶上來的');

  await request('POST', '/api/jobs', { ...稿件, voice: '收斂→收練\n櫃買→貴買' });
  assert.deepEqual(詞對(await 唸法回報(request)), ['收斂→收練', '櫃買→貴買'],
    '同樣的詞再出一支就多一筆的話，收件匣會被自己灌爆');

  await request('POST', '/api/jobs', { ...稿件, voice: '收斂→收練\n采鈺→彩玉' });
  assert.deepEqual(詞對(await 唸法回報(request)), ['采鈺→彩玉', '收斂→收練', '櫃買→貴買'].sort(),
    '新的詞還是要送');
});

test('共用詞庫已經有的原文不再回報，停用的也算看過', async (t) => {
  const root = fixture(t);
  const request = loadServer(root);

  assert.equal((await request('POST', '/api/pronounce', { from: '收斂', to: '收練', force: true })).status, 200);
  assert.equal((await request('POST', '/api/pronounce', { from: '櫃買', to: '貴買', force: true })).status, 200);
  assert.equal((await request('PATCH', '/api/pronounce', { from: '櫃買', enabled: false })).status, 200);

  await request('POST', '/api/jobs', { ...稿件, voice: '收斂→收練\n櫃買→貴買\n采鈺→彩玉' });
  assert.deepEqual(詞對(await 唸法回報(request)), ['采鈺→彩玉'],
    '詞庫裡已經有的（含停用的）再送就是一直來吵同一件事');
});

test('沒填唸法就不會產生任何回報', async (t) => {
  const root = fixture(t);
  const request = loadServer(root);
  await request('POST', '/api/jobs', 稿件);
  await request('POST', '/api/jobs', { ...稿件, voice: '' });
  assert.deepEqual(await 唸法回報(request), []);
});
