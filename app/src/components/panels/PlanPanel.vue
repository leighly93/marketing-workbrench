<script setup>
// 配圖計畫確認。待確認：可以改每一段（拖框、改範圍、換圖、加減段）再按「確認，開始出片」；
// 排隊等出片：還來得及反悔（退回確認）；之前：佔位說明；之後：已確認。
// edits 只在這支工作「進入待確認」時從 planView 重建一次 —— 輪詢不會重建，拉到一半的框不會被洗掉。
import { computed, ref, watch } from 'vue';
import { api, fmt, json } from '../../lib/api.js';
import { hasArrow } from '../../lib/arrows.js';
import { rangeText } from '../../lib/emphasis.js';
import { uploadMoreShots, pickFiles } from '../../lib/uploads.js';
import { templates } from '../../stores/health.js';
import { openEditor } from '../../stores/editor.js';
import { useJobContent } from '../../stores/content.js';
import { owner } from '../../stores/owner.js';
import ShotPreview from '../shared/ShotPreview.vue';
import ShotWall from '../shared/ShotWall.vue';
import EmphasisBox from '../shared/EmphasisBox.vue';
import MotionBox from '../shared/MotionBox.vue';

const props = defineProps({ job: Object, node: Object });
const emit = defineEmits(['refresh']);
const content = useJobContent();
const pv = computed(() => props.job.planView);
const stage = computed(() => (props.job.status === 'review' && pv.value ? 'review'
  : props.job.status === 'approved' ? 'approved'
  : ['queued', 'preparing', 'detached', 'draft'].includes(props.job.status) ? 'pending' : 'after'));

const edits = ref({});
const images = ref([]);
let addSeq = 0;
function rebuild() {
  const p = pv.value;
  if (!p) return;
  const e = {};
  for (const r of p.rows || []) {
    e[r.i] = { i: r.i, src: r.src, deleted: false, cell: r.cell || null, region: r.region || null, arrow: r.arrow || null,
      start: r.start, end: r.end, _manual: false, startCharIdx: r.startCharIdx, endCharIdx: r.endCharIdx,
      imgW: r.imageWidth, imgH: r.imageHeight, _autoPhrase: r.phrase || '', _autoCellText: r.cellText || '' };
  }
  // 「標注遲到」的救援：沒進計畫的標注當成已填好的人工段補回來，標成「標注補回」
  addSeq = 0;
  for (const a of p.pendingAnnots || []) {
    const key = 'a' + (addSeq++);
    e[key] = { i: key, _added: true, _manual: true, _late: true, deleted: false, src: a.src, cell: a.cell || null, region: a.region || null,
      arrow: a.arrow || null, startCharIdx: a.startCharIdx, endCharIdx: a.endCharIdx, imgW: a.imgW || null, imgH: a.imgH || null };
  }
  edits.value = e;
  images.value = [...(p.images || [])];
}
watch(() => [props.job.id, props.job.status, props.job.preparedAt], rebuild, { immediate: true });

const keys = computed(() => Object.keys(edits.value).sort((a, b) => (edits.value[a].startCharIdx ?? 1e9) - (edits.value[b].startCharIdx ?? 1e9)));
const lateCount = computed(() => (pv.value && pv.value.pendingAnnots || []).length);
const count = computed(() => { const c = {}; for (const e of Object.values(edits.value)) if (!e.deleted) c[e.src] = (c[e.src] || 0) + 1; return c; });
const covered = computed(() => Object.values(edits.value));
const upMsg = ref('');

