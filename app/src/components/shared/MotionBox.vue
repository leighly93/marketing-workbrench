<script setup>
// 動態小影片：跟重點詞同一套手勢，但**每支只有一段** —— 再拖一次就是取代，點已選的地方就取消。
import { computed, ref, watch } from 'vue';
import { api, json } from '../../lib/api.js';
import { charsCoveredBy } from '../../lib/emphasis.js';
import RangePicker from './RangePicker.vue';

const props = defineProps({
  job: { type: Object, required: true },
  chars: { type: Array, default: () => [] },
  covered: { type: Array, default: () => [] },
  charSec: { type: Number, default: null },
  editable: { type: Boolean, default: true },
});

const entries = ref([]);
const saved = ref('');
const specText = ref('');
const specMsg = ref('');
const open = ref(false);
const specFocused = ref(false);
let seq = 0;

async function load() {
  const mv = await api(`/api/jobs/${props.job.id}/motion`).catch(() => ({ entries: [] }));
  entries.value = (mv.entries || []).filter((m) => Number.isInteger(m.startCharIdx) && Number.isInteger(m.endCharIdx));
  if (entries.value.length) open.value = true;
  syncSpec();
}
watch(() => props.job.id, load, { immediate: true });

const m = computed(() => entries.value[0] || null);
const marks = computed(() => (m.value ? [m.value] : []));
const coveredSet = computed(() => charsCoveredBy(props.covered));
const picked = computed(() => {
  if (!m.value) return '';
  const txt = props.chars.slice(m.value.startCharIdx, m.value.endCharIdx + 1).map((c) => c.c).join('');
  return txt.slice(0, 60) + (txt.length > 60 ? '…' : '');
});
const secs = computed(() => (m.value && props.charSec ? `　約 ${((m.value.endCharIdx - m.value.startCharIdx + 1) * props.charSec).toFixed(1)} 秒` : ''));

function syncSpec() {
  // 正在打字的時候不要蓋掉人家的參數
  if (specFocused.value) return;
  specText.value = m.value && m.value.spec ? JSON.stringify(m.value.spec, null, 2) : '';
}

async function save() {
  // 進階參數：留空＝交給 Claude；有填就要是合法 JSON，不然擋下來並說清楚
  if (entries.value.length) {
    const raw = specText.value.trim();
    if (!raw) { delete entries.value[0].spec; specMsg.value = ''; }
    else {
      try { entries.value[0].spec = JSON.parse(raw); specMsg.value = ''; }
      catch (e) { specMsg.value = 'JSON 格式有問題，這份參數還沒存進去：' + e.message; return; }
    }
  }
  const s = ++seq;
  try {
    const r = await json('PUT', `/api/jobs/${props.job.id}/motion`, { entries: entries.value });
    if (s !== seq) return;
    saved.value = r.count ? '已存' : '已清除';
  } catch (e) {
    if (s !== seq) return;
    saved.value = '存不進去：' + e.message;
  }
}
function pick({ lo, hi, click }) {
  if (!props.editable) return;
  const cur = m.value;
  // 單點在已選範圍內＝取消；其餘一律取代（每支只有一段），保留原本的 spec
  if (cur && click && lo >= cur.startCharIdx && lo <= cur.endCharIdx) entries.value = [];
  else entries.value = [{ ...(cur && cur.spec ? { spec: cur.spec } : {}), startCharIdx: lo, endCharIdx: hi }];
  save();
}
function clear() { entries.value = []; save(); }
</script>

<template>
  <details class="emph" :open="open" @toggle="open = $event.target.open">
    <summary>動態小影片（選填）　<span class="sec">{{ m ? `已選 ${m.endCharIdx - m.startCharIdx + 1} 個字` : '尚未指定' }}</span>
      <span class="sec" style="margin-left:10px">{{ saved }}</span></summary>
    <div class="tip">在下面的腳本上拖選一段，那段畫面會換成帶動畫的文字卡 —— 卡片上的每一項會<b>跟著旁白唸到它的時間</b>依序出現。再拖一次就換一段，點已選的地方取消。</div>
    <div class="tip">挑「一次講三件事以上、大約 10 秒以上」的段落效果最好；<b>沒有配圖的地方</b>（字底下沒有藍線）最適合，那裡原本畫面上只有講者。</div>
    <RangePicker :chars="chars" :marks="marks" :covered="coveredSet" :disabled="!editable" @pick="pick" />
    <div v-if="m" class="tip" style="margin-top:6px"><span>這一段：</span><b>{{ picked }}</b><span>{{ secs }}</span></div>
    <details style="margin-top:10px">
      <summary class="sec">進階：自己指定卡片內容</summary>
      <div class="tip">留空的話，卡片文字由 Claude 讀那段旁白自己濃縮。要自己指定就貼一份參數 JSON，例如：<br>
        <code>{"template":"list","kicker":"三大法人","title":"買超|超過1165億","items":[{"text":"外資買超","at":"外資在買"}]}</code><br>
        template 可用 list（條列）／contrast（不是X而是Y）／quote（一句話）。每一項的 <code>at</code> 要是旁白原文裡真的有的字串，用來算進場時間。</div>
      <textarea v-model="specText" rows="6" style="width:100%;font-family:ui-monospace,Menlo,monospace;font-size:12px;min-height:0"
        placeholder="留空＝交給 Claude" :disabled="!editable"
        @focus="specFocused = true" @blur="specFocused = false; save()" @change="save"></textarea>
      <div class="tip" style="color:var(--warn)">{{ specMsg }}</div>
    </details>
    <div style="margin-top:8px"><button class="ghost tiny" :disabled="!m || !editable" @click="clear">清除</button></div>
  </details>
</template>
