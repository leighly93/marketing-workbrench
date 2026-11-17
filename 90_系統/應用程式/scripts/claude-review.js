'use strict';

/**
 * 檢查 Claude 排的配圖（2026-11-17 使用者定案「Start 1 and 2」）—— 純邏輯，測試在 90_系統/測試/檢查配圖.test.js。
 *
 * 現在大盤小報是 Claude 排好就直接出片，中間沒人改，所以「AI 原本怎麼排 vs 人改成什麼」的修正紀錄
 * 與人工框選記憶庫都不再長東西。這裡補兩條管道：
 *   ① 每支 Claude 排的計畫都寫進 claude-plans.jsonl；重新出片寫了「給 Claude 的指示」→ 修正紀錄記一筆「Claude指示」
 *   ② 成品頁「檢查配圖」：每段標 👍／配錯圖／框錯位置／不該放截圖／其他 → 修正紀錄記「Claude排錯」，
 *      拖過的正確框學進記憶庫；「照修正重新出片」時改過的段落鎖住照人的（claude-fixed.json），其他再給 Claude 排。
 */

const VERDICTS = {
  ok: '沒問題',
  wrongImage: '配錯圖',
  wrongBox: '框錯位置',
  noShot: '不該放截圖',
  other: '其他',
};

const box = (x) => (x && x.w > 0 && x.h > 0
  ? { x: Math.round(x.x), y: Math.round(x.y), w: Math.round(x.w), h: Math.round(x.h) } : null);

/** 計畫的一列（buildPlanView 的 rows）→ 給紀錄看的精簡版 */
function rowSummary(r) {
  return {
    src: r.src, phrase: r.phrase || '', startCharIdx: r.startCharIdx, endCharIdx: r.endCharIdx,
    region: box(r.region), cell: box(r.cell),
  };
}

/** claude-annotations.json 的 shots → 精簡版（字元範圍換成文字） */
function shotsSummary(shots, chars) {
  const textOf = (a, b) => (!Array.isArray(chars) || !chars.length || a == null || b == null ? ''
    : chars.slice(a, b + 1).map((c) => c.c).join(''));
  return (shots || []).filter((s) => s && s.src).map((s) => ({
    src: s.src, title: s.title || '', phrase: textOf(s.startCharIdx, s.endCharIdx),
    startCharIdx: s.startCharIdx, endCharIdx: s.endCharIdx, region: box(s.region), cell: box(s.cell),
    why: (s._claude && (s._claude.cellWhy || s._claude.why)) || '',
  }));
}

/**
 * 前台送來的檢查結果 → 乾淨的 items（丟掉不認得的 verdict、對不到列的 i、壞掉的框）。
 * rows：planView.rows；images：可以換的圖（planView.images）
 */
function normalizeItems(items, rows, images) {
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || !Object.hasOwn(VERDICTS, it.verdict)) continue;
    const row = rows.find((r) => r.i === it.i);
    if (!row) continue;
    const src = it.src && (images || []).includes(it.src) ? it.src : row.src;
    // 沒開編輯器（沒送 src／框）＝只說錯、框照 Claude 原本的；開過編輯器才以送來的為準（null＝刻意拿掉）
    const edited = ['src', 'region', 'cell'].some((k) => Object.hasOwn(it, k));
    out.push({
      i: row.i,
      verdict: it.verdict,
      note: typeof it.note === 'string' ? it.note.trim().slice(0, 300) : '',
      src,
      region: edited ? box(it.region) : box(row.region),
      cell: edited ? box(it.cell) : box(row.cell),
      imgW: Number(it.imgW) > 0 ? Math.round(it.imgW) : row.imageWidth || null,
      imgH: Number(it.imgH) > 0 ? Math.round(it.imgH) : row.imageHeight || null,
    });
  }
  return out;
}

/** 這一項跟 Claude 原本的有沒有實質不同（有改圖或改框才算「人給了正確答案」） */
function hasFix(it, row) {
  return it.src !== row.src || JSON.stringify(it.cell) !== JSON.stringify(box(row.cell))
    || JSON.stringify(it.region) !== JSON.stringify(box(row.region));
}

