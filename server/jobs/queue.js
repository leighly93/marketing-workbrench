// @ts-nocheck
'use strict';

/**
 * 一次只跑一支的佇列：挑下一支、排第幾、推進，以及對外的工作資料。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得（測試可換成假的 fs／子程序）。
 */

module.exports = function create(ctx) {
  const { fs, timers, allJobs, LOCK, appendLog, saveJob, doPrepare, doRender, backupJobArtifacts, pruneOldJobs } = ctx;

  // ── 佇列 ──────────────────────────────────
  let busy = false;

  function pickNext() {
    // 已確認要 render 的優先（人已經等過一輪了），其次才是新工作
    return (
      allJobs().filter((j) => j.status === 'approved').sort((a, b) => (a.approvedAt < b.approvedAt ? -1 : 1))[0] ||
      allJobs().filter((j) => j.status === 'queued').sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0]
    );
  }

  function queuePosition(job) {
    if (job.status !== 'queued' && job.status !== 'approved') return 0;
    const list = allJobs().filter((j) => j.status === 'queued' || j.status === 'approved');
    const order = list.sort((a, b) => {
      const w = (j) => (j.status === 'approved' ? 0 : 1);
      if (w(a) !== w(b)) return w(a) - w(b);
      return (a.approvedAt || a.createdAt) < (b.approvedAt || b.createdAt) ? -1 : 1;
    });
    return order.findIndex((j) => j.id === job.id) + (busy ? 1 : 0);
  }

  let lockWaitLogged = null;
  function tick() {
    if (busy) return;
    const job = pickNext();
    if (!job) return;
    // .run.lock 存在但伺服器沒在跑東西 → 鎖是「外面」造成的：
    // Leighly 自己在終端機跑 run.js，或上次沒清乾淨留下的。
    // 這時候要排隊等，不能把工作標成失敗 —— 同事只會看到一個看不懂的錯誤
    //（2026-08-17 使用者問「工作區被鎖住時還可以建立工作嗎」時發現）。
    if (fs.existsSync(LOCK)) {
      if (lockWaitLogged !== job.id) {
        lockWaitLogged = job.id;
        appendLog(job, '\n⏳ 工作區正被其他流程使用（.run.lock），排隊等它結束…\n');
      }
      timers.setTimeout(tick, 5000);
      return;
    }
    lockWaitLogged = null;
    busy = true;
    const work = job.status === 'approved' ? doRender(job) : doPrepare(job);
    work
      .catch((e) => {
        // 人按了取消 → run.js 被 SIGTERM，這裡一定會收到非 0 結束碼。
        // 那不是失敗，狀態已經是 cancelled 了，蓋成 failed 會讓人以為是系統出錯。
        if (job.status === 'cancelled') return;
        job.status = 'failed';
        job.error = e.message;
        appendLog(job, '\n❌ ' + e.message + '\n');
        saveJob(job);
      })
      .finally(() => {
        busy = false;
        try { backupJobArtifacts(job); } catch (_) {}   // 先備份再 prune，順序不能反
        try { pruneOldJobs(); } catch (_) {}
        timers.setTimeout(tick, 200);
      });
  }

  // admin=false（＝同事）時，回應裡**根本不會有** ip 這個欄位 —— 不是前端不畫而已，
  // 是伺服器不送。所以按 F12 翻 Network 也翻不到（2026-08-21 使用者要求）。
  function publicJob(j, admin) {
    const { pid, pendingEdits, pendingEmphasis, autoPlan, ip, ...rest } = j;
    const out = { ...rest, queuePosition: queuePosition(j) };
    if (admin && ip) out.ip = ip;
    return out;
  }

  const isBusy = () => busy;

  return { pickNext, queuePosition, tick, publicJob, isBusy };
};
