<script setup>
// 執行記錄。輪詢時只換文字，捲在最底的話跟著捲（不在底就不動，別把人正在看的地方彈走）。
import { nextTick, ref, watch } from 'vue';

const props = defineProps({ text: String, open: Boolean });
const emit = defineEmits(['update:open']);
const pre = ref(null);
watch(() => props.text, async () => {
  const el = pre.value;
  if (!el) return;
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
  await nextTick();
  if (atBottom) el.scrollTop = el.scrollHeight;
});
watch(() => props.open, async (o) => { if (o) { await nextTick(); if (pre.value) pre.value.scrollTop = pre.value.scrollHeight; } });
</script>

<template>
  <div class="card" style="padding:14px 18px">
    <div class="flex items-center gap-3">
      <h2 class="m-0">執行記錄</h2>
      <span class="flex-1"></span>
      <button class="ghost tiny" @click="emit('update:open', !open)">{{ open ? '收起' : '展開' }}</button>
    </div>
    <pre v-if="open" ref="pre" class="log mt-3">{{ text || '（還沒有輸出）' }}</pre>
  </div>
</template>
