<script setup>
// 框選編輯器（顯示區域／黃框／箭頭 ＋ 出現在哪一段）。全頁只有一個，由 App.vue 掛上；狀態在 stores/editor.js。
// 兩種框分開：顯示區域（藍虛線）＝圖要捲到哪裡；黃框（黃實線）＝要圈起來強調的地方。
// 可以只有一種、也可以兩種都有、也可以都沒有（整張顯示）。座標一律存**原圖像素**。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ARROW_COLORS, ARROW_DEFAULT, ARROW_MIN_RATIO, arrowShaftPx, hasArrow, shotGuideLines } from '../../lib/arrows.js';
import { fileUrl } from '../../lib/api.js';
import { closeEditor, ed } from '../../stores/editor.js';
import ArrowSvg from '../shared/ArrowSvg.vue';
import RangePicker from '../shared/RangePicker.vue';

const ctx = ed.ctx;
const imgEl = ref(null);
const wrapEl = ref(null);
const stripEl = ref(null);
// 圖片在容器裡的實際位置與大小 —— ⚠️ 框一定要用它換算成像素，不能用百分比：容器會被上面那排縮圖撐寬。
const box = ref({ ox: 0, oy: 0, iw: 0, ih: 0, ww: 0, wh: 0 });
function measure() {
  const img = imgEl.value, wrap = wrapEl.value;
  if (!img || !wrap) return;
  box.value = { ox: img.offsetLeft, oy: img.offsetTop, iw: img.offsetWidth, ih: img.offsetHeight, ww: wrap.offsetWidth, wh: wrap.offsetHeight };
}
function onLoad() {
  ctx.natW = imgEl.value.naturalWidth; ctx.natH = imgEl.value.naturalHeight;
  nextTick(measure);
}
onMounted(() => { window.addEventListener('resize', measure); });
onBeforeUnmount(() => { window.removeEventListener('resize', measure); });

const mode = computed(() => ctx.mode2);
const arrowOn = computed(() => !!ctx.arrowAllowed);

function px(r) {
  const b = box.value;
  if (!r || !(r.w > 0) || !ctx.natW) return null;
  return { left: b.ox + (r.x / ctx.natW) * b.iw + 'px', top: b.oy + (r.y / ctx.natH) * b.ih + 'px',
    width: (r.w / ctx.natW) * b.iw + 'px', height: (r.h / ctx.natH) * b.ih + 'px' };
}
const regionPx = computed(() => px(ctx.region));
const cellPx = computed(() => px(ctx.cell));
const arrowPx = computed(() => {
  const a = ctx.arrow, b = box.value;
  if (!hasArrow(a) || !ctx.natW) return null;
  const kx = b.iw / ctx.natW, ky = b.ih / ctx.natH;
  return { w: b.ww, h: b.wh, x1: b.ox + a.x1 * kx, y1: b.oy + a.y1 * ky, x2: b.ox + a.x2 * kx, y2: b.oy + a.y2 * ky,
    color: a.color || ctx.arrowColor, shaft: arrowShaftPx(b.iw, ctx.natW, ctx.natH, ctx.region) };   // 線寬用圖片的顯示寬換算，不是容器寬
});
// 參考線：成品裡字幕從哪開始、畫面底部在哪。跟著顯示區域算，沒圈就用整張圖。
const guides = computed(() => {
  if (!ctx.natW) return [];
  const b = box.value;
  const r = ctx.region && ctx.region.w > 0 ? ctx.region : { x: 0, y: 0, w: ctx.natW, h: ctx.natH };
  return shotGuideLines(ctx.natW, ctx.natH, ctx.region).map((g) => ({ ...g,
    style: { left: b.ox + (r.x / ctx.natW) * b.iw + 'px', top: b.oy + (g.y / ctx.natH) * b.ih + 'px', width: (r.w / ctx.natW) * b.iw + 'px' } }));
});
const hasR = computed(() => !!(ctx.region && ctx.region.w > 0));
const hasC = computed(() => !!(ctx.cell && ctx.cell.w > 0));
const hasA = computed(() => hasArrow(ctx.arrow));

