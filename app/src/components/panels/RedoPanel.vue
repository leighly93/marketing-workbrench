<script setup>
// 重新出片：用同一份稿件、截圖、標注、講者影片再跑一次，不呼叫 HeyGen／MiniMax。
import { ref } from 'vue';
import { api } from '../../lib/api.js';

const props = defineProps({ job: Object, node: Object });
const emit = defineEmits(['goto']);
const busy = ref(false);
async function redo() {
  busy.value = true;
  try { const r = await api(`/api/jobs/${props.job.id}/redo`, { method: 'POST' }); emit('goto', r.job.id); }
  catch (e) { busy.value = false; alert('重新出片失敗：' + e.message); }
}
</script>

<template>
  <div class="card">
    <h2>重新出片</h2>
    <div v-if="!['done', 'failed'].includes(job.status)" class="hint">這支跑完（或失敗）之後才能重新出片。</div>
    <template v-else>
      <div class="note">用<b>完全一樣</b>的稿件、截圖、標注（顯示範圍／黃框／箭頭）與講者影片再跑一次。<br>
        <b>不會重新呼叫 HeyGen 或 MiniMax，不扣點數。</b><br><br>
        按下去<b>直接開始準備</b>（分析截圖、轉字幕、排配圖計畫），跑完會<b>停在「配圖計畫確認」</b>等你 —— 到那裡再拖框、改範圍、換圖、加減段、標重點詞，確認了才真的出片。<br>
        <b>稿件不能改</b> —— 標注是照字元位置對到稿件的，改一個字後面的框就會跑掉。要改稿請重新建立一支工作。</div>
      <div class="mt-4 flex items-center gap-3"><button class="ghost" :disabled="busy" @click="redo">♻ 重新出片</button><span class="hint">{{ busy ? '複製中…' : '' }}</span></div>
    </template>
  </div>
</template>
