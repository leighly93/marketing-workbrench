<script setup>
// 準備／出片階段的自動步驟：顯示底下每個步驟的狀態、耗時、備註與錯誤；細節在執行記錄。
import { computed } from 'vue';
import { duration, whenFull } from '../../lib/api.js';
import { NODE_STATUS_TEXT } from '../../lib/pipeline.js';

const props = defineProps({ job: Object, node: Object, steps: Array });
const emit = defineEmits(['open-log']);
const STEP_LABEL = { 'stage-inputs': '複製輸入檔到工作區', assets: '複製套版素材', generate: '生成講者影片', 'image-analysis': '截圖分析（OCR／版面）',
  backup: '備份講者影片', speed: '加速 125%', transcribe: '字幕轉錄', shots: '自動配圖判定', counterfactual: '對照組（修正紀錄用）', snapshot: '製作快照',
  'plan-view': '整理配圖計畫', 'render-prep': '還原快照與套用設定', 'motion-render': '動態小影片渲染', 'plan-edits': '套用人工修正', render: 'Remotion 渲染', finalize: '音量校正與歸檔', 'motion-clips': '動態小影片素材' };
const rows = computed(() => (props.steps || []).filter((s) => props.node.steps.includes(s.id)));
const PIPE_STATUS = { ok: '完成', warning: '完成（有警告）', failed: '失敗', cancelled: '已取消', running: '執行中', skipped: '略過' };
</script>

<template>
  <div class="card">
    <h2>{{ node.label }}</h2>
    <div class="text-sm">狀態：<b>{{ NODE_STATUS_TEXT[node.status] }}</b><span v-if="node.ms != null" class="hint">　耗時 {{ duration(node.ms / 1000) }}</span></div>
    <div v-if="node.note" class="mt-2" :class="node.status === 'failed' ? 'note bad' : 'note'">{{ node.note }}</div>
    <table v-if="rows.length" class="list mt-4">
      <thead><tr><th>步驟</th><th>狀態</th><th>耗時</th><th>備註</th></tr></thead>
      <tbody>
        <tr v-for="(s, i) in rows" :key="s.id + i">
          <td>{{ STEP_LABEL[s.id] || s.label || s.id }}<span v-if="s.attempt > 1" class="hint">（第 {{ s.attempt }} 次）</span></td>
          <td>{{ PIPE_STATUS[s.status] || s.status }}</td>
          <td class="hint">{{ s.ms != null ? duration(s.ms / 1000) : (s.startedAt ? whenFull(s.startedAt).slice(11) + ' 開始' : '—') }}</td>
          <td class="hint" style="word-break:break-all">{{ s.error || s.note || '' }}</td>
        </tr>
      </tbody>
    </table>
    <div v-else class="hint mt-3">{{ node.status === 'pending' ? '還沒跑到。' : '這支工作沒有步驟記錄（功能上線前建立的，或是在步驟之外就停了）。' }}</div>
    <div class="mt-4"><button class="ghost tiny" @click="emit('open-log')">看執行記錄</button></div>
  </div>
</template>
