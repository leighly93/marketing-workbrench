// 修正紀錄頁（管理者）。

import { $, api, el } from './dom.js';

// ── 修正紀錄 ──
export async function loadFix() {
  const d = await api('/api/corrections');
  const wrap = $('#fix');
  if (!d.total) return wrap.replaceChildren(el('div', { class: 'empty' },
    '還沒有人改過任何配圖 —— 目前為止 AI 排的都被直接採用了'));
  const sum = el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;margin:18px 0' },
    ...Object.entries(d.byType).map(([k, v]) => el('span', { class: 'pill' }, `${k}　${v} 次`)));
  // 標籤統計才是「規則庫還缺什麼」的直接答案 —— 類型只說明「改了什麼」，標籤說明「為什麼」
  const tagSum = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px' },
    ...Object.entries(d.byTag || {}).sort((x, y) => y[1] - x[1])
      .map(([k, v]) => el('span', { class: 'pill' }, `${k}　${v} 次`)),
    d.noReason ? el('span', { class: 'pill', style: 'opacity:.6' }, `沒填原因　${d.noReason} 筆`) : '');
  const src = el('div', { class: 'tip', style: 'margin-bottom:14px' },
    d.logged
      ? `共 ${d.total} 筆，修正紀錄會持續保留，工作移除後也能查閱。`
      : `共 ${d.total} 筆。下次按「確認，開始出片」時會自動保存修正紀錄。`);
  const t = el('table', {}, el('thead', {}, el('tr', {},
    el('th', {}, '類型'), el('th', {}, '那一段旁白'), el('th', {}, '原本'), el('th', {}, '改成'),
    el('th', {}, 'AI 當時的判斷'), el('th', {}, '人給的原因'))));
  const tb = el('tbody');
  const fmtCell = (c, sz) => !c ? '—'
    : sz ? `${Math.round(c.x / sz.w * 100)},${Math.round(c.y / sz.h * 100)}% `
         + `${Math.round(c.w / sz.w * 100)}×${Math.round(c.h / sz.h * 100)}%`
         : `${Math.round(c.x)},${Math.round(c.y)} ${Math.round(c.w)}×${Math.round(c.h)}`;
  // 箭頭：尾 → 頭，跟框一樣能換算成比例就用比例（換手機解析度也讀得懂）
  const fmtArrow = (a, sz) => !a ? null
    : '箭頭 ' + (sz
      ? `${Math.round(a.x1 / sz.w * 100)},${Math.round(a.y1 / sz.h * 100)}%`
        + `→${Math.round(a.x2 / sz.w * 100)},${Math.round(a.y2 / sz.h * 100)}%`
      : `${Math.round(a.x1)},${Math.round(a.y1)}→${Math.round(a.x2)},${Math.round(a.y2)}`)
      + (a.color ? ` ${a.color}` : '');
  for (const r of d.rows) {
    let before = r.from || '—', after = r.to || '—';
    if (r.type === '改框') {
      // region（顯示區域）與 cell（黃框）分開顯示 —— 只畫顯示區域也是有效的修正。
      // 箭頭（2026-09-16）同一格顯示；自動配圖不會產生箭頭，所以「原本」那欄一定是空的。
      const pair = (cell, region, arrow) => [
        cell ? '黃框 ' + fmtCell(cell, r.size) : null,
        region ? '區域 ' + fmtCell(region, r.size) : null,
        fmtArrow(arrow, r.size),
      ].filter(Boolean).join('　') || '整張顯示';
      before = `${r.autoCellText || ''} ${pair(r.autoCell, r.autoRegion, r.autoArrow)}`;
      after = pair(r.manualCell, r.manualRegion, r.manualArrow);
    }
    if (r.type === '改時間') { before = `${r.auto}　${r.autoPhrase || ''}`; after = `${r.manual}　${r.manualPhrase || ''}`; }
    if (r.type === '新增一段') { before = (r.autoCoveredBy || []).join('、') || '（原本沒有圖）'; after = `${r.from}　${r.manual || ''}`; }
    // 人工標記：「原本」是對照組（假裝沒人標注、讓 AI 自己排一次）的結果
    if (r.type === '人工標記') {
      const pair = (cell, region, arrow) => [
        cell ? '黃框 ' + fmtCell(cell, r.size) : null,
        region ? '區域 ' + fmtCell(region, r.size) : null,
        fmtArrow(arrow, r.size),
      ].filter(Boolean).join('　') || '整張顯示';
      // 「原本」是空的有三種：AI 真的不配圖、這一支對照組整份沒排出來、
      // 舊紀錄比對用錯欄位（focus 版型，autoKind 由伺服器補）。只有第一種能說「AI 不配圖」。
      const blank = {
        noCounterfactual: '（比不出來：這一支對照組一段都沒排，多半是頁型沒認出來）',
        legacyNoSrc: '（比不出來：舊紀錄沒記到 AI 配了哪張圖）',
      }[r.autoKind] || '（AI 本來不配圖）';
      before = r.from
        ? `${r.from}　${r.autoCellText || ''} ${pair(r.autoCell, r.autoRegion, null)}`.trim()
        : blank;
      after = `${r.to}　${pair(r.manualCell, r.manualRegion, r.manualArrow)}`;
    }
    const reason = [...((r.reason && r.reason.tags) || []), (r.reason && r.reason.note) || '']
      .filter(Boolean).join('／');
    // 「系統原本會怎麼圈」（2026-08-26 使用者定案：影片只吃人工的框，系統的判斷只進紀錄）。
    // 沒有這個欄位的舊紀錄不會畫這一行 —— 一律不影響既有資料的顯示。
    const sysNote = (r.systemCell || r.systemWhy)
      ? el('div', { style: 'margin-top:5px;color:#c98a00' },
          `系統原本會框「${r.systemCellText || '—'}」　${fmtCell(r.systemCell, r.size)}`
          + `（來源：${r.systemWhy || '規則判定'}）`)
      : null;
    tb.append(el('tr', {}, el('td', {}, r.type), el('td', {}, r.phrase),
      el('td', { style: 'color:var(--dim);font-size:12.5px' }, before, sysNote || ''),
      el('td', { style: 'font-size:12.5px' }, after),
      el('td', { style: 'color:var(--dim);font-size:12.5px' }, r.autoWhy || '—'),
      el('td', { style: 'font-size:12.5px;color:#c98a00' }, reason || '—')));
  }
  t.append(tb);
  wrap.replaceChildren(sum, tagSum, src, t);
}

// 版本標記：F12 開 Console 看到這行，就代表瀏覽器抓到的是最新版
