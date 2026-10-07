// 框選編輯器（顯示區域／黃框／箭頭）與確認出片。

import { drawAnnots, saveAnnots } from './annotations.js';
import { ARROW_COLORS, ARROW_DEFAULT, ARROW_MIN_RATIO, arrowSVG, arrowShaftPx, hasArrow, shotGuideLines } from './arrows.js';
import { $, api, el } from './dom.js';
import { loadJob } from './job-detail.js';
import { drawRange } from './range.js';
import { S } from './state.js';

// ── 框選編輯器 ────────────────────────────

export function edMode() { return (S.edCtx && S.edCtx.mode2) || 'region'; }
export function setEdMode(m) {
  S.edCtx.mode2 = m;
  document.querySelectorAll('#edModes div').forEach((d) => d.classList.toggle('on', d.dataset.m === m));
  // 色票只在箭頭模式出現 —— 另外兩種的顏色是固定的（顯示區域藍虛線、黃框黃實線）
  const row = $('#edColorRow');
  if (row) row.hidden = m !== 'arrow';
}


/**
 * 箭頭只在「timeline 真的有把 arrow 交給渲染端」的版型出現。
 *
 * 哪些版型算數由伺服器的 TEMPLATES `arrow` 旗標決定（跟著 /api/health 一起送過來）。
 * ⚠️ 不擋的話就是**靜默失效**：編輯器照樣讓人畫、存得進計畫，成品卻沒有箭頭 ——
 *    2026-09-16 使用者在盤中焦點實際踩到（那次是 timeline 漏接，已補；焦點股日報、
 *    三大法人、投廣是真的還沒接）。旗標與 timeline 的對應有回歸測試（測試/配圖箭頭）。
 */
export function setEdArrow(job) {
  const on = !!(S.TPLS[(job && job.template) || ''] || {}).arrow;
  document.querySelectorAll('#ed [data-arrow]').forEach((n) => { n.hidden = !on; });
  if (!on && S.edCtx) S.edCtx.arrow = null;
  return on;
}

/** 六色色票。選色會同時套用到已經畫好的箭頭（不用重畫一次）。 */
export function drawEdColors() {
  const box = $('#edColors');
  if (!box || !S.edCtx) return;
  box.replaceChildren(...ARROW_COLORS.map((c) =>
    el('i', {
      style: `background:${c}`, title: c,
      class: c.toLowerCase() === String(S.edCtx.arrowColor).toLowerCase() ? 'on' : '',
      onclick: () => {
        S.edCtx.arrowColor = c;
        if (S.edCtx.arrow) S.edCtx.arrow.color = c;
        drawEdColors();
        drawEdBox();
      },
    })));
  const sw = $('#edArrowSw');
  if (sw) sw.style.background = S.edCtx.arrowColor || ARROW_DEFAULT;
}
document.querySelectorAll('#edModes div').forEach((d) =>
  d.onclick = () => { if (S.edCtx) setEdMode(d.dataset.m); });

export function edRects() { return S.edCtx ? { region: S.edCtx.region, cell: S.edCtx.cell } : {}; }