// 拖曳畫框：一律換算成原圖像素座標存，換手機解析度也對。X 與 Y 各自算縮放比例。
function down(ev) {
  const img = imgEl.value;
  if (!img || !ctx.natW || !ctx.natH) return;   // 圖還沒載入完，這時候換算比例會是錯的
  const b = img.getBoundingClientRect();
  const scX = ctx.natW / b.width, scY = ctx.natH / b.height;
  ctx.drag = { x0: (ev.clientX - b.left) * scX, y0: (ev.clientY - b.top) * scY, b, scX, scY };
  ev.preventDefault();
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}
function move(ev) {
  if (!ctx.drag) return;
  const { x0, y0, b, scX, scY } = ctx.drag;
  const x1 = Math.max(0, Math.min(ctx.natW, (ev.clientX - b.left) * scX));
  const y1 = Math.max(0, Math.min(ctx.natH, (ev.clientY - b.top) * scY));
  if (mode.value === 'arrow') {
    // 箭頭是線段不是矩形：按下的地方是尾、放開的地方是頭（箭鏃）
    ctx.arrow = { x1: x0, y1: y0, x2: x1, y2: y1, color: ctx.arrowColor || ARROW_DEFAULT };
  } else {
    ctx[mode.value] = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  }
}
function up() {
  window.removeEventListener('mousemove', move);
  window.removeEventListener('mouseup', up);
  if (!ctx.drag) return;
  ctx.drag = null;
  if (mode.value === 'arrow') {
    // 太短多半是誤點。⚠️ 不能沿用框那組 w/h 門檻 —— 水平或垂直的箭頭一定有一軸是 0。線段只能用長度判斷。
    const a = ctx.arrow;
    const min = Math.min(ctx.natW, ctx.natH) * ARROW_MIN_RATIO;
    if (a && Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < min) ctx.arrow = null;
    return;
  }
  const r = ctx[mode.value];
  if (r && (r.w < ctx.natW * 0.02 || r.h < ctx.natH * 0.008)) ctx[mode.value] = null;   // 太小多半是誤點
}
onBeforeUnmount(() => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); });

