// @ts-nocheck —— 原樣搬過來，型別之後逐步補
'use strict';

/**
 * 配圖計畫的排法（純函式）：列舉句拆分 → 逐子句配圖 → 呈現時間規則 → 人工標注重疊處理。
 */
const { resolveManualOverlaps } = require('../pipeline/script-utils');

// 圖片只在「這一句真的講到對應內容」時出現（2026-08-12 使用者定案：
// 不用時間硬切，而是靠語意相關性）。判斷方式：這個子句要嘛自己配到圖，
// 要嘛在同一主題段落內、且能在圖上找到對應的數字或欄位。找不到就回講者。
// ── 呈現規則（2026-08-12 依使用者手動標記歸納）──
//   「(image4做滑動因為從講到南電開始的資訊在圖片下方)」→ 目標在下半部就滑動
//   「(image2做滑動因為圖維持蠻久沒動很無聊)」        → 停太久就滑動
//   「image1其實沒有亂圈！算是表現最好了」            → 明確數字接連命中時的快速換框是好的，
//                                                     不要合併、也不要改成滑動
const MIN_BOX_SEC = 2.5;          // 併入後方滑動段的門檻（只用在「短暫的鋪陳段」）
const MIN_SHOT_SEC = 1.4;         // 一般情況：一張圖至少停這麼久，否則閃一下就換
const MIN_ENUM_SEC = 0.8;         // 同一句裡的列舉例外：「南亞科、華邦電、友達群創」整句只有 3.3 秒，
                                  // 要塞四檔就是每張 0.83 秒。用 1.4 秒去卡會直接丟掉兩張圖，
                                  // 但使用者更不能接受「圖沒出現」。所以同句列舉放寬到 0.8 秒。
                                  // （這是取捨，不是最佳解 —— 覺得太快就在審核頁把時間改長。）
const MAX_SHOT_SEC = 10;          // 一張圖最長就停這麼久，超過直接截斷回講者
                                  //（使用者兩次回報「停留太久」）

/**
 * 列舉句再拆一次：「友達群創雙漲停。」一個子句點名兩檔股票，但一個子句只能配一張圖 →
 * 後面那檔的截圖永遠用不到（2026-08-13 使用者：「都沒放截圖」）。依股名在句中的位置切開，一檔一段。
 * @param {any[]} clauses
 * @param {any[]} imgs
 * @param {(img: any) => string[]} namesOf
 * @returns {any[]}
 */
function splitEnumerations(clauses, imgs, namesOf) {
  // 用「每張圖實際命中的那個寫法」，不是只用主要股名 ——
  // 主要股名可能是 OCR 多吃一個字的版本（性友達），在腳本裡根本找不到。
  const out = [];
  for (const c of clauses) {
    const hits = [];
    for (const img of imgs) {
      if (!img.stockName) continue;
      let n = null;
      for (const cand of namesOf(img)) if (c.text.includes(cand)) { n = cand; break; }
      if (!n) continue;
      const i = c.text.indexOf(n);
      if (i >= 0 && !hits.some((h) => i < h.i + h.n.length && i + n.length > h.i)) hits.push({ n, i });
    }
    hits.sort((a, b) => a.i - b.i);
    if (hits.length < 2) { out.push(c); continue; }
    let st = 0;
    for (let k = 1; k <= hits.length; k++) {
      const end = k < hits.length ? hits[k].i : c.text.length;
      const t = c.text.slice(st, end);
      if (t.trim().length) out.push({ text: t, start: c.start + st, end: c.start + end, sid: c.sid, blk: c.blk, u: c.u });
      st = end;
    }
  }
  return out;
}

/**
 * 逐子句決定「用哪張圖、框哪一格」。
 * @param {{ clauses: any[], imgs: any[], manual: any[], toCleaned: Function, matcher: { scoreImage: Function, findCell: Function } }} input
 * @returns {{ auto: any[], preview: string[], used: Set<string> }}
 */
