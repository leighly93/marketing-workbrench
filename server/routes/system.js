// @ts-nocheck
'use strict';

/**
 * 系統：管理者暗號換 cookie、健康檢查、修正紀錄總覽、解鎖與舊清理入口。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得（測試可換成假的 fs／子程序）。
 */

module.exports = function createRoutes(ctx) {
  const { fs, process, config: { ADMIN_KEY, CORRECTIONS_LOG }, ADMIN_COOKIE, sameSecret, isAdmin, send, refreshDetached, isBusy, LOCK, TEMPLATES,
    REASON_TAGS, STARTED_AT, codeChangedAt, webChangedAt, isMockMode, dirSize, JOBS_DIR, allCorrections,
    pruneOldJobs, rmrf } = ctx;

  return async function handle({ req, res, url, p, seg, admin }) {
  // 帶暗號開網頁：換成 cookie，再轉回乾淨的網址。
  if (url.searchParams.has('k') && !p.startsWith('/api/')) {
    const key = url.searchParams.get('k');
    url.searchParams.delete('k');
    const headers = { Location: url.pathname + url.search };
    if (ADMIN_KEY && sameSecret(key, ADMIN_KEY)) {
      headers['Set-Cookie'] = `${ADMIN_COOKIE}=${encodeURIComponent(key)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`;
    }
    return send(res, 303, '', headers);
  }

    if (p === '/api/health') {
      refreshDetached();
      return send(res, 200, {
        ok: true, busy: isBusy(),
        // locked 只代表「有鎖」；externalLock 才是需要提醒的狀況
        //（伺服器自己在跑的時候 run.js 也會建立 .run.lock，那是正常的）
        locked: fs.existsSync(LOCK),
        externalLock: !isBusy() && fs.existsSync(LOCK),
        lockAgeMin: fs.existsSync(LOCK)
          ? Math.round((Date.now() - fs.statSync(LOCK).mtimeMs) / 60000) : null,
        templates: TEMPLATES, reasonTags: REASON_TAGS,
        startedAt: STARTED_AT, codeChangedAt: codeChangedAt(),
        // 前台檔案本身的時間戳。已經開著的分頁不會自己重抓 index.html，
        // 所以要讓它自己發現「我手上這份網頁過期了」→ 跳「請重新整理」（2026-08-21）。
        webBuiltAt: webChangedAt(),
        admin: isAdmin(req),
        // 模擬模式（.env WORKBENCH_MOCK=1）：前台頁首掛警示，避免把假成品當真的發出去
        mock: isMockMode(process.env),
        diskMB: Math.round(dirSize(JOBS_DIR) / 1048576),
        keep: { automatic: false },
      });
    }

    // 修正紀錄總覽：哪一類最常被改 → 規則庫還缺什麼
    // 只給 Leighly 看（2026-08-17 要求）—— 這是內部檢討用的，同事看了只會困惑
    if (p === '/api/corrections') {
      if (!isAdmin(req)) return send(res, 403, { error: '這頁只有管理者看得到' });
      // 來源改成 append-only 彙總檔（data/corrections.jsonl）∪ 還沒進檔的舊 job。
      // 以前只讀 JOBS，工作被刪紀錄就一起消失（2026-08-18 使用者要求改掉）。
      const rows = allCorrections().sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
      const byType = {}, byTag = {};
      let noReason = 0;
      for (const r of rows) {
        byType[r.type] = (byType[r.type] || 0) + 1;
        const tags = (r.reason && r.reason.tags) || [];
        if (!tags.length && !(r.reason && r.reason.note)) noReason += 1;
        for (const t of tags) byTag[t] = (byTag[t] || 0) + 1;
      }
      return send(res, 200, {
        total: rows.length, byType, byTag, noReason,
        logged: fs.existsSync(CORRECTIONS_LOG),
        rows: rows.slice(0, 200),
      });
    }

    // 舊版管理介面相容入口；永久工作資料不再由此刪除
    if (p === '/api/prune' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: '只有管理者可以清理' });
      const freed = pruneOldJobs();
      return send(res, 200, { ok: true, freedMB: Math.round(freed / 1048576) });
    }

    if (p === '/api/unlock' && req.method === 'POST') {
      rmrf(LOCK);
      return send(res, 200, { ok: true });
    }
  };
};
