// @ts-check
'use strict';

/**
 * 依序把請求交給各組路由；第一個回傳 truthy 的就算處理掉。都沒人接就 404。
 * 送來的 JSON 格式錯（BadRequest）回 400，其餘例外回 500 —— 一個壞請求不能讓整台伺服器掛掉。
 */

/**
 * @typedef {{ req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse,
 *   url: URL, p: string, seg: string[], admin: boolean }} RouteInput
 * @typedef {(input: RouteInput) => Promise<unknown> | unknown} RouteHandler
 */

/**
 * @param {{
 *   handlers: RouteHandler[],
 *   isAdmin: (req: any) => boolean,
 *   send: (res: any, code: number, body: unknown, headers?: Record<string, string>) => unknown,
 *   BadRequest: new (...args: any[]) => Error,
 * }} deps
 */
function createRouter({ handlers, isAdmin, send, BadRequest }) {
  /** @param {any} req @param {any} res */
  return async function route(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const seg = p.split('/').filter(Boolean);
    const admin = isAdmin(req);
    try {
      for (const handle of handlers) {
        if (await handle({ req, res, url, p, seg, admin })) return;
      }
      send(res, 404, { error: 'Not found' });
    } catch (e) {
      send(res, e instanceof BadRequest ? 400 : 500, { error: /** @type {Error} */ (e).message });
    }
  };
}

module.exports = { createRouter };
