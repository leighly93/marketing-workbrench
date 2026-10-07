'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { once } = require('node:events');
const { createRouter } = require('./router');
const { unitWorkbench } = require('../tests/unit-workbench');

function fakeRes() {
  const chunks = [];
  const res = new Writable({ write(c, _e, done) { chunks.push(Buffer.from(c)); done(); } });
  res.writeHead = (code, headers) => { res.status = code; res.headers = headers; };
  res.text = () => Buffer.concat(chunks).toString();
  return res;
}

describe('auth', () => {
  test('cookieValue 只認完整名稱；sameSecret 長度不同直接不相等', (t) => {
    const { cookieValue, sameSecret } = unitWorkbench(t);
    const req = { headers: { cookie: 'x_wb_admin=1; wb_admin=a%20b; other=2' } };
    expect(cookieValue(req, 'wb_admin')).toBe('a b');
    expect(cookieValue(req, 'missing')).toBe('');
    expect(sameSecret('abc', 'abc')).toBe(true);
    expect(sameSecret('abc', 'abcd')).toBe(false);
  });

  test('isAdmin：本機一律是；區網要帶對的 cookie；沒設暗號就只有本機', (t) => {
    const lan = (cookie) => ({ headers: { cookie }, socket: { remoteAddress: '::ffff:192.168.1.5' } });
    const withKey = unitWorkbench(t, { env: { ADMIN_KEY: 'k' } });
    expect(withKey.isAdmin({ headers: {}, socket: { remoteAddress: '::1' } })).toBe(true);
    expect(withKey.isAdmin(lan('wb_admin=k'))).toBe(true);
    expect(withKey.isAdmin(lan('wb_admin=x'))).toBe(false);
    expect(withKey.clientIp(lan(''))).toBe('192.168.1.5');
    expect(unitWorkbench(t).isAdmin(lan('wb_admin='))).toBe(false);
  });
});

describe('respond', () => {
  test('send 物件轉 JSON、不快取，回傳 true 表示處理掉了', (t) => {
    const { send } = unitWorkbench(t);
    const res = fakeRes();
    expect(send(res, 201, { a: 1 })).toBe(true);
    expect(res.status).toBe(201);
    expect(res.headers).toMatchObject({ 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' });
  });

  test('readJson：空本文是 {}，壞 JSON 是 BadRequest；readBody 超過上限就拒絕', async (t) => {
    const { readJson, readBody, BadRequest } = unitWorkbench(t);
    expect(await readJson(Readable.from([]))).toEqual({});
    await expect(readJson(Readable.from([Buffer.from('{x')]))).rejects.toBeInstanceOf(BadRequest);
    await expect(readBody(Readable.from([Buffer.alloc(10)]), 5)).rejects.toThrow(/太大/);
  });

  test('sendFile：Range 回 206；下載時中文檔名用 RFC 5987；資料夾當成找不到', async (t) => {
    const wb = unitWorkbench(t);
    const file = path.join(wb.root, '成品(2).mp4');
    fs.writeFileSync(file, '0123456789');
    const res = fakeRes();
    const done = once(res, 'finish');
    wb.sendFile({ headers: { range: 'bytes=2-5' } }, res, file, true);
    await done;
    expect(res.status).toBe(206);
    expect(res.text()).toBe('2345');
    expect(res.headers['Content-Disposition']).toBe(`attachment; filename="__(2).mp4"; filename*=UTF-8''%E6%88%90%E5%93%81%282%29.mp4`);
    const dir = fakeRes();
    wb.sendFile({ headers: {} }, dir, wb.root);
    expect(dir.status).toBe(404);
  });
});

describe('router', () => {
  const send = (res, code, body) => { res.code = code; res.body = body; return true; };
  class BadRequest extends Error {}
  const run = async (handlers, url = '/api/x') => {
    const res = {};
    await createRouter({ handlers, isAdmin: () => false, send, BadRequest })({ url }, res);
    return res;
  };

  test('依序交給路由，第一個處理掉的為準；都沒人接回 404', async () => {
    const seen = [];
    const res = await run([({ p, seg }) => { seen.push(['a', p, seg]); }, ({ res: r }) => send(r, 200, 'b'), () => { throw new Error('不該到這裡'); }]);
    expect(res).toMatchObject({ code: 200, body: 'b' });
    expect(seen).toEqual([['a', '/api/x', ['api', 'x']]]);
    expect((await run([() => undefined])).code).toBe(404);
  });

  test('BadRequest 回 400，其他例外回 500', async () => {
    expect((await run([() => { throw new BadRequest('壞'); }])).code).toBe(400);
    expect(await run([async () => { throw new Error('炸'); }])).toMatchObject({ code: 500, body: { error: '炸' } });
  });
});
