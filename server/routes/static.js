// @ts-nocheck
'use strict';

/**
 * 前台靜態檔：Vite 建置產物（app/dist）。
 *   - /assets/… 檔名帶 hash → 可以長快取（immutable）；其餘一律 no-store。
 *   - 不是 /api 的路徑找不到檔案 → 回 index.html（前台用 history 路由，/jobs/<id> 要由瀏覽器端解析）。
 *   - dist 還沒建 → 回一頁說明怎麼建，不要讓人看到 404 JSON 以為伺服器壞了。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得（測試可換成假的 fs／子程序）。
 */

module.exports = function createRoutes(ctx) {
  const { fs, path, config: { WEB_DIR }, send, sendFile } = ctx;

  const NOT_BUILT = '<!doctype html><meta charset="utf-8"><title>前台尚未建置</title>'
    + '<body style="font:15px/1.7 -apple-system,BlinkMacSystemFont,sans-serif;padding:40px;max-width:640px">'
    + '<h1 style="font-size:18px">前台還沒建置</h1><p>伺服器在跑，但 <code>app/dist/</code> 不存在。在 repository 根目錄執行：</p>'
    + '<pre style="background:#f0f3f7;padding:12px;border-radius:8px">npm run build:web</pre>'
    + '<p>開發時也可以用 <code>npm run dev:web</code>（Vite dev server，/api 會代理到這台）。</p></body>';

  const isFile = (file) => file.startsWith(WEB_DIR) && fs.existsSync(file) && fs.statSync(file).isFile();

  return async function handle({ req, res, url, p, seg, admin }) {
    if (p.startsWith('/api/')) return;
    const index = path.join(WEB_DIR, 'index.html');
    const file = path.join(WEB_DIR, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
    if (isFile(file)) {
      const hashed = /^\/assets\//.test(p) && /-[\w-]{8,}\.\w+$/.test(p);
      return sendFile(req, res, file, false, hashed ? { cache: 'public, max-age=31536000, immutable' } : undefined);
    }
    // 看起來像檔案（有副檔名）的就真的 404；像頁面路徑的交給前台路由
    if (/\.[a-z0-9]{1,5}$/i.test(p)) return;
    if (isFile(index)) return sendFile(req, res, index);
    return send(res, 503, NOT_BUILT, { 'Content-Type': 'text/html; charset=utf-8' });
  };
};
