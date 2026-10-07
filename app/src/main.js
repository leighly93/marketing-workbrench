// 工作台前台入口（Vite + Vue 3）。頁面在 views/、共用狀態在 stores/、純邏輯在 lib/。
import { createApp } from 'vue';
import App from './App.vue';
import { createAppRouter } from './router.js';
import './style.css';

// 版本標記：F12 開 Console 看到這行，就代表瀏覽器抓到的是最新版
console.log('%c大眾短影音出片工具 build 2026-10-08（Vue 工作台：儀表板＋pipeline）', 'color:#1f6feb;font-weight:bold');

export function mountApp(el = '#app', router = createAppRouter()) {
  const app = createApp(App);
  app.use(router);
  app.mount(el);
  return { app, router };
}

if (!import.meta.env.VITEST) mountApp();