export function drawEdBox() {
  const wrap = $('#edImg');
  wrap.querySelectorAll('.bx').forEach((n) => n.remove());
  const img = wrap.querySelector('img');
  if (!S.edCtx || !S.edCtx.natW || !img) return;
  // ⚠️ 一定要用「圖片在容器裡的實際位置與大小」換算成像素，不能用百分比。
  //    百分比是相對 #edImg 容器算的，而容器會被上面那排縮圖撐寬 ——
  //    7 張截圖時容器 406px、圖片只有 308px，框就往右偏了 49px、寬度也多 32%，
  //    圖越多偏越多（2026-08-21 使用者回報：「點的位置沒出現黃框，跑到旁邊」）。
  //    標注模式因為把縮圖列清空了，容器剛好等於圖片，所以那邊看不出問題。
  const ox = img.offsetLeft, oy = img.offsetTop;
  const iw = img.offsetWidth, ih = img.offsetHeight;
  for (const [k, r] of Object.entries(edRects())) {
    if (!r || !(r.w > 0)) continue;
    wrap.append(el('div', { class: 'bx' + (k === 'region' ? ' region' : ''), style:
      `left:${ox + (r.x / S.edCtx.natW) * iw}px;top:${oy + (r.y / S.edCtx.natH) * ih}px;`
      + `width:${(r.w / S.edCtx.natW) * iw}px;height:${(r.h / S.edCtx.natH) * ih}px` }));
  }
  // 箭頭：同樣拿圖片在容器裡的實際位置換算（理由跟上面那段一樣，不能用百分比）。
  const hasA = hasArrow(S.edCtx.arrow);
  if (hasA) {
    const a = S.edCtx.arrow;
    const kx = iw / S.edCtx.natW, ky = ih / S.edCtx.natH;
    wrap.append(arrowSVG(
      wrap.offsetWidth, wrap.offsetHeight,
      ox + a.x1 * kx, oy + a.y1 * ky, ox + a.x2 * kx, oy + a.y2 * ky,
      a.color || S.edCtx.arrowColor,
      // ⚠️ 線寬要用**圖片**的顯示寬換算，不是容器寬 —— 容器會被上面那排縮圖撐寬
      //    （drawEdBox 開頭那段註解講的同一件事）。
      arrowShaftPx(iw, S.edCtx.natW, S.edCtx.natH, S.edCtx.region)));
  }
  // 參考線：跟著顯示區域算，沒圈就用整張圖（見 shotGuideLines）。線只畫在那一塊的寬度內。
  {
    const r = S.edCtx.region && S.edCtx.region.w > 0
      ? S.edCtx.region : { x: 0, y: 0, w: S.edCtx.natW, h: S.edCtx.natH };
    for (const g of shotGuideLines(S.edCtx.natW, S.edCtx.natH, S.edCtx.region)) {
      wrap.append(el('div', { class: 'bx guide' + (g.cut ? ' cut' : ''), style:
        `left:${ox + (r.x / S.edCtx.natW) * iw}px;top:${oy + (g.y / S.edCtx.natH) * ih}px;`
        + `width:${(r.w / S.edCtx.natW) * iw}px` }, [el('span', {}, [g.label])]));
    }
  }
  const hasR = !!(S.edCtx.region && S.edCtx.region.w > 0), hasC = !!(S.edCtx.cell && S.edCtx.cell.w > 0);
  $('#edRegionState').textContent = hasR ? '已畫' : '沒有';
  $('#edCellState').textContent = hasC ? '已畫' : '沒有';
  $('#edArrowState').textContent = hasA ? '已畫' : '沒有';
  $('#edClearRegion').disabled = !hasR;
  $('#edClearCell').disabled = !hasC;
  $('#edClearArrow').disabled = !hasA;
  $('#edClearRegion').style.opacity = hasR ? 1 : 0.35;
  $('#edClearCell').style.opacity = hasC ? 1 : 0.35;
  $('#edClearArrow').style.opacity = hasA ? 1 : 0.35;
}

