// @ts-nocheck
'use strict';

/**
 * 把人工框選學進配圖記憶庫（data/shot-memory.json）。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得（測試可換成假的 fs／子程序）。
 */

module.exports = function create(ctx) {
  const { fs, path, config: { WORKSPACE_ROOT }, SHOT_MEMORY, jobPath, appendLog, nowISO } = ctx;

  /**
   * 把這一支的人工框選學進 data/shot-memory.json，下次遇到同一種頁面就自動套。
   *
   * 為什麼不是用 data/corrections.jsonl（修正紀錄）：那份是給人看的日記，
   * 出片流程一行都沒讀它 —— 使用者 2026-08-21 問「都有記錄了，下次應該就會自己認得吧？」
   * 答案是不會，因為沒有任何東西回頭讀它。這一支才是真的接回 auto-shot.js 的那條線。
   *
   * ⚠️ 圖片的頁型／代號要從**這支工作的快照**讀（jobs/<id>/state），不能讀 ROOT ——
   *    按確認的當下 ROOT 可能已經被下一支工作佔用了。
   */
  function learnFromEdits(job, edits) {
    try {
      const state = jobPath(job.id, 'state');
      const imgs = JSON.parse(
        fs.readFileSync(path.join(state, 'src', 'app-images.generated.json'), 'utf-8')).images || [];
      const chars = (job.planView && job.planView.chars) || [];
      const textOf = (a, b) => (a == null || b == null || !chars.length ? ''
        : chars.slice(a, b + 1).map((c) => c.c).join(''));
      // 只學「人真的動過的」—— 自動段原樣送回來的不算，學了等於把 AI 自己的判斷
      // 當成人的示範，會愈學愈歪（跟 applyPlanEdits 用同一個 _manual／_added 判準）。
      const items = edits
        .filter((e) => (e._manual || e._added) && !e.deleted && e.src && e.cell && e.cell.w > 0)
        .map((e) => ({
          src: e.src, cell: e.cell, region: e.region,
          imgW: e.imgW, imgH: e.imgH,
          phrase: textOf(e.startCharIdx, e.endCharIdx),
          startCharIdx: e.startCharIdx,
        }));
      // ── 標注頁畫的框也要學（2026-08-25）──
      // 原本只學「在計畫頁動過的」，但標注頁的框是**直接變成計畫的一部分**、不算「動過」，
      // 所以一次都沒被學進去。而 auto-shot 從 8/25 起預設只用人工標注 —— 標注頁的框
      // 就是唯一會進成品的東西，不學它等於整個記憶庫再也收不到料。
      // 按「標好了，直接出片」的工作更是完全沒有 edits，能學的全部在這裡。
      const seen = new Set(items.map((it) => `${it.src}@${it.startCharIdx}`));
      try {
        const ann = JSON.parse(fs.readFileSync(
          jobPath(job.id, 'input', 'annotations.json'), 'utf-8')).shots || [];
        for (const a of ann) {
          if (!a || !a.src || !a.cell || !(a.cell.w > 0)) continue;
          if (typeof a.startCharIdx !== 'number' || typeof a.endCharIdx !== 'number') continue;
          const lo = Math.min(a.startCharIdx, a.endCharIdx), hi = Math.max(a.startCharIdx, a.endCharIdx);
          if (seen.has(`${a.src}@${lo}`)) continue;   // 同一句已經從計畫頁學過了，不要重複灌
          seen.add(`${a.src}@${lo}`);
          items.push({
            src: a.src, cell: a.cell, region: a.region,
            imgW: a.imgW, imgH: a.imgH,
            phrase: textOf(lo, hi), startCharIdx: lo,
          });
        }
      } catch (_) {}
      if (!items.length) return;
      const r = SHOT_MEMORY.learn(WORKSPACE_ROOT, items, imgs, nowISO());
      const bits = [];
      if (r.learnedPages.length) bits.push(`${r.learnedPages.length} 種頁面的框位`);
      const names = Object.entries(r.learnedNames);
      if (names.length) bits.push('代號 ' + names.map(([c, n]) => `${c}=${n}`).join('、'));
      if (bits.length) appendLog(job, `\n🧠 記住了：${bits.join('　')}（下次遇到同型頁面會自動套用）\n`);
    } catch (e) {
      // 學不起來不能影響出片
      try { appendLog(job, `\n⚠️ 標注記憶寫入失敗（不影響出片）：${e.message}\n`); } catch (_) {}
    }
  }

  return { learnFromEdits };
};
