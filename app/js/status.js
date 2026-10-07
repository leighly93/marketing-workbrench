// 工作狀態的顯示文字。

export const STATUS_TEXT = { draft:'建立中', queued:'排隊中', preparing:'準備中', review:'待確認',
  approved:'等待出片', rendering:'出片中', done:'完成', failed:'失敗', cancelled:'已取消',
  // 伺服器重開前就開始跑的工作。run.js 是 detached 的，會自己跑完。
  detached:'背景執行中', 'detached-done':'已在背景跑完' };

/**
 * 狀態文字。draft 平常是「建立中」（上傳檔案那一瞬間），但重新出片複製出來的工作
 * 也停在 draft，而且會一直停在那裡等人確認 —— 顯示「建立中」會讓人以為系統還在忙。
 */
export function statusText(j) {
  if (j.status === 'draft' && j.redoOf) return '等你確認';
  return STATUS_TEXT[j.status] || j.status;
}

