<script setup>
// 講者影片與配音語氣。「用現成的講者影片」是唯一不花點數的出片路徑 —— 開放給所有人，不要鎖回管理者。
import { computed, ref } from 'vue';
import { json } from '../../lib/api.js';
import { isVideoFile } from '../../lib/files.js';
import { EMOTIONS, emotionLabel } from '../../lib/voice.js';
import { pickFiles, uploadNamed } from '../../lib/uploads.js';
import Modes from '../ui/Modes.vue';

const props = defineProps({ job: Object, node: Object });
const emit = defineEmits(['refresh']);
const draft = computed(() => props.job.status === 'draft');
const hasHeygen = computed(() => (props.job.files || []).some((n) => /^heygen\.mp4$/i.test(n)));
const HEYGEN_MODES = [[false, '重新生成'], [true, '用現成的']];
const TIP = { [false]: '會呼叫 HeyGen 生成一支新的講者影片。', [true]: '不呼叫 HeyGen、不扣點數 —— 拿一支之前的講者影片重跑就好。' };
const hot = ref(false);
const msg = ref('');

async function patch(fields) {
  try { await json('PATCH', `/api/jobs/${props.job.id}`, fields); emit('refresh'); }
  catch (e) { alert('存不進去：' + e.message); }
}
async function setVideo(f) {
  if (!f) return;
  if (!isVideoFile(f)) return alert(`「${f.name}」看起來不是影片檔。`);
  msg.value = `上傳 ${f.name}（${(f.size / 1048576).toFixed(1)} MB）…`;
  try { await uploadNamed(props.job, f, 'heygen.mp4'); msg.value = '已上傳'; emit('refresh'); }
  catch (e) { msg.value = ''; alert(e.message); }
}
async function pick() { setVideo((await pickFiles({ accept: 'video/*,.mp4', multiple: false }))[0]); }
</script>

<template>
  <div class="card">
    <h2>講者影片與語氣</h2>
    <template v-if="draft">
      <label>講者影片</label>
      <Modes :options="HEYGEN_MODES" :model-value="!!job.skipGenerate" @update:model-value="(v) => patch({ skipGenerate: v })" />
      <div class="tip">{{ TIP[!!job.skipGenerate] }}</div>
      <div v-if="job.skipGenerate" class="mt-3">
        <div class="vdrop" :class="{ hot, ok: hasHeygen }" @click="pick"
          @dragover.prevent="hot = true" @dragleave="hot = false" @drop.prevent="hot = false; setVideo($event.dataTransfer.files[0])">
          <b>{{ hasHeygen ? '已有 heygen.mp4（點這裡可換掉）' : '選擇或拖曳講者影片' }}</b>
          <span>{{ msg || '支援 .mp4（會被存成 heygen.mp4）' }}</span>
        </div>
        <div class="tip">⚠️ <b>腳本要跟這支影片對得上</b> —— 字幕是從影片的聲音轉出來的。想換版面、換截圖、改配圖，就把腳本原封不動貼回來；腳本改了就得重新生一支影片，不然字幕會跟旁白對不起來。<br>
          影片的速度不用管 —— 已經加速過的檔案系統認得出來，不會再加速一次。</div>
      </div>
      <label>配音語氣</label>
      <Modes :options="EMOTIONS" :model-value="job.emotion || 'fluent'" :off="!!job.skipGenerate" @update:model-value="(v) => patch({ emotion: v })" />
      <div class="tip" v-if="job.skipGenerate">用現成的講者影片不會重新配音 —— 這支的語氣就是那支影片原本的。</div>
      <div class="tip" v-else>講漲勢、好消息用「開心」；重挫、壞消息用「流暢」（平穩）。<b>不選擇預設就是流暢。</b></div>
    </template>
    <template v-else>
      <div class="text-sm">講者影片：<b>{{ job.skipGenerate ? '用現成的 heygen.mp4' : '由 HeyGen 重新生成' }}</b></div>
      <div class="text-sm mt-1">配音語氣：<b>{{ job.skipGenerate ? '沿用影片原本的' : emotionLabel(job.emotion || 'fluent') }}</b></div>
    </template>
  </div>
</template>
