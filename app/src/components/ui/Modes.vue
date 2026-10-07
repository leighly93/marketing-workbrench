<script setup>
// 等寬的選項組。options：[[值, 文字], …]；off＝這組這次不適用（看得到、不能點、仍顯示選到哪一顆）。
defineProps({ options: { type: Array, required: true }, modelValue: { required: true }, off: { type: Boolean, default: false } });
const emit = defineEmits(['update:modelValue']);
</script>

<template>
  <div class="modes" :class="{ off }">
    <div v-for="[v, label] in options" :key="String(v)" :class="{ on: v === modelValue }"
      @click="!off && v !== modelValue && emit('update:modelValue', v)">{{ label }}</div>
  </div>
</template>