export function loadEdImage(src) {
  // ⚠️ 換圖一定要把框清掉（2026-08-25）。框存的是「原圖像素座標」，套到另一張圖上
  //    一定是錯的位置；而伺服器那邊 `applyPlanEdits()` 會照單全收前台送回來的框，
  //    所以在 A 圖畫的框會原座標畫到 B 圖上。開編輯器的第一次載入不算換圖。
  const swapped = !!S.edCtx.src && S.edCtx.src !== src;
  S.edCtx.src = src;
  if (swapped) {
    S.edCtx.region = null;
    S.edCtx.cell = null;
    // 箭頭存的也是原圖像素座標 —— 留著就會原座標畫到另一張圖上（跟框同一個坑，2026-09-16）
    S.edCtx.arrow = null;
    const note = $('#edNote');
    if (note) note.textContent = '（換了截圖，原本的框與箭頭已清掉 —— 請在新的圖上重畫）';
    // 「同一張圖的其他段」是虛線、別張圖是實線 —— 換了圖，這個判斷就變了，要重畫一次。
    // （開編輯器的第一次載入不算換圖，那條路本來就會在後面自己呼叫 drawRange。）
    drawRange();
  }
  // 新圖還沒載入完之前 natW/natH 是舊圖的，這時候拖框會用錯比例換算 → 先清掉，
  // 拖曳那幾支看到 natW 是空的就不動作，等 onload 補上。
  S.edCtx.natW = null;
  S.edCtx.natH = null;
  const wrap = $('#edImg');
  // 標注模式的標題就是檔名 —— 換了圖不跟著換的話，畫面會顯示你正在標另一張（2026-09-01）
  if (S.edCtx.mode === 'annot') $('#edTitle').textContent = '標注　' + src;
  const img = el('img', { src: `/api/jobs/${S.edCtx.job.id}/file/${src}`, alt: '' });
  wrap.replaceChildren(img);
  img.onload = () => { S.edCtx.natW = img.naturalWidth; S.edCtx.natH = img.naturalHeight; drawEdBox(); };
  document.querySelectorAll('#edStrip div').forEach((d) => {
    const on = d.dataset.src === src;
    d.classList.toggle('on', on);
    // 縮圖列現在是橫捲的單列 —— 選到的那張可能在可視範圍外，捲過去讓人看得到自己選了哪張
    if (on) d.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

export function drawStrip(imgs) {
  $('#edStrip').replaceChildren(...imgs.map((n) =>
    el('div', { 'data-src': n, class: n === S.edCtx.src ? 'on' : '', title: n,
      onclick: () => loadEdImage(n) },
      el('img', { src: `/api/jobs/${S.edCtx.job.id}/file/${n}`, alt: '' }))));
}

// 拖曳畫框：一律換算成原圖像素座標存，換手機解析度也對
$('#edImg').addEventListener('mousedown', (ev) => {
  const img = $('#edImg').querySelector('img');
  if (!img || !S.edCtx) return;
  if (!S.edCtx.natW || !S.edCtx.natH) return;   // 圖還沒載入完，這時候換算比例會是錯的
  const b = img.getBoundingClientRect();
  // X 與 Y 各自算縮放比例。以前 Y 也用 X 的比例（natW/b.width），
  // 圖片等比例顯示時剛好相等看不出來，但不等比時框會上下錯位（2026-08-18）。
  const scX = S.edCtx.natW / b.width, scY = S.edCtx.natH / b.height;
  S.edCtx.drag = { x0: (ev.clientX - b.left) * scX, y0: (ev.clientY - b.top) * scY, b, scX, scY };
  ev.preventDefault();
});
window.addEventListener('mousemove', (ev) => {
  if (!S.edCtx || !S.edCtx.drag) return;
  const { x0, y0, b, scX, scY } = S.edCtx.drag;
  const x1 = Math.max(0, Math.min(S.edCtx.natW, (ev.clientX - b.left) * scX));
  const y1 = Math.max(0, Math.min(S.edCtx.natH, (ev.clientY - b.top) * scY));
  if (edMode() === 'arrow') {
    // 箭頭是線段不是矩形：按下的地方是尾、放開的地方是頭（箭鏃）。
    S.edCtx.arrow = { x1: x0, y1: y0, x2: x1, y2: y1, color: S.edCtx.arrowColor || ARROW_DEFAULT };
  } else {
    S.edCtx[edMode()] = { x: Math.min(x0, x1), y: Math.min(y0, y1),
      w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  }
  drawEdBox();
});
window.addEventListener('mouseup', () => {
  if (!S.edCtx || !S.edCtx.drag) return;
  S.edCtx.drag = null;
  if (edMode() === 'arrow') {
    // 太短多半是誤點。⚠️ 不能沿用下面那組 w/h 門檻 —— 水平或垂直的箭頭一定有一軸是 0，
    //    套下去每一支畫完就消失。線段只能用長度判斷。
    const a = S.edCtx.arrow;
    const min = Math.min(S.edCtx.natW, S.edCtx.natH) * ARROW_MIN_RATIO;
    if (a && Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < min) S.edCtx.arrow = null;
    drawEdBox();
    return;
  }
  const r = S.edCtx[edMode()];
  // 太小多半是誤點
  if (r && (r.w < S.edCtx.natW * 0.02 || r.h < S.edCtx.natH * 0.008)) S.edCtx[edMode()] = null;
  drawEdBox();
});
// 框是用像素畫的 → 視窗大小一變（圖片跟著縮放）就要重畫，不然會跟圖片脫節
window.addEventListener('resize', () => { if (S.edCtx) drawEdBox(); });
$('#edClearRegion').onclick = () => { S.edCtx.region = null; drawEdBox(); };
$('#edClearCell').onclick = () => { S.edCtx.cell = null; drawEdBox(); };
$('#edClearArrow').onclick = () => { S.edCtx.arrow = null; drawEdBox(); };
$('#edCancel').onclick = () => { $('#ed').style.display = 'none'; S.edCtx = null; };

export function openEditor(job, pv, row, done) {
  const e = S.edits[row.i];
  S.edCtx = { job, mode: 'shot', e, done, drag: null, src: e.src, mode2: 'cell',
    region: e.region ? { ...e.region } : null,
    cell: e.cell ? { ...e.cell } : null,
    arrow: e.arrow ? { ...e.arrow } : null,
    arrowColor: (e.arrow && e.arrow.color) || ARROW_DEFAULT,
    // 出現範圍用「在腳本上拖選」，不叫人填秒數
    from: e.startCharIdx ?? null, to: e.endCharIdx ?? null };
  $('#edTitle').textContent = row.phrase || '調整這一段';
  $('#edNote').textContent = '';
  setEdArrow(job);
  drawEdColors();
  setEdMode('cell');
  drawStrip(pv.images);
  loadEdImage(e.src);
  drawRange();
  $('#ed').style.display = 'flex';
}

$('#edOK').onclick = () => {
  // 標注模式：存「哪一段子句範圍」，不是秒數（秒數要等語音轉字幕才存在）
  if (S.edCtx.mode === 'annot') {
    if (S.edCtx.from == null) return alert('還沒選範圍 —— 在下面的腳本上點一下或拖選');
    const a = S.ANNOTS[S.edCtx.k];
    a.src = S.edCtx.src;
    a.startCharIdx = Math.min(S.edCtx.from, S.edCtx.to);
    a.endCharIdx = Math.max(S.edCtx.from, S.edCtx.to);
    a.region = S.edCtx.region; a.cell = S.edCtx.cell;
    a.arrow = hasArrow(S.edCtx.arrow) ? S.edCtx.arrow : null;
    a.imgW = S.edCtx.natW; a.imgH = S.edCtx.natH;
    const job = S.edCtx.job;
    $('#ed').style.display = 'none'; S.edCtx = null;
    drawAnnots(job); saveAnnots(job);
    return;
  }
  const { e, done } = S.edCtx;
  if (S.edCtx.from == null) return alert('還沒選範圍 —— 在下面的腳本上點一下或拖選');
  const a0 = Math.min(S.edCtx.from, S.edCtx.to), b0 = Math.max(S.edCtx.from, S.edCtx.to);
  // ⚠️ 箭頭也要進這個比對 —— 只動箭頭、沒動框的話 `_manual` 不會被標起來，
  //    applyPlanEdits() 就不會把這一段當人工段寫回去，箭頭靜默消失（2026-09-16）。
  const arrowOf = (a) => (hasArrow(a)
    ? [Math.round(a.x1), Math.round(a.y1), Math.round(a.x2), Math.round(a.y2),
      String(a.color || ARROW_DEFAULT).toLowerCase()]
    : null);
  const changed = JSON.stringify([S.edCtx.region, S.edCtx.cell, arrowOf(S.edCtx.arrow)])
      !== JSON.stringify([e.region, e.cell, arrowOf(e.arrow)])
    || a0 !== e.startCharIdx || b0 !== e.endCharIdx
    || S.edCtx.src !== e.src;
  e.region = S.edCtx.region; e.cell = S.edCtx.cell;
  e.arrow = hasArrow(S.edCtx.arrow) ? S.edCtx.arrow : null;
  e.imgW = S.edCtx.natW; e.imgH = S.edCtx.natH;
  e.startCharIdx = a0; e.endCharIdx = b0;
  e.src = S.edCtx.src;
  if (changed) e._manual = true;
  $('#ed').style.display = 'none'; S.edCtx = null;
  done();
};

// 送出配圖計畫 → 開始出片。
// ⚠️ 2026-08-18：這個函式一度在改編輯器時被連帶刪掉，導致「確認，開始出片」
//    按下去是 ReferenceError、完全沒反應。務必保留。
export async function approve(job, e) {
  try {
    await api(`/api/jobs/${job.id}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ edits: e, by: $('#owner').value, emphasis: S.EMPH }),
    });
    loadJob();
  } catch (err) { alert('出錯了：' + err.message); }
}

