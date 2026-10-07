// @ts-nocheck
'use strict';

/**
 * HTTP 回應與請求本文：JSON、檔案（含 Range）、讀 body。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得（測試可換成假的 fs／子程序）。
 */

module.exports = function create(ctx) {
  const { fs, path } = ctx;

  function send(res, code, body, headers) {
    const h = { 'Cache-Control': 'no-store', ...(headers || {}) };
    if (typeof body === 'object' && !Buffer.isBuffer(body)) {
      body = JSON.stringify(body);
      h['Content-Type'] = 'application/json; charset=utf-8';
    }
    res.writeHead(code, h);
    res.end(body);
    return true; // 路由靠回傳值判斷「這個請求處理掉了」
  }

  class BadRequest extends Error {}

  /** 讀 JSON 本文；格式錯誤回 400，不落到外層的 500。 */
  async function readJson(req) {
    const text = (await readBody(req)).toString();
    try { return JSON.parse(text || '{}'); }
    catch (_) { throw new BadRequest('送來的資料不是有效的 JSON'); }
  }

  function readBody(req, limit = 2 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let n = 0;
      const parts = [];
      req.on('data', (c) => {
        n += c.length;
        if (n > limit) { reject(new Error('內容太大')); req.destroy(); return; }
        parts.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(parts)));
      req.on('error', reject);
    });
  }

  const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.mp4': 'video/mp4', '.json': 'application/json',
    '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.map': 'application/json',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
  };

  /**
   * @param {object} req @param {object} res @param {string} file
   * @param {boolean} [download] 以附件下載
   * @param {{ cache?: string }} [opts] cache：覆寫 Cache-Control（Vite 的 assets/ 檔名帶 hash，可以 immutable）
   */
  function sendFile(req, res, file, download, opts) {
    if (!fs.existsSync(file)) return send(res, 404, { error: '找不到檔案' });
    const st = fs.statSync(file);
    // ⚠️ 資料夾不能當檔案送 —— createReadStream 對目錄是**非同步**丟 EISDIR（stream 的
    //    'error' 事件），呼叫端的 try/catch 攔不到 → 未處理例外 → 整台伺服器當場死。
    //    2026-09-11 17:32：同事在沒有截圖的工作按「＋ 加一段」，前台送出檔名是空字串的
    //    /api/jobs/<id>/file/，解回 _meta/thumbs 這個目錄 → 全公司連不進來 35 分鐘。
    if (!st.isFile()) return send(res, 404, { error: '找不到檔案' });
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cache-Control': (opts && opts.cache) || 'no-store' };
    if (download) {
      // ⚠️ HTTP header 的值只能是 Latin-1 —— 中文檔名直接塞進去，Node 會丟
      //    ERR_INVALID_CHAR：`Invalid character in header content ["Content-Disposition"]`。
      //    成品在 843d768 之後會改名歸檔成「0826-三大法人-標題.mp4」，所以**從成品庫下載
      //    一定爆**；從 jobs/<id>/out/ 下載因為檔名是 output-xxx.mp4（純 ASCII）才沒事。
      //    2026-08-26 使用者回報。
      // 解法是 RFC 5987 的兩段式寫法：filename= 給 ASCII 退路，filename*= 給真正的 UTF-8 檔名，
      // 瀏覽器會優先採用後者 → 中文檔名照樣正確落地。
      const base = path.basename(file);
      const ascii = base.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      // ⚠️ encodeURIComponent 不會跳脫 ' ( ) *，但這四個不在 RFC 5987 的 attr-char 裡 ——
      //    而成品檔名真的會出現括號（同一天重跑會變成「…！(2).mp4」），要自己補跳脫。
      const enc = encodeURIComponent(base).replace(/['()*]/g, (c) =>
        '%' + c.charCodeAt(0).toString(16).toUpperCase());
      headers['Content-Disposition'] = `attachment; filename="${ascii}"; filename*=UTF-8''${enc}`;
    }

    // 保險：讀到一半出事（檔案被刪、權限、磁碟）也只能斷這一條連線。
    // 沒有這個 handler 的話，stream 的 'error' 會變成未處理例外，一個壞請求＝整台重開。
    const pipe = (stream) => {
      stream.on('error', (e) => {
        console.error(`  ⚠️ 送檔中斷 ${path.basename(file)}：${e.message}`);
        res.destroy();
      });
      return stream.pipe(res);
    };

    // 影片要支援拖時間軸 → Range
    const range = req.headers.range;
    if (range && /^bytes=\d*-\d*$/.test(range)) {
      const [a, b] = range.replace('bytes=', '').split('-');
      const start = a ? parseInt(a, 10) : 0;
      const end = b ? parseInt(b, 10) : st.size - 1;
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      return pipe(fs.createReadStream(file, { start, end }));
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
    pipe(fs.createReadStream(file));
    return true;
  }

  return { send, BadRequest, readJson, readBody, MIME, sendFile };
};
