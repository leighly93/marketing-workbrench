<script setup>
// 發音回報：剛看完成品的地方就能回報，秒數一鍵帶入。管理者直接進共用詞庫；同事送一筆「跟我說」。
import { computed, ref } from 'vue';
import { fileUrl, json } from '../../lib/api.js';
import { admin } from '../../stores/health.js';
import { owner } from '../../stores/owner.js';
import { addDictRuleConfirming } from '../../lib/dict.js';

const props = defineProps({ job: Object, node: Object });
const video = ref(null);
const rows = ref([newRow()]);
function newRow() { return { from: '', to: '', sec: '', done: false, msg: '' }; }
const first = computed(() => (props.job.outputs || [])[0]);
const hit = computed(() => (props.job.voiceRules || {}).hit);

function stamp(r) { if (!video.value) return alert('這支還沒有可以播的成品'); r.sec = video.value.currentTime.toFixed(1); }
function replay(r) { const t = parseFloat(r.sec); if (!video.value || !isFinite(t)) return; video.value.currentTime = Math.max(0, t - 1.5); video.value.play(); }
async function send(r) {
  const from = r.from.trim(), to = r.to.trim();
  if (!from || !to) return alert('兩格都要填：唸錯的詞、該怎麼寫');
  if (from === to) return alert('「該怎麼寫」要填不一樣的字（同音、但 AI 唸得對的寫法）');
  const at = parseFloat(r.sec);
  const why = '人工聽出來的' + (isFinite(at) ? `（第 ${at.toFixed(1)} 秒）` : '');
  const by = owner.value || props.job.owner;
  try {
    if (admin.value) { if (!(await addDictRuleConfirming({ from, to, why, by }))) return; }
    else await json('POST', '/api/messages', { kind: 'pronounce', word: from, suggest: to, why, by, job: props.job.id });
    r.done = true; r.msg = admin.value ? '✅ 已加進共用詞庫' : '✅ 已回報，等管理者收錄';
  } catch (e) { alert(e.message); }
}
</script>

<template>
  <div class="card">
    <h2>發音回報　—　聽到唸錯的字寫在這裡</h2>
    <div class="note mb-3">影片放出來聽，哪個字唸錯了就填在這裡。{{ admin ? '按下去直接進共用詞庫，之後每支影片自動套用。' : '送出後管理者會收到，收錄之後每支影片都會自動用對的唸法。' }}<br>
      <b>「該怎麼寫」請填同音字或數字唸法</b>（例：收斂→<b>收練</b>、櫃買→<b>貴買</b>、2330→<b>二三三零</b>），不要填注音。<b>聲調不對也算</b>。秒數可以不填，填了我才知道去聽哪一段。</div>
    <video v-if="first" ref="video" controls :src="fileUrl(job.id, first.name)" style="max-width:260px;margin-bottom:8px"></video>
    <div v-for="(r, i) in rows" :key="i" class="say2">
      <input v-model="r.from" placeholder="唸錯的詞（例：收斂）" :disabled="r.done">
      <input v-model="r.to" placeholder="該怎麼寫（同音字）" :disabled="r.done">
      <input v-model="r.sec" class="sec" placeholder="秒數" :disabled="r.done">
      <button class="ghost" @click="stamp(r)">⏱ 用現在的播放位置</button>
      <button class="ghost" @click="replay(r)">▶ 再聽一次</button>
      <button class="go" :disabled="r.done" @click="send(r)">{{ admin ? '加進共用詞庫' : '送出' }}</button>
      <span class="ok">{{ r.msg }}</span>
    </div>
    <div class="mt-3"><button class="ghost" @click="rows.push(newRow())">＋ 再加一則</button></div>
    <!-- 這支套了哪幾條規則：hit == null 的舊工作不畫（那是「不知道」，不是「沒套到」） -->
    <div v-if="hit != null" class="mt-4 border-t border-line pt-3">
      <div class="hint mb-2">{{ hit.length ? `這支送 AI 配音前，先套了這 ${hit.length} 條發音規則 —— 這些字聽起來還是錯的話，代表規則沒生效，換一種寫法再回報一次。` : '這支沒有套到任何發音規則。聽到唸錯的字都是新的，直接回報就好。' }}</div>
      <div v-if="hit.length" class="rules">
        <span v-for="r in hit" :key="r.from + r.to + r.src" class="rule">{{ r.from }} → <b>{{ r.to }}</b>{{ r.times > 1 ? ` ×${r.times}` : '' }}<i>{{ r.src === 'own' ? '本支自己填的' : '共用詞庫' }}</i></span>
      </div>
    </div>
  </div>
</template>
