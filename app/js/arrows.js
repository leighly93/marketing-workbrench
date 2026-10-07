// 箭頭：幾何換算與 SVG（跟 Remotion 的 ShotFocus 同一組常數）。

// ── 箭頭（2026-09-16）────────────────────────────────────────────
// ⚠️ 色票要跟成品端一致：src/ShotFocus.tsx 的 SHOT_FOCUS.arrow.palette。改這裡就要改那裡。
export const ARROW_COLORS = ['#FF3B30', '#00C853', '#2E9BFF', '#FF9500', '#FFFFFF', '#1A1A1A'];
export const ARROW_DEFAULT = ARROW_COLORS[0];
/** 短到這個長度以下（佔圖片短邊的比例）就當誤點 —— 箭頭是線段，不能沿用框那組 w/h 門檻。 */
export const ARROW_MIN_RATIO = 0.04;
// 成品端的尺寸（畫面 px，直式畫布 1080×1920）。⚠️ 要跟 src/ShotFocus.tsx 的 SHOT_FOCUS.arrow
// 與各 composition 的 safeTop/safeBottom 一致；改那邊就要改這裡，不然預覽又會跟成品對不起來。
export const ARROW_CANVAS_W = 1080, ARROW_CANVAS_H = 1920;
export const ARROW_SAFE_H = 1120;                 // safeBottom 1430 − safeTop 310
// 直式配圖的擺法（2026-09-24，src/ShotFocus.tsx 的 fitVertical）：不滿版的圖寬度固定 SHOT_W，
// 放大後比安全框高就上緣貼齊 SHOT_SAFE_TOP 往下長。字幕條從 SHOT_SUB_TOP 起（Subtitles.tsx 的 paddingTop）。
// ⚠️ 美股焦點的 safeTop 是 325，這裡統一用 310 —— 參考線差 15 畫面 px，預覽用不影響判斷。
export const SHOT_W = 1070;                       // SHOT_FOCUS.verticalImageWidth
export const SHOT_SAFE_TOP = 310, SHOT_SUB_TOP = 1440;
export const ARROW_SHAFT = 11, ARROW_HEAD_RATIO = 30 / 11, ARROW_HEAD_W_RATIO = 38 / 11;
export const ARROW_ROUND_RATIO = 3 / 11;          // headRound ÷ width（箭鏃圓角）
export const ARROW_COVER_KEEP = 0.75;             // SHOT_FOCUS.wholePageCoverKeep

/**
 * 「這張圖在成品裡會被放多大」——回傳圖片在畫布上的顯示寬（畫面 px）。
 *
 * 為什麼需要它：成品的線寬是**固定的畫面 px**（跟截圖解析度無關，見 SHOT_FOCUS.arrow），
 * 而預覽是把原圖縮到幾百 px 來畫。不換算的話，同一支箭頭在編輯器裡看起來比成品粗好幾倍
 * （2026-09-16 使用者回報「成品的箭頭跟圈選的時候不一樣」）。
 *
 * ⚠️ 這是**近似**：照渲染端的三條擺放規則走（圈了 region 就放大到安全框、沒圈就看
 *    coverKeep 門檻決定滿版或整張縮進去），但安全框高度用直式的固定值，
 *    也不處理橫式的左右分割。預覽只要粗細看起來對，不需要像素級一致。
 */
export function arrowShownWidth(natW, natH, region) {
  if (!(natW > 0) || !(natH > 0)) return ARROW_CANVAS_W;
  if (region && region.w > 0 && region.h > 0) {
    return natW * SHOT_W / region.w;
  }
  const ar = natW / natH, boxAr = ARROW_CANVAS_W / ARROW_CANVAS_H;
  const keep = Math.min(ar, boxAr) / Math.max(ar, boxAr);
  return keep >= ARROW_COVER_KEEP
    ? natW * Math.max(ARROW_CANVAS_W / natW, ARROW_CANVAS_H / natH)   // 滿版
    : SHOT_W;                                                         // 整張放成固定寬度
}

/**
 * 標注頁的參考線（2026-09-24 使用者要的）：成品畫面上「字幕從這裡開始」與「畫面底部」
 * 各落在原圖的哪個 y。只算直式、不滿版的圖（圈了顯示區域，或沒圈但整張放成固定寬度）——
 * 滿版的手機截圖會跟著黃框捲動，位置不固定，不畫。
 * 回傳 [{ y, label, cut }]，y 是原圖像素；線落在那一塊外面（例如扁的圖整塊都在字幕上方）就不回。
 */
