// @ts-nocheck
'use strict';

/**
 * 本機狀態：工作區鎖、磁碟用量、佇列。/api/health 與 /api/quotas 都從這裡拿，兩邊才不會各算各的。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得（測試可換成假的 fs／子程序）。
 */

module.exports = function create(ctx) {
  const { fs, LOCK, isBusy, dirSize, JOBS_DIR, allJobs } = ctx;

  /**
   * .run.lock 的狀態。locked 只代表「有鎖」；externalLock 才是需要提醒的狀況
   *（伺服器自己在跑的時候 run.js 也會建立 .run.lock，那是正常的）。
   */
  function lockStatus() {
    const locked = fs.existsSync(LOCK);
    return {
      locked,
      externalLock: !isBusy() && locked,
      lockAgeMin: locked ? Math.round((Date.now() - fs.statSync(LOCK).mtimeMs) / 60000) : null,
    };
  }

  /** 工作資料夾總量（MB）。 */
  function diskMB() {
    return Math.round(dirSize(JOBS_DIR) / 1048576);
  }

  /** 佇列：排隊中、等出片、正在跑的那支（跑的時候 busy 擋著，同時只會有一支）。 */
  function queueStatus() {
    const jobs = allJobs();
    const running = jobs.find((j) => j.status === 'preparing' || j.status === 'rendering');
    return {
      queued: jobs.filter((j) => j.status === 'queued').length,
      approved: jobs.filter((j) => j.status === 'approved').length,
      runningJobId: running ? running.id : null,
    };
  }

  function localStatus() {
    return { diskMB: diskMB(), busy: isBusy(), lock: lockStatus(), queue: queueStatus() };
  }

  return { lockStatus, diskMB, queueStatus, localStatus };
};
