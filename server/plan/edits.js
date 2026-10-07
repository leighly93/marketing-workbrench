// @ts-nocheck
'use strict';

/**
 * 把配圖計畫頁的人工修改寫回工作區的計畫檔。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得（測試可換成假的 fs／子程序）。
 */

module.exports = function create(ctx) {
  const { fs, path, config: { ROOT }, TEMPLATES, planItemsOf, unitsOf, pickImageSize, resolveManualOverlaps, appendLog } = ctx;

  /**
   * 把使用者改過的計畫寫回快照裡的計畫檔。
   * 只支援 v1 開放的三種修改：換圖 / 切換滑動 / 刪掉這段。
   * 換圖時原本的框座標就沒意義了 —— 改成框新那張圖的標題（跟 auto-shot 的退路一致）。
   */
  function applyPlanEdits(job, edits) {
    // ⚠️ 2026-08-18 真因修正（「手動框選一直不見、而且沒勾滑動卻自己滑」）：
    // 這裡要改的是「ROOT 工作區」，不是 jobs/<id>/state 快照。
    // doRender 的順序是 restoreWorkspace(state → ROOT) 之後才呼叫本函式，
    // 而 run.js --render-only 只讀 ROOT 的 *.generated.json。
    // 原本寫回快照 = 寫進一個 doRender 結尾就 rmrf 掉的資料夾 →
    // 所有人工框選／改時間／加一段全部靜默消失，render 用的還是自動計畫
    // （當年還會自動帶上已移除的 pan:true），前台卻顯示「已套用 N 項人工修正」。
    // 過去每次都在下面的合併／裁切邏輯裡找原因，但那些程式根本沒作用在被 render 的檔案上。
    const state = ROOT;
    const cfg = TEMPLATES[job.template];
    const f = path.join(state, cfg.plan);
    const { plan, items: shots } = planItemsOf(state, job.template);
    if (!plan) throw new Error('找不到配圖計畫檔');

    let images = [];
    try {
      images = JSON.parse(fs.readFileSync(path.join(state, 'src/app-images.generated.json'), 'utf-8')).images || [];
    } catch (_) {}

    // 秒數 → 字元索引（人工調時間用）。取「結束時間還沒超過目標」的最後一個字。
    let CT = [];
    try {
      CT = JSON.parse(fs.readFileSync(path.join(state, 'src/subtitles.json'), 'utf-8'))._scriptCharTimes || [];
    } catch (_) {}
    const idxAtStart = (t) => {
      let best = 0;
      for (let i = 0; i < CT.length; i++) if (CT[i] && CT[i].start <= t) best = i;
      return best;
    };
    const idxAtEnd = (t) => {
      let best = 0;
      for (let i = 0; i < CT.length; i++) if (CT[i] && CT[i].end <= t) best = i;
      return best;
    };

    const UNITS = unitsOf(path.join(state, 'public', 'script.txt'));

    const keep = [];
    edits.forEach((e) => {
      // e._added = 前台「＋ 加一段」新增的段，原本計畫裡沒有 → 從空白開始
      //（2026-08-18 使用者：上傳 6 張只自動用了 2 張，其餘要能自己補上）。
      const s = e._added ? {} : shots[e.i];
      if (!s || e.deleted) return;
      // 新增的段一定要有出現範圍，否則是半成品，跳過
      if (e._added && !(typeof e.startCharIdx === 'number' || typeof e.from === 'number')) return;
      if (e._added) { s.src = ''; s._auto = false; s._added = true; }
      if (e.src && e.src !== s.src) {
        const img = images.find((m) => m.file === e.src);
        s.src = e.src;
        // ⚠️ 事後補上傳的圖不在 app-images.generated.json 裡（那支分析是在 doPrepare 一開頭
        //    跟 HeyGen 平行跑的），`img` 會是 undefined → imageWidth 沒有值 →
        //    ShotFocus.tsx 直接退成「整張顯示」，**使用者拉的框靜默失效**。
        //    退到前台量到的原圖尺寸（openEditor 存的 natW/natH）。2026-09-01 補上。
        // ⚠️ 2026-09-14：更糟的是「查得到、但那筆是**上一支工作**的同名圖」（見
        //    invalidateStaleAnalysis 的說明）—— 尺寸是別張圖的，框會整塊位移＋縮放。
        //    前台量到的 natW/natH 必定屬於這支工作正在看的那張圖，所以它一律優先。
        const picked = pickImageSize(img, e);
        s.imageWidth = picked.width;
        s.imageHeight = picked.height;
        // 尺寸對不上＝這筆分析是別張圖的 → 連帶的頁型也不能用（它決定自動配圖怎麼框）。
        s.page = img && !picked.stale ? img.page : undefined;
        // 換了圖一定要清掉舊圖的框 —— 框存的是「原圖像素座標」，套到另一張圖上一定是錯的位置。
        // ⚠️ 2026-08-26 使用者定案「**我故意不畫黃框就是不要，不要幫我加上去**」：
        //    這裡以前有一條退路，換圖又沒重畫框時就照 img.topicBox 框「頁面標題」。
        //    但 `_added`（前台「＋加一段」）的段是從 `s = {}` 開始的、`s.src` 永遠 undefined，
        //    所以這個條件**對每一筆新加的段都成立** → 使用者只畫顯示區域、故意不畫黃框，
        //    也會被補上一個框標題的黃框（0826「且南亞更直接攻上漲停」那段實測到，
        //    同支還有 shot7／shot8 框標題、shot4 框 PCB、shot5 框 ABF 四段）。
        //    現在一律不補。「系統原本會怎麼圈」改成只算給修正紀錄看（見 suggestCellFor()），
        //    不寫進計畫檔 —— 跟 2026-08-25「人工沒標就不要出現、自動判定只進修正紀錄」同一條規則，
        //    只是層級從「段落」下到「框」。
        delete s.cell; delete s.cellText;
        // 箭頭跟框一樣存原圖像素座標 —— 換了圖就是錯的位置，一起清掉（2026-09-16）。
        delete s.arrow;
        s.isColumn = false;
      }
      // 人工拖出來的框：完全照使用者給的，不再套任何自動推算。
      // ⚠️ region（顯示區域）與 cell（黃框）是兩件事，各自可有可無
      //（2026-08-17 使用者指出的設計錯誤）。
      const R = (b) => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) });
      if (e.cell !== undefined || e.region !== undefined) {
        const hasCell = e.cell && e.cell.w > 0 && e.cell.h > 0;
        const hasRegion = e.region && e.region.w > 0 && e.region.h > 0;
        if (hasCell) { s.cell = R(e.cell); s.cellText = '人工黃框'; s.isColumn = false; }
        else { delete s.cell; delete s.cellText; }
        if (hasRegion) s.region = R(e.region); else delete s.region;
        s.wholePage = !hasCell && !hasRegion;   // 都沒有 → 整張顯示
        s._manualCell = hasCell || hasRegion;
      }
      // ── 箭頭（2026-09-16 使用者定案）────────────────────────────
      // 跟 cell／region 完全獨立：可以只有箭頭、沒有任何框（那時 wholePage 仍是 true ——
      // 箭頭不改變圖片怎麼擺，渲染端 ShotFocus.tsx 對「wholePage ＋ 有箭頭」的段落特別放行）。
      // 存兩個端點的原圖像素座標；長度 0 或座標不是數字就當成沒畫。
      if (e.arrow !== undefined) {
        const a = e.arrow;
        const nums = a && [a.x1, a.y1, a.x2, a.y2].every((n) => typeof n === 'number' && Number.isFinite(n));
        if (nums && Math.hypot(a.x2 - a.x1, a.y2 - a.y1) > 0) {
          s.arrow = {
            x1: Math.round(a.x1), y1: Math.round(a.y1),
            x2: Math.round(a.x2), y2: Math.round(a.y2),
          };
          if (typeof a.color === 'string' && /^#[0-9a-f]{6}$/i.test(a.color)) s.arrow.color = a.color;
        } else {
          delete s.arrow;
        }
      }
      // 出現範圍：優先用「子句範圍」（前台拉的），秒數只是退路。
      // 子句 → 字元索引的對位是 auto-shot 算好附在 units 裡的，這裡只取頭尾。
      if (typeof e.startCharIdx === 'number' && typeof e.endCharIdx === 'number') {
        s.startCharIdx = Math.min(e.startCharIdx, e.endCharIdx);
        s.endCharIdx = Math.max(e.startCharIdx, e.endCharIdx);
        s._manualTime = true;
      } else if (typeof e.from === 'number' && typeof e.to === 'number') {
        const lo = Math.min(e.from, e.to), hi = Math.max(e.from, e.to);
        const u0 = UNITS.find((u) => u.i === lo), u1 = UNITS.find((u) => u.i === hi);
        if (u0 && u1 && u0.startCharIdx != null && u1.endCharIdx != null) {
          s.startCharIdx = u0.startCharIdx;
          s.endCharIdx = Math.max(u0.startCharIdx, u1.endCharIdx);
          s._manualTime = true;
        }
      } else if (CT.length && typeof e.start === 'number' && typeof e.end === 'number' && e.end > e.start) {
        s.startCharIdx = idxAtStart(e.start);
        s.endCharIdx = Math.max(s.startCharIdx, idxAtEnd(e.end));
        s._manualTime = true;
      }
      // 2026-08-18 修正：只有前台明確標記的段（_manual＝人工新增或編輯過、_added＝加一段）
      // 才算「人工段」。之前用「有沒有 cell/charIdx 欄位」來猜，但前台會把自動段的欄位
      // 原樣回傳，害自動段也被當成人工段、永遠不會被裁 → shot5 的自動滑動蓋掉手動黃框。
      s._userManual = !!(e._manual || e._added);
      keep.push(s);
    });

    const isManual = (s) => !!(s._userManual || s._annotated);

    // ── 人工段之間的重疊：後標的為主（2026-08-25 使用者定案「以後標的為主」）──
    // 下面那段只裁「自動段」而且只比對**同一張圖** → 兩段都是人工、又是不同圖的重疊
    // 完全沒人管，畫面上就是兩張截圖疊在一起（0825 那支 27.3~28.2 秒實測到的）。
    // ⚠️ 一定要在 keep.sort() **之前**做 —— 這裡的順序還是 edits 的順序，也就是
    //    「後加的排後面」（前台新增的段、appendMissingAnnots 補回來的都在最後），
    //    排序過就分不出誰先誰後了。
    // ⚠️ 主要防線其實在 video/shots/auto-shot.js（勾「直接出片」不會經過這裡）；
    //    這一份是擋「同事自己在計畫頁拉出重疊」的情況，兩邊用同一支演算法。
    {
      const mans = keep.filter(isManual);
      if (mans.length > 1) {
        const durOf = (a, b) => {
          const s0 = CT[a] ? CT[a].start : null, e0 = CT[b] ? CT[b].end : null;
          return s0 == null || e0 == null ? null : e0 - s0;
        };
        const r = resolveManualOverlaps(mans, { durOf, minSec: 1.4 });
        if (r.notes.length) {
          const rest = keep.filter((x) => !isManual(x));
          keep.length = 0;
          keep.push(...rest, ...r.items);
          appendLog(job, '\n🔀 人工段重疊，後標的為主：\n' + r.notes.map((n) => '   ' + n).join('\n') + '\n');
        }
      }
    }

    // 依出現時間排序 —— 新增的段可能插在中間，順序不對會讓「連續同圖合併」判斷錯
    keep.sort((a, b) => (a.startCharIdx ?? 0) - (b.startCharIdx ?? 0));

    // ── 人工段落蓋過重疊的自動段（同一張圖）──
    // 2026-08-18 使用者實際踩到：自動把 shot5 配成「整張滑動」(char133~176)，
    // 使用者又在 shot5 的 char133/143/151 手動框了欣興/景碩/南電。兩個時間重疊、
    // 又是同一張圖 → buildShotRuns 合併後，滑動那格把手動黃框蓋掉，框看起來「消失」。
    // 規則：手動段（_added / _manualCell / _manualTime）優先，把重疊到的「自動段」裁掉；
    // 自動段被裁到剩太少就整個拿掉。這樣「我手動框的一定會贏」。
    // （isManual 在上面「人工 vs 人工」那段就宣告了，兩處共用同一個判準。）
    const manuals = keep.filter(isManual);
    for (const a of keep) {
      if (isManual(a) || a.startCharIdx == null) continue; // 只裁自動段
      const origLen = (a.endCharIdx ?? 0) - (a.startCharIdx ?? 0) + 1;
      const origEnd = a.endCharIdx;
      const overlapped = [];
      for (const m of manuals) {
        if (m.src !== a.src || m.startCharIdx == null) continue;
        if (m.endCharIdx < a.startCharIdx || m.startCharIdx > a.endCharIdx) continue; // 沒重疊
        overlapped.push(m);
        // 手動段蓋住自動段開頭 → 自動段往後縮
        if (m.startCharIdx <= a.startCharIdx && m.endCharIdx >= a.startCharIdx)
          a.startCharIdx = m.endCharIdx + 1;
        // 手動段蓋住自動段結尾 → 自動段往前縮
        if (m.startCharIdx <= a.endCharIdx && m.endCharIdx >= a.endCharIdx)
          a.endCharIdx = m.startCharIdx - 1;
      }
      const newLen = (a.endCharIdx ?? 0) - (a.startCharIdx ?? 0) + 1;
      // 被裁到剩不到一半、或幾乎沒了 → 整段拿掉（使用者顯然是要用手動的取代它）
      if (a.startCharIdx > a.endCharIdx || newLen < Math.max(3, origLen * 0.5)) {
        a._drop = true;
        // 2026-08-18 使用者定案「依照我手動的判定為主」：
        // 自動段整段丟掉後，原本它撐著的「尾巴」會變成沒有圖 → 同一張圖中途下畫面、
        // 切回講者（實際踩到：手動框到「景碩漲近5%」為止，後面「AI GPU ASIC 帶動…」就沒圖了）。
        // 改成把「最後一個蓋到它的人工段」延長到原自動段的結尾：
        // 同一張圖全程不下畫面（ShotFocus 的原始設計），而且框沿用人工框，
        // 不會讓自動判定的框在句尾跳回來。
        const tail = overlapped
          .filter((m) => m.endCharIdx < origEnd)
          .sort((x, y) => y.endCharIdx - x.endCharIdx)[0];
        if (tail) {
          // 不可以延長到「下一段（別張圖）」的頭上去
          const nexts = keep.filter((s) => s !== a && s !== tail && !s._drop
            && s.startCharIdx != null && s.startCharIdx > tail.endCharIdx);
          const limit = nexts.length ? Math.min(...nexts.map((s) => s.startCharIdx)) - 1 : origEnd;
          tail.endCharIdx = Math.max(tail.endCharIdx, Math.min(origEnd, limit));
        }
      }
    }
    const kept = keep.filter((s) => !s._drop);

    const next = Array.isArray(plan) ? kept : { ...plan, shots: kept };
    fs.writeFileSync(f, JSON.stringify(next, null, 2));
    return kept.length;
  }

  return { applyPlanEdits };
};
