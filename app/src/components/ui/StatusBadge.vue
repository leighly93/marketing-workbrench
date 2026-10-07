<script setup>
import { computed } from 'vue';
import { statusText, statusTone } from '../../lib/status.js';

const props = defineProps({ job: { type: Object, required: true } });
const text = computed(() => statusText(props.job)
  + (props.job.queuePosition > 0 ? `（前面還有 ${props.job.queuePosition} 支）` : ''));
</script>

<template>
  <span class="st" :class="statusTone(job.status)" :data-status="job.status">{{ text }}</span>
</template>
