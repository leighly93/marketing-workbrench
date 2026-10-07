<script setup>
// 儀表板：現在的狀況（執行中／排隊／待確認）、這段期間的成功失敗率與趨勢、第三方額度與本機資源、
// 需要人處理的清單、依版型／建立者的統計。資料來自 /api/dashboard（真工作算的）與 /api/quotas（額度目前是 mock）。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api, duration, when } from '../lib/api.js';
import { statusText } from '../lib/status.js';
import { templateLabel } from '../stores/health.js';
import TrendChart from '../components/charts/TrendChart.vue';

const router = useRouter();
const range = ref('7d');
const RANGES = [['today', '今天'], ['7d', '7 天'], ['30d', '30 天'], ['all', '全部']];
const dash = ref(null);
const quotas = ref(null);
const err = ref('');
let timer = null;

async function load() {
  try {
    const [d, q] = await Promise.all([api(`/api/dashboard?range=${range.value}`), api('/api/quotas').catch(() => null)]);
    dash.value = d; quotas.value = q; err.value = '';
  } catch (e) { err.value = e.message; }
}
onMounted(() => { load(); timer = setInterval(load, 5000); });
onBeforeUnmount(() => clearInterval(timer));
watch(range, load);

const pct = (v) => (v == null ? '—' : Math.round(v * 100) + '%');
const REASON = { review: '等你確認配圖', failed: '失敗', draft: '草稿還沒送出', 'detached-done': '背景跑完，沒接回', 'missing-output': '完成但沒有成品檔' };
const rateTone = computed(() => { const s = dash.value && dash.value.rates.success; return s == null ? 'dim' : s >= 0.9 ? 'ok' : s >= 0.7 ? 'warn' : 'bad'; });
function quotaTone(p) {
  if (p.total == null || p.remaining == null) return '';
  const r = p.remaining / p.total;
  return r < 0.15 ? 'bad' : r < 0.35 ? 'warn' : '';
}
function quotaPct(p) { return p.total ? Math.max(0, Math.min(100, (p.remaining / p.total) * 100)) : null; }
const localTiles = computed(() => {
  const l = quotas.value && quotas.value.local;
  if (!l) return [];
  return [
    { label: '磁碟（工作紀錄）', value: l.diskMB != null ? `${(l.diskMB / 1024).toFixed(1)} GB` : '—', sub: '歷史工作持續保留' },
    { label: '佇列', value: `${(l.queue.queued || 0) + (l.queue.approved || 0)}`, sub: `等準備 ${l.queue.queued || 0}・等出片 ${l.queue.approved || 0}` },
    { label: '工作區', value: l.busy ? '出片中' : (l.lock.externalLock ? '被佔用' : '閒置'), sub: l.lock.externalLock ? `鎖了 ${l.lock.lockAgeMin ?? '?'} 分鐘` : (l.queue.runningJobId ? '正在跑 ' + l.queue.runningJobId : '沒有鎖') },
  ];
});
</script>

