// @ts-nocheck
'use strict';

/**
 * 配圖計畫：讀取、子句、待補標注、頁型，整理成前台的計畫檢視（含縮圖）。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得（測試可換成假的 fs／子程序）。
 */

module.exports = function create(ctx) {
  const { fs, path, config: { ROOT, SHOTS_DIR }, TEMPLATES, TEMPLATE_ASSET, jobPath, ensureDir, appendLog,
    readJobEmphasis, emphasisOf } = ctx;
    const execFileSync = (...a) => ctx.childProcess.execFileSync(...a);

  // ── 配圖計畫：讀取／縮圖／寫回 ──────────────
  function charTimes() {
    try {
      return JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'subtitles.json'), 'utf-8'))._scriptCharTimes || [];
    } catch (_) { return []; }
  }

  /**
   * 取子句清單。切法與字元對位一律交給 auto-shot.js 算（--sentences），
   * 伺服器不自己實作第二套 —— 兩套遲早會漂走。
   */
  function scriptUnits(scriptPath) {
    if (!fs.existsSync(scriptPath)) return { units: [], chars: [] };
    try {
      const out = execFileSync('node', [path.join(SHOTS_DIR, 'auto-shot.js'), '--sentences', `--script=${scriptPath}`],
        { cwd: ROOT, encoding: 'utf-8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
      const j = JSON.parse(out);
      return { units: j.units || [], chars: j.chars || [] };
    } catch (_) { return { units: [], chars: [] }; }
  }
  function unitsOf(scriptPath) { return scriptUnits(scriptPath).units; }

  function readPlanFrom(baseDir, tpl) {
    const cfg = TEMPLATES[tpl];
    if (!cfg || !cfg.plan) return null;
    const f = path.join(baseDir, cfg.plan);
    if (!fs.existsSync(f)) return null;
    try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch (_) { return null; }
  }

  function shotsOf(plan) {
    if (!plan) return [];
    return Array.isArray(plan) ? plan : plan.shots || [];
  }

  /**
   * 計畫的「一列」清單。
   * ⚠️ buildPlanView 與 applyPlanEdits **一定要都走這支** —— 前台回傳的 `e.i` 是這個陣列的索引，
   *    兩邊併的順序只要差一點，人改的東西就會套到別一列上去。
   * 2026-09-22：planKind 'focus'（三大法人那套「區塊帶＋黃框」，一列不是一張截圖、
   * 座標靠 OCR 逐字框在渲染時算出來）隨該版型移除，現存版型全是 'shots'，所以這裡只剩一條路。
   * 那套寫回規則連同 focusRowView()／findCellIn() 一起刪了，要看原樣翻這個 commit 的 diff。
   */
  function planItemsOf(baseDir, tpl) {
    const plan = readPlanFrom(baseDir, tpl);
    return { plan, items: shotsOf(plan) };
  }

  /**
   * 沒被自動計畫吃到的手動標注。
   * auto-shot 是在 run.js 最後才讀 public/annotations.json 的。標注頁存檔的時間
   * 只要晚於那一刻（勾「用現成的講者影片」時，「準備中」可能只有幾十秒），那筆標注
   * 就進不了計畫 —— 前台看起來就是「我標的那張圖不見了」（2026-08-21 使用者回報）。
   * 前台會把這裡回傳的每一筆自動補成人工段，使用者不用重標。
   * 比對規則：同一張圖、字元範圍有重疊就算已經進去了
   *（auto-shot 會微調頭尾、也會合併，不能只比對相等）。
   */
  function pendingAnnotsOf(job, rows) {
    let ann = [];
    try {
      ann = JSON.parse(fs.readFileSync(
        jobPath(job.id, 'input', 'annotations.json'), 'utf-8')).shots || [];
    } catch (_) { return []; }
    return ann
      .filter((a) => a && a.src
        && typeof a.startCharIdx === 'number' && typeof a.endCharIdx === 'number')
      .map((a) => ({
        src: a.src,
        startCharIdx: Math.min(a.startCharIdx, a.endCharIdx),
        endCharIdx: Math.max(a.startCharIdx, a.endCharIdx),
        region: a.region || null, cell: a.cell || null, arrow: a.arrow || null,
        imgW: a.imgW || null, imgH: a.imgH || null,
      }))
      .filter((a) => !(rows || []).some((r) => r.src === a.src && r.startCharIdx != null
        && !(r.endCharIdx < a.startCharIdx || r.startCharIdx > a.endCharIdx)));
  }

  /**
   * approve 的當下再算一次「還沒進計畫的人工標注」，補成人工段。
   *
   * 為什麼要再算一次：`pendingAnnotsOf()` 只在**進編輯頁的那一刻**算一次，判斷「這筆標注
   * 有沒有被計畫收進去」。同事接著把那一列改去別的區間之後，原本代表那筆標注的列就不見了，
   * 那筆標注會無聲無息消失，前台也不會再提醒（2026-08-25 使用者回報；0825 那支
   * shot1@62~79「框加權指數 45169.46」就是這樣不見的）。
   *
   * ⚠️ 被同事**刪掉**的段落不要復活 —— 同一張圖、範圍重疊而且 deleted 的，視為刻意移除。
   */
  function appendMissingAnnots(job, edits) {
    let ann = [];
    try {
      ann = JSON.parse(fs.readFileSync(
        jobPath(job.id, 'input', 'annotations.json'), 'utf-8')).shots || [];
    } catch (_) { return edits; }
    const overlaps = (a, list) => list.some((e) => e.src === a.src
      && typeof e.startCharIdx === 'number' && typeof e.endCharIdx === 'number'
      && !(e.endCharIdx < a.lo || e.startCharIdx > a.hi));
    const kept = edits.filter((e) => !e.deleted);
    const dropped = edits.filter((e) => e.deleted);
    const added = [];
    ann.forEach((a, i) => {
      if (!a || !a.src) return;
      if (typeof a.startCharIdx !== 'number' || typeof a.endCharIdx !== 'number') return;
      const item = {
        src: a.src,
        lo: Math.min(a.startCharIdx, a.endCharIdx),
        hi: Math.max(a.startCharIdx, a.endCharIdx),
      };
      if (overlaps(item, kept)) return;      // 已經有段落代表它了
      if (overlaps(item, dropped)) return;   // 同事刻意刪掉的，不要復活
      added.push({
        i: `ann${i}`, _added: true, _manual: true, _late: true, deleted: false,
        src: a.src, cell: a.cell || null, region: a.region || null, arrow: a.arrow || null,
        startCharIdx: item.lo, endCharIdx: item.hi,
        imgW: a.imgW || null, imgH: a.imgH || null,
      });
    });
    if (added.length) {
      appendLog(job, `\n✋ 有 ${added.length} 筆人工標注沒被計畫收進去，已自動補回（不補的話會無聲消失）\n`);
    }
    return added.length ? edits.concat(added) : edits;
  }

  /**
   * 把配圖計畫整理成前台看得懂的樣子：秒數、框住什麼、縮圖。
   * 縮圖是「截圖上畫好黃框」的小圖 —— 同事不用想像，一眼就知道會框到哪。
   */
  /** 這支工作每張截圖「系統判定的頁型」：{ 檔名: { page, pageLabel, stockName, stockCode, width, height } }。讀不到就空物件。 */
  function pagesOf(state) {
    const out = {};
    try {
      const ims = JSON.parse(fs.readFileSync(path.join(state, 'src', 'app-images.generated.json'), 'utf-8')).images || [];
      for (const im of ims) out[im.file] = { page: im.page || 'unknown', pageLabel: im.pageLabel || '未知頁面',
        stockName: im.stockName || null, stockCode: im.stockCode || null, width: im.width, height: im.height };
    } catch (_) {}
    return out;
  }

  function buildPlanView(job) {
    const state = jobPath(job.id, 'state');
    const ct = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(state, 'src/subtitles.json'), 'utf-8'))._scriptCharTimes || [];
      } catch (_) { return charTimes(); }
    })();
    const shots = planItemsOf(state, job.template).items;
    const thumbDir = jobPath(job.id, 'thumbs');
    ensureDir(thumbDir);

    const rows = shots.map((s, i) => {
      const st = ct[s.startCharIdx] ? ct[s.startCharIdx].start : null;
      const en = ct[s.endCharIdx] ? ct[s.endCharIdx].end : null;
      const thumb = `plan-${i}.png`;
      try { makeThumb(path.join(state, 'public', s.src), s.cell, path.join(thumbDir, thumb)); }
      catch (_) {}
      return {
        i,
        src: s.src,
        phrase: s._phrase || '',
        start: st, end: en,
        dur: st != null && en != null ? +(en - st).toFixed(1) : null,
        cellText: s.cellText || (s.wholePage ? '整張' : ''),
        wholePage: !!s.wholePage,
        // 框的座標與原圖尺寸 —— 前台直接用比例畫出來，也讓人可以拖著改
        //（2026-08-17 使用者：「我認為你可以看我手動來學習」）
        cell: s.cell || null,
        region: s.region || null,
        // 箭頭（2026-09-16）。ffmpeg 縮圖畫不出箭頭（drawbox 只能畫軸對齊矩形），
        // 前台的 preview() 是自己用 SVG 疊的，所以這個欄位一定要跟著送過去。
        arrow: s.arrow || null,
        // 前台在腳本上拖選，存的就是字元索引（比叫人填秒數直觀得多）
        startCharIdx: s.startCharIdx,
        endCharIdx: s.endCharIdx,
        imageWidth: s.imageWidth || null,
        imageHeight: s.imageHeight || null,
        thumb: fs.existsSync(path.join(thumbDir, thumb)) ? thumb : null,
      };
    });

    // 可以換的圖：這支工作上傳的所有截圖
    const images = [];
    const pub = path.join(state, 'public');
    if (fs.existsSync(pub)) {
      for (const n of fs.readdirSync(pub)) {
        if (TEMPLATE_ASSET.test(n)) continue;
        if (/\.(png|jpe?g)$/i.test(n)) images.push(n);
      }
    }
    const totalSec = ct.length ? ct[ct.length - 1].end : null;
    return {
      // 2026-08-21 起配圖計畫一律能線上改（使用者：「配圖計劃也改人手工，因為現在配的還是不好」）。
      // 前台的閘門看 editable。舊的 kind 欄位（TEMPLATES[].planKind）已於 2026-09-22 隨 focus
      // 分支一起移除 —— 當時漏刪這裡的簡寫，準備中算計畫時會 ReferenceError（2026-09-22 修）。
      editable: true,
      // 三大法人的聚焦是「捲到區塊帶 + 壓暗其餘」，沒有「往下滑動」這回事 ——
      // 勾了也不會有任何效果，所以前台不要畫那個勾選框（靜默失效比沒有更糟）。
      rows, images, totalSec,
      // 字幕重點詞（2026-09-17）：存腳本字元範圍。
      // 以工作自己的 input/emphasis.json 為準；沒有才退回快照 —— 快照那份是這個功能
      // 剛上線、還沒有獨立儲存端點時留下的，只為了讓那幾支舊工作不要平白少掉標記。
      emphasis: (() => {
        const own = readJobEmphasis(job);
        return own.length ? own : emphasisOf(state);
      })(),
      // 2026-09-07 每張圖系統判定的頁型，給審核頁顯示＋決定要不要給 📌（認不出來才給）。
      pages: pagesOf(state),
      pendingAnnots: pendingAnnotsOf(job, rows),
      ...scriptUnits(path.join(state, 'public', 'script.txt')),
      unused: images.filter((n) => !rows.some((r) => r.src === n)),
    };
  }

  /** 用 ffmpeg 在截圖上畫黃框、縮成小圖 */
  function makeThumb(imgPath, cell, outPath) {
    if (!fs.existsSync(imgPath)) return;
    if (fs.existsSync(outPath)) return;
    const vf = [];
    if (cell && cell.w > 0 && cell.h > 0) {
      vf.push(`drawbox=x=${Math.round(cell.x)}:y=${Math.round(cell.y)}:w=${Math.round(cell.w)}:h=${Math.round(cell.h)}:color=yellow@0.95:t=10`);
    }
    vf.push('scale=300:-1');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', imgPath, '-vf', vf.join(','), outPath], {
      stdio: 'ignore', timeout: 20000,
    });
  }

  return { charTimes, scriptUnits, unitsOf, readPlanFrom, shotsOf, planItemsOf, pendingAnnotsOf, appendMissingAnnots, pagesOf, buildPlanView, makeThumb };
};
