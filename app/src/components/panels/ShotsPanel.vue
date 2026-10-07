<script setup>
// 截圖。草稿：選檔就直接上傳（檔名固定 shotN，重傳覆蓋），可以刪；
// 送出後：只看縮圖，準備中／待確認還能用 auto=1 補圖（伺服器排檔名）。
import { computed, ref } from 'vue';
import { api, fileUrl } from '../../lib/api.js';
import { isShotFile, isVideoFile, jobImages, nextShotName } from '../../lib/files.js';
import { pickFiles, uploadMoreShots, uploadNamed } from '../../lib/uploads.js';
import { ANNOTATABLE } from '../../lib/status.js';
import { useJobContent } from '../../stores/content.js';
import ShotWall from '../shared/ShotWall.vue';

const props = defineProps({ job: Object, node: Object });
const emit = defineEmits(['refresh']);
const content = useJobContent();
const draft = computed(() => props.job.status === 'draft');
const canLate = computed(() => ANNOTATABLE.includes(props.job.status) || props.job.status === 'review');
const images = computed(() => jobImages(props.job));
const msg = ref('');
const hot = ref(false);
const busy = ref(false);

async function addFiles(files) {
  if (!files.length) return;
  const bad = files.filter((f) => !isShotFile(f));
  if (bad.length) {
    // 一次選十張、其中三張不是圖片的話，彈三次視窗比不提醒還煩 —— 併成一則。
    alert(bad.some(isVideoFile)
      ? '這幾格是放 APP 截圖的。\n\n講者影片在「講者影片與語氣」那一格上傳。'
      : `「${bad[0].name}」不是圖片檔，這裡只能放截圖（png、jpg、heic 都可以）。` + (bad.length > 1 ? `\n\n另外還有 ${bad.length - 1} 個檔也一樣，都沒有放進去。` : ''));
  }
  const good = files.filter(isShotFile);
  if (!good.length) return;
  busy.value = true;
  try {
    if (draft.value) {
      const existing = [...(props.job.files || [])];
      for (let i = 0; i < good.length; i++) {
        const name = nextShotName(existing, good[i]);
        msg.value = `上傳 ${i + 1}/${good.length}（${(good[i].size / 1048576).toFixed(1)} MB）…`;
        await uploadNamed(props.job, good[i], name);
        existing.push(name);
      }
      msg.value = `已上傳 ${good.length} 張`;
    } else {
      await uploadMoreShots(props.job, good, (t) => { msg.value = t; });
      content.reloadPages();
    }
    emit('refresh');
  } catch (e) { msg.value = ''; alert(e.message); emit('refresh'); }
  busy.value = false;
  setTimeout(() => { msg.value = ''; }, 4000);
}
async function pick() { addFiles(await pickFiles({ accept: 'image/*', multiple: true })); }
function drop(e) { hot.value = false; addFiles([...e.dataTransfer.files]); }
async function remove(name) {
  if (!confirm(`刪掉 ${name}？`)) return;
  try { await api(`/api/jobs/${props.job.id}/upload?name=${encodeURIComponent(name)}`, { method: 'DELETE' }); emit('refresh'); }
  catch (e) { alert('刪不掉：' + e.message); }
}
</script>

<template>
  <div class="card">
    <h2>截圖</h2>
    <div v-if="draft" class="note mb-4">放 APP 截圖，png、jpg、heic 都可以，一次可以選好幾張。講者影片不是放這裡。</div>
    <div v-if="draft" class="slots">
      <div v-for="n in images" :key="n" class="slot filled">
        <img :src="fileUrl(job.id, n)" alt="">
        <button class="x" title="刪掉這張" @click.stop="remove(n)">✕</button>
        <div class="tag"><b>{{ n }}</b></div>
      </div>
      <div class="slot add" :class="{ hot }" title="再新增" @click="pick"
        @dragover.prevent="hot = true" @dragleave="hot = false" @drop.prevent="drop">
        <div class="n" style="font-size:26px;font-weight:300">＋</div><div class="h">點擊或拖曳</div>
      </div>
    </div>
    <template v-else>
      <div v-if="!images.length" class="hint">這支工作沒有截圖。</div>
      <ShotWall v-else :job="job" :images="images" :count="{}" :pages="content.pages.value" />
      <div v-if="canLate" class="mt-4 flex items-center gap-3">
        <button class="ghost" :disabled="busy" @click="pick">＋ 上傳更多截圖</button>
        <span class="hint">補上去的圖要到「手動標記」或「配圖計畫」裡指定出現在哪一段。</span>
      </div>
    </template>
    <div class="hint mt-2">{{ msg }}</div>
  </div>
</template>
