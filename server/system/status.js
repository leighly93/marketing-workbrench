// @ts-nocheck
'use strict';

/**
 * 服務狀態：區網 IP、啟動時間、程式與網頁的修改時間。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得（測試可換成假的 fs／子程序）。
 */

module.exports = function create(ctx) {
  const { fs, path, os, config: { WEB_DIR, VIDEO_DIR, SERVER_DIR } } = ctx;

  /** 本機在區網上的 IP，開機訊息要印給同事看 */
  function lanIP() {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const i of list || []) {
        if (i.family === 'IPv4' && !i.internal) return i.address;
      }
    }
    return 'localhost';
  }

  // 啟動時間 vs 程式碼修改時間。
  // 改完檔案忘了重開伺服器 → 網頁看起來「沒有變」，因為版型設定是這個程序回答的。
  // 這個坑第一次就踩到了（2026-08-13），所以讓網頁自己判斷、自己提醒。
  const STARTED_AT = Date.now();
  /** 前台的建置產物（app/dist 的 index.html 與 assets/ 底下的 js／css）。 */
  function webFiles() {
    const out = [];
    const walk = (dir) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        if (e.isDirectory()) walk(path.join(dir, e.name));
        else if (/\.(html|css|js)$/.test(e.name) && !e.name.endsWith('.test.js')) out.push(path.join(dir, e.name));
      }
    };
    walk(WEB_DIR);
    return out;
  }
  function webChangedAt() {
    let t = 0;
    for (const file of webFiles()) {
      try { t = Math.max(t, fs.statSync(file).mtimeMs); } catch (_) {}
    }
    return t || null;
  }

  /** server/ 底下的程式（不含測試）：拆成多個模組後，改任何一支都算「程式改了要重開」。 */
  function serverFiles() {
    const out = [];
    const walk = (dir) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        if (e.isDirectory()) { if (e.name !== 'tests' && e.name !== 'deploy') walk(path.join(dir, e.name)); }
        else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) out.push(path.join(dir, e.name));
      }
    };
    walk(SERVER_DIR);
    return out;
  }

  // ⚠️ 前台不算在這裡：它是建置產物、不需要重開伺服器，重新建置的提醒走 webChangedAt → 前台的「請重新整理」橫幅。
  //    算進來的話每次 npm run build:web 都會跳「伺服器要重開」，而那是假警報。
  function codeChangedAt() {
    let t = 0;
    for (const f of [...serverFiles(), path.join(VIDEO_DIR, 'run.js')]) {
      try { t = Math.max(t, fs.statSync(f).mtimeMs); } catch (_) {}
    }
    return t;
  }

  return { lanIP, STARTED_AT, webChangedAt, codeChangedAt };
};
