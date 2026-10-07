import { createRouter, createWebHistory, createMemoryHistory } from 'vue-router';
import DashboardView from './views/DashboardView.vue';
import JobsView from './views/JobsView.vue';
import JobView from './views/JobView.vue';
import NewJobView from './views/NewJobView.vue';
import SayView from './views/SayView.vue';
import FixView from './views/FixView.vue';

export const routes = [
  { path: '/', name: 'dashboard', component: DashboardView },
  { path: '/jobs', name: 'jobs', component: JobsView },
  { path: '/jobs/:id', name: 'job', component: JobView, props: true },
  { path: '/new', name: 'new', component: NewJobView },
  { path: '/say', name: 'say', component: SayView },
  { path: '/fix', name: 'fix', component: FixView },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

// 伺服器對非 /api 的路徑一律回 index.html（server/routes/static.js），所以可以用 history 模式。
export function createAppRouter({ memory = false } = {}) {
  return createRouter({ history: memory ? createMemoryHistory() : createWebHistory('/'), routes });
}
