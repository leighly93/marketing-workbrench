// 單筆工作的輪詢：工作本身、執行記錄、步驟事件，每 3 秒更新一次（頁面開著的時候）。
// 畫面是 Vue 的 reactive，所以「內容沒變就不重畫」由各元件自己決定（key 用 job.id，
// 計畫的 edits 只在 status／preparedAt 變了才重建）—— 不像舊版要靠特徵字串整頁 replaceChildren。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api } from '../lib/api.js';
import { buildPipeline } from '../lib/pipeline.js';

export const lastJob = ref(null);   // 「跟我說」要記得使用者是從哪一支點過來的

export function useJob(idRef) {
  const job = ref(null);
  const log = ref('');
  const steps = ref([]);
  const error = ref('');
  let timer = null, inflight = false;

  async function refresh() {
    const id = idRef.value;
    if (!id || inflight) return;
    inflight = true;
    try {
      const [{ job: j }, l, s] = await Promise.all([
        api('/api/jobs/' + id),
        api(`/api/jobs/${id}/log`).catch(() => ({ text: '' })),
        api(`/api/jobs/${id}/steps`).catch(() => ({ steps: [] })),
      ]);
      if (idRef.value !== id) return;
      job.value = j;
      log.value = l.text || '';
      steps.value = s.steps || [];
      lastJob.value = j.id;
      error.value = '';
    } catch (e) {
      error.value = e.message;
      if (e.status === 404) job.value = null;
    } finally { inflight = false; }
  }

  const pipeline = computed(() => (job.value ? buildPipeline(job.value, steps.value) : null));

  onMounted(() => { refresh(); timer = setInterval(refresh, 3000); });
  onBeforeUnmount(() => clearInterval(timer));
  watch(idRef, () => { job.value = null; log.value = ''; steps.value = []; refresh(); });

  return { job, log, steps, error, pipeline, refresh };
}
