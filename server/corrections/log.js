// @ts-nocheck
'use strict';

/**
 * 修正紀錄彙總檔（append-only）與讀取。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得（測試可換成假的 fs／子程序）。
 */

module.exports = function create(ctx) {
  const { fs, path, config: { CORRECTIONS_LOG }, ensureDir, nowISO, appendLog, jobPath, allJobs } = ctx;

  // 修正原因的快選標籤。
  // ⚠️ **2026-08-21 起前台不再問原因** —— 配圖計畫編輯器的「為什麼要改」整塊已移除（使用者：
  //    「其他同事會看不懂」）。所以這份清單目前**沒有人在畫**，`/api/health` 照樣回傳只是留著介面。
  //    「為什麼」改由修正紀錄頁的 `autoWhy` 自動推斷（AI 完全沒用到這張圖／用過但沒配到這一句／
  //    AI 原本沒框，人自己框了…），不再依賴人填。
  //    要恢復問原因：把 `app/index.html` 的 `.tags` 樣式、編輯器裡的
  //    `為什麼要改` 區塊、`drawEdTags()`、`edCtx.tags`、`e.reasonTags/reasonNote` 幾處加回來
  //    （backup：`app/index.html.bak-no-reason-*`）。伺服器端從未拆掉，加回前台就會通。
  // 固定選項才能直接統計次數 —— 自由文字只能人工讀。刪標籤要小心：歷史紀錄裡的舊標籤會變成孤兒。
  const REASON_TAGS = [
    'AI 沒框到重點',
    'AI 完全沒用到這張圖',
    '框錯位置',
    '框太小',
    '框太大',
    '股名／關鍵字沒辨識到',
    '這句該用別張圖',
    '出現時間不對',
    '不該滑動',
    '應該要滑動',
  ];

  /** 追加寫進 append-only 彙總檔。寫失敗只警告，絕對不能讓 approve 掛掉。 */
  function appendCorrectionsLog(job, diffs) {
    if (!diffs || !diffs.length) return;
    if (job.correctionsLoggedAt) return; // 同一支只寫一次（append-only 沒有去重機制）
    try {
      ensureDir(path.dirname(CORRECTIONS_LOG));
      const at = nowISO();
      const lines = diffs.map((d) => JSON.stringify({
        at, job: job.id, template: job.template,
        by: job.approvedBy || job.owner || '', title: (job.title || '').replace(/\n/g, ' '),
        ...d,
      }));
      fs.appendFileSync(CORRECTIONS_LOG, lines.join('\n') + '\n');
      job.correctionsLoggedAt = at;
    } catch (e) {
      appendLog(job, `\n⚠️ 修正紀錄彙總檔寫入失敗（不影響出片）：${e.message}\n`);
    }
  }

  function readCorrectionsLog() {
    if (!fs.existsSync(CORRECTIONS_LOG)) return [];
    const out = [];
    for (const line of fs.readFileSync(CORRECTIONS_LOG, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (_) {} // 壞掉那行就跳過，不要整份報廢
    }
    return out;
  }

  /** 彙總檔 ∪ 還沒進彙總檔的舊 job（往前相容，不用做一次性搬遷） */
  function allCorrections() {
    const rows = readCorrectionsLog();
    const seen = new Set(rows.map((r) => r.job));
    for (const j of allJobs()) {
      if (seen.has(j.id)) continue;
      for (const c of j.corrections || [])
        rows.push({ at: j.approvedAt, job: j.id, template: j.template, by: j.approvedBy || j.owner || '', ...c });
    }
    // 2026-09-14 起「人工標記」會自己寫 autoKind。它之前的紀錄沒有這個欄位，
    // 其中 focus 版型（三大法人）那批的「原本」一律是空的 —— 不是 AI 沒配圖，
    // 是比對時拿了對照組根本沒有的 `src` 欄位。
    // append-only 的歷史檔不改，這裡只在回應裡標成「舊紀錄不可信」，讓頁面不要再講假話。
    // 另一種空白：那一輪對照組整份是 0 段（不是「AI 判斷這裡不用配圖」，是根本沒有基準可比）。
    // 舊紀錄裡看不出來，只能回頭看工作的 auto-noannots.json；工作被刪就維持原樣。
    const cfEmpty = new Map();
    const cfIsEmpty = (id) => {
      if (cfEmpty.has(id)) return cfEmpty.get(id);
      let v = false;
      try {
        const a = JSON.parse(fs.readFileSync(jobPath(id, 'auto-noannots.json'), 'utf-8'));
        v = Array.isArray(a) && !a.length;
      } catch (_) { v = false; }
      cfEmpty.set(id, v);
      return v;
    };
    for (const r of rows) {
      if (r.type !== '人工標記' || r.autoKind || r.from) continue;
      // ⚠️ 認代號、不查 TEMPLATES：三大法人 2026-09-22 移除了，查 TEMPLATES 會一律落空，
      //    那批舊紀錄就會掉進下面的 cfIsEmpty 或完全不標記 —— 頁面又開始講「AI 本來不配圖」的假話。
      //    'institution' 是歷來唯一的 focus 版型，歷史紀錄裡的代號不會再變。
      if (r.template === 'institution') r.autoKind = 'legacyNoSrc';
      else if (cfIsEmpty(r.job)) r.autoKind = 'noCounterfactual';
    }
    return rows;
  }

  return { REASON_TAGS, appendCorrectionsLog, readCorrectionsLog, allCorrections };
};
