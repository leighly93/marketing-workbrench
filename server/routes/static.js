// @ts-nocheck
'use strict';

/**
 * 前台靜態檔（app/）。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得（測試可換成假的 fs／子程序）。
 */

module.exports = function createRoutes(ctx) {
  const { fs, path, config: { WEB_DIR }, sendFile } = ctx;

  return async function handle({ req, res, url, p, seg, admin }) {
    // ── 靜態檔 ──
    const file = path.join(WEB_DIR, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
    if (file.startsWith(WEB_DIR) && fs.existsSync(file) && fs.statSync(file).isFile())
      return sendFile(req, res, file);
  };
};
