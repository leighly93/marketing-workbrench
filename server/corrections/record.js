// @ts-nocheck
'use strict';

/**
 * 確認出片時，比對「AI 原本／對照組」與「人改成什麼」寫成修正紀錄。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得（測試可換成假的 fs／子程序）。
 */

module.exports = function create(ctx) {
  const { fs, path, config: { ROOT, SHOTS_DIR }, jobPath, appendLog, charTimes, appendCorrectionsLog, saveJob } = ctx;
    const execFileSync = (...a) => ctx.childProcess.execFileSync(...a);

  /**
   * 修正紀錄：AI 原本怎麼排、人改成什麼。
   * 這是判斷「什麼時候可以安心關掉審核關卡」的依據 ——
   * 某一類修正連續兩週沒出現，那部分就可以不用看了。
   */
  /**
   * 「系統原本會怎麼圈」——只給修正紀錄用，不會進影片。
   *
   * 2026-08-26 使用者定案：「我故意不畫黃框就是不要，不要幫我加上去；最終影片顯示要照人手工框的，
   * 自動的部分一樣要做但是要記錄到『修正紀錄』裡。」`applyPlanEdits()` 因此不再補框，
   * 系統的判斷改由這支算出來寫進 `data/corrections.jsonl`。
   *
   * 做法是 spawn 一次 `video/shots/auto-shot.js --suggest-cells=`，跟「對照組」（`--no-annots`）
   * 同一個模式 —— 那組挑框規則（漲跌幅／數字／整列／記憶庫／標題）吃 REGIONS、官方股名表、
   * 記憶庫、OCR 詞框合併一整套模組層狀態，抽成共用模組給這裡 require 等於開第二份實作。
   *
   * ⚠️ 一定要讀 `jobs/<id>/state` 快照的腳本與圖片分析，不可以讀 ROOT —— 按下「確認，開始出片」
   *    的當下，ROOT 可能已經被下一支工作佔用了（`learnFromEdits()` 早就踩過同一個坑）。
   * ⚠️ 記憶庫刻意讀 ROOT 的最新版，但**本函式一定要在 `learnFromEdits()` 之前跑**
   *    （`/approve` 與 autoApprove 兩條路現在都是這個順序），否則建議會被使用者這一支剛教的
   *    東西污染，變成「系統早就知道」的假象。
   * 算失敗就回空的 —— 寧可少記，不要記出假的比對（沿用對照組的處置）。
   */
  function suggestCellsFor(job, items) {
    const map = {};
    try {
      if (!Array.isArray(items) || !items.length) return map;
      const st = jobPath(job.id, 'state');
      const script = path.join(st, 'public', 'script.txt');
      const images = path.join(st, 'src', 'app-images.generated.json');
      if (!fs.existsSync(script) || !fs.existsSync(images)) return map;
      const seen = new Set();
      const want = [];
      for (const it of items) {
        if (!it || !it.src || typeof it.startCharIdx !== 'number' || typeof it.endCharIdx !== 'number') continue;
        const lo = Math.min(it.startCharIdx, it.endCharIdx), hi = Math.max(it.startCharIdx, it.endCharIdx);
        const k = `${it.src}@${lo}~${hi}`;
        if (seen.has(k)) continue;
        seen.add(k);
        want.push({ src: it.src, startCharIdx: lo, endCharIdx: hi });
      }
      if (!want.length) return map;
      const inF = jobPath(job.id, 'cell-suggest-in.json');
      const outF = jobPath(job.id, 'cell-suggest.json');
      fs.writeFileSync(inF, JSON.stringify(want, null, 2));
      execFileSync('node', [path.join(SHOTS_DIR, 'auto-shot.js'),
        `--script=${script}`, `--images=${images}`, `--suggest-cells=${inF}`, '--out', outF],
        { cwd: ROOT, stdio: 'ignore', timeout: 120000 });
      const arr = JSON.parse(fs.readFileSync(outF, 'utf-8'));
      (Array.isArray(arr) ? arr : []).forEach((r) => {
        map[`${r.src}@${r.startCharIdx}~${r.endCharIdx}`] = r;
      });
      const boxed = Object.values(map).filter((r) => r && r.cell).length;
      appendLog(job, `\n🔍 系統框選建議：${want.length} 段算出 ${boxed} 個框（只寫進修正紀錄，不進影片）\n`);
    } catch (e) {
      appendLog(job, `\n⚠️ 系統框選建議計算失敗（不影響出片，只是修正紀錄少一項）：${e.message}\n`);
    }
    return map;
  }

  function recordCorrections(job, before, edits) {
    const diffs = [];
    const beforeRows = (before && before.rows) || []; // 缺 planView 也不要讓 approve 整個掛掉
    const chars = (before && before.chars) || [];
    const ct = (() => {
      try {
        return JSON.parse(fs.readFileSync(jobPath(job.id, 'state', 'src/subtitles.json'), 'utf-8'))
          ._scriptCharTimes || [];
      } catch (_) { return charTimes(); }
    })();

    const textOf = (a, b) => (a == null || b == null || !chars.length ? ''
      : chars.slice(a, b + 1).map((c) => c.c).join(''));
    const secOf = (a, b) => {
      const st = ct[a] ? ct[a].start : null, en = ct[b] ? ct[b].end : null;
      return st == null || en == null ? null : `${st.toFixed(1)}~${en.toFixed(1)}s`;
    };
    // 框的比對一律先四捨五入 —— 前台拖出來的是浮點數，計畫檔裡是整數，不歸一化會每次都判定「改過」
    const box = (x) => (x && x.w > 0 && x.h > 0
      ? { x: Math.round(x.x), y: Math.round(x.y), w: Math.round(x.w), h: Math.round(x.h) } : null);
    const same = (x, y) => JSON.stringify(box(x)) === JSON.stringify(box(y));
    // 箭頭（2026-09-16）：兩個端點＋顏色，長度 0 當成沒畫。
    const arw = (a) => (a && [a.x1, a.y1, a.x2, a.y2].every((n) => typeof n === 'number' && Number.isFinite(n))
      && Math.hypot(a.x2 - a.x1, a.y2 - a.y1) > 0
      ? { x1: Math.round(a.x1), y1: Math.round(a.y1), x2: Math.round(a.x2), y2: Math.round(a.y2),
        color: String(a.color || '').toLowerCase() || null } : null);
    const sameArw = (x, y) => JSON.stringify(arw(x)) === JSON.stringify(arw(y));
    // 使用者在編輯器選的原因（快選標籤 + 補充文字）。一列可能產生多筆 diff，都掛同一份原因。
    // ⚠️ 2026-08-21 起前台不再送這兩個欄位（編輯器的「為什麼要改」已移除），所以新紀錄的
    //    `reason` 一律是 null，修正紀錄頁那一欄會顯示「—」。**故意留著不拆**：
    //    `data/corrections.jsonl` 裡的舊資料還有原因、頁面照樣要顯示；而且哪天要恢復問原因，
    //    只要把前台那塊加回來就通，伺服器端不用再動。
    const reasonOf = (e) => {
      const tags = Array.isArray(e.reasonTags) ? e.reasonTags.filter(Boolean) : [];
      const note = typeof e.reasonNote === 'string' ? e.reasonNote.trim() : '';
      return tags.length || note ? { tags, note } : null;
    };
    // 這張圖在自動計畫裡出現過幾次 → 判斷「AI 完全沒用到」還是「用了但沒配到這一句」
    // 「AI 本來會怎麼配」＝ 對照組（jobs/<id>/auto-noannots.json，buildCounterfactual 產的）。
    // ⚠️ 2026-08-25 起計畫檔只放人工標注（auto-shot 預設濾掉自動段），planView.rows 裡
    //    **已經沒有 AI 的判斷了** —— 再拿它當「AI 本來的樣子」會講出假話
    //    （「AI 完全沒用到這張圖」其實只是「人沒用到」）。統一改讀對照組。
    //    對照組讀不到就退回舊行為，寧可粗糙也不要整段沒有。
    let cfRows = beforeRows;
    try {
      const cf = JSON.parse(fs.readFileSync(jobPath(job.id, 'auto-noannots.json'), 'utf-8'));
      if (Array.isArray(cf) && cf.length) cfRows = cf;
    } catch (_) {}
    const autoUse = {};
    cfRows.forEach((r) => { autoUse[r.src] = (autoUse[r.src] || 0) + 1; });

    // ── 「系統原本會怎麼圈」（2026-08-26）──
    // 成品的框只吃人工畫的（applyPlanEdits 不再補框），系統的判斷在這裡算出來、只寫進紀錄。
    // 一次把「這一支所有有範圍的段落」都問完（一次 spawn），下面各類型再各自取用。
    const wantSuggest = [];
    edits.forEach((e) => {
      const b = beforeRows[e.i] || {};
      wantSuggest.push({ src: e.src || b.src, startCharIdx: e.startCharIdx, endCharIdx: e.endCharIdx });
    });
    try {
      const ann0 = JSON.parse(fs.readFileSync(
        jobPath(job.id, 'input', 'annotations.json'), 'utf-8')).shots || [];
      ann0.forEach((a) => wantSuggest.push(a));
    } catch (_) { /* 沒有標注檔就只問計畫頁改過的那些 */ }
    const SUG = suggestCellsFor(job, wantSuggest);
    const sugOf = (src, a, b) => (src == null || a == null || b == null ? null
      : SUG[`${src}@${Math.min(a, b)}~${Math.max(a, b)}`] || null);
    /** 人沒畫黃框、系統原本會框 → 補一句話進「AI 當時的判斷」欄 */
    const sugNote = (sug, manualCell) => (sug && sug.cell && !box(manualCell)
      ? `；人刻意不畫黃框，系統原本會框「${sug.cellText || '—'}」（${sug.why || '規則判定'}）——`
        + '只記錄、不進影片'
      : '');

    edits.forEach((e) => {
      const reason = reasonOf(e);
      const phrase = textOf(e.startCharIdx, e.endCharIdx);

      // ── 新增一段：AI 漏掉的圖被人補上 ──
      // 2026-08-18 使用者要求：要記「為什麼 AI 沒判斷到」，所以除了那句旁白，
      // 還記下這張圖自動計畫用過幾次、這段旁白原本被哪張圖蓋著（＝AI 當時的判斷）。
      if (e._added) {
        if (e.startCharIdx == null) return;
        const coveredBy = cfRows.filter((r) => r.startCharIdx != null
          && r.startCharIdx <= e.endCharIdx && r.endCharIdx >= e.startCharIdx);
        const sug = sugOf(e.src, e.startCharIdx, e.endCharIdx);
        diffs.push({
          type: '新增一段',
          phrase,
          from: e.src, to: e.src,
          systemCell: sug ? box(sug.cell) : null,
          systemCellText: sug ? sug.cellText : null,
          systemPage: sug ? sug.page : null,   // 2026-09-03：記下系統當時判的頁型（cell-suggest 本來就帶 page），給 page-types / memKey 用
          systemWhy: sug ? sug.why : null,
          autoWhy: (autoUse[e.src]
            ? `AI 用過這張圖 ${autoUse[e.src]} 次，但沒配到這一句`
            : 'AI 完全沒用到這張圖') + sugNote(sug, e.cell),
          autoCoveredBy: coveredBy.map((r) => r.src + (r.cellText ? `（${r.cellText}）` : '')),
          manual: secOf(e.startCharIdx, e.endCharIdx),
          manualChars: `${e.startCharIdx}~${e.endCharIdx}`,
          manualCell: box(e.cell), manualRegion: box(e.region), manualArrow: arw(e.arrow),
          size: e.imgW && e.imgH ? { w: e.imgW, h: e.imgH } : null,
          reason,
        });
        return;
      }

      const b = beforeRows[e.i];
      if (!b) return;
      if (e.deleted) { diffs.push({ type: '刪掉這段', phrase: b.phrase, from: b.src, reason }); return; }

      if (e.src && e.src !== b.src)
        diffs.push({ type: '換圖', phrase: b.phrase || phrase, from: b.src, to: e.src, reason });

      // ── 改框 ──
      // 2026-08-18 使用者要求：「就算 AI 原本沒框也要記錄為什麼人手動框了」。
      // 原本的判斷式是 `e.cell && b.cell`，所以「AI 沒框、人自己框」這個最重要的訊號
      // 完全記不到；而且 region（顯示區域）從頭到尾沒進紀錄 —— 只畫顯示區域是最常見的操作。
      const cellChanged = !same(e.cell, b.cell);
      const regionChanged = !same(e.region, b.region);
      // 只加了箭頭、框一個都沒動也是一次人工修正 —— 不記的話這一列在紀錄裡完全看不到（2026-09-16）
      const arrowChanged = !sameArw(e.arrow, b.arrow);
      if (cellChanged || regionChanged || arrowChanged) {
        const hadAuto = !!(box(b.cell) || box(b.region));
        const hasManual = !!(box(e.cell) || box(e.region));
        const sug = sugOf(e.src || b.src, e.startCharIdx ?? b.startCharIdx, e.endCharIdx ?? b.endCharIdx);
        diffs.push({
          type: '改框',
          phrase: b.phrase || phrase,
          from: b.src,
          autoCell: box(b.cell), manualCell: box(e.cell),
          autoRegion: box(b.region), manualRegion: box(e.region),
          autoArrow: arw(b.arrow), manualArrow: arw(e.arrow),
          autoCellText: b.cellText,
          systemCell: sug ? box(sug.cell) : null,
          systemCellText: sug ? sug.cellText : null,
          systemPage: sug ? sug.page : null,   // 2026-09-03：記下系統當時判的頁型（cell-suggest 本來就帶 page），給 page-types / memKey 用
          systemWhy: sug ? sug.why : null,
          autoWhy: (!cellChanged && !regionChanged
            // 框一個都沒動、只動了箭頭 —— 不要套下面那幾句（會變成「人自己框了」這種假話）
            ? '框沒有動，人只加／改了箭頭 → 自動配圖沒有箭頭這回事，一律是人工標的'
            : !hadAuto
              ? 'AI 原本沒框（整張顯示），人自己框了 → 自動判定沒抓到重點'
              : !hasManual
                ? '人把 AI 的框整個拿掉，改成整張顯示'
                : `AI 框了「${b.cellText || '—'}」，人改了位置或大小`) + sugNote(sug, e.cell),
          changed: [cellChanged ? '黃框' : null, regionChanged ? '顯示區域' : null,
            arrowChanged ? '箭頭' : null].filter(Boolean).join('＋'),
          size: b.imageWidth && b.imageHeight ? { w: b.imageWidth, h: b.imageHeight } : null,
          reason,
        });
      }

      // ── 改時間 ──
      // 2026-08-18 修正：原本比對 e.start / e.end，但前台改出現範圍時只更新
      // startCharIdx / endCharIdx，start / end 一直是自動算出來的值 → 差值永遠 0，
      // 這一類從上線到現在「從來沒有被記錄過一筆」。改成以字元索引為準。
      if (e.startCharIdx != null && b.startCharIdx != null
        && (e.startCharIdx !== b.startCharIdx || e.endCharIdx !== b.endCharIdx)) {
        diffs.push({
          type: '改時間',
          phrase: b.phrase || phrase,
          from: b.src,
          auto: secOf(b.startCharIdx, b.endCharIdx)
            || `${(b.start ?? 0).toFixed(1)}~${(b.end ?? 0).toFixed(1)}s`,
          manual: secOf(e.startCharIdx, e.endCharIdx),
          autoChars: `${b.startCharIdx}~${b.endCharIdx}`,
          manualChars: `${e.startCharIdx}~${e.endCharIdx}`,
          autoPhrase: b.phrase || textOf(b.startCharIdx, b.endCharIdx),
          manualPhrase: phrase,
          autoWhy: 'AI 給的出現範圍不對（太長／太短／位置偏了）',
          reason,
        });
      }
    });

    // ── 人工標記 vs 對照組 ────────────────────
    // 「手動標記」頁標過的句子，auto-shot／auto-focus 是**完全不碰**的 —— 標注本身就變成
    // 計畫的一部分，所以上面那個迴圈永遠比不出差異，最有價值的訊號（人覺得非自己標不可）
    // 一筆都留不下來。`buildCounterfactual()` 在準備階段多跑了一次 `--no-annots`，
    // 這裡拿那份「AI 本來會怎麼配」來對照（2026-08-21 使用者：「要，而且要真的比對」）。
    // 對照組算失敗（檔案不在）就整段跳過 —— 寧可少記，不要記出假的比對。
    try {
      const ann = JSON.parse(fs.readFileSync(
        jobPath(job.id, 'input', 'annotations.json'), 'utf-8')).shots || [];
      const cf = JSON.parse(fs.readFileSync(
        jobPath(job.id, 'auto-noannots.json'), 'utf-8')) || [];
      // ⚠️ 現存版型的對照組段落一律帶 src，所以這裡直接比對就好。
      //    2026-09-14 曾為 focus 版型（三大法人）補過一條例外：它的段落沒有 src、圖永遠是
      //    那張版面截圖，直接比會全部比出 undefined、`from` 變空字串，修正紀錄頁就一律顯示
      //    「（AI 本來不配圖）」—— institution 的 38 筆全是這樣來的。該版型 2026-09-22 移除，
      //    例外一併拿掉；那 38 筆歷史紀錄改由 correctionRows() 認代號標成 legacyNoSrc。
      const cfSrc = (c) => (c && c.src) || null;
      // 對照組整份是空的（auto-shot 這一輪一段都沒排，多半是頁型沒認出來）
      // ＝ 這支根本沒有可比的基準，不是「AI 判斷這裡不用配圖」。兩者要分開講。
      const noCf = !Array.isArray(cf) || !cf.length;
      for (const a of ann) {
        if (!a || !a.src || typeof a.startCharIdx !== 'number' || typeof a.endCharIdx !== 'number') continue;
        const lo = Math.min(a.startCharIdx, a.endCharIdx), hi = Math.max(a.startCharIdx, a.endCharIdx);
        // 對照組裡蓋到這段旁白的所有段落 ＝ AI 本來會在這裡放的東西
        const hit = (Array.isArray(cf) ? cf : []).filter((c) => c && c.startCharIdx != null
          && !(c.endCharIdx < lo || c.startCharIdx > hi));
        const first = hit[0] || null;
        const hitSrcs = [...new Set(hit.map(cfSrc).filter(Boolean))];
        const sameImg = hit.some((c) => cfSrc(c) === a.src);
        const manualBoxed = !!(box(a.cell) || box(a.region));
        const sug = sugOf(a.src, lo, hi);
        diffs.push({
          type: '人工標記',
          systemCell: sug ? box(sug.cell) : null,
          systemCellText: sug ? sug.cellText : null,
          systemPage: sug ? sug.page : null,   // 2026-09-03：記下系統當時判的頁型（cell-suggest 本來就帶 page），給 page-types / memKey 用
          systemWhy: sug ? sug.why : null,
          phrase: textOf(lo, hi),
          from: hitSrcs.length ? hitSrcs.join('／') : null,
          // 「原本」為空時，這一欄說明是哪一種空：沒得比（noCf）還是真的沒配（none）。
          // 舊紀錄沒有這個欄位，前台會照舊顯示（見 app.js 的 drawFix）。
          autoKind: noCf ? 'noCounterfactual' : (hit.length ? 'covered' : 'none'),
          to: a.src,
          auto: first ? secOf(first.startCharIdx, hit[hit.length - 1].endCharIdx) : null,
          autoChars: first ? `${first.startCharIdx}~${hit[hit.length - 1].endCharIdx}` : null,
          autoCell: first ? box(first.cell) : null,
          autoRegion: first ? box(first.region) : null,
          autoCellText: first ? (first.cellText || (first.wholePage ? '整張顯示' : '')) : '',
          manual: secOf(lo, hi),
          manualChars: `${lo}~${hi}`,
          manualCell: box(a.cell), manualRegion: box(a.region), manualArrow: arw(a.arrow),
          autoWhy: (noCf
            ? '這一支的對照組一段都沒排出來（多半是頁型沒認出來），所以比不出 AI 本來會怎麼配'
            : !hit.length
              ? '這一句 AI 本來一張圖都不會配（對照組：留在講者畫面）'
              : !sameImg
                ? `AI 本來會配「${hitSrcs.join('／')}」，人改用「${a.src}」`
                : manualBoxed
                  ? `AI 本來也用這張圖、框「${first.cellText || '整張顯示'}」，人自己框了別的地方`
                  : 'AI 本來也用這張圖，人只是重新指定了出現範圍') + sugNote(sug, a.cell),
          size: a.imgW && a.imgH ? { w: a.imgW, h: a.imgH } : null,
          reason: null,
        });
      }
    } catch (_) { /* 沒有標注或沒有對照組 → 這一類就不記 */ }

    job.corrections = diffs;
    // autoPlan＝「AI 本來會怎麼配」的存證（只寫進 job.json，publicJob 會把它拿掉不外送）。
    // 2026-08-25 起一樣改讀對照組 —— 計畫檔裡已經沒有自動段了，照舊寫的話這欄會變成
    // 「人工計畫」的複本，名不副實，之後翻紀錄的人會被騙。
    job.autoPlan = cfRows.map((r, i) => ({
      i: r.i != null ? r.i : i,
      src: r.src,
      cellText: r.cellText || (r.wholePage ? '整張顯示' : ''),
      phrase: r.phrase || r._phrase || '',
    }));
    appendCorrectionsLog(job, diffs);
    saveJob(job);
    return diffs;
  }

  return { suggestCellsFor, recordCorrections };
};
