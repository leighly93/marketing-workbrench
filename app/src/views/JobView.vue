<script setup>
// 單筆工作：左邊 pipeline、右邊所選節點的面板。每 3 秒輪詢；狀態一變就把右側切到「現在輪到的」節點，
// 人自己點過的選擇在同一個狀態內不會被輪詢搶走。
import { computed, ref, toRef, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api, whenFull } from '../lib/api.js';
import { FINISHED, RUNNING } from '../lib/status.js';
import { templateLabel } from '../stores/health.js';
import { useJob } from '../stores/job.js';
import { provideJobContent } from '../stores/content.js';
import StatusBadge from '../components/ui/StatusBadge.vue';
import PipelineGraph from '../components/pipeline/PipelineGraph.vue';
import LogDrawer from '../components/pipeline/LogDrawer.vue';
import ScriptPanel from '../components/panels/ScriptPanel.vue';
import ShotsPanel from '../components/panels/ShotsPanel.vue';
import VoicePanel from '../components/panels/VoicePanel.vue';
import AnchorPanel from '../components/panels/AnchorPanel.vue';
import SubmitPanel from '../components/panels/SubmitPanel.vue';
import StepPanel from '../components/panels/StepPanel.vue';
import AnnotatePanel from '../components/panels/AnnotatePanel.vue';
import PlanPanel from '../components/panels/PlanPanel.vue';
import EmphasisPanel from '../components/panels/EmphasisPanel.vue';
import MotionPanel from '../components/panels/MotionPanel.vue';
import OutputsPanel from '../components/panels/OutputsPanel.vue';
import ReportPanel from '../components/panels/ReportPanel.vue';
import RedoPanel from '../components/panels/RedoPanel.vue';

const props = defineProps({ id: { type: String, required: true } });
const router = useRouter();
const { job, log, steps, error, pipeline, refresh } = useJob(toRef(props, 'id'));
provideJobContent(job);

const selected = ref(null);
const logOpen = ref(false);
// 只在「換工作」或「狀態變了」的時候把右側切到現在輪到的節點。輪詢每 3 秒重算 pipeline，
// 不能每次都跟著跳 —— 草稿上傳完一張截圖，面板就從「截圖」跳到「送出」，人還沒傳完（實測踩到）。
watch(() => job.value && job.value.id + '|' + job.value.status, () => {
  if (pipeline.value) selected.value = pipeline.value.current;
});
watch(pipeline, (p) => { if (p && !p.nodes[selected.value]) selected.value = p.current; }, { immediate: true });
function select(id) { selected.value = id; }

const node = computed(() => (pipeline.value && pipeline.value.nodes[selected.value]) || null);
const PANELS = { script: ScriptPanel, shots: ShotsPanel, voice: VoicePanel, anchor: AnchorPanel, submit: SubmitPanel, step: StepPanel,
  annotate: AnnotatePanel, plan: PlanPanel, emphasis: EmphasisPanel, motion: MotionPanel, outputs: OutputsPanel, report: ReportPanel, redo: RedoPanel };

const running = computed(() => job.value && RUNNING.includes(job.value.status));
const cancelable = computed(() => job.value && !FINISHED.includes(job.value.status));
async function cancel(ev) {
  // 正在跑的要講清楚代價 —— 錢是呼叫當下就扣的，停掉不會退。
  const ask = running.value
    ? '這支正在跑，取消會直接停掉它。\n\n⚠️ HeyGen／MiniMax 已經扣掉的點數不會退回，而且製作快照會被清掉（不能再「重新出片」）。\n\n確定要停？'
    : '確定取消這支工作？';
  if (!confirm(ask)) return;
  ev.target.disabled = true;
  try { await api(`/api/jobs/${job.value.id}/cancel`, { method: 'POST' }); await refresh(); }
  catch (e) { ev.target.disabled = false; alert('取消失敗：' + e.message); }
}
</script>

<template>
  <div v-if="error && !job" class="card"><div class="note bad">{{ error }}</div>
    <div class="mt-3"><RouterLink to="/jobs" class="ghost">← 回列表</RouterLink></div></div>
  <div v-else-if="!job" class="empty">讀取中…</div>
  <template v-else>
    <div class="card" data-job-head>
      <div class="flex flex-wrap items-center gap-3">
        <h2 class="m-0">{{ templateLabel(job.template) }}　{{ (job.title || '').replace(/\n/g, ' ') }}</h2>
        <StatusBadge :job="job" />
        <span class="flex-1"></span>
        <!-- 取消鈕放在頁首、一直顯示（2026-09-17 使用者：「一進到下一頁就要一直顯示」） -->
        <button v-if="cancelable" class="ghost danger" @click="cancel">{{ running ? '⛔ 停止這支' : '取消工作' }}</button>
        <RouterLink to="/jobs" class="ghost">← 回列表</RouterLink>
      </div>
      <div class="hint mt-2">{{ job.owner }}・{{ whenFull(job.createdAt) }}<span v-if="job.mock">・🧪 模擬模式產生（假配音、假講者，不能發布）</span>
        <span class="ml-2 text-xs opacity-70">{{ job.id }}</span></div>
      <div v-if="job.status === 'rendering'" class="note mt-3">可以晚點再到『工作列表』查看生成完成的影片～</div>
      <div v-if="job.error" class="note bad mt-3">{{ job.error }}</div>
      <div v-if="job.status === 'detached' || job.status === 'detached-done'" class="note mt-3">
        <b>{{ job.status === 'detached' ? '這支正在背景跑' : '這支已經在背景跑完' }}</b><br>
        <template v-if="job.status === 'detached'">伺服器在它跑到一半時重開過。它沒有被殺掉，會自己跑完 —— <b>HeyGen 點數不會浪費</b>。</template>
        <template v-else>它已經跑完了，但伺服器當時已經重開，所以沒有接回前台流程。</template><br>
        <b>怎麼零成本接回：</b>講者影片留在專案的 <code>public/heygen.mp4</code>。重新建立一次工作，講者影片選「<b>用現成的</b>」、選那支 mp4 —— 不會再呼叫 HeyGen。
      </div>
    </div>

    <div class="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(360px,2fr)]">
      <div class="min-w-0">
        <div class="card" style="padding:16px 18px">
          <PipelineGraph :pipeline="pipeline" :selected="selected" @select="select" />
        </div>
        <LogDrawer :text="log" v-model:open="logOpen" />
      </div>
      <div class="min-w-0" data-panel>
        <component v-if="node" :is="PANELS[node.panel]" :key="node.id" :job="job" :node="node" :steps="steps"
          @refresh="refresh" @open-log="logOpen = true" @goto="(id) => router.push('/jobs/' + id)" />
      </div>
    </div>
  </template>
</template>
