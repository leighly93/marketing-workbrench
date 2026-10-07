<script setup>
// 稿件與標題。草稿還能改標題與建立者（PATCH）；稿件本身不給改 —— 標注是照字元位置對到稿件的。
import { computed, ref, watch } from 'vue';
import { json } from '../../lib/api.js';
import { templateLabel, templates } from '../../stores/health.js';

const props = defineProps({ job: Object, node: Object });
const emit = defineEmits(['refresh']);
const draft = computed(() => props.job.status === 'draft');
const cfg = computed(() => (templates.value[props.job.template] || {}).title || { lines: 2, per: 12, where: '' });
const lines = ref([]);
const owner = ref('');
const msg = ref('');
watch(() => props.job.id + props.job.title + props.job.owner, () => {
  const got = (props.job.title || '').split('\n');
  lines.value = Array.from({ length: cfg.value.lines }, (_, i) => got[i] || '');
  owner.value = props.job.owner || '';
}, { immediate: true });

function count(i) {
  const n = (lines.value[i] || '').trim().length;
  if (!n) return { text: '', over: false };
  const over = cfg.value.wrap && n > cfg.value.per;
  return { text: n + '/' + cfg.value.per + (over ? '・會換行' : ''), over };
}
async function save() {
  try {
    await json('PATCH', `/api/jobs/${props.job.id}`, { title: lines.value.map((l) => l.trim()).filter(Boolean).join('\n'), owner: owner.value });
    msg.value = '已存'; setTimeout(() => { msg.value = ''; }, 2500);
    emit('refresh');
  } catch (e) { alert('存不進去：' + e.message); }
}
</script>

<template>
  <div class="card">
    <h2>稿件與標題</h2>
    <label>版型</label>
    <div class="text-sm font-semibold">{{ templateLabel(job.template) }}</div>
    <label>{{ templateLabel(job.template) }}標題</label>
    <template v-if="draft">
      <div v-for="(l, i) in lines" :key="i" class="tline">
        <input type="text" v-model="lines[i]" :maxlength="cfg.wrap === false ? cfg.per : null"
          :placeholder="cfg.lines === 1 ? '' : (i === 0 ? '第一行' : '第二行')">
        <span class="cnt" :class="{ over: count(i).over }">{{ count(i).text }}</span>
      </div>
      <div class="hint">{{ cfg.where }}</div>
      <label>你是誰</label>
      <input type="text" v-model="owner" placeholder="王小明">
      <div class="mt-4 flex items-center gap-3"><button class="ghost" @click="save">儲存</button><span class="hint">{{ msg }}</span></div>
    </template>
    <div v-else class="whitespace-pre-wrap text-sm">{{ job.title || '（沒有標題）' }}</div>
    <label>腳本</label>
    <div v-if="job.scriptBody" class="whitespace-pre-wrap rounded-lg border border-line bg-[#fcfdfe] p-3 text-sm leading-7">{{ job.scriptBody }}</div>
    <div v-else class="hint">這支工作建立時沒有另存稿件原文；完整稿件在工作資料夾的 script.txt。</div>
    <div class="tip">稿件送出後就不能改 —— 標注與重點詞是照字元位置對到稿件的，改一個字後面的框就會跑掉。要改稿請重新建立一支工作。</div>
  </div>
</template>
