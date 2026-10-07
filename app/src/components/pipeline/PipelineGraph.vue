<script setup>
// 五個階段橫排、每階段的節點直排。點節點 → 右側面板換內容。
import { NODE_STATUS_TEXT, stageStatus } from '../../lib/pipeline.js';

defineProps({ pipeline: { type: Object, required: true }, selected: String });
const emit = defineEmits(['select']);

const ICON = { ok: '✓', warning: '!', failed: '✕', cancelled: '✕', running: '▶', ready: '●', todo: '!', pending: '', skipped: '–', optional: '·' };
const STAGE_DOT = { ok: 'var(--ok)', warning: '#e0a200', failed: 'var(--bad)', cancelled: 'var(--bad)', running: 'var(--accent)', ready: 'var(--accent)', pending: 'var(--line)' };
</script>

<template>
  <div class="pipe" data-pipeline>
    <div v-for="s in pipeline.stages" :key="s.id" :data-stage="s.id">
      <div class="stage-h"><i class="dot" :style="{ background: STAGE_DOT[stageStatus(s)] }"></i>{{ s.label }}</div>
      <button v-for="n in s.nodes" :key="n.id" class="node" :class="[n.status, { on: n.id === selected, parallel: n.parallel }]"
        :data-node="n.id" :title="NODE_STATUS_TEXT[n.status]" @click="emit('select', n.id)">
        <i class="ic">{{ ICON[n.status] }}</i>
        <div class="t"><b>{{ n.label }}</b><span>{{ n.note || NODE_STATUS_TEXT[n.status] }}</span></div>
      </button>
    </div>
  </div>
</template>
