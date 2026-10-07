<script setup>
// 新增任務（最小建立）：版型、你是誰、標題、腳本 → 建一份草稿，接著到 pipeline 補截圖、唸法、講者影片再送出。
// 腳本在這裡就定案（建立那一刻寫進 script.txt，標注照字元位置對它）。
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { json } from '../lib/api.js';
import { pickableTemplates, templates } from '../stores/health.js';
import { owner } from '../stores/owner.js';

const router = useRouter();
const tpl = ref(null);
const titleVals = ref(['', '']);
const body = ref('');
const busy = ref(false);

// 預設選中＝可選清單的第一個（順序由 video/templates/registry.js 的宣告順序決定）
watch(pickableTemplates, (list) => {
  if (!tpl.value || !templates.value[tpl.value] || templates.value[tpl.value].disabled || templates.value[tpl.value].hidden) {
    const ok = list.find((t) => !t.disabled);
    if (ok) tpl.value = ok.id;
  }
}, { immediate: true });

const cur = computed(() => templates.value[tpl.value] || {});
const cfg = computed(() => cur.value.title || { lines: 2, per: 12, where: '' });
// 會換行的模板字數只是「參考」；只有不能換行的（cfg.wrap === false）才用 maxlength 硬擋
function count(i) {
  const n = (titleVals.value[i] || '').trim().length;
  if (!n) return { text: '', over: false };
  const over = cfg.value.wrap && n > cfg.value.per;
  return { text: n + '/' + cfg.value.per + (over ? '・會換行' : ''), over };
}
const PLACEHOLDER = '想轉戰二線光學撿便宜？先看清楚殘酷的真相！\n先進光跟中揚光目前只有送樣，與題材驗證，先進光 8 月營收甚至還在年減，根本沒有實質獲利保證！\n聯一光短線已經暴漲超過三成，細看盤中動向，大戶狂賣、散戶還趕著進場，\n小心盲目摸底二線股，可能惹禍上身！';

async function create() {
  if (!tpl.value) return alert('先選版型');
  if (!body.value.trim()) return alert('腳本是空的');
  busy.value = true;
  try {
    const { job } = await json('POST', '/api/jobs', {
      template: tpl.value, owner: owner.value,
      title: titleVals.value.slice(0, cfg.value.lines).map((v) => v.trim()).filter(Boolean).join('\n'),
      body: body.value, voice: '', skipGenerate: false, autoApprove: false, emotion: 'fluent',
    });
    body.value = ''; titleVals.value = ['', ''];
    router.push('/jobs/' + job.id);
  } catch (e) { alert('建立失敗：' + e.message); }
  busy.value = false;
}
</script>

<template>
  <div :data-tpl="tpl || ''" id="v-new">
    <div class="card">
      <h2>1・選版型</h2>
      <div class="tpl" id="tpl">
        <div v-for="t in pickableTemplates" :key="t.id" :data-k="t.id" :class="{ on: t.id === tpl, off: t.disabled }" :title="t.disabled ? '暫時關閉' : ''"
          @click="!t.disabled && (tpl = t.id)">{{ t.label }}</div>
      </div>
    </div>
    <div class="card">
      <h2>2・基本資料</h2>
      <label>你是誰</label>
      <input type="text" id="owner" v-model="owner" placeholder="王小明">
      <!-- 標題欄位前面掛版型名（同事會按錯版型） -->
      <label id="titleLabel">{{ cur.label || '影片' }}標題</label>
      <div v-for="i in cfg.lines" :key="i" class="tline">
        <input type="text" v-model="titleVals[i - 1]" :maxlength="cfg.wrap === false ? cfg.per : null" :placeholder="cfg.lines === 1 ? '' : (i === 1 ? '第一行' : '第二行')">
        <span class="cnt" :class="{ over: count(i - 1).over }">{{ count(i - 1).text }}</span>
      </div>
      <div class="hint">{{ cfg.where }}</div>
      <label>腳本（直接貼上）</label>
      <textarea id="body" v-model="body" :placeholder="PLACEHOLDER"></textarea>
    </div>
    <div class="card">
      <h2>3・建立草稿</h2>
      <div class="note">按下去只會建一份<b>草稿</b>，<b>不會扣點數</b>。接著在工作頁的流程圖裡補截圖、唸法、講者影片，最後在「送出出片」那一格才真的開始。<br>
        腳本在這裡就定案 —— 之後的標注是照字元位置對到腳本的，所以草稿建好後不能改稿。</div>
      <div class="mt-4"><button class="go" id="submit" :disabled="busy" @click="create">建立草稿：{{ cur.label || '' }}</button></div>
    </div>
  </div>
</template>