function others(key) {
  return Object.keys(edits.value).filter((k) => k !== key && !edits.value[k].deleted && typeof edits.value[k].startCharIdx === 'number')
    .map((k) => { const e = edits.value[k]; return { src: e.src || '（未選圖）', lo: Math.min(e.startCharIdx, e.endCharIdx), hi: Math.max(e.startCharIdx, e.endCharIdx), auto: !(e._manual || e._added || e._late) }; });
}
function open(key) {
  const e = edits.value[key];
  openEditor({
    job: props.job, mode: 'shot', images: images.value, src: e.src,
    title: e._late ? '你標注的一段　' + e.src : (e._added ? '新增的一段' : e._autoPhrase),
    region: e.region, cell: e.cell, arrow: e.arrow, from: e.startCharIdx ?? null, to: e.endCharIdx ?? null,
    arrowAllowed: !!(templates.value[props.job.template] || {}).arrow,
    chars: content.chars.value, units: content.units.value, charSec: content.charSec.value, others: others(key),
    onDone: (r) => {
      // ⚠️ 箭頭也要進這個比對 —— 只動箭頭沒動框的話 _manual 不會被標起來，applyPlanEdits 就不會把這段當人工段寫回去
      const arrowOf = (a) => (hasArrow(a) ? [Math.round(a.x1), Math.round(a.y1), Math.round(a.x2), Math.round(a.y2), String(a.color || '').toLowerCase()] : null);
      const changed = JSON.stringify([r.region, r.cell, arrowOf(r.arrow)]) !== JSON.stringify([e.region, e.cell, arrowOf(e.arrow)])
        || r.startCharIdx !== e.startCharIdx || r.endCharIdx !== e.endCharIdx || r.src !== e.src;
      Object.assign(e, r);
      if (changed) e._manual = true;
    },
  });
}
function addSeg(src) {
  // ⚠️ 絕不用 src:'' 當退路（曾經讓伺服器 EISDIR 整台掛掉）。沒圖就擋。
  const use = src || images.value[0];
  if (!use) return alert('這支工作沒有上傳截圖，沒有東西可以加 —— 請先上傳截圖。');
  const key = 'a' + (addSeq++);
  edits.value[key] = { i: key, _added: true, _manual: true, deleted: false, src: use, cell: null, region: null, arrow: null, startCharIdx: null, endCharIdx: null, imgW: null, imgH: null };
  open(key);
}
function removeOrToggle(key) {
  const e = edits.value[key];
  if (e._added) delete edits.value[key]; else e.deleted = !e.deleted;
}
async function more() {
  const files = await pickFiles();
  if (!files.length) return;
  try {
    const added = await uploadMoreShots(props.job, files, (t) => { upMsg.value = t; });
    for (const n of added) if (!images.value.includes(n)) images.value.push(n);   // 只更新縮圖牆，絕不整頁重載
    upMsg.value = added.length ? `已加入 ${added.join('、')}，點縮圖就能用它加一段` : '';
    content.reloadPages();
  } catch (e) { upMsg.value = ''; if (e.added) images.value.push(...e.added); alert(e.message); }
  setTimeout(() => { upMsg.value = ''; }, 6000);
}
const busy = ref(false);
async function approve(list) {
  busy.value = true;
  try {
    const { marks } = await api(`/api/jobs/${props.job.id}/emphasis`).catch(() => ({ marks: [] }));
    await json('POST', `/api/jobs/${props.job.id}/approve`, { edits: list, by: owner.value, emphasis: marks || [] });
    emit('refresh');
  } catch (e) { alert('出錯了：' + e.message); }
  busy.value = false;
}
async function unapprove() {
  try { await api(`/api/jobs/${props.job.id}/unapprove`, { method: 'POST' }); emit('refresh'); }
  catch (e) { alert('退不回來：' + e.message); }
}
const planSteps = computed(() => (props.job.skipGenerate ? '分析截圖版面 → 轉字幕 → 排配圖計畫' : '生成講者影片 → 分析截圖版面 → 轉字幕 → 排配圖計畫'));
const coveredRows = computed(() => (pv.value && pv.value.rows) || []);
</script>

