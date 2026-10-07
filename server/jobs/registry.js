// @ts-nocheck
'use strict';

/**
 * 記憶體中的工作清單（啟動時從磁碟載入）。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得（測試可換成假的 fs／子程序）。
 */

module.exports = function create(ctx) {
  const { store: STORE, isRunJs, saveJob, appendLog } = ctx;

  function loadJobs() {
    const out = [];
    for (const j of STORE.scan()) {
      try {
        // 伺服器上次是在跑到一半被關掉的。
        // run.js 是 detached 的，所以它很可能還活著 —— 那就不是「中斷」，
        // 是「在背景繼續跑」。標成失敗會讓人以為 HeyGen 點數白花了（其實沒有）。
        if (j.status === 'preparing' || j.status === 'rendering') {
          if (isRunJs(j.pid)) {
            j.status = 'detached';
            j.error = null;
          } else {
            j.status = 'failed';
            j.error = '伺服器重新啟動，這支工作中斷了。請重新建立。';
          }
        }
        out.push(j);
      } catch (_) {}
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  let JOBS = loadJobs();
  JOBS.forEach(saveJob);

  function getJob(id) { return JOBS.find((j) => j.id === id); }

  /**
   * 更新「重開前就在跑、現在在背景」的那些工作。
   * 伺服器沒有接回它們（那是方案 B），只負責把狀態顯示對，
   * 並告訴使用者怎麼零成本接回（講者影片還在 public/heygen.mp4）。
   */
  function refreshDetached() {
    for (const j of JOBS) {
      if (j.status !== 'detached') continue;
      if (isRunJs(j.pid)) continue;
      j.status = 'detached-done';
      j.pid = null;
      appendLog(j, '\n🔚 這支在背景跑完了（伺服器當時已重開，沒有接回流程）。\n'
        + '   講者影片留在 public/heygen.mp4 —— 重新建立工作並勾「用現成的講者影片」，\n'
        + '   就能零成本接著出片，不用再花 HeyGen 點數。\n');
      saveJob(j);
    }
  }

  /** 新的在前（跟 loadJobs 的排序一致）。 */
  function addJob(job) { JOBS.unshift(job); }
  function removeJob(id) { JOBS = JOBS.filter((x) => x.id !== id); }
  function allJobs() { return JOBS; }

  return { getJob, refreshDetached, addJob, removeJob, allJobs };
};