/** 換圖一定要把框清掉：框存的是原圖像素座標，套到另一張圖上一定是錯的位置。 */
function swapImage(src) {
  if (src === ctx.src) return;
  ctx.src = src;
  ctx.region = null; ctx.cell = null; ctx.arrow = null;
  ctx.note = '（換了截圖，原本的框與箭頭已清掉 —— 請在新的圖上重畫）';
  ctx.natW = null; ctx.natH = null;
  nextTick(() => {
    const on = stripEl.value && stripEl.value.querySelector('.on');
    if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}
function pickColor(c) {
  ctx.arrowColor = c;
  if (ctx.arrow) ctx.arrow.color = c;
}

// ── 出現在哪一段 ──
const selection = computed({
  get: () => (ctx.from == null ? null : { lo: Math.min(ctx.from, ctx.to), hi: Math.max(ctx.from, ctx.to) }),
  set: (v) => { if (!v) { ctx.from = null; ctx.to = null; } else { ctx.from = v.lo; ctx.to = v.hi; } },
});
/** 別的段落各自佔了哪些字。mine＝同一張圖的其他段（虛線）；auto＝自動排的那一列（提示講法不同）。 */
const used = computed(() => (ctx.others || []).map((u) => ({ ...u, mine: !!u.src && u.src === ctx.src })));
function ownerOf(i) { let own = null; for (const u of used.value) if (i >= u.lo && i <= u.hi) own = u; return own; }   // 後標的為主
const coveredSet = computed(() => { const s = new Set(); for (const u of used.value) for (let i = u.lo; i <= u.hi; i++) s.add(i); return s; });
const mineSet = computed(() => { const s = new Set(); for (const u of used.value) if (u.mine) for (let i = u.lo; i <= u.hi; i++) s.add(i); return s; });
const titleOf = (i) => { const o = ownerOf(i); return o ? `${o.src} 已經選了這裡（${o.lo}–${o.hi}）` : null; };
/** 1.4 秒（MIN_SHOT_SEC）大約是幾個字 —— 算不出秒數時用 8 個字當保守值 */
const shortChars = computed(() => (ctx.charSec ? Math.max(2, Math.ceil(1.4 / ctx.charSec)) : 8));
const selectedText = computed(() => {
  const s = selection.value;
  return s ? (ctx.chars || []).filter((c) => c.i >= s.lo && c.i <= s.hi).map((c) => c.c).join('') : '';
});
/** 這一選會蓋掉誰（跟 resolveManualOverlaps 同一套區間相減，先講出來）。自動列走另一條規則，不報假警。 */
const overlaps = computed(() => {
  const s = selection.value;
  if (!s) return [];
  const out = [];
  for (const u of used.value) {
    if (u.hi < s.lo || u.lo > s.hi) continue;
    const who = u.src + (u.mine ? '（同一張圖的另一段）' : '');
    if (u.auto) { out.push({ bad: false, text: `會蓋到自動排的 ${who}（${u.lo}–${u.hi}）—— 出片時那一段會讓給你。` }); continue; }
    const parts = [];
    if (u.lo < s.lo) parts.push([u.lo, s.lo - 1]);
    if (u.hi > s.hi) parts.push([s.hi + 1, u.hi]);
    if (!parts.length) { out.push({ bad: true, text: `⚠️ 會整段蓋住 ${who}（${u.lo}–${u.hi}）→ 那一段不會出現在影片裡` }); continue; }
    const left = parts.reduce((n, p) => n + (p[1] - p[0] + 1), 0);
    const where = parts.map((p) => `${p[0]}–${p[1]}`).join('、');
    const secs = ctx.charSec ? `，約 ${(left * ctx.charSec).toFixed(1)} 秒` : '';
    out.push({ bad: left < shortChars.value, text: `會蓋到 ${who}（${u.lo}–${u.hi}）→ 裁成 ${where}（共 ${left} 個字${secs}）`
      + (left < shortChars.value ? '，不到 1.4 秒 → 出片時會被丟掉，那一段也不會出現' : '') });
  }
  return out;
});

function ok() {
  if (ctx.from == null) return alert('還沒選範圍 —— 在下面的腳本上點一下或拖選');
  const result = {
    src: ctx.src, region: ctx.region, cell: ctx.cell,
    arrow: hasArrow(ctx.arrow) ? ctx.arrow : null,
    startCharIdx: Math.min(ctx.from, ctx.to), endCharIdx: Math.max(ctx.from, ctx.to),
    imgW: ctx.natW, imgH: ctx.natH,
  };
  const done = ctx.onDone;
  closeEditor();
  done(result);
}
watch(() => ctx.src, () => nextTick(measure));
</script>

<template>
  <div class="ed" data-editor>
    <div class="ed-in">
      <div class="ed-left">
        <div ref="stripEl" class="ed-strip">
          <div v-for="n in ctx.images" :key="n" :class="{ on: n === ctx.src }" :title="n" @click="swapImage(n)">
            <img :src="fileUrl(ctx.job.id, n)" alt="">
          </div>
        </div>
        <div ref="wrapEl" class="ed-img" @mousedown="down">
          <img ref="imgEl" :key="ctx.src" :src="fileUrl(ctx.job.id, ctx.src)" alt="" @load="onLoad">
          <div v-if="regionPx" class="bx region" :style="regionPx"></div>
          <div v-if="cellPx" class="bx" :style="cellPx"></div>
          <ArrowSvg v-if="arrowPx" v-bind="arrowPx" />
          <div v-for="g in guides" :key="g.label" class="bx guide" :class="{ cut: g.cut }" :style="g.style"><span>{{ g.label }}</span></div>
        </div>
      </div>
      <div class="ed-side">
        <h3>{{ ctx.mode === 'annot' ? '標注　' + ctx.src : (ctx.title || '調整這一段') }}</h3>
        <label>現在要畫哪一種</label>
        <div class="modes">
          <div :class="{ on: mode === 'region' }" @click="ctx.mode2 = 'region'">顯示區域</div>
          <div :class="{ on: mode === 'cell' }" @click="ctx.mode2 = 'cell'">黃框</div>
          <div v-if="arrowOn" :class="{ on: mode === 'arrow' }" @click="ctx.mode2 = 'arrow'">箭頭</div>
        </div>
        <div class="rects">
          <div><i class="sw region"></i>顯示區域<span>{{ hasR ? '已畫' : '沒有' }}</span>
            <button class="ghost tiny" :disabled="!hasR" @click="ctx.region = null">刪掉</button></div>
          <div><i class="sw cell"></i>黃框<span>{{ hasC ? '已畫' : '沒有' }}</span>
            <button class="ghost tiny" :disabled="!hasC" @click="ctx.cell = null">刪掉</button></div>
          <div v-if="arrowOn"><i class="sw arrow" :style="{ background: ctx.arrowColor || ARROW_DEFAULT }"></i>箭頭<span>{{ hasA ? '已畫' : '沒有' }}</span>
            <button class="ghost tiny" :disabled="!hasA" @click="ctx.arrow = null">刪掉</button></div>
        </div>
        <div v-if="arrowOn && mode === 'arrow'">
          <label>箭頭顏色</label>
          <div class="colors">
            <i v-for="c in ARROW_COLORS" :key="c" :style="{ background: c }" :title="c"
              :class="{ on: c.toLowerCase() === String(ctx.arrowColor).toLowerCase() }" @click="pickColor(c)"></i>
          </div>
        </div>
        <div class="tip">在左圖拖曳就會畫出「現在要畫的那一種」。<br>
          顯示區域與黃框可以只有一種、也可以都有；都沒有就是整張顯示。<br>
          <span v-if="arrowOn">箭頭是<b>從尾拖到頭</b>（放開的那一端是箭鏃），一段一支；成品裡它會沿著自己的方向前後微微晃動。</span></div>
        <div style="margin-top:14px"><small style="color:#c98a00">{{ ctx.note }}</small></div>
        <label>出現在哪一段（點頭、再點尾）</label>
        <RangePicker mode="live" :chars="ctx.chars || []" :units="ctx.units || []" v-model:selection="selection"
          :covered="coveredSet" :mine="mineSet" :titles="titleOf" />
        <div class="tip">
          <div v-if="!selection">點一下選整句，或按住拖曳選任意範圍。再點一次取消。</div>
          <template v-else>
            <div>選了：{{ selectedText }}</div>
            <div v-for="(o, i) in overlaps" :key="i" class="ovr" :class="{ bad: o.bad }">{{ o.text }}</div>
          </template>
        </div>
        <div class="ed-act">
          <button class="ghost" @click="closeEditor">取消</button>
          <button class="go" @click="ok">完成</button>
        </div>
      </div>
    </div>
  </div>
</template>
