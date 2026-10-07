<script setup>
// 每日完成／失敗的堆疊直條（SVG）。dataviz 規則：細條（≤24px、頂端 4px 圓角、底部貼基線）、
// 段與段之間 2px 底色縫、淡色實線格線、兩個系列一定有圖例、hover 有提示、另有表格檢視。
import { computed, ref } from 'vue';

const props = defineProps({ days: { type: Array, default: () => [] } });
const W = 640, H = 200, PAD = { l: 34, r: 8, t: 14, b: 26 };
const COLORS = { done: 'var(--viz-1)', failed: 'var(--viz-2)' };
const hover = ref(null);
const table = ref(false);

const max = computed(() => Math.max(1, ...props.days.map((d) => (d.done || 0) + (d.failed || 0))));
function niceStep(m) { const raw = m / 3; const p = Math.pow(10, Math.floor(Math.log10(raw))); const n = raw / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }
const step = computed(() => niceStep(max.value));
const top = computed(() => Math.ceil(max.value / step.value) * step.value);
const ticks = computed(() => { const t = []; for (let v = 0; v <= top.value; v += step.value) t.push(v); return t; });
const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
const y = (v) => PAD.t + plotH - (v / top.value) * plotH;
const bars = computed(() => {
  const n = props.days.length || 1;
  const slot = plotW / n;
  const bw = Math.min(24, slot * 0.6);
  return props.days.map((d, i) => {
    const x = PAD.l + slot * i + (slot - bw) / 2;
    const done = d.done || 0, failed = d.failed || 0;
    const yDone = y(done), yTop = y(done + failed);
    return { d, i, x, bw, cx: x + bw / 2,
      done: done ? { y: yDone, h: y(0) - yDone } : null,
      failed: failed ? { y: yTop, h: Math.max(0, yDone - yTop - (done ? 2 : 0)) } : null,   // 2px 底色縫
      label: i === 0 || i === n - 1 || (n > 10 ? i % Math.ceil(n / 6) === 0 : true) ? d.day.slice(5) : '' };
  });
});
const tip = computed(() => {
  if (hover.value == null) return null;
  const b = bars.value[hover.value];
  return { ...b, left: (b.cx / W * 100) + '%', text: `${b.d.day}　完成 ${b.d.done || 0}・失敗 ${b.d.failed || 0}${b.d.cancelled ? '・取消 ' + b.d.cancelled : ''}${b.d.created != null ? '・建立 ' + b.d.created : ''}` };
});
const r = 4;   // 頂端圓角、底部直角
function roundedTop(x, yy, w, h) {
  const rr = Math.min(r, h / 2, w / 2);
  return `M${x},${yy + h} V${yy + rr} Q${x},${yy} ${x + rr},${yy} H${x + w - rr} Q${x + w},${yy} ${x + w},${yy + rr} V${yy + h} Z`;
}
</script>

<template>
  <div class="viz relative">
    <div class="mb-1 flex items-center gap-4 text-xs text-dim">
      <span class="flex items-center gap-1.5"><i class="inline-block h-2.5 w-2.5 rounded-sm" :style="{ background: COLORS.done }"></i>完成</span>
      <span class="flex items-center gap-1.5"><i class="inline-block h-2.5 w-2.5 rounded-sm" :style="{ background: COLORS.failed }"></i>失敗</span>
      <span class="flex-1"></span>
      <button class="ghost tiny" @click="table = !table">{{ table ? '圖' : '表格' }}</button>
    </div>
    <table v-if="table" class="list text-xs">
      <thead><tr><th>日期</th><th>建立</th><th>完成</th><th>失敗</th><th>取消</th></tr></thead>
      <tbody><tr v-for="d in days" :key="d.day"><td>{{ d.day }}</td><td>{{ d.created ?? '—' }}</td><td>{{ d.done }}</td><td>{{ d.failed }}</td><td>{{ d.cancelled }}</td></tr></tbody>
    </table>
    <svg v-else :viewBox="`0 0 ${W} ${H}`" class="block w-full" style="height:auto" @mouseleave="hover = null">
      <g v-for="t in ticks" :key="t">
        <line :x1="PAD.l" :x2="W - PAD.r" :y1="y(t)" :y2="y(t)" :stroke="t === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'" stroke-width="1" />
        <text :x="PAD.l - 6" :y="y(t) + 3.5" text-anchor="end" font-size="10" fill="var(--viz-muted)" style="font-variant-numeric:tabular-nums">{{ t }}</text>
      </g>
      <g v-for="b in bars" :key="b.i" @mouseenter="hover = b.i">
        <rect :x="b.x - 6" :y="PAD.t" :width="b.bw + 12" :height="plotH" fill="transparent" />
        <path v-if="b.done" :d="b.failed ? `M${b.x},${y(0)} V${b.done.y} H${b.x + b.bw} V${y(0)} Z` : roundedTop(b.x, b.done.y, b.bw, b.done.h)" :fill="COLORS.done" />
        <path v-if="b.failed" :d="roundedTop(b.x, b.failed.y, b.bw, b.failed.h)" :fill="COLORS.failed" />
        <text v-if="b.label" :x="b.cx" :y="H - 8" text-anchor="middle" font-size="10" fill="var(--viz-muted)">{{ b.label }}</text>
      </g>
      <line v-if="tip" :x1="tip.cx" :x2="tip.cx" :y1="PAD.t" :y2="y(0)" stroke="var(--viz-axis)" stroke-width="1" />
    </svg>
    <div v-if="tip && !table" class="pointer-events-none absolute top-6 -translate-x-1/2 rounded-md border border-line bg-white px-2 py-1 text-xs shadow-sm" :style="{ left: tip.left }">{{ tip.text }}</div>
  </div>
</template>
