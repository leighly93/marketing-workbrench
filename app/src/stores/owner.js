// 「你是誰」只要填一次：記在 localStorage，建立工作與「跟我說」共用。
import { ref, watch } from 'vue';

export const OWNER_KEY = 'mv.owner';

function load() {
  try { return localStorage.getItem(OWNER_KEY) || ''; } catch (_) { return ''; }   // 隱私模式會擋，忽略
}

export const owner = ref(load());

watch(owner, (v) => {
  try { localStorage.setItem(OWNER_KEY, (v || '').trim()); } catch (_) { /* 同上 */ }
});

export function who() { return (owner.value || '').trim(); }