export function shotGuideLines(natW, natH, region) {
  if (!(natW > 0) || !(natH > 0)) return [];
  let r = region && region.w > 0 && region.h > 0 ? region : null;
  if (!r) {
    const ar = natW / natH, boxAr = ARROW_CANVAS_W / ARROW_CANVAS_H;
    if (Math.min(ar, boxAr) / Math.max(ar, boxAr) >= ARROW_COVER_KEEP) return [];   // 滿版
    r = { x: 0, y: 0, w: natW, h: natH };
  }
  const s = SHOT_W / r.w;
  const rh = r.h * s;
  const top = rh <= ARROW_SAFE_H ? SHOT_SAFE_TOP + (ARROW_SAFE_H - rh) / 2 : SHOT_SAFE_TOP;
  return [
    { screenY: SHOT_SUB_TOP, label: '直式：以下會被字幕壓到', cut: false },
    { screenY: ARROW_CANVAS_H, label: '直式：以下成品看不到', cut: true },
  ].map((g) => ({ ...g, y: r.y + (g.screenY - top) / s }))
    .filter((g) => g.y < r.y + r.h && g.y > r.y);
}

/**
 * 在一個 position:relative 的容器上疊一支箭頭（SVG）。座標是**容器內的 px**，換算由呼叫端負責。
 *
 * 形狀跟成品（ShotFocus.tsx）同一套：桿子＋三角箭鏃＋半透明黑描邊。
 * 但**尺寸不是成品尺寸** —— 成品的線寬是畫布 px、跟截圖解析度無關，預覽只能按容器寬度抓個
 * 看得清楚的比例。預覽是用來確認「位置、方向、顏色」，不是用來量粗細的。
 */
export function arrowSVG(w, h, x1, y1, x2, y2, color, shaft) {
  const NS = 'http://www.w3.org/2000/svg';
  // shaft＝呼叫端算好的線寬（見 arrowShaftPx）。沒給就退回舊的「容器寬 2.2%」。
  const lw = Math.max(1.5, shaft || w * 0.022);
  const len = Math.hypot(x2 - x1, y2 - y1);
  // 箭鏃相對線寬的比例跟成品同一組（ShotFocus.tsx：線寬 11、headLen 30、headWidth 38）
  const k = Math.min(1, len / (lw * ARROW_HEAD_RATIO * 1.6));   // 太短的箭頭不要讓箭鏃吃掉整支
  const hl = lw * ARROW_HEAD_RATIO * k;
  const hw = lw * ARROW_HEAD_W_RATIO * k;
  const ang = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
  // 純色一層，不描邊也不加陰影（成品同一條規則，見 ShotFocus.tsx 的 SHOT_FOCUS.arrow）。
  // 箭鏃的 stroke 跟 fill 同色，只是拿來把角磨圓。
  const paint = (c) =>
    `<line x1="0" y1="0" x2="${(len - hl + 1).toFixed(1)}" y2="0" stroke="${c}"`
    + ` stroke-width="${lw.toFixed(1)}" stroke-linecap="round"/>`
    + `<polygon points="${len.toFixed(1)},0 ${(len - hl).toFixed(1)},${(-hw / 2).toFixed(1)}`
    + ` ${(len - hl).toFixed(1)},${(hw / 2).toFixed(1)}" fill="${c}" stroke="${c}"`
    + ` stroke-width="${(lw * ARROW_ROUND_RATIO * 2 * k).toFixed(1)}" stroke-linejoin="round"/>`;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'bx arrow');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.style.cssText = `left:0;top:0;width:${w}px;height:${h}px`;
  svg.innerHTML = `<g transform="translate(${x1.toFixed(1)} ${y1.toFixed(1)}) rotate(${ang.toFixed(2)})">`
    + paint(color || ARROW_DEFAULT)
    + '</g>';
  return svg;
}

/**
 * 成品的線寬（8 畫面 px）換算成預覽上要畫幾 px。
 * displayW＝這張圖在預覽裡的顯示寬，natW/natH＝原圖尺寸，region＝有沒有圈顯示區域。
 */
export function arrowShaftPx(displayW, natW, natH, region) {
  return displayW * ARROW_SHAFT / arrowShownWidth(natW, natH, region);
}

/** 箭頭是不是有效（有兩個端點、長度不是 0）。存進去的一律是原圖像素座標。 */
export function hasArrow(a) {
  return !!(a && Number.isFinite(a.x1) && Number.isFinite(a.y1)
    && Number.isFinite(a.x2) && Number.isFinite(a.y2)
    && Math.hypot(a.x2 - a.x1, a.y2 - a.y1) > 0);
}