function assignShots({ clauses, imgs, manual, toCleaned, matcher }) {
  const { scoreImage, findCell } = matcher;
  // 規則：
  //   1. 子句本身配到圖 → 用它
  //   2. 沒配到，但跟上一個有圖的子句同一句 → 沿用同一張圖（只換框的位置）
  //   3. 換句了還是沒配到 → 切回講者（圖消失）—— 使用者要求「講完那句就消失」
  const auto = [];
  const preview = [];
  const usedImg = new Set();
  let cur = null; // { img, sid }

  for (const c of clauses) {
    const r = toCleaned(c.start, c.end);
    const disp = c.text.replace(/\(shot:[^)]*\)/gi, '').replace(/\s+/g, '').slice(0, 24);
    if (!r || !disp) continue;
    if (manual.some((m) => r.startCharIdx <= m.endCharIdx && r.endCharIdx >= m.startCharIdx)) {
      preview.push(`  ✋ ${disp}…\n       （手動標記，維持不動）`);
      cur = null;
      continue;
    }

    let best = null;
    for (const img of imgs) {
      const { sc: base, why, row } = scoreImage(c.text, img);
      // 「還沒用到的圖」加分：使用者放進 public/ 的每張截圖都應該要出現。
      // 只在「這句已經點名這檔股票／這個主題」（base ≥ 10）時才加，
      // 否則無關的句子也會被硬配一張圖。
      const sc = base + (base >= 10 && !usedImg.has(img.file) ? 3 : 0);
      // 個股頁：門檻 13 = 股名(10) + 頁面關鍵字/數字佐證。
      //   只提到股名的列舉句（「健鼎跳空漲停」「金居盤中亮燈」）不切圖，避免畫面一直跳。
      // 清單頁/大盤頁：沒有股名可比，只能靠關鍵字，門檻放低到 3。
      // ⚠️ 用「頁面型態」判斷，不要用「有沒有讀到股名」：個股頁的股名 OCR 失敗時
      //    會被誤當清單頁、門檻掉到 3，隨便一個「漲停」就切圖（2026-08-13）。
      const need = img.isStockPage || img.stockName ? 13 : 3;
      if (sc >= need && (!best || sc > best.sc)) best = { img, sc, why, row };
    }
    if (best) {
      cur = { img: best.img, blk: c.blk, lastCell: null, lastSid: c.sid, row: best.row || null };
      usedImg.add(best.img.file);
    } else if (cur && cur.lastSid !== c.sid) {
      // ⚠️ 這一行是整個「圖什麼時候消失」的關鍵，改之前先想清楚。
      // 這個子句自己沒配到圖（沒點名股票、沒命中頁面關鍵字）→ 只有「還在同一句」才讓圖留著；
      // 換句了就收掉，回講者。
      //
      // 以前這裡是比 blk（主題段落），而且下面還要 !found 才收 ——
      // 結果 findCell 只要在圖上隨便命中一個數字或欄位，就繞過句子判斷一路掛著
      //（2026-08-17：群創那張從 12.18 秒黏到 26 秒，中間講的是完全不相干的族群）。
      // 「圖上找得到某個東西」≠「這句話在講這張圖」，那正是亂圈的來源。
      cur = null;
    }

    if (!cur) {
      preview.push(`  🎤 ${disp}…\n       講者`);
      continue;
    }

    // 這一句在圖上找得到對應（數字或欄位）嗎？
    // row = 這一句點名、而且在圖上找得到的那一列（排行榜用）。沒有新的就沿用同一句的。
    const found = findCell(c.text, cur.img, (best && best.row) || cur.row);
    // 同一主題段落內找不到新的目標時：圖與框都維持不變，只延長時間。
    // （例：「融券單日大減」在這張融資頁上沒有對應欄位，硬找會跳到錯的欄；
    //   維持前一個畫面比亂框或突然切走都好。2026-08-12 使用者回報內容錯誤。）
    // 找不到新目標時要不要讓圖繼續留著？以「句號」為界：
    //   同一句內（例：「融資連9日增加、融券單日大減，空方持續退場。」）→ 留著，框不變。
    //   換到下一句還是找不到（例：「HVLP4高頻銅箔是…」）→ 收掉，切回講者。
    // 用句子而不是整個主題段落，否則同一段裡後面不相干的句子會一直掛著圖
    //（2026-08-12 使用者回報：講到 HVLP4 時圖片應該要消失了）。
    if (!found && !best && cur.lastCell) {
      const prev0 = auto[auto.length - 1];
      if (prev0 && prev0.src === cur.img.file) {
        prev0.endCharIdx = r.endCharIdx;
        prev0._uTo = c.u;
        preview.push(`  ↳  ${disp}…\n       （同一句，${cur.img.file} 繼續、框不變）`);
        continue;
      }
    }
    if (!found && !best) {
      // 同一句但這個子句在圖上什麼都對不上 → 回講者（使用者定案：真的講到才出現圖）
      // 只有「純連接語氣」的短句才讓圖繼續留著，避免一句一切太碎。
      // 一旦這句沒講到圖上的東西就收回講者，並清掉 cur ——
      // 否則短句會被當成「連接語氣」讓圖回來，造成圖→講者→圖的閃爍。
      cur = null;
      preview.push(`  🎤 ${disp}…\n       講者（這句沒講到圖上的內容）`);
      continue;
    }
    const f = found || cur.lastCell;
    if (found) {
      cur.lastCell = found;
      cur.lastSid = c.sid;
    }
    const prev = auto[auto.length - 1];
    // 比較時把 undefined / null 正規化，否則「兩段都沒有框」會被誤判成不同 →
    // 同一張圖被切成好幾段、每段各淡入一次，看起來就像閃爍。
    const cellKey = (v) => JSON.stringify((v && v.cell ? v.cell : v) || null);
    const sameAsPrev =
      prev && prev.src === cur.img.file && cellKey(prev.cell) === cellKey(f);
    if (sameAsPrev) {
      prev.endCharIdx = r.endCharIdx;
      prev._uTo = c.u;
      preview.push(`  ↳  ${disp}…\n       （${cur.img.file} 繼續，框不變）`);
      continue;
    }

    auto.push({
      src: cur.img.file,
      ...r,
      _phrase: disp,
      _sid: c.sid,      // 屬於哪一句 —— 時間重分配不可以跨句借時間
      _uFrom: c.u,      // 來自哪幾個子句 —— 前台的「拉範圍」用這個對位
      _uTo: c.u,
      _auto: true,
      page: cur.img.page,
      imageWidth: cur.img.width,
      imageHeight: cur.img.height,
      ...(f ? { cell: f.cell, cellText: f.cellText, isColumn: !!f.isColumn, wholePage: !!f.wholePage } : {}),
    });
    preview.push(
      `  ${f ? '🔍' : '🖼 '} ${disp}…\n       → ${cur.img.file}` +
        (f ? `　框住「${f.cellText}」` : '　（整張顯示）') +
        (best ? `　依據：${best.why.join('、')}` : '　（沿用同一句的圖）')
    );
  }
  const used = usedImg;
  return { auto, preview, used };
}

