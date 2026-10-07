// @ts-nocheck
'use strict';

/**
 * 誰是管理者：本機連線，或帶著正確暗號 cookie 的連線。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得（測試可換成假的 fs／子程序）。
 */

module.exports = function create(ctx) {
  const { crypto, config: { ADMIN_KEY } } = ctx;
  const ADMIN_COOKIE = 'wb_admin';

  // ── HTTP ──────────────────────────────────
  /**
   * 這個請求是不是「管理者」（＝ Leighly 本人）。
   *
   * 沒有帳號系統，也不需要 —— 用「從哪連進來」判斷就夠：
   *   本機 localhost = 坐在這台 Mac 前面的人 = Leighly
   *   區網 IP        = 同事
   * Leighly 偶爾用手機／別台連進來時，網址加 ?k=<ADMIN_KEY> 開一次，之後靠 cookie。
   * 這只是「不要讓同事看到內部資訊」，不是資安機制 —— 區網內本來就互相信任。
   *
   * 2026-08-21：舊的 ?admin=1 拿掉了（使用者要求）—— 誰都猜得到那五個字，
   * 直接在網址列打 /api/messages?admin=1 就能讀到收件匣。改成只有 Leighly 知道的暗號。
   */
  function clientIp(req) {
    // Node 在雙堆疊 socket 上會把 IPv4 包成 ::ffff:192.168.x.x，去掉前綴才是人看得懂的 IP。
    // 這台是直連（沒有反向代理），所以不必理會 X-Forwarded-For —— 那個標頭可以偽造。
    return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  }

  function cookieValue(req, name) {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return '';
  }

  function sameSecret(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  }

  function isAdmin(req) {
    if (ADMIN_KEY && sameSecret(cookieValue(req, ADMIN_COOKIE), ADMIN_KEY)) return true;
    const ip = clientIp(req);
    return ip === '127.0.0.1' || ip === '::1';
  }

  return { ADMIN_COOKIE, clientIp, cookieValue, sameSecret, isAdmin };
};
