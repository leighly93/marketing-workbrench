<script setup>
// 字幕重點詞區塊。**共用** —— 標注、待確認、排隊等出片都要有這一塊（使用者回報過兩次只開在計畫頁不夠）。
// 改了就存（PUT），不靠「確認，開始出片」那一下；序號擋掉亂序回來的舊回應。
import { computed, ref, watch } from 'vue';
import { api, json } from '../../lib/api.js';
import { charsCoveredBy, cleanMarks, toggleEmph } from '../../lib/emphasis.js';
import RangePicker from './RangePicker.vue';

const props = defineProps({
  job: { type: Object, required: true },
  chars: { type: Array, default: () => [] },
  covered: { type: Array, default: () => [] },     // 哪些段落佔了哪些字（來源由呼叫端給）
  initial: { type: Array, default: null },         // 計畫頁的 planView 本來就帶了；其他階段自己讀
  editable: { type: Boolean, default: true },
});
const emit = defineEmits(['change']);

const marks = ref([]);
const saved = ref('');
const open = ref(false);
let seq = 0;

async function load() {
  const ev = props.initial ? { marks: props.initial } : await api(`/api/jobs/${props.job.id}/emphasis`).catch(() => ({ marks: [] }));
  marks.value = cleanMarks(ev.marks);
  if (marks.value.length) open.value = true;   // 標過的就展開 —— 收合列上的「已標 N 處」看起來會像沒標
  emit('change', marks.value);
}
watch(() => props.job.id, load, { immediate: true });

const coveredSet = computed(() => charsCoveredBy(props.covered));

async function save() {
  const s = ++seq;
  emit('change', marks.value);
  try {
    const r = await json('PUT', `/api/jobs/${props.job.id}/emphasis`, { marks: marks.value });
    if (s !== seq) return;
    saved.value = r.count ? `已存 ${r.count} 處` : '已清除';
  } catch (e) {
    if (s !== seq) return;
    saved.value = '存不進去：' + e.message;
  }
}
function pick({ lo, hi }) {
  if (!props.editable) return;
  marks.value = toggleEmph(marks.value, lo, hi);
  save();
}
function clear() { marks.value = []; save(); }
defineExpose({ marks });
</script>

<template>
  <details class="emph" :open="open" @toggle="open = $event.target.open">
    <summary>字幕重點詞（選填）　<span class="sec">{{ marks.length ? `已標 ${marks.length} 處` : '尚未標記' }}</span>
      <span class="sec" style="margin-left:10px">{{ saved }}</span></summary>
    <div class="tip">在下面的腳本上拖選要強調的詞 —— 成品裡那幾個字會放大變黃，同一句其餘維持白字一般大小。點一下已標的地方就取消。改了就會自動存，不用按任何按鈕。</div>
    <div class="tip">字底下有藍線＝那一段已經有配圖；沒有線的地方畫面上只有講者。</div>
    <RangePicker :chars="chars" :marks="marks" :covered="coveredSet" :disabled="!editable" @pick="pick" />
    <div style="margin-top:8px">
      <button class="ghost tiny" :disabled="!marks.length || !editable" @click="clear">全部清除</button>
    </div>
  </details>
</template>