/**
 * 依呈現規則調整自動段的長度（直接修改 auto）：硬性上限截斷、列舉句的時間重分配、太短的拿掉。
 * @param {any[]} auto
 * @param {Array<{ start: number, end: number }>} charTimes 字幕的 _scriptCharTimes
 */
function applyTimingRules(auto, charTimes) {
  const CHAR_TIMES = charTimes || [];
  const secOf = (i, w) => (CHAR_TIMES[i] ? (w === 'end' ? CHAR_TIMES[i].end : CHAR_TIMES[i].start) : null);
  const dur = (a, b) => {
    const s0 = secOf(a, 'start'), e0 = secOf(b, 'end');
    return s0 != null && e0 != null ? e0 - s0 : null;
  };

  // ⚠️ 順序很重要：硬性上限要先跑。
  // 本來 MAX_SHOT_SEC 截斷排在重分配後面，結果重分配拿到一個還沒被截斷的 13.9 秒段
  // 去當「可借用的時間」，四張圖各拿 4 秒（2026-08-17）。先截斷就不會有這種東西。
  const truncate = () => {
    for (const a of auto) {
      const s0 = secOf(a.startCharIdx, 'start');
      if (s0 == null) continue;
      const limit = s0 + MAX_SHOT_SEC;
      if ((secOf(a.endCharIdx, 'end') ?? 0) <= limit) continue;
      let cut = a.startCharIdx;
      for (let i = a.startCharIdx; i <= a.endCharIdx; i++) {
        const e = secOf(i, 'end');
        if (e != null && e <= limit) cut = i;
      }
      if (cut > a.startCharIdx) a.endCharIdx = cut;
    }
  };
  truncate();

  // ── 列舉句的時間重新分配 ──
  // 「南亞科、華邦電漲逾9%、友達群創雙漲停。」四檔擠在 3.5 秒內講完，
  // 照句子切就是每張 0.9 秒 —— 比轉場還短，等於閃一下。
  // 作法：把這一連串太短的段當成一個「區塊」，連同後面「還在講同一件事」的那一段
  //（沿用同一張圖的延伸句）一起，總時長平均分給區塊裡的每張圖。
  // 這樣 9.5s~15.5s 的 6 秒就變成 4 張 × 1.5 秒，看得清楚又不拖。
  {
    const endIdxAtOrBefore = (from, t) => {
      let cut = from;
      for (let k = from; k < CHAR_TIMES.length; k++) {
        const e = secOf(k, 'end');
        if (e == null) continue;
        if (e > t) break;
        cut = k;
      }
      return cut;
    };
    for (let i = 0; i < auto.length; i++) {
      if ((dur(auto[i].startCharIdx, auto[i].endCharIdx) ?? 9) >= MIN_SHOT_SEC) continue;
      let j = i;
      while (j + 1 < auto.length && (dur(auto[j + 1].startCharIdx, auto[j + 1].endCharIdx) ?? 9) < MIN_SHOT_SEC) j++;
      // 借用後面那一段的時間，但只在「同一張圖的延伸句」時才借（不搶別的內容），
      // 而且 ⚠️ 只借到「每段剛好 MIN_SHOT_SEC」為止。
      // 借光整段會出大事：2026-08-17 後面那段被延伸到 13.9 秒，整段借過來平均分給四張圖，
      // 變成「南亞科」三個字配一張圖停 4 秒，中間講別的股票時圖還掛著。
      const n = j - i + 1;
      const s0 = secOf(auto[i].startCharIdx, 'start');
      if (s0 == null || n < 2) { i = j; continue; }
      // 借時間只能在「同一句」裡借。跨句去借，就會出現「這句在講別的股票，
      // 上一句的圖還掛在畫面上」（2026-08-17 使用者：要看句子判讀，不是固定幾秒）。
      const cand = j + 1 < auto.length ? auto[j + 1] : null;
      const next = cand && cand.src === auto[j].src && cand._sid === auto[j]._sid ? cand : null;
      const own = secOf(auto[j].endCharIdx, 'end');
      const e1 = next
        ? Math.min(s0 + n * MIN_SHOT_SEC, secOf(next.endCharIdx, 'end') ?? own)
        : own;
      const borrow = next && e1 > own ? next : null;   // 真的有借到才要調整後面那段
      if (e1 == null) { i = j; continue; }
      // 同一句裡的列舉用比較寬的下限；跨句的才用一般下限
      const sameSentence = auto.slice(i, j + 1).every((a) => a._sid === auto[i]._sid);
      const floor = sameSentence ? MIN_ENUM_SEC : MIN_SHOT_SEC * 0.85;
      const each = (e1 - s0) / n;
      if (each >= floor) {
        for (let k = i; k <= j; k++) {
          auto[k].startCharIdx = k === i ? auto[i].startCharIdx : auto[k - 1].endCharIdx + 1;
          auto[k].endCharIdx =
            k === j && !borrow
              ? auto[j].endCharIdx
              : endIdxAtOrBefore(auto[k].startCharIdx, s0 + each * (k - i + 1));
        }
        if (borrow) borrow.startCharIdx = auto[j].endCharIdx + 1;
        if (borrow && (dur(borrow.startCharIdx, borrow.endCharIdx) ?? 0) <= 0.2) borrow._tooShort = true;
      }
      i = j;
    }
    // 重分配後還是太短 → 整段拿掉，寧可少一張也不要閃。
    // 但同一句裡的列舉用比較寬的下限（見 MIN_ENUM_SEC）。
    for (let i = auto.length - 1; i >= 0; i--) {
      const d = dur(auto[i].startCharIdx, auto[i].endCharIdx) ?? 9;
      const near = [auto[i - 1], auto[i + 1]].filter(Boolean);
      const inEnum = near.some((a) => a._sid === auto[i]._sid);
      const floor = inEnum ? MIN_ENUM_SEC * 0.95 : MIN_SHOT_SEC * 0.7;
      if (auto[i]._tooShort || d < floor) auto.splice(i, 1);
    }
  }

  // ⚠️ 2026-09-11 使用者定案「長圖捲動其實可以整個刪掉」：
  //    原本這裡會把清單頁／停留過久的段落標成 pan（從標題往下滑過整頁），
  //    再算 panToY（滑到旁白提到的個股）與 titleY（滑動起點），最後把相鄰的
  //    同圖 pan 段併成一次連續滑動。整條路連同渲染端（ShotFocus.tsx）一起移除。
  //    現在這些段落就是定格顯示；要限制看到哪一塊，用人工「顯示區域」圈。

  // 硬性上限：重分配可能又把某段拉長，再截一次
  truncate();

  // 合併後長度可能又超標 → 再截斷一次
  for (const a of auto) {
    const s0 = secOf(a.startCharIdx, 'start');
    if (s0 == null) continue;
    const limit = s0 + MAX_SHOT_SEC;
    if ((secOf(a.endCharIdx, 'end') ?? 0) <= limit) continue;
    let cut = a.startCharIdx;
    for (let i = a.startCharIdx; i <= a.endCharIdx; i++) {
      const e = secOf(i, 'end');
      if (e != null && e <= limit) cut = i;
    }
    if (cut > a.startCharIdx) a.endCharIdx = cut;
  }
}

/**
 * 人工標注之間的重疊：後標的為主（2026-08-25）。要用字幕時間軸才判斷得出「裁完剩幾秒」。
 * 也要在產線做，不能只在前台：勾「標好了，直接出片」那條路不會經過前台的 applyPlanEdits()。
 * @param {any[]} manual
 * @param {Array<{ start: number, end: number }>} charTimes
 * @returns {{ items: any[], notes: string[] }}
 */
function resolveOverlaps(manual, charTimes) {
  const CHAR_TIMES = charTimes || [];
  const secAt = (i, w) => (CHAR_TIMES[i] ? (w === 'end' ? CHAR_TIMES[i].end : CHAR_TIMES[i].start) : null);
  const durOf = (a, b) => {
    const s0 = secAt(a, 'start'), e0 = secAt(b, 'end');
    return s0 == null || e0 == null ? null : e0 - s0;
  };
  return resolveManualOverlaps(manual, { durOf, minSec: MIN_SHOT_SEC });
}

module.exports = { splitEnumerations, assignShots, applyTimingRules, resolveOverlaps, MIN_SHOT_SEC, MAX_SHOT_SEC, MIN_ENUM_SEC };
