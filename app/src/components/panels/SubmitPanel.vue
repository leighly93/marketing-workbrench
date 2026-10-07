<script setup>
// 送出出片：草稿的最後一關。檢查清單 → 扣點數警語 → confirm → POST /submit。
import { computed, ref } from 'vue';
import { api, whenFull } from '../../lib/api.js';
import { jobImages } from '../../lib/files.js';
import { emotionLabel } from '../../lib/voice.js';
import { templateLabel } from '../../stores/health.js';

const props = defineProps({ job: Object, node: Object });
const emit = defineEmits(['refresh']);
const draft = computed(() => props.job.status === 'draft');
const hasHeygen = computed(() => (props.job.files || []).some((n) => /^heygen\.mp4$/i.test(n)));
const checks = computed(() => [
  { ok: true, text: `版型：${templateLabel(props.job.template)}` },
  { ok: !!props.job.title, text: props.job.title ? `標題：${props.job.title.replace(/\n/g, ' / ')}` : '沒有標題（可以沒有，但成品上方會是空的）', soft: true },
  { ok: jobImages(props.job).length > 0, text: jobImages(props.job).length ? `截圖 ${jobImages(props.job).length} 張` : '沒有截圖 —— 影片會只有講者', soft: true },
  props.job.skipGenerate
    ? { ok: hasHeygen.value, text: hasHeygen.value ? '用現成的講者影片（不扣點數）' : '選了「用現成的講者影片」，但還沒上傳 heygen.mp4' }
    : { ok: true, text: `HeyGen 重新生成，配音語氣：${emotionLabel(props.job.emotion || 'fluent')}` },
]);
const blocked = computed(() => checks.value.some((c) => !c.ok && !c.soft));
const busy = ref(false);

async function submit() {
  if (blocked.value) return;
  const j = props.job;
  // 版型放第一行（同事會按錯）。原生 confirm 只能用【】強調。用現成的講者影片不扣點數，不用問。
  if (!j.skipGenerate && !j.redoOf
    && !confirm(`這支要出的是【${templateLabel(j.template)}】\n配音語氣：${emotionLabel(j.emotion || 'fluent')}\n\n確定要開始出片嗎？\n送出前再確認一次：版型、腳本、標題、截圖。`)) return;
  busy.value = true;
  try { await api(`/api/jobs/${j.id}/submit`, { method: 'POST' }); emit('refresh'); }
  catch (e) { alert('送不出去：' + e.message); }
  busy.value = false;
}
</script>

<template>
  <div class="card">
    <h2>送出出片</h2>
    <template v-if="draft">
      <div v-if="job.redoOf" class="note mb-3">稿件、截圖、標注與講者影片都從工作 <code>{{ job.redoOf }}</code> 帶過來了，<b>還沒開始跑</b>。看一下「手動標記」裡的框還在不在、要不要微調，好了就按開始。這支不會重新呼叫 HeyGen／MiniMax，<b>不扣點數</b>。</div>
      <ul class="m-0 list-none p-0 text-sm">
        <li v-for="(c, i) in checks" :key="i" class="flex items-start gap-2 py-1">
          <span :style="{ color: c.ok ? 'var(--ok)' : (c.soft ? 'var(--warn)' : 'var(--bad)') }">{{ c.ok ? '✓' : (c.soft ? '△' : '✕') }}</span><span>{{ c.text }}</span>
        </li>
      </ul>
      <div v-if="!job.skipGenerate" class="warn mt-4">
        <b>⚠️ 按下「開始出片」就會扣點數。</b><br>
        按下去會馬上呼叫 HeyGen 生成講者影片，<b>點數當下就扣掉，之後取消或重出都退不回來</b>。<br>
        送出前請再檢查一次：腳本有沒有錯字、標題對不對、截圖是不是最新的。
      </div>
      <div class="mt-4"><button class="go" :disabled="blocked || busy" @click="submit">{{ busy ? '送出…' : `開始出片：${templateLabel(job.template)}` }}</button></div>
      <div class="tip">送出後稿件就不能改了；截圖還可以在準備中補。排隊與準備期間可以先做「手動標記」。</div>
    </template>
    <template v-else>
      <div class="text-sm">已送出{{ job.startedAt ? `，${whenFull(job.startedAt)} 開始準備` : '' }}。</div>
      <div class="tip">要停下來用頁首的「取消工作」；跑完之後想再出一次用「重新出片」。</div>
    </template>
  </div>
</template>
