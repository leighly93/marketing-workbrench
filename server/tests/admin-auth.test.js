'use strict';

const assert = require('node:assert/strict');
const { fixture, loadServer } = require('./isolated-server');

const KEY = 'synthetic-admin-key';

test('帶暗號開網頁會換成 HttpOnly cookie，並轉回不含暗號的網址', async (t) => {
  const request = loadServer(fixture(t), { env: { ADMIN_KEY: KEY }, remoteAddress: '192.168.0.20' });
  const r = await request('GET', `/?k=${KEY}&tab=jobs`);
  assert.equal(r.status, 303);
  assert.equal(r.headers.Location, '/?tab=jobs');
  assert.match(r.headers['Set-Cookie'], /^wb_admin=synthetic-admin-key; .*HttpOnly/);
  assert.match(r.headers['Set-Cookie'], /SameSite=Strict/);
});

test('錯的暗號只轉址，不設 cookie', async (t) => {
  const request = loadServer(fixture(t), { env: { ADMIN_KEY: KEY }, remoteAddress: '192.168.0.20' });
  const r = await request('GET', '/?k=wrong');
  assert.equal(r.status, 303);
  assert.equal(r.headers.Location, '/');
  assert.equal(r.headers['Set-Cookie'], undefined);
});

test('區網連線只認 cookie；API 網址帶暗號不算管理者', async (t) => {
  const request = loadServer(fixture(t), { env: { ADMIN_KEY: KEY }, remoteAddress: '192.168.0.20' });
  assert.equal((await request('GET', '/api/messages')).status, 403);
  assert.equal((await request('GET', `/api/messages?k=${KEY}`)).status, 403);
  assert.equal((await request('GET', '/api/messages', undefined, { cookie: 'wb_admin=wrong' })).status, 403);
  const ok = await request('GET', '/api/messages', undefined, { cookie: `other=1; wb_admin=${KEY}` });
  assert.equal(ok.status, 200);
});

test('本機連線不需要暗號', async (t) => {
  const request = loadServer(fixture(t), { env: { ADMIN_KEY: KEY } });
  assert.equal((await request('GET', '/api/messages')).status, 200);
});

test('JSON 格式錯誤回 400，而不是 500', async (t) => {
  const request = loadServer(fixture(t));
  const r = await request('POST', '/api/messages', Buffer.from('{not json'));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /JSON/);
});