<template>
  <!-- 準備中的佔位：先把同一顆按鈕畫在同一個位置、反灰，講清楚在跑什麼、算完會停在這一關 -->
  <div v-if="stage === 'pending'" class="card">
    <h2>配圖計畫確認</h2>
    <div class="note">
      {{ job.status === 'queued' ? '⏳ 排隊中 —— 前面還有工作在跑，輪到它就會開始。' : (job.status === 'draft' ? '還沒送出。' : '⏳ 正在準備…') }}<br>
      要跑完「{{ planSteps }}」才知道哪句話在第幾秒、圖該配在哪裡，所以計畫現在還看不到。<br>
      算完<b>會停在這一關等你</b>：這裡會列出計畫（可以拖框、改範圍、換圖、加減段），下面這顆按鈕也會亮起來。
    </div>
    <div class="mt-4"><button class="go" disabled>確認，開始出片</button><span class="hint ml-3">還在跑，算完才能按</span></div>
  </div>

  <div v-else-if="stage === 'approved'" class="card">
    <h2>排隊等出片</h2>
    <div class="note">
      <template v-if="job.approvedBy === '（自動出片）'">你設定了「標好了，直接出片」，所以準備一跑完就自動排進出片佇列。<br></template>
      還沒開始出片，現在退回去還可以改配圖／標注。<b>開始出片之後就退不回來了</b>。<br>
      「字幕重點詞」與「動態小影片」還可以直接改，不用退回 —— 真的開始出片才會定案。
    </div>
    <div class="mt-4"><button class="ghost" @click="unapprove">↩ 退回確認</button></div>
    <EmphasisBox :job="job" :chars="content.chars.value" :covered="coveredRows" />
    <MotionBox :job="job" :chars="content.chars.value" :covered="coveredRows" :char-sec="content.charSec.value" />
  </div>

  <div v-else-if="stage === 'after'" class="card">
    <h2>配圖計畫確認</h2>
    <div class="text-sm">{{ job.approvedBy === '（自動出片）' ? '這支設定了「標好了，直接出片」，沒有停下來等確認。' : `已確認${job.approvedBy ? '：' + job.approvedBy : ''}${job.approvedAt ? '（' + new Date(job.approvedAt).toLocaleString('zh-TW', { hour12: false }) + '）' : ''}。` }}</div>
    <div class="tip">人工改過的每一筆都進了「修正紀錄」。想再調整就用「重新出片」。</div>
  </div>

  <!-- 舊工作的 planView 沒有 editable 欄位 → 只有明確 false 才擋 -->
  <div v-else-if="pv.editable === false" class="card">
    <h2>配圖計畫</h2>
    <div class="note">這個版型還不支援線上調整。請看執行記錄裡的判定清單。</div>
    <div class="mt-4"><button class="go" :disabled="busy" @click="approve([])">確認，開始出片</button></div>
  </div>

  <div v-else class="card">
    <h2>配圖計畫　—　點預覽圖可以改，也可以自己加一段</h2>
    <div class="note">AI 排的只是起點。<b>點左邊的預覽圖</b>就能拖框、改範圍、換圖。<br>
      表格下面「<b>全部截圖</b>」會一直列出你上傳的每一張，看得出哪張用了、哪張還沒；<b>點一下就加一段用那張</b>。<br>
      你改的每一筆都會被記下來，之後拿來修規則 —— 讓你越改越少。</div>
    <div v-if="lateCount" class="warn mt-3">⚠️ 有 <b>{{ lateCount }}</b> 筆你在「手動標記」標的段落沒被自動計畫吃到（計畫算完之後才存的）。<b>已經幫你補進下面的表格</b>，標成「標注補回」—— 請確認範圍和框對不對，不要的話按「刪除」。</div>

    <table class="plan mt-3">
      <thead><tr><th>預覽（點我編輯）</th><th>這段旁白</th><th>設定</th><th></th></tr></thead>
      <tbody>
        <tr v-if="!keys.length"><td colspan="4" class="empty" style="padding:26px 0">
          {{ images.length ? '這支還沒有任何配圖 —— 從下面的「全部截圖」點一張開始加。' : '這支還沒有任何配圖，也還沒有截圖 —— 先用下面的「＋ 上傳截圖」傳幾張。' }}</td></tr>
        <tr v-for="k in keys" :key="k" :class="{ del: edits[k].deleted }">
          <td><ShotPreview :job="job" :e="edits[k]" :manual="!!edits[k]._manual" @click="open(k)" /></td>
          <td>
            <div class="ph">{{ edits[k].startCharIdx != null ? rangeText(content.chars.value, edits[k]) : (edits[k]._added ? '（還沒設定範圍）' : (edits[k]._autoPhrase || '—')) }}</div>
            <div class="sec">{{ (edits[k]._manual || edits[k]._added) ? '（範圍已設，秒數出片時算）' : `${fmt(edits[k].start)} – ${fmt(edits[k].end)}　共 ${(edits[k].end - edits[k].start).toFixed(1)} 秒` }}</div>
            <div class="sec" :style="edits[k]._late ? 'color:#c98a00;font-weight:600' : ''">{{ edits[k]._late ? '標注補回（自動計畫沒吃到）' : (edits[k]._added ? '人工新增' : (edits[k]._manual ? '人工調整過' : '自動：' + (edits[k]._autoCellText || '—'))) }}</div>
          </td>
          <td><div class="sec">{{ edits[k].src || '（未選圖）' }}</div>
            <div class="sec">{{ [edits[k].region ? '顯示區域' : null, edits[k].cell ? '黃框' : null, hasArrow(edits[k].arrow) ? '箭頭' : null].filter(Boolean).join('＋') || '整張顯示' }}</div></td>
          <td><button class="ghost danger tiny" @click="removeOrToggle(k)">{{ edits[k]._added ? '刪除' : (edits[k].deleted ? '要回來' : '不要這段') }}</button></td>
        </tr>
      </tbody>
    </table>

    <div class="mt-5 border-t border-line pt-4">
      <div class="flex flex-wrap items-center gap-2.5">
        <div class="hint">{{ images.length ? `全部截圖 ${images.length} 張，已經用了 ${Object.keys(count).length} 張　—　點一下就加一段用它。` : '這支工作還沒有任何截圖 —— 先傳幾張，才能把旁白配到畫面上。' }}</div>
        <button class="ghost tiny" @click="more">{{ images.length ? '＋ 上傳更多截圖' : '＋ 上傳截圖' }}</button>
        <span class="hint">{{ upMsg }}</span>
      </div>
      <ShotWall v-if="images.length" :job="job" :images="images" :count="count" :pages="pv.pages" @pick="addSeg" />
    </div>

    <!-- 重點詞與動態排在「確認，開始出片」上面；按鈕永遠是這張卡片的最後一個東西 -->
    <EmphasisBox :job="job" :chars="content.chars.value" :covered="covered" :initial="pv.emphasis" />
    <MotionBox :job="job" :chars="content.chars.value" :covered="covered" :char-sec="content.charSec.value" />
    <div class="mt-5 flex items-center gap-3">
      <button v-if="images.length" class="ghost" @click="addSeg()">＋ 加一段</button>
      <button class="go" :disabled="busy" @click="approve(Object.values(edits))">確認，開始出片</button>
    </div>
  </div>
</template>
