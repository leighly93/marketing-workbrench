// @ts-nocheck
'use strict';

/**
 * 確認關卡：確認出片、直接出片開關、退回確認、取消。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得（測試可換成假的 fs／子程序）。
 */

module.exports = function createRoutes(ctx) {
  const { timers, send, readJson, nowISO, rmrf, jobPath, getJob, saveJob, appendLog, publicJob, tick, appendMissingAnnots,
    recordCorrections, learnFromEdits, saveJobEmphasis, stopMotion, stopRunJs } = ctx;

  return async function handle({ req, res, url, p, seg, admin }) {
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'approve' && req.method === 'POST') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      if (job.status !== 'review') return send(res, 400, { error: '這支工作現在不是待確認狀態' });
      const body = await readJson(req);
      const edits = appendMissingAnnots(job, Array.isArray(body.edits) ? body.edits : []);
      // ⚠️ approvedBy 要在 recordCorrections 之前設好 —— 彙總檔要記「是誰改的」
      job.approvedBy = (body.by || '').trim() || job.owner;
      job.approvedAt = nowISO();
      recordCorrections(job, job.planView, edits);
      learnFromEdits(job, edits);
      job.pendingEdits = edits;
      // 字幕重點詞跟 edits 是兩份資料（它不屬於任何一段配圖，可能落在完全沒配圖的地方），
      // 所以分開帶、分開寫。計畫頁送上來就存進工作自己的檔，真正寫進 ROOT 是在 doRender。
      // ⚠️ 沒帶 emphasis 欄位（舊前台）不等於「清空」—— 那會把人在準備階段標好的抹掉。
      if (Array.isArray(body.emphasis)) {
        job.emphasisCount = saveJobEmphasis(job, body.emphasis).length;
      }
      job.status = 'approved';
      saveJob(job);
      // ⚠️ 這裡用 setImmediate，不要直接 tick() —— tick() 會同步一路跑到 doRender 的
      //    第一個 await 為止（restoreWorkspace 要同步複製整份快照），那段期間整個
      //    event loop 都停著，這個 200 也發不出去。
      //    2026-09-21 實際踩到：一段 17.9 秒的動態讓伺服器凍結 32 秒 —— 同事按
      //    「確認，開始出片」完全沒反應（連 3 秒輪詢都停了），又按了兩次；解凍後那兩次
      //    才被處理，那時狀態已是 approved，於是跳出「這支工作現在不是待確認狀態」。
      //    先把回應送出去，出片工作下一輪 tick 再啟動。
      timers.setImmediate(tick);
      return send(res, 200, { job: publicJob(job, admin) });
    }

    // 「標好了就直接出片」：HeyGen 跑完不停在確認關卡，直接接著 render。
    // 這只是一個旗標，doPrepare 是在最後一刻才讀 —— 所以 HeyGen 還在生成的期間
    // 隨時可以改主意（取消勾選、繼續改標注），都還來得及。
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'auto-approve' && req.method === 'POST') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      if (!['queued', 'preparing', 'detached'].includes(job.status))
        return send(res, 400, { error: '這支已經過了準備階段，改不了了' });
      const body = await readJson(req);
      job.autoApprove = !!body.on;
      saveJob(job);
      return send(res, 200, { job: publicJob(job, admin) });
    }

    // 反悔鍵：已經在排隊等出片 → 退回「等你確認」。
    // 真的開始 render（status 轉 rendering）之後就退不回來了，那時只能取消重跑。
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'unapprove' && req.method === 'POST') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      if (job.status !== 'approved')
        return send(res, 400, { error: '這支現在不是「排隊等出片」，退不回來' });
      if (!job.planView) return send(res, 400, { error: '這支沒有配圖計畫可以確認' });
      job.status = 'review';
      job.autoApprove = false;
      job.pendingEdits = [];
      // ⚠️ 不要清掉重點詞 —— 退回確認是「我還要再改」，不是「我要重標」。
      //    以前這裡把它歸零，人在計畫頁標完、按確認、再按退回，標記就無聲消失。
      delete job.approvedAt;
      delete job.approvedBy;
      appendLog(job, '\n↩️ 已退回「等你確認」\n');
      saveJob(job);
      return send(res, 200, { job: publicJob(job, admin) });
    }

    /**
     * 取消工作（2026-09-17 改：正在跑的也能取消）。
     *
     * 以前 preparing／rendering 一律回 400「請等它結束」—— 使用者實際遇到的是
     * HeyGen 卡在 processing 十幾分鐘，前台連按鈕都沒有，只能乾等。
     * 現在一律受理：還在跑就先把 run.js 停掉（連同它 spawn 的子程序），再標成已取消。
     *
     * ⚠️ HeyGen／MiniMax 的錢在呼叫當下就扣了，停掉不會退 —— 前台要講清楚，不要
     *    讓人以為按了就沒事。
     */
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'cancel' && req.method === 'POST') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      if (job.status === 'cancelled') return send(res, 200, { job: publicJob(job, admin) });
      if (['done', 'failed'].includes(job.status))
        return send(res, 400, { error: '這支已經結束了，要清掉請用列表的刪除' });
      // ⚠️ 兩種子程序都要停：產線的 run.js，以及動態渲染。
      //    動態那 30 秒以前按不到取消（event loop 被 spawnSync 綁住，請求進不來），
      //    2026-09-21 改成非同步之後按得到了 —— 只殺 run.js 的話它會繼續渲完、繼續往下
      //    真的出片，最後把這裡設的 cancelled 蓋成 done（doRender 那邊也有一道檢查）。
      //    兩個都要叫，不能用 || 短路 —— 一支停不掉不代表另一支不用停。
      const stoppedMotion = stopMotion(job);
      const stopped = stopRunJs(job) || stoppedMotion;
      // ⚠️ 要在改 status 之前立旗標：殺掉 run.js 會讓 runPipeline 的 close 以非 0 結束碼
      //    reject，tick() 的 .catch 接著把工作標成 failed —— 那會蓋掉這裡的 cancelled，
      //    使用者按了取消卻看到「失敗」。
      job.cancelledAt = nowISO();
      job.status = 'cancelled';
      job.error = null;
      if (stopped) appendLog(job, '\n⛔ 已取消：已停止正在執行的產線（HeyGen／MiniMax 已扣的點數不會退回）\n');
      else appendLog(job, '\n⛔ 已取消\n');
      rmrf(jobPath(job.id, 'state'));
      saveJob(job);
      return send(res, 200, { job: publicJob(job, admin), stopped });
    }
  };
};