<template>
  <div v-if="err" class="card"><div class="note bad">儀表板讀不到：{{ err }}</div></div>
  <div v-else-if="!dash" class="empty">讀取中…</div>
  <template v-else>
    <div class="mb-4 flex flex-wrap items-center gap-3">
      <h2 class="m-0">儀表板</h2>
      <div class="flex gap-1.5">
        <button v-for="[v, label] in RANGES" :key="v" class="ghost tiny" :style="range === v ? 'border-color:var(--accent);color:var(--accent);background:var(--accent-soft)' : ''" @click="range = v">{{ label }}</button>
      </div>
      <span class="flex-1"></span>
      <RouterLink to="/new" class="go" style="padding:9px 18px;font-size:14px;text-decoration:none;color:#fff;border-radius:9px">＋ 新增任務</RouterLink>
    </div>

    <!-- 現在：數字卡 -->
    <div class="grid grid-cols-2 gap-3 md:grid-cols-5" data-stats>
      <div class="tile"><div class="lb">執行中</div><div class="v">{{ dash.snapshot.running }}</div><div class="d">準備／出片／背景</div></div>
      <div class="tile"><div class="lb">排隊中</div><div class="v">{{ dash.snapshot.queued }}</div><div class="d">等準備或等出片</div></div>
      <div class="tile" style="cursor:pointer" @click="router.push('/jobs')"><div class="lb">待確認</div><div class="v" :style="dash.snapshot.review ? 'color:var(--accent)' : ''">{{ dash.snapshot.review }}</div><div class="d">配圖計畫等人按</div></div>
      <div class="tile"><div class="lb">這段期間完成</div><div class="v">{{ dash.inRange.done }}</div><div class="d">建立 {{ dash.inRange.created }}・失敗 {{ dash.inRange.failed }}・取消 {{ dash.inRange.cancelled }}</div></div>
      <div class="tile"><div class="lb">成功率</div><div class="v">{{ pct(dash.rates.success) }}</div>
        <div class="meter mt-2" :class="rateTone === 'ok' ? '' : rateTone"><i :style="{ width: ((dash.rates.success || 0) * 100) + '%' }"></i></div>
        <div class="d">失敗率 {{ pct(dash.rates.failure) }}・{{ dash.rates.basis }} 支計算</div></div>
    </div>

    <div class="mt-4 grid gap-4 lg:grid-cols-[3fr_2fr]">
      <div class="card">
        <div class="flex items-center gap-3"><h2 class="m-0">每日完成與失敗</h2><span class="hint">平均總耗時 {{ duration(dash.durations.avgTotalSec) }}・準備 {{ duration(dash.durations.avgPrepareSec) }}・出片 {{ duration(dash.durations.avgRenderSec) }}</span></div>
        <TrendChart class="mt-3" :days="dash.trend" />
      </div>

      <div class="card" data-quotas>
        <h2>第三方 API 額度</h2>
        <div v-if="!quotas" class="hint">讀不到額度資料。</div>
        <template v-else>
          <div v-for="p in quotas.providers" :key="p.id" class="mb-4">
            <div class="flex items-baseline gap-2"><b class="text-sm">{{ p.label }}</b>
              <span class="hint">{{ p.kind === 'credits' ? '點數' : '餘額' }}</span><span class="flex-1"></span>
              <span class="text-lg font-semibold">{{ p.remaining != null ? p.remaining.toLocaleString() : '—' }}</span>
              <span class="hint">{{ p.unit }}{{ p.total != null ? ` / ${p.total.toLocaleString()}` : '' }}</span></div>
            <div v-if="quotaPct(p) != null" class="meter mt-1.5" :class="quotaTone(p)"><i :style="{ width: quotaPct(p) + '%' }"></i></div>
            <div class="hint mt-1">{{ p.source === 'mock' ? '🧪 假資料' : '更新於 ' + when(p.updatedAt) }}<span v-if="p.resetAt">・{{ when(p.resetAt) }} 重置</span><span v-if="p.note">・{{ p.note }}</span></div>
          </div>
          <div class="grid grid-cols-3 gap-2 border-t border-line pt-3">
            <div v-for="t in localTiles" :key="t.label" class="min-w-0"><div class="hint">{{ t.label }}</div><div class="text-base font-semibold">{{ t.value }}</div><div class="hint truncate" :title="t.sub">{{ t.sub }}</div></div>
          </div>
        </template>
      </div>
    </div>

    <div class="mt-4 grid gap-4 lg:grid-cols-[3fr_2fr]">
      <div class="card" data-attention>
        <div class="flex items-center gap-3"><h2 class="m-0">需要你處理</h2><span class="hint">{{ dash.attention.length }} 筆</span></div>
        <div v-if="!dash.attention.length" class="empty">沒有東西卡著 —— 太好了</div>
        <table v-else class="list mt-3">
          <thead><tr><th>為什麼</th><th>版型</th><th>標題</th><th>建立者</th><th>狀態</th><th>時間</th></tr></thead>
          <tbody>
            <tr v-for="a in dash.attention" :key="a.id" class="row" @click="router.push('/jobs/' + a.id)">
              <td><b class="text-sm">{{ REASON[a.reason] || a.reason }}</b></td>
              <td>{{ templateLabel(a.template) }}</td>
              <td>{{ a.title || '—' }}</td>
              <td>{{ a.owner }}</td>
              <td class="hint">{{ statusText(a) }}</td>
              <td class="hint" style="white-space:nowrap">{{ when(a.since) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div>
        <div class="card">
          <h2>依版型</h2>
          <table class="list"><thead><tr><th>版型</th><th>總數</th><th>完成</th><th>失敗</th><th>成功率</th></tr></thead>
            <tbody><tr v-for="t in dash.byTemplate" :key="t.template"><td>{{ t.label || templateLabel(t.template) }}</td><td>{{ t.total }}</td><td>{{ t.done }}</td><td>{{ t.failed }}</td>
              <td><div class="flex items-center gap-2"><div class="meter" style="width:60px"><i :style="{ width: ((t.successRate || 0) * 100) + '%' }"></i></div><span class="hint">{{ pct(t.successRate) }}</span></div></td></tr>
              <tr v-if="!dash.byTemplate.length"><td colspan="5" class="hint">這段期間沒有工作</td></tr></tbody></table>
        </div>
        <div class="card">
          <h2>依建立者</h2>
          <table class="list"><thead><tr><th>建立者</th><th>總數</th><th>完成</th><th>失敗</th><th>成功率</th></tr></thead>
            <tbody><tr v-for="o in dash.byOwner" :key="o.owner"><td>{{ o.owner }}</td><td>{{ o.total }}</td><td>{{ o.done }}</td><td>{{ o.failed }}</td>
              <td><div class="flex items-center gap-2"><div class="meter" style="width:60px"><i :style="{ width: ((o.successRate || 0) * 100) + '%' }"></i></div><span class="hint">{{ pct(o.successRate) }}</span></div></td></tr>
              <tr v-if="!dash.byOwner.length"><td colspan="5" class="hint">這段期間沒有工作</td></tr></tbody></table>
        </div>
      </div>
    </div>
  </template>
</template>
