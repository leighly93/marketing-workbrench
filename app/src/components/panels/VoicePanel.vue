<script setup>
// 唸法（發音替換）。只影響「這一支」，改壞了也只壞一支；填的詞會順便回報給管理者。
import { computed, ref, watch } from 'vue';
import { json } from '../../lib/api.js';
import { voiceDupes, voiceProblem, voiceRows, voiceText } from '../../lib/voice.js';

const props = defineProps({ job: Object, node: Object });
const emit = defineEmits(['refresh']);
const draft = computed(() => props.job.status === 'draft');
const rows = ref([{ from: '', to: '' }]);
const msg = ref('');
watch(() => props.job.id, () => { rows.value = voiceRows((props.job.voiceRules || {}).own); }, { immediate: true });
const dupes = computed(() => voiceDupes(rows.value));
const hit = computed(() => (props.job.voiceRules || {}).hit);

async function save() {
  const vp = voiceProblem(rows.value);
  if (vp) return alert(vp);
  try {
    await json('PATCH', `/api/jobs/${props.job.id}`, { voice: voiceText(rows.value) });
    msg.value = '已存'; setTimeout(() => { msg.value = ''; }, 2500);
    emit('refresh');
  } catch (e) { alert('存不進去：' + e.message); }
}
</script>

<template>
  <div class="card">
    <h2>唸法（選填）</h2>
    <div class="note mb-3">
      AI 唸錯字的時候用這裡救。<b>要填「怎麼寫它才唸得對」，不是注音</b> —— 破音字換成同音字（收斂→收練、櫃買→貴買），股票代號直接寫成唸法（2330→二三三零）。<br>
      <b>字幕不受影響</b>，還是顯示你原本寫的字。填在這裡的詞會<b>順便回報給我</b>，常出現的我會收進共用詞庫。
    </div>
    <template v-if="draft">
      <div v-for="(r, i) in rows" :key="i" class="sayrow" :class="{ dup: dupes.has(i), 'mt-2.5': i > 0 }">
        <div><label v-if="i === 0">預想會唸錯的詞</label><input type="text" v-model="r.from" placeholder="收斂"></div>
        <div><label v-if="i === 0">建議怎麼寫</label><input type="text" v-model="r.to" placeholder="收練"></div>
        <button v-if="rows.length > 1" class="ghost vx" title="刪掉這一條" @click="rows.splice(i, 1)">✕</button>
      </div>
      <div class="mt-3 flex items-center gap-3">
        <button class="ghost" @click="rows.push({ from: '', to: '' })">＋ 再加一條</button>
        <button class="ghost" @click="save">儲存</button>
        <span class="hint">{{ msg }}</span>
      </div>
    </template>
    <template v-else>
      <div v-if="(job.voiceRules && job.voiceRules.own || []).length" class="rules">
        <span v-for="s in job.voiceRules.own" :key="s" class="rule">{{ s }}</span>
      </div>
      <div v-else class="hint">這支沒有自己填的唸法。</div>
      <div v-if="hit != null" class="mt-4 border-t border-line pt-3">
        <div class="hint mb-2">{{ hit.length ? `送 AI 配音前套了這 ${hit.length} 條發音規則（含共用詞庫）：` : '這支沒有套到任何發音規則。' }}</div>
        <div v-if="hit.length" class="rules">
          <span v-for="r in hit" :key="r.from + r.to + r.src" class="rule">{{ r.from }} → <b>{{ r.to }}</b>{{ r.times > 1 ? ` ×${r.times}` : '' }}<i>{{ r.src === 'own' ? '本支自己填的' : '共用詞庫' }}</i></span>
        </div>
      </div>
    </template>
  </div>
</template>
