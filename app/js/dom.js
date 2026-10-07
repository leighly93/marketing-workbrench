// 畫面小工具：查元素、建元素、呼叫 API、秒數格式。


export const $ = (s) => document.querySelector(s);
export const el = (t, a = {}, ...kids) => {
  const n = document.createElement(t);
  for (const [k, v] of Object.entries(a)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
  }
  kids.flat().forEach((c) => n.append(c && c.nodeType ? c : document.createTextNode(c ?? '')));
  return n;
};
// 管理者身分靠伺服器設的 HttpOnly cookie（用 ?k=... 開一次網頁就會設好），
// 同源 fetch 會自動帶上，前台不經手暗號。
export const api = async (u, o) => {
  const r = await fetch(u, o);
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
};
export const fmt = (s) => (s == null ? '—' : s.toFixed(1) + 's');

