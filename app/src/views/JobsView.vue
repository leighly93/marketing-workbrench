<script setup>
// 工作列表：可以依狀態與關鍵字過濾；管理者看得到來源 IP 與刪除鈕，建立者可以刪自己的草稿。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, when } from '../lib/api.js';
import { STATUS_TEXT, UNDELETABLE } from '../lib/status.js';
import { admin, templateLabel } from '../stores/health.js';
import { owner } from '../stores/owner.js';
import StatusBadge from '../components/ui/StatusBadge.vue';

const router = useRouter();
const jobs = ref([]);
const total = ref(0);
const limit = ref(100);
const q = ref('');
const status = ref('');
let timer = null;

async function load() {
  try {
    const r = await api(`/api/jobs?limit=${limit.value}`);
    jobs.value = r.jobs || [];
    total.value = r.total ?? jobs.value.length;
  } catch (_) { /* 頁首已經會顯示離線 */ }
}
onMounted(() => { load(); timer = setInterval(load, 3000); });
onBeforeUnmount(() => clearInterval(timer));

const GROUPS = [['', '全部'], ['active', '進行中'], ['review', '待確認'], ['draft', '草稿'], ['done', '完成'], ['failed', '失敗／取消']];
const ACTIVE = ['queued', 'preparing', 'approved', 'rendering', 'detached', 'detached-done'];
const filtered = computed(() => jobs.value.filter((j) => {
  if (status.value === 'active' && !ACTIVE.includes(j.status)) return false;
  if (status.value === 'failed' && !['failed', 'cancelled'].includes(j.status)) return false;
  if (['review', 'draft', 'done'].includes(status.value) && j.status !== status.value) return false;
  const k = q.value.trim();
  if (k && !((j.title || '') + ' ' + (j.owner || '') + ' ' + templateLabel(j.template) + ' ' + j.id).includes(k)) return false;
  return true;
}));
const counts = computed(() => {
  const c = { '': jobs.value.length, active: 0, review: 0, draft: 0, done: 0, failed: 0 };
  for (const j of jobs.value) {
    if (ACTIVE.includes(j.status)) c.active++;
    else if (['failed', 'cancelled'].includes(j.status)) c.failed++;
    else if (c[j.status] != null) c[j.status]++;
  }
  return c;
});
function canDelete(j) {
  if (UNDELETABLE.includes(j.status)) return false;
  if (admin.value) return true;
  return j.status === 'draft' && (owner.value || '').trim() && (owner.value || '').trim() === (j.owner || '').trim();
}
async function remove(j) {
  if (UNDELETABLE.includes(j.status)) return alert('正在跑的工作不能刪，等它結束或先取消。');
  if (!confirm(j.status === 'draft' ? '刪除這份草稿與已上傳的素材？' : '刪除這筆工作紀錄與上傳的素材？\n\n（出好的影片已存在「成品」資料夾，不會被刪。）')) return;
  try {
    const by = admin.value ? '' : `?by=${encodeURIComponent((owner.value || '').trim())}`;
    await api(`/api/jobs/${j.id}${by}`, { method: 'DELETE' });
    load();
  } catch (e) { alert('刪除失敗：' + e.message); }
}
function open(j) { router.push('/jobs/' + j.id); }
</script>

<template>
  <div class="card">
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="m-0">工作列表</h2>
      <span class="hint">{{ total }} 筆</span>
      <span class="flex-1"></span>
      <input type="search" v-model="q" placeholder="搜尋標題、建立者、版型" style="width:260px">
      <RouterLink to="/new" class="ghost">＋ 新增任務</RouterLink>
    </div>
    <div class="mt-3 flex flex-wrap gap-1.5">
      <button v-for="[v, label] in GROUPS" :key="v" class="ghost tiny" :style="status === v ? 'border-color:var(--accent);color:var(--accent);background:var(--accent-soft)' : ''" @click="status = v">{{ label }} {{ counts[v] }}</button>
    </div>
    <div v-if="!filtered.length" class="empty">{{ jobs.length ? '沒有符合的工作' : '還沒有任何工作' }}</div>
    <table v-else class="list mt-4" id="jobs">
      <thead><tr><th>建立時間</th><th>版型</th><th>標題</th><th>建立者</th><th>狀態</th><th v-if="admin">來源 IP</th><th></th></tr></thead>
      <tbody>
        <tr v-for="j in filtered" :key="j.id" class="row jobrow" @click="open(j)">
          <td style="white-space:nowrap">{{ when(j.createdAt) }}</td>
          <td>{{ templateLabel(j.template) }}</td>
          <td>{{ (j.mock ? '🧪 ' : '') + ((j.title || '—').replace(/\n/g, ' ')) }}</td>
          <td>{{ j.owner }}</td>
          <td><StatusBadge :job="j" /></td>
          <td v-if="admin" class="hint" style="font-variant-numeric:tabular-nums">{{ j.ip || '—' }}</td>
          <td><button v-if="canDelete(j)" class="ghost danger tiny" title="刪除這筆工作" @click.stop="remove(j)">🗑</button></td>
        </tr>
      </tbody>
    </table>
    <div v-if="total > jobs.length" class="mt-4 text-center"><button class="ghost" @click="limit += 100; load()">再載入 100 筆（共 {{ total }} 筆）</button></div>
    <div class="tip">狀態說明：{{ Object.values(STATUS_TEXT).slice(0, 7).join('・') }}。所有工作都會保留，不會自動刪除。</div>
  </div>
</template>
