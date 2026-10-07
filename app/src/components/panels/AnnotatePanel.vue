<script setup>
// 手動標記（HeyGen 還在跑的時候就能做）：哪張圖配在哪一句、框哪裡。存的是「哪一段字」不是秒數。
// 標注是 auto-shot 讀檔那一刻被讀走的 —— 準備中之後改就吃不到了（伺服器會回 applied:false）。
import { computed, ref, watch } from 'vue';
import { api, json } from '../../lib/api.js';
import { hasArrow } from '../../lib/arrows.js';
import { rangeText } from '../../lib/emphasis.js';
import { jobImages } from '../../lib/files.js';
import { ANNOTATABLE } from '../../lib/status.js';
import { uploadMoreShots, pickFiles } from '../../lib/uploads.js';
import { templates } from '../../stores/health.js';
import { openEditor } from '../../stores/editor.js';
import { useJobContent } from '../../stores/content.js';
import ShotPreview from '../shared/ShotPreview.vue';
import ShotWall from '../shared/ShotWall.vue';
import EmphasisBox from '../shared/EmphasisBox.vue';
import MotionBox from '../shared/MotionBox.vue';

const props = defineProps({ job: Object, node: Object });
const emit = defineEmits(['refresh']);
const content = useJobContent();
const editable = computed(() => ANNOTATABLE.includes(props.job.status));
const annots = ref([]);
const saved = ref('');
const savedBad = ref(false);
const upMsg = ref('');
const localFiles = ref([]);   // 補上傳的檔名先記在這裡，不等輪詢（也不整頁重載）
const images = computed(() => [...new Set([...jobImages(props.job), ...localFiles.value])]);

watch(() => props.job.id, async () => {
  annots.value = []; localFiles.value = [];
  const av = await api(`/api/jobs/${props.job.id}/annotations`).catch(() => ({ shots: [] }));
  annots.value = av.shots || [];
}, { immediate: true });

const count = computed(() => { const c = {}; for (const a of annots.value) c[a.src] = (c[a.src] || 0) + 1; return c; });
const byImage = computed(() => images.value.map((src) => ({ src, mine: annots.value.map((a, k) => ({ a, k })).filter((x) => x.a.src === src) })));

async function save() {
  try {
    const r = await json('PUT', `/api/jobs/${props.job.id}/annotations`, { shots: annots.value });
    // 配圖計畫已經算完之後才存的標注，這支影片吃不到 —— 講清楚，不要只顯示「已儲存」
    if (r && r.applied === false) { savedBad.value = true; saved.value = `已存 ${annots.value.length} 筆，但這支的配圖計畫已經算完 —— 這筆不會自動進去，請到「配圖計畫確認」裡確認。`; return; }
    savedBad.value = false; saved.value = `已儲存 ${annots.value.length} 筆`;
    setTimeout(() => { saved.value = ''; }, 2500);
    emit('refresh');
  } catch (e) { alert('儲存失敗：' + e.message); }
}

function others(k) {
  return annots.value.map((a, i) => ({ a, i })).filter((x) => x.i !== k && typeof x.a.startCharIdx === 'number')
    .map((x) => ({ src: x.a.src || '（未選圖）', lo: Math.min(x.a.startCharIdx, x.a.endCharIdx), hi: Math.max(x.a.startCharIdx, x.a.endCharIdx), auto: false }));
}
function edit(k) {
  const a = annots.value[k];
  openEditor({
    job: props.job, mode: 'annot', images: images.value, src: a.src,
    region: a.region, cell: a.cell, arrow: a.arrow, from: a.startCharIdx ?? null, to: a.endCharIdx ?? null,
    arrowAllowed: !!(templates.value[props.job.template] || {}).arrow,
    chars: content.chars.value, units: content.units.value, charSec: content.charSec.value, others: others(k),
    onDone: (r) => { Object.assign(annots.value[k], r); save(); },
  });
}
function add(src) {
  if (!content.chars.value.length) return alert('腳本還在讀，等一下再試');
  // 沒帶 src（下方那顆按鈕）→ 先開第一張；編輯器有縮圖列，開錯張也能當場換掉。⚠️ 絕不 push src=undefined。
  const use = src || images.value[0];
  if (!use) return alert('這支工作沒有上傳截圖，沒有東西可以標注。');
  annots.value.push({ src: use, startCharIdx: null, endCharIdx: null, region: null, cell: null, arrow: null });
  edit(annots.value.length - 1);
}
function remove(k) { annots.value.splice(k, 1); save(); }
async function more() {
  const files = await pickFiles();
  if (!files.length) return;
  try {
    const added = await uploadMoreShots(props.job, files, (t) => { upMsg.value = t; });
    localFiles.value.push(...added);
    content.reloadPages();
  } catch (e) { upMsg.value = ''; if (e.added) localFiles.value.push(...e.added); alert(e.message); }
  setTimeout(() => { upMsg.value = ''; }, 4000);
}
const toggling = ref(false);
async function toggleAuto() {
  toggling.value = true;
  try { await json('POST', `/api/jobs/${props.job.id}/auto-approve`, { on: !props.job.autoApprove }); emit('refresh'); }
  catch (e) { alert('設定失敗：' + e.message); }
  toggling.value = false;
}
const summary = (a) => [a.region ? '有顯示區域' : null, a.cell ? '有黃框' : null, hasArrow(a.arrow) ? '有箭頭' : null].filter(Boolean).join('＋') || '整張顯示';
</script>

