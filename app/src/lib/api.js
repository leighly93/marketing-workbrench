// 呼叫工作台 API。
// 管理者身分靠伺服器設的 HttpOnly cookie（用 ?k=... 開一次網頁就會設好），
// 同源 fetch 會自動帶上，前台不經手暗號。
export async function api(url, options) {
  const r = await fetch(url, options);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    // ⚠️ 回應內容要一起帶上去。伺服器有些 400 不是「錯誤」而是「提醒」（例如加詞庫的軟擋，
    //    會多回 `short: true` / `clash: [...]`），呼叫端得看得到那些欄位才知道可以帶 force 重送。
    //    2026-08-21 踩過：只丟 message 出去，呼叫端只能比對中文字串，提醒文案一改功能就壞。
    const e = new Error(j.error || ('HTTP ' + r.status));
    e.status = r.status;
    e.data = j;
    throw e;
  }
  return j;
}

/** JSON 本文的 POST／PUT／PATCH。 */
export function json(method, url, body) {
  return api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

/** 上傳單一檔案：整個 request body 就是檔案內容（伺服器不吃 multipart）。回傳 Response。 */
export function upload(url, file) {
  return fetch(url, { method: 'POST', body: file });
}

export const fmt = (s) => (s == null ? '—' : s.toFixed(1) + 's');

export const mb = (bytes) => (bytes / 1048576).toFixed(1) + ' MB';

/** 本地時間，去掉年份（列表用）。 */
export function when(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-TW', { hour12: false }).slice(5);
}

export function whenFull(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-TW', { hour12: false });
}

/** 秒數變成「1 分 20 秒」。 */
export function duration(sec) {
  if (sec == null || !isFinite(sec)) return '—';
  if (sec < 60) return `${Math.round(sec)} 秒`;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  if (m < 60) return s ? `${m} 分 ${s} 秒` : `${m} 分`;
  const h = Math.floor(m / 60);
  return `${h} 小時 ${m % 60} 分`;
}

export function fileUrl(jobId, name, dl) {
  return `/api/jobs/${jobId}/file/${encodeURIComponent(name)}${dl ? '?dl=1' : ''}`;
}
