<script setup>
// 腳本逐字選取。兩種手勢：
//   live（編輯器的「出現在哪一段」）：拖曳中就直接改 selection；點一下選整個子句、點已選的取消。
//   preview（重點詞／動態）：拖曳中只上色（內部 preview），放手才 emit pick —— 那兩處放手時做的是
//   **決策**（取消／合併／取代），中途套用會在拖曳途中反覆翻轉。
import { computed, onBeforeUnmount, ref } from 'vue';
import { inPreview } from '../../lib/emphasis.js';

const props = defineProps({
  chars: { type: Array, default: () => [] },
  units: { type: Array, default: () => [] },
  mode: { type: String, default: 'preview' },
  selection: { type: Object, default: null },        // live：{lo,hi}
  marks: { type: Array, default: () => [] },         // 黃底：[{startCharIdx,endCharIdx}]
  covered: { type: Object, default: null },          // Set：藍底線（已經有配圖）
  mine: { type: Object, default: null },             // Set：虛線（同一張圖的其他段）
  titles: { type: Function, default: null },         // i → title 文字
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['update:selection', 'pick']);

const preview = ref(null);
let dragging = false, anchor = null, last = null, moved = false;

function isMarked(i) { return props.marks.some((m) => i >= m.startCharIdx && i <= m.endCharIdx); }
function inSel(i) { return !!props.selection && i >= props.selection.lo && i <= props.selection.hi; }

const tokens = computed(() => props.chars.map((c) => ({
  c,
  cls: [
    props.covered && props.covered.has(c.i) ? 'used' : '',
    props.mine && props.mine.has(c.i) ? 'mine' : '',
    (props.mode === 'live' ? inSel(c.i) : inPreview(preview.value, c.i)) ? 'sel'
      : (props.mode !== 'live' && isMarked(c.i) ? 'emph' : ''),
    c.b ? 'br' : '',
  ].filter(Boolean).join(' '),
  title: props.titles ? props.titles(c.i) : null,
})));

const idxOf = (t) => (t && t.dataset && t.dataset.i != null ? +t.dataset.i : null);

function clauseAt(i) {
  return props.units.find((u) => u.startCharIdx != null && i >= u.startCharIdx && i <= u.endCharIdx);
}

function onDown(ev) {
  if (props.disabled) return;
  const i = idxOf(ev.target);
  if (i == null) return;
  dragging = true; moved = false; anchor = i; last = i;
  if (props.mode !== 'live') preview.value = { lo: i, hi: i };   // 點下去就上色，不等放手
  ev.preventDefault();
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}
function onMove(ev) {
  if (!dragging) return;
  const i = idxOf(ev.target);
  if (i == null || i === last) return;
  if (i !== anchor) moved = true;
  last = i;
  const lo = Math.min(anchor, i), hi = Math.max(anchor, i);
  if (props.mode === 'live') emit('update:selection', { lo, hi });
  else preview.value = { lo, hi };
}
function onUp() {
  if (!dragging) return;
  dragging = false;
  document.removeEventListener('mousemove', onMove);
  document.removeEventListener('mouseup', onUp);
  if (props.mode === 'live') {
    if (moved) return;                     // 拖曳過 → 範圍已經在 mousemove 設好
    const i = anchor;
    const cl = clauseAt(i);
    if (inSel(i)) emit('update:selection', null);   // 點已選中的 → 取消
    else if (cl) emit('update:selection', { lo: cl.startCharIdx, hi: cl.endCharIdx });
    else emit('update:selection', { lo: i, hi: i });
    return;
  }
  preview.value = null;                  // 預覽讓位給真正套用的結果
  emit('pick', { lo: Math.min(anchor, last), hi: Math.max(anchor, last), click: anchor === last });
}
onBeforeUnmount(() => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); });
</script>

<template>
  <div class="range" @mousedown="onDown">
    <span v-if="!chars.length">（腳本還在讀…）</span>
    <template v-for="t in tokens" :key="t.c.i">
      <i :data-i="t.c.i" :class="t.cls" :title="t.title">{{ t.c.c }}</i>
      <br v-if="t.c.p" class="para">
    </template>
  </div>
</template>
