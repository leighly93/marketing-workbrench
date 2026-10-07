// 伺服器狀態：版型清單、管理者身分、模擬模式、佔用／鎖定，每 3 秒輪詢一次。
import { computed, reactive, ref } from 'vue';
import { api } from '../lib/api.js';

export const health = ref(null);
export const offline = ref(false);
// 這個分頁載入時伺服器前台的建置時間戳（第一次 poll 記起來，之後比對）
const webSeen = ref(null);
export const reloadNeeded = ref(false);

export const templates = computed(() => (health.value && health.value.templates) || {});
export const admin = computed(() => !!(health.value && health.value.admin));
export const mock = computed(() => !!(health.value && health.value.mock));
export const stale = computed(() => !!(health.value && health.value.codeChangedAt > health.value.startedAt));

/** 可以選的版型（hidden 不畫、disabled 變灰）。TPLS 仍然收到全部 —— 列表要靠它顯示舊工作的版型名稱。 */
export const pickableTemplates = computed(() =>
  Object.entries(templates.value).filter(([, t]) => !t.hidden).map(([k, t]) => ({ id: k, ...t })));

export function templateLabel(id) {
  // ⚠️ fallback 是必要的：2026-09-22 移除三大法人等版型後，那些舊工作的 template 在 TPLS 裡查不到。
  return (templates.value[id] || {}).label || id || '已移除的版型';
}

/** 頁首狀態燈：⚠️ busy 要先判斷。run.js 一跑就會建立 .run.lock，先看 locked 的話每支影片跑的時候都會顯示「被鎖住」。 */
export const statusPill = computed(() => {
  if (offline.value) return { tone: 'bad', text: '✕ 主機離線', title: '' };
  const h = health.value;
  if (!h) return { tone: 'dim', text: '連線中…', title: '' };
  if (h.busy) return { tone: 'run', text: '● 出片中', title: '' };
  if (h.externalLock) {
    return { tone: 'bad', text: `⚠️ 工作區被佔用${h.lockAgeMin != null ? '（' + h.lockAgeMin + ' 分鐘）' : ''}`,
      title: '有其他流程在用工作區（可能是終端機在跑 run.js，或上次沒清乾淨）。新工作會排隊等，不會失敗。點一下可以強制解鎖。', lock: true };
  }
  return { tone: 'dim', text: '○ 閒置', title: '' };
});

export async function pollHealth() {
  try {
    const h = await api('/api/health');
    health.value = h;
    offline.value = false;
    // 這個分頁是什麼時候載入的？之後前台又重新建置過 → 畫面是舊的，要重新整理。
    // ⚠️ 這跟 stale（伺服器跑舊程式）是**兩件不同的事**，橫幅分開。
    if (h.webBuiltAt) {
      if (webSeen.value == null) webSeen.value = h.webBuiltAt;
      else if (h.webBuiltAt !== webSeen.value) reloadNeeded.value = true;
    }
  } catch (_) {
    offline.value = true;
  }
  return health.value;
}

let timer = null;
export function startHealthPolling(intervalMs = 3000) {
  if (timer) return;
  timer = setInterval(pollHealth, intervalMs);
}

/** 強制解鎖（只有管理者點得動）。 */
export async function forceUnlock() {
  if (!admin.value || !statusPill.value.lock) return;
  if (!confirm('強制刪掉 .run.lock？\n\n只有在確定沒有任何 run.js 在跑的時候才做，'
    + '否則兩個流程會同時寫 public/，兩支影片都會壞掉。')) return;
  await api('/api/unlock', { method: 'POST' });
  pollHealth();
}

/** 畫面上的暫時訊息（例如「已上傳 3 張」），各面板共用。 */
export const flash = reactive({ text: '', tone: 'dim' });
let flashTimer = null;
export function showFlash(text, tone = 'dim', ms = 4000) {
  flash.text = text; flash.tone = tone;
  clearTimeout(flashTimer);
  if (ms) flashTimer = setTimeout(() => { flash.text = ''; }, ms);
}