<template>
  <div class="card">
    <h2>手動標記　—　請手動標記要顯示的範圍</h2>
    <div v-if="editable" class="note mb-3">
      HeyGen 生成要好幾分鐘，這段時間可以先把圖標好：<b>哪張圖配在哪一句、框哪裡</b>。<br>
      每張要用的圖都請手動圈出要顯示的範圍；沒圈的截圖不會出現在影片裡。<br>
      <b>標「哪一句」而不是「第幾秒」</b> —— 秒數要等語音轉完字幕才存在，系統會自己換算。
    </div>
    <div v-else class="hint mb-3">標注已經被配圖計畫讀走了，這裡只看不改；要調整到「配圖計畫確認」裡做。</div>

    <div v-if="!content.chars.value.length" class="hint py-3">正在讀腳本…</div>
    <template v-else>
      <div v-for="g in byImage" :key="g.src" class="border-b border-line py-3">
        <div class="mb-1 flex items-center gap-2"><b class="text-[13.5px]">{{ g.src }}</b><span class="flex-1"></span>
          <button v-if="editable" class="ghost tiny" @click="add(g.src)">{{ g.mine.length ? '＋ 再加一段' : '＋ 標注這張' }}</button></div>
        <div v-for="{ a, k } in g.mine" :key="k" class="an">
          <ShotPreview :job="job" :e="a" manual :hint="(!a.region && !a.cell && !hasArrow(a.arrow)) ? '整張顯示・點我改' : '點我改'" @click="editable && edit(k)" />
          <div class="s"><b>出現在：{{ rangeText(content.chars.value, a) }}</b><span>{{ summary(a) }}</span></div>
          <button v-if="editable" class="ghost danger" @click.stop="remove(k)">刪除</button>
        </div>
        <div v-if="!g.mine.length" class="flex items-center gap-3 pt-1">
          <ShotPreview :job="job" :e="{ src: g.src }" dim hint="還沒標" @click="editable && add(g.src)" />
          <span class="hint">沒圈選的截圖不會出現在影片裡。</span>
        </div>
      </div>
      <div v-if="images.length" class="mt-4">
        <div class="hint mb-1">全部截圖 {{ images.length }} 張，已經用了 {{ Object.keys(count).length }} 張　—　點一下就用它加一段；同一張可以點多次、各自標不同區塊。</div>
        <ShotWall :job="job" :images="images" :count="count" :pages="content.pages.value" @pick="(n) => editable && add(n)" />
      </div>
    </template>
    <div v-if="editable" class="mt-4 flex flex-wrap items-center gap-2.5">
      <button class="ghost" @click="add()">＋ 加一個標注</button>
      <button class="ghost" @click="more">＋ 上傳更多截圖</button>
      <span class="hint">{{ upMsg }}</span>
      <span class="hint" :style="savedBad ? 'color:var(--bad)' : ''">{{ saved }}</span>
    </div>

    <!-- 重點詞與動態排在「標好了，直接出片」上面 —— 擺在它下面等於沒機會被看到 -->
    <EmphasisBox :job="job" :chars="content.chars.value" :covered="annots" :editable="editable" />
    <MotionBox :job="job" :chars="content.chars.value" :covered="annots" :char-sec="content.charSec.value" :editable="editable" />

    <div v-if="editable && job.status !== 'draft'" class="mt-4 border-t border-line pt-4">
      <button :class="job.autoApprove ? 'go' : 'ghost'" :disabled="toggling" @click="toggleAuto">{{ job.autoApprove ? '✓ 標好了，直接出片' : '標好了，直接出片' }}</button>
      <span class="hint ml-3" v-if="job.autoApprove">HeyGen 一生成完就自動接著出片，你可以先去忙別的。<b>還沒開始出片前都可以點一下取消</b>。</span>
      <span class="hint ml-3" v-else>打開的話，HeyGen 跑完就直接出片，不停下來等你確認。</span>
    </div>
  </div>
</template>