const sig = (it) => JSON.stringify([it.i, it.verdict, it.note, it.src, it.region, it.cell]);

/**
 * 修正紀錄的列（type「Claude排錯」）。logged＝這支已經寫過的簽章，同一個判斷重送不重記。
 * 回傳 { rows, sigs }
 */
function correctionRows(items, rows, logged = []) {
  const done = new Set(logged);
  const out = [];
  const sigs = [];
  for (const it of items) {
    if (it.verdict === 'ok') continue;
    const s = sig(it);
    if (done.has(s)) continue;
    const row = rows.find((r) => r.i === it.i);
    const fixed = hasFix(it, row);
    out.push({
      type: 'Claude排錯',
      kind: VERDICTS[it.verdict],
      phrase: row.phrase || '',
      from: row.src,
      to: it.verdict === 'noShot' ? '（不放截圖）' : it.src,
      autoCell: box(row.cell), autoRegion: box(row.region),
      manualCell: it.verdict === 'noShot' ? null : it.cell,
      manualRegion: it.verdict === 'noShot' ? null : it.region,
      size: row.imageWidth && row.imageHeight ? { w: row.imageWidth, h: row.imageHeight } : null,
      autoWhy: `Claude 排的；人標「${VERDICTS[it.verdict]}」`
        + (it.verdict !== 'noShot' && it.verdict !== 'other' && !fixed ? '（沒給正確答案）' : ''),
      reason: it.note ? { tags: [VERDICTS[it.verdict]], note: it.note } : { tags: [VERDICTS[it.verdict]], note: '' },
    });
    sigs.push(s);
  }
  return { rows: out, sigs };
}

/** 要學進記憶庫的：有框、有改過的（跟 learnFromEdits 給 shot-memory.learn 的同一個形狀） */
function memoryItems(items, rows) {
  return items
    .filter((it) => (it.verdict === 'wrongImage' || it.verdict === 'wrongBox' || it.verdict === 'other')
      && it.cell && hasFix(it, rows.find((r) => r.i === it.i)))
    .map((it) => {
      const row = rows.find((r) => r.i === it.i);
      return { src: it.src, cell: it.cell, region: it.region, imgW: it.imgW, imgH: it.imgH,
        phrase: row.phrase || '', startCharIdx: row.startCharIdx };
    });
}

/**
 * 「照修正重新出片」要鎖住的東西 → input/claude-fixed.json（claude-shot-plan.js 讀）：
 *   fixed   有框或有裁切：整段照人的，不給 Claude 排
 *   hints   只換了圖、沒畫框：那張圖一定配在這幾句（框交給 Claude）
 *   noShot  這幾句不放截圖
 */
function fixedPlan(items, rows) {
  const fixed = []; const hints = []; const noShot = [];
  for (const it of items) {
    if (it.verdict === 'ok') continue;
    const row = rows.find((r) => r.i === it.i);
    const range = { startCharIdx: row.startCharIdx, endCharIdx: row.endCharIdx };
    if (it.verdict === 'noShot') { noShot.push(range); continue; }
    if (!hasFix(it, row)) continue;          // 只說錯、沒給答案 → 交給 Claude 重排（指示另外寫）
    if (it.cell || it.region) {
      fixed.push({ ...range, src: it.src, region: it.region, cell: it.cell, imgW: it.imgW, imgH: it.imgH });
    } else {
      hints.push({ ...range, src: it.src });
    }
  }
  return { fixed, hints, noShot };
}

/** 只說錯、沒給正確答案的段落 → 自動補一句給 Claude 的指示 */
function autoNote(items, rows) {
  const lines = [];
  for (const it of items) {
    if (it.verdict === 'ok' || it.verdict === 'noShot') continue;
    const row = rows.find((r) => r.i === it.i);
    if (hasFix(it, row) && it.verdict !== 'other') continue;
    const p = (row.phrase || '').slice(0, 24);
    lines.push(`「${p}」上次${VERDICTS[it.verdict]}${it.note ? `：${it.note}` : ''}`);
  }
  return lines.join('；');
}

module.exports = { VERDICTS, rowSummary, shotsSummary, normalizeItems, correctionRows, memoryItems, fixedPlan, autoNote, hasFix };
