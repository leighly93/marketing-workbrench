'use strict';

/**
 * 以前排錯的教訓（2026-11-17 使用者定案「第三階段做吧」）—— 純邏輯，測試在 90_系統/測試/檢查配圖.test.js。
 *
 * 成品頁「檢查配圖」送出後，修正紀錄（corrections.jsonl）會有 type「Claude排錯」的列。
 * 這裡把它們整理成兩份給 Claude 看的提示，讓同樣的錯不要再犯：
 *   ① planLessons：排「哪張圖配哪句」時用（放錯句子、配錯圖、不該放截圖、漏用的圖、其他）—— 最近 PLAN_MAX 筆
 *   ② boxLessons：排「卡片怎麼裁、框哪裡」時用（同一種頁面 memKey 被改過的框）—— 最近 BOX_MAX 筆
 * 筆數有上限：只是多幾行提示，不會讓排配圖明顯變慢（使用者問過「會讓生成更久嗎」）。
 * 讀不到檔、格式壞掉一律當沒有教訓，不影響出片。
 */

const fs = require('fs');

const PLAN_MAX = 8;
const BOX_MAX = 3;

/** 修正紀錄裡「Claude排錯」的列，新的在前 */
function read(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf-8'); } catch (_) { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && r.type === 'Claude排錯') rows.push(r);
    } catch (_) { /* 壞掉那行跳過 */ }
  }
  return rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

const clip = (s, n = 24) => { const t = String(s || '').replace(/\s+/g, ''); return t.length > n ? `${t.slice(0, n)}…` : t; };

/** 一筆修正 → 一行教訓（排「哪張圖配哪句」用）；框的問題不在這裡講 */
function planLine(r, pageName) {
  const pg = (p) => (pageName(p) ? `「${pageName(p)}」頁` : '截圖');
  const note = r.reason && r.reason.note ? `（剪輯師說：${clip(r.reason.note, 40)}）` : '';
  const said = `「${clip(r.phrase)}」`;
  switch (r.kind) {
    case '放錯句子': return r.manualPhrase ? `${pg(r.page)}被放在${said}，應該放在「${clip(r.manualPhrase)}」${note}` : null;
    case '配錯圖': return r.to && r.to !== r.from ? `${said}配了${pg(r.page)}，應該配${pg(r.toPage)}${note}` : (note ? `${said}配了${pg(r.page)}，配錯了${note}` : null);
    case '不該放截圖': return `${said}不該放截圖（當時配了${pg(r.page)}）${note}`;
    case '漏用這張圖': return `${pg(r.toPage)}那張圖沒用到，應該放在${said}${note}`;
    case '其他': return note ? `${said}（${pg(r.page)}）${note}` : null;
    default: return null;
  }
}

/**
 * 排配圖第一步要附的教訓（文字行），最近 n 筆、同一句旁白只留最新的。
 * pageName：app-pages.js 的 pageName（頁型代號 → 中文）
 */
function planLessons(rows, pageName, n = PLAN_MAX) {
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const line = planLine(r, pageName);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length >= n) break;
  }
  return out;
}

/** 框換成 0～1 比例（size＝原圖寬高） */
function ratio(b, size) {
  if (!b || !size || !(size.w > 0) || !(size.h > 0)) return null;
  return { x: b.x / size.w, y: b.y / size.h, w: b.w / size.w, h: b.h / size.h };
}

/**
 * 同一種頁面（memKey）以前被人改過的框，最近 n 筆。
 * 回傳 [{ phrase, auto: { cell, region }, manual: { cell, region }, note }]（比例座標）
 */
function boxLessons(rows, memKey, n = BOX_MAX) {
  if (!memKey) return [];
  const out = [];
  for (const r of rows) {
    // 框是人改在哪張圖上就看哪張圖的頁型：換了圖看 toMemKey，沒換看 memKey
    const key = r.to && r.to !== r.from ? r.toMemKey : r.memKey;
    if (key !== memKey || !r.size || (!r.manualCell && !r.manualRegion)) continue;
    if (r.kind === '不該放截圖') continue;
    const same = r.to === r.from && JSON.stringify([r.manualCell, r.manualRegion]) === JSON.stringify([r.autoCell, r.autoRegion]);
    if (same) continue;   // 只說錯、沒給答案的不算示範
    out.push({
      phrase: r.manualPhrase || r.phrase || '',
      auto: r.to === r.from ? { cell: ratio(r.autoCell, r.size), region: ratio(r.autoRegion, r.size) } : null,
      manual: { cell: ratio(r.manualCell, r.size), region: ratio(r.manualRegion, r.size) },
      note: (r.reason && r.reason.note) || '',
    });
    if (out.length >= n) break;
  }
  return out;
}

/** 第一步 prompt 用的一段文字；沒有教訓回空字串 */
function planLessonsText(lines) {
  if (!lines || !lines.length) return '';
  return [
    '以前 Claude 排錯、被剪輯師在成品頁改過的（最近幾筆，同樣的情況別再犯；這支內容不同就以這支為準）：',
    ...lines.map((l) => `- ${l}`),
  ].join('\n');
}

/** 卡片 prompt 用的一段文字（座標換算成這張圖送出去的尺寸）；沒有教訓回空字串 */
function boxLessonsText(list, width, height) {
  if (!list || !list.length) return '';
  const px = (b) => (b ? `[${Math.round(b.x * width)}, ${Math.round(b.y * height)}, ${Math.round(b.w * width)}, ${Math.round(b.h * height)}]` : '（整張）');
  return [
    '**同一種頁面**以前 Claude 框錯、被剪輯師改過（座標已換算成這張圖），同樣的錯別再犯：',
    ...list.map((e) => `- 旁白「${clip(e.phrase, 30)}」：`
      + (e.auto ? `Claude 裁 ${px(e.auto.region)}、框 ${px(e.auto.cell)} → ` : '')
      + `人改成 裁 ${px(e.manual.region)}、框 ${px(e.manual.cell)}`
      + (e.note ? `（${clip(e.note, 40)}）` : '')),
  ].join('\n');
}

module.exports = { PLAN_MAX, BOX_MAX, read, planLine, planLessons, boxLessons, planLessonsText, boxLessonsText };
