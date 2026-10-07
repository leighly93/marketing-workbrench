// @ts-nocheck
'use strict';

/**
 * 單筆工作的磁碟操作：路徑、存 job.json、寫執行記錄、產生 ID。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得（測試可換成假的 fs／子程序）。
 */

module.exports = function create(ctx) {
  const { fs, path, store: STORE, ensureDir } = ctx;
  const JOBS_DIR = STORE.base;

  // ── 工作儲存 ──────────────────────────────
  // 用檔案存，伺服器重開不會掉。不用資料庫 —— 一天十幾筆而已。
  ensureDir(JOBS_DIR);

  function jobDir(id) { return STORE.path(id); }
  function jobPath(id, ...parts) { return STORE.path(id, ...parts); }
  function jobFile(id) { return jobPath(id, 'job.json'); }

  function saveJob(j) {
    STORE.directory(j.id, j);
    ensureDir(jobDir(j.id));
    fs.writeFileSync(jobFile(j.id), JSON.stringify(j, null, 2));
  }

  function appendLog(job, line) {
    const f = jobPath(job.id, 'log.txt');
    ensureDir(path.dirname(f));
    fs.appendFileSync(f, line.endsWith('\n') ? line : line + '\n');
  }

  function newId() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return (
      `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
      '-' + Math.random().toString(36).slice(2, 6)
    );
  }

  return { jobDir, jobPath, jobFile, saveJob, appendLog, newId };
};
