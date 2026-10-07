<script setup>
// 一列的預覽：原圖 ＋ 用比例畫上去的黃框／顯示區域／箭頭（改完立刻反映，不用等伺服器重畫縮圖）。
// ⚠️ 縮圖固定 120px 寬（.prev），箭頭的高度要照原圖比例算，不能拿 offsetHeight（圖可能還沒載入）。
// 沒有框就什麼線都不要畫 —— 以前畫一個包住整張圖的黃框當「整張顯示」，結果被當成真的黃框。
import { computed } from 'vue';
import { arrowShaftPx, hasArrow } from '../../lib/arrows.js';
import { fileUrl } from '../../lib/api.js';
import ArrowSvg from './ArrowSvg.vue';

const props = defineProps({ job: Object, e: Object, hint: String, manual: Boolean, dim: Boolean });
const W = 120;
const pct = (r) => (r && r.w > 0 && props.e.imgW && props.e.imgH
  ? { left: (r.x / props.e.imgW) * 100 + '%', top: (r.y / props.e.imgH) * 100 + '%', width: (r.w / props.e.imgW) * 100 + '%', height: (r.h / props.e.imgH) * 100 + '%' }
  : null);
const region = computed(() => pct(props.e.region));
const cell = computed(() => pct(props.e.cell));
const arrow = computed(() => {
  const a = props.e.arrow;
  if (!hasArrow(a) || !props.e.imgW || !props.e.imgH) return null;
  const h = (W * props.e.imgH) / props.e.imgW, k = W / props.e.imgW;
  return { w: W, h, x1: a.x1 * k, y1: a.y1 * k, x2: a.x2 * k, y2: a.y2 * k, color: a.color, shaft: arrowShaftPx(W, props.e.imgW, props.e.imgH, props.e.region) };
});
const empty = computed(() => !props.e.region && !props.e.cell && !hasArrow(props.e.arrow));
</script>

<template>
  <div class="prev" :class="{ man: manual }" :style="dim ? 'opacity:.55' : ''">
    <img :src="fileUrl(job.id, e.src)" alt="">
    <div v-if="region" class="bx region" :style="region"></div>
    <div v-if="cell" class="bx" :style="cell"></div>
    <ArrowSvg v-if="arrow" v-bind="arrow" />
    <div class="hint">{{ hint || (empty ? '整張顯示・點我編輯' : (manual ? '已手動調整' : '點我編輯')) }}</div>
  </div>
</template>
