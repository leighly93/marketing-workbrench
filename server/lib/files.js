// @ts-nocheck
'use strict';

/**
 * 檔案小工具：遞迴複製／刪除、資料夾大小。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得（測試可換成假的 fs／子程序）。
 */

module.exports = function create(ctx) {
  const { fs, path } = ctx;

  const nowISO = () => new Date().toISOString();
  const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });

  function copyRecursive(from, to, skipNames) {
    if (!fs.existsSync(from)) return;
    const st = fs.statSync(from);
    if (st.isDirectory()) {
      ensureDir(to);
      for (const n of fs.readdirSync(from)) {
        if (skipNames && skipNames.includes(n)) continue;
        copyRecursive(path.join(from, n), path.join(to, n), skipNames);
      }
    } else {
      ensureDir(path.dirname(to));
      fs.copyFileSync(from, to);
    }
  }

  function rmrf(p) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
  }

  function dirSize(p) {
    let n = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else n += fs.statSync(f).size;
      }
    };
    try { walk(p); } catch (_) {}
    return n;
  }

  return { nowISO, ensureDir, copyRecursive, rmrf, dirSize };
};
