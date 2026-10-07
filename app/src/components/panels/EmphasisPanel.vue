<script setup>
// 字幕重點詞的獨立節點。藍底線的來源：有計畫就看計畫列，沒有就看手動標注。
import { computed, ref, watch } from 'vue';
import { api } from '../../lib/api.js';
import { MARKS_EDITABLE } from '../../lib/status.js';
import { useJobContent } from '../../stores/content.js';
import EmphasisBox from '../shared/EmphasisBox.vue';

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
    <h2>字幕重點詞</h2>
    <div v-if="!editable" class="hint mb-2">已經開始出片，重點詞定案了；這裡只看不改。</div>
    <EmphasisBox :job="job" :chars="content.chars.value" :covered="covered" :editable="editable" />
  </div>
</template>
