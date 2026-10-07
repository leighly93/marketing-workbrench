// 工作狀態的顯示文字與分類。伺服器的狀態機在 server/jobs/（queue.js、production.js、registry.js）。

export const STATUS_TEXT = {
  draft: '草稿', queued: '排隊中', preparing: '準備中', review: '待確認',
  approved: '等待出片', rendering: '出片中', done: '完成', failed: '失敗', cancelled: '已取消',
  // 伺服器重開前就開始跑的工作。run.js 是 detached 的，會自己跑完。
  detached: '背景執行中', 'detached-done': '已在背景跑完',
};

/**
 * 狀態文字。draft 平常是「草稿」（還沒送出），但重新出片複製出來的舊工作也停在 draft，
 * 而且會一直停在那裡等人確認 —— 顯示「草稿」會讓人以為要重填，所以另外講。
 */
export function statusText(j) {
  if (j.status === 'draft' && j.redoOf) return '等你確認';
  return STATUS_TEXT[j.status] || j.status;
}

/** 已經結束、不能取消的狀態（取消鈕不畫）。跟 server/routes/review.js 的 cancel 一致。 */
export const FINISHED = ['done', 'failed', 'cancelled'];
/** 正在跑的狀態：取消要講清楚代價（錢是呼叫當下就扣的，停掉不會退）。 */
export const RUNNING = ['preparing', 'rendering', 'detached'];
/** 正在跑的工作不能刪（server/routes/jobs.js 的 DELETE 也擋）。 */
export const UNDELETABLE = ['preparing', 'rendering'];
/** 還能改標注的階段：標注是 auto-shot 讀檔那一刻被讀走的，之後改就吃不到了。 */
export const ANNOTATABLE = ['draft', 'queued', 'preparing', 'detached'];
/** 還能改字幕重點詞／動態的階段（伺服器 EMPHASIS_EDITABLE 同一條界線：真的開始 render 才定案）。 */
export const MARKS_EDITABLE = ['draft', 'queued', 'preparing', 'detached', 'review', 'approved'];

/** 狀態 → 顏色語意（Tailwind class 在 StatusBadge.vue）。 */
export function statusTone(status) {
  if (status === 'done') return 'ok';
  if (status === 'failed' || status === 'cancelled') return 'bad';
  if (status === 'review') return 'accent';
  if (status === 'detached-done') return 'info';
  if (['preparing', 'rendering', 'approved', 'detached'].includes(status)) return 'warn';
  return 'dim';
}
