<script setup>
// 在一個 position:relative 的容器上疊一支箭頭。座標是**容器內的 px**，換算由呼叫端負責。
// 形狀跟成品（ShotFocus.tsx）同一套：桿子＋三角箭鏃，純色一層不描邊。
import { computed } from 'vue';
import { arrowGeometry } from '../../lib/arrows.js';

const props = defineProps({
  w: Number, h: Number, x1: Number, y1: Number, x2: Number, y2: Number, color: String, shaft: Number,
});
const g = computed(() => arrowGeometry(props.w, props.h, props.x1, props.y1, props.x2, props.y2, props.color, props.shaft));
</script>

<template>
  <svg class="bx arrow" :viewBox="`0 0 ${w} ${h}`" :style="{ left: 0, top: 0, width: w + 'px', height: h + 'px' }">
    <g :transform="g.transform">
      <line x1="0" y1="0" :x2="g.lineX2" y2="0" :stroke="g.color" :stroke-width="g.lw.toFixed(1)" stroke-linecap="round" />
      <polygon :points="g.points" :fill="g.color" :stroke="g.color" :stroke-width="g.headStroke" stroke-linejoin="round" />
    </g>
  </svg>
</template>
