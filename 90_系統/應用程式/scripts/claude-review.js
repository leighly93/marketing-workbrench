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

/** 稿件字元（auto-shot --sentences 的 chars）→ 字元範圍的文字 */
function textOf(chars, a, b) {
  return !Array.isArray(chars) || !chars.length || a == null || b == null ? ''
    : chars.slice(Math.min(a, b), Math.max(a, b) + 1).map((c) => c.c).join('');
}

/** 計畫列補上「那一段旁白」（Claude 排的計畫 _phrase 常是空的）；另外附前後文給編輯器顯示放在哪句話 */
function withPhrases(rows, chars) {
  return (rows || []).map((r) => ({
    ...r,
    phrase: r.phrase || textOf(chars, r.startCharIdx, r.endCharIdx),
    before: textOf(chars, Math.max(0, r.startCharIdx - 18), r.startCharIdx - 1),
    after: textOf(chars, r.endCharIdx + 1, r.endCharIdx + 18),
  }));
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

/**
 * 沒用到的截圖（2026-11-17 使用者：「包含我丟了但是沒用到的圖也要顯示在這邊」）。
 *   verdict 'missing'＝應該要用，帶人選的位置（字元範圍）與可選的框；'unused'＝不用沒關係。
 * 只收這支有、而且 Claude 沒用到的圖；位置要在稿件範圍內。
 */
function normalizeExtras(extras, images, rows, chars) {
  const used = new Set((rows || []).map((r) => r.src));
  const n = Array.isArray(chars) ? chars.length : 0;
  const out = [];
  const seen = new Set();
  for (const x of Array.isArray(extras) ? extras : []) {
    if (!x || !(images || []).includes(x.src) || used.has(x.src) || seen.has(x.src)) continue;
    if (x.verdict !== 'missing' && x.verdict !== 'unused') continue;
    seen.add(x.src);
    const note = typeof x.note === 'string' ? x.note.trim().slice(0, 300) : '';
    if (x.verdict === 'unused') { out.push({ src: x.src, verdict: 'unused', note }); continue; }
    const a = Math.round(Number(x.startCharIdx)); const b = Math.round(Number(x.endCharIdx));
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < a || (n && b >= n)) continue;
    out.push({ src: x.src, verdict: 'missing', note, startCharIdx: a, endCharIdx: b,
      region: box(x.region), cell: box(x.cell),
      imgW: Number(x.imgW) > 0 ? Math.round(x.imgW) : null, imgH: Number(x.imgH) > 0 ? Math.round(x.imgH) : null });
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
function correctionRows(items, rows, logged = [], extras = [], chars = []) {
  const done = new Set(logged);
  const out = [];
  const sigs = [];
  for (const x of extras) {
    if (x.verdict !== 'missing') continue;
    const s = JSON.stringify(['extra', x.src, x.startCharIdx, x.endCharIdx, x.note, x.region, x.cell]);
    if (done.has(s)) continue;
    out.push({
      type: 'Claude排錯', kind: '漏用這張圖', phrase: textOf(chars, x.startCharIdx, x.endCharIdx),
      from: '（Claude 沒用到）', to: x.src, autoCell: null, autoRegion: null,
      manualCell: x.cell, manualRegion: x.region, size: x.imgW && x.imgH ? { w: x.imgW, h: x.imgH } : null,
      autoWhy: 'Claude 沒用到這張圖；人指定放在這句', reason: { tags: ['漏用這張圖'], note: x.note || '' },
    });
    sigs.push(s);
  }
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
function memoryItems(items, rows, extras = [], chars = []) {
  const fromExtras = extras.filter((x) => x.verdict === 'missing' && x.cell).map((x) => ({
    src: x.src, cell: x.cell, region: x.region, imgW: x.imgW, imgH: x.imgH,
    phrase: textOf(chars, x.startCharIdx, x.endCharIdx), startCharIdx: x.startCharIdx }));
  return fromExtras.concat(items
    .filter((it) => (it.verdict === 'wrongImage' || it.verdict === 'wrongBox' || it.verdict === 'other')
      && it.cell && hasFix(it, rows.find((r) => r.i === it.i)))
    .map((it) => {
      const row = rows.find((r) => r.i === it.i);
      return { src: it.src, cell: it.cell, region: it.region, imgW: it.imgW, imgH: it.imgH,
        phrase: row.phrase || '', startCharIdx: row.startCharIdx };
    }));
}

/**
 * 「照修正重新出片」要鎖住的東西 → input/claude-fixed.json（claude-shot-plan.js 讀）：
 *   fixed   有框或有裁切：整段照人的，不給 Claude 排
 *   hints   只換了圖、沒畫框：那張圖一定配在這幾句（框交給 Claude）
 *   noShot  這幾句不放截圖
 */
function fixedPlan(items, rows, extras = []) {
  const fixed = []; const hints = []; const noShot = [];
  for (const x of extras) {
    if (x.verdict !== 'missing') continue;
    const range = { startCharIdx: x.startCharIdx, endCharIdx: x.endCharIdx };
    if (x.cell || x.region) fixed.push({ ...range, src: x.src, region: x.region, cell: x.cell, imgW: x.imgW, imgH: x.imgH });
    else hints.push({ ...range, src: x.src });
  }
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

module.exports = { VERDICTS, textOf, withPhrases, rowSummary, shotsSummary, normalizeItems, normalizeExtras, correctionRows, memoryItems, fixedPlan, autoNote, hasFix };
