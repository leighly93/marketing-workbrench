// 工作頁各面板共用的腳本資料：逐字（chars）、子句（units）、頁型（pages）、一個字幾秒。
// 換一支工作才重讀；待確認階段 planView 本來就帶了 chars／units，直接用。
import { computed, inject, provide, ref, watch } from 'vue';
import { api } from '../lib/api.js';
import { charSecOf } from '../lib/emphasis.js';

const KEY = Symbol('job-content');

export function provideJobContent(job) {
  const chars = ref([]);
  const units = ref([]);
  const pages = ref({});
  const loadedFor = ref(null);

  async function loadScript() {
    const j = job.value;
    if (!j) return;
    const pv = j.planView;
    if (pv && pv.chars && pv.chars.length) { chars.value = pv.chars; units.value = pv.units || []; loadedFor.value = j.id; return; }
    if (loadedFor.value === j.id) return;
    loadedFor.value = j.id;
    const sv = await api(`/api/jobs/${j.id}/sentences`).catch(() => ({ units: [], chars: [] }));
    if (job.value && job.value.id === j.id) { chars.value = sv.chars || []; units.value = sv.units || []; }
  }
  async function loadPages() {
    const j = job.value;
    if (!j) return;
    if (j.planView && j.planView.pages) { pages.value = j.planView.pages; return; }
    // 截圖分析跟 HeyGen 平行跑，可能比這裡晚完成 —— 讀不到就先畫「未知頁面」，狀態一變再補
    const pv = await api(`/api/jobs/${j.id}/pages`).catch(() => ({ pages: {} }));
    if (job.value && job.value.id === j.id) pages.value = pv.pages || {};
  }
  watch(() => job.value && job.value.id, () => { chars.value = []; units.value = []; pages.value = {}; loadedFor.value = null; loadScript(); loadPages(); }, { immediate: true });
  watch(() => job.value && job.value.status, () => { loadScript(); loadPages(); });

  const charSec = computed(() => (job.value && job.value.planView ? charSecOf(job.value.planView.rows) : null));
  const content = { chars, units, pages, charSec, reloadPages: loadPages };
  provide(KEY, content);
  return content;
}

export function useJobContent() { return inject(KEY); }
