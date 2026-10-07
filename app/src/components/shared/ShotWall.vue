<script setup>
// 截圖縮圖牆：配圖計畫頁與手動標記頁用同一份。count＝每張被用了幾次；pages＝系統判定的頁型；
// 點一下＝用那張加一段。認不出來的頁型給管理者一顆 📌（只存指紋與截圖，之後批次命名）。
import { ref } from 'vue';
import { fileUrl, json } from '../../lib/api.js';
import { admin, showFlash } from '../../stores/health.js';
import { lastJob } from '../../stores/job.js';
import { who } from '../../stores/owner.js';

const props = defineProps({ job: Object, images: Array, count: Object, pages: Object });
const emit = defineEmits(['pick']);
const pinned = ref(new Set());

function unknownPage(n) {
  const pg = (props.pages || {})[n] || {};
  return !pg.page || pg.page === 'unknown' || pg.page === 'stock-other';
}
function pageLabel(n) { return ((props.pages || {})[n] || {}).pageLabel || '未知頁面'; }

async function pin(n) {
  if (!who()) return alert('先填一下「你是誰」，我才知道是誰回報的。');
  try {
    await json('POST', '/api/messages', { kind: 'page-pin', src: n, by: who(), job: lastJob.value });
    pinned.value = new Set([...pinned.value, n]);
    showFlash('📌 記下了，之後批次命名');
  } catch (e) { alert('送不出去：' + e.message); }
}
</script>

<template>
  <div class="shots">
    <figure v-for="n in images" :key="n" :class="{ used: (count || {})[n] }" :title="`點一下＝用 ${n} 加一段`" @click="emit('pick', n)">
      <img :src="fileUrl(job.id, n)" alt="">
      <div class="tag">{{ (count || {})[n] ? `已用 ${count[n]} 次` : '還沒用' }}</div>
      <div class="pg" :class="{ unk: unknownPage(n) }" title="系統判定的頁型">{{ pageLabel(n) }}</div>
      <div class="nm">{{ n }}</div>
      <button v-if="unknownPage(n) && admin" class="pin" :disabled="pinned.has(n)"
        title="記下這種頁：系統認不出來，先存指紋與截圖，之後批次命名" @click.stop="pin(n)">{{ pinned.has(n) ? '✓' : '📌' }}</button>
    </figure>
  </div>
</template>
