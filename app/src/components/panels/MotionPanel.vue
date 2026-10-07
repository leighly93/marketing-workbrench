<script setup>
import { computed, ref, watch } from 'vue';
import { api } from '../../lib/api.js';
import { MARKS_EDITABLE } from '../../lib/status.js';
import { useJobContent } from '../../stores/content.js';
import MotionBox from '../shared/MotionBox.vue';

const props = defineProps({ job: Object, node: Object });
const content = useJobContent();
const annots = ref([]);
watch(() => props.job.id, async () => {
  if (props.job.planView) return;
  annots.value = (await api(`/api/jobs/${props.job.id}/annotations`).catch(() => ({ shots: [] }))).shots || [];
}, { immediate: true });
const covered = computed(() => (props.job.planView && props.job.planView.rows) || annots.value);
const editable = computed(() => MARKS_EDITABLE.includes(props.job.status));
</script>

<template>
  <div class="card">
    <h2>動態小影片</h2>
    <div v-if="!editable" class="hint mb-2">已經開始出片，動態定案了；這裡只看不改。</div>
    <MotionBox :job="job" :chars="content.chars.value" :covered="covered" :char-sec="content.charSec.value" :editable="editable" />
  </div>
</template>
