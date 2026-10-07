// 跟我說：留言、唸法回報、收件匣與共用詞庫。

import { $, api, el } from './dom.js';
import { S } from './state.js';

// ── 跟我說 ─────────────────────────────────
// 同事回報唸錯的詞、以及任何前台問題。送出就寫進 data/messages.jsonl。
// 收件匣與詞庫管理只有管理者（本機）看得到。
export function sayWho() { return ($('#sayOwner').value || $('#owner').value || '').trim(); }

// 「你是誰」只要填一次。兩頁的欄位互相同步，並記在 localStorage ——
// 換頁、重新整理、關掉分頁再開都不用重打（2026-08-21 使用者要求：
// 只是要回報一個唸錯的詞，卻得先跑去「建立工作」那頁填名字，很奇怪）。
export const OWNER_KEY = 'mv.owner';
export function syncOwner(v, from) {
  const s = (v || '').trim();
  if (from !== 'owner') $('#owner').value = s;
  if (from !== 'sayOwner') $('#sayOwner').value = s;
  try { localStorage.setItem(OWNER_KEY, s); } catch (e) { /* 隱私模式會擋，忽略 */ }
}
$('#owner').oninput = () => syncOwner($('#owner').value, 'owner');
$('#sayOwner').oninput = () => syncOwner($('#sayOwner').value, 'sayOwner');
try {
  const savedOwner = localStorage.getItem(OWNER_KEY);
  if (savedOwner) syncOwner(savedOwner);
} catch (e) { /* 同上 */ }

/** 📌 記下這種頁：走「說一件事」同一條路（/api/messages, kind=page-pin），server 端補指紋、複製截圖。 */
export async function pinPage(src, fig) {
  const ok = await sendSay({ kind: 'page-pin', src }, $('#planUpMsg'), '📌 記下了，之後批次命名');
  if (ok && fig) { const b = fig.querySelector('.pin'); if (b) { b.textContent = '✓'; b.disabled = true; } }
}

export async function sendSay(payload, msgEl, okText) {
  const who = sayWho();
  if (!who) return alert('上面先填一下「你是誰」，我才知道是誰回報的。');
  msgEl.textContent = '送出中…';
  try {
    await api('/api/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, by: who, job: S.lastJob }),
    });
    msgEl.textContent = okText;
    setTimeout(() => { msgEl.textContent = ''; }, 4000);
    if (S.ADMIN) loadSay();
    return true;
  } catch (e) {
    msgEl.textContent = '';
    alert('送不出去：' + e.message);
    return false;
  }
}

$('#sayWordSend').onclick = async () => {
  const word = $('#sayWord').value.trim();
  const suggest = $('#saySuggest').value.trim();
  if (!word) return alert('還沒填「唸錯的詞」');
  if (!suggest) return alert('還沒填「建議怎麼寫」—— 只說唸錯了我沒辦法改，要給我一個寫法');
  const ok = await sendSay({ kind: 'pronounce', word, suggest, why: $('#sayWhy').value.trim() },
    $('#sayWordMsg'), '收到了，謝謝！我會加進共用詞庫。');
  if (ok) { $('#sayWord').value = ''; $('#saySuggest').value = ''; $('#sayWhy').value = ''; }
};

$('#sayNoteSend').onclick = async () => {
  const text = $('#sayNote').value.trim();
  if (!text) return alert('留言是空的');
  const ok = await sendSay({ kind: 'note', text }, $('#sayNoteMsg'), '收到了，謝謝！');
  if (ok) $('#sayNote').value = '';
};

export async function loadSay() {
  $('#sayInboxCard').hidden = !S.ADMIN;
  $('#sayDictCard').hidden = !S.ADMIN;
  if (!S.ADMIN) return;
  const [inbox, dict] = await Promise.all([
    api('/api/messages').catch(() => ({ messages: [] })),
    api('/api/pronounce').catch(() => ({ rules: [] })),
  ]);
  drawInbox(inbox.messages || []);
  drawDict(dict.rules || []);
}

export function drawInbox(list) {
  const wrap = $('#sayInbox');
  if (!list.length) return wrap.replaceChildren(el('div', { class: 'empty' }, '目前沒有任何留言'));
  // 未讀在前，其餘照時間新到舊
  const sorted = [...list].sort((a, b) =>
    (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0) || (a.at < b.at ? 1 : -1));
  wrap.replaceChildren(...sorted.map((m) => {
    const meta = [
      m.by,
      new Date(m.at).toLocaleString('zh-TW', { hour12: false }).slice(5),
      m.job ? '工作 ' + m.job : null,
      m.kind === 'pronounce' ? (m.auto ? '唸法・出片時帶上' : '唸法回報')
        : m.kind === 'page-pin' ? '📌 記下的頁' : '留言',
    ].filter(Boolean).join('・');
    const body = m.kind === 'pronounce'
      ? el('div', { class: 'b' },
          el('div', { class: 'w' }, `${m.word}　→　${m.suggest}`),
          el('div', { class: 'm' }, (m.why ? '原因：' + m.why + '　' : '') + meta))
      : m.kind === 'page-pin'
      ? el('div', { class: 'b' },
          el('div', { class: 'w' }, `📌 ${m.src}　系統原判：${m.systemPage || '?'}` + (m.pinned ? '　已存圖' : '')),
          el('div', { class: 'm' }, ((m.fingerprint && m.fingerprint.words) ? '關鍵字：' + m.fingerprint.words.slice(0, 8).join('、') + '　' : '') + meta
            + '　→ 批次命名：node video/shots/page-pins.js'))
      : el('div', { class: 'b' },
          el('div', { class: 'w' }, m.text),
          el('div', { class: 'm' }, meta));
    const acts = el('div', { style: 'display:flex;gap:8px;flex-shrink:0' });
    if (m.kind === 'pronounce' && m.status !== 'done')
      acts.append(el('button', { class: 'ghost tiny', onclick: async () => {
        const rule = { from: m.word, to: m.suggest, why: m.why || '', by: m.by, fromMessage: m.id };
        try {
          if (!(await addDictRuleConfirming(rule))) return;
          await setMsgStatus(m.id, 'done');
        } catch (e) { alert('收錄失敗：' + e.message); }
      } }, '收錄進詞庫'));
    acts.append(el('button', { class: 'ghost tiny', onclick: () => setMsgStatus(m.id, m.status === 'done' ? 'new' : 'done') },
      m.status === 'done' ? '標回未讀' : '已讀'));
    return el('div', { class: 'msg' + (m.status === 'done' ? ' done' : '') }, body, acts);
  }));
}

export async function setMsgStatus(id, status) {
  try {
    await api('/api/messages/status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status }),
    });
    loadSay();
  } catch (e) { alert('更新失敗：' + e.message); }
}

// 加詞庫。伺服器有兩種「軟擋」會回 400 —— 那不是錯誤，是提醒，按確定就帶 force 再送一次：
//   ① `short: true`  → 原文只有兩個字（台股公司名大多是兩個字，這是最常用的情況）
//   ② `clash: [...]` → 跟詞庫裡現有規則重疊
// ⚠️ 判斷「這是軟擋還是真錯誤」一定要看這兩個欄位，不要比對錯誤訊息的中文。
//    2026-08-21 踩過：這裡原本寫 /有重疊/，而兩個字那則訊息裡沒有「有重疊」三個字，
//    所以兩個字的詞永遠加不進去（訊息叫人「再按一次」，但再按一次也不會帶 force）。
//    單字（一個字）是硬擋、沒有這兩個欄位，就會照原樣往外丟 —— 那是刻意的。
export function isSoftBlock(e) {
  return !!(e && e.data && (e.data.short || (e.data.clash && e.data.clash.length)));
}

export async function addDictRule(rule, force) {
  await api('/api/pronounce', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...rule, ...(force ? { force: true } : {}) }),
  });
}

/** 加一條規則，遇到軟擋就問一次、確定後帶 force 重送。回傳 true = 真的加進去了 */
export async function addDictRuleConfirming(rule) {
  try {
    await addDictRule(rule, false);
  } catch (e) {
    if (!isSoftBlock(e)) throw e;
    if (!confirm(e.message)) return false;
    await addDictRule(rule, true);
  }
  return true;
}

$('#dictAdd').onclick = async () => {
  const from = $('#dictFrom').value.trim();
  const to = $('#dictTo').value.trim();
  if (!from || !to) return alert('原文跟唸法都要填');
  const rule = { from, to, why: $('#dictWhy').value.trim(), by: sayWho() };
  try {
    if (!(await addDictRuleConfirming(rule))) return;
    $('#dictFrom').value = ''; $('#dictTo').value = ''; $('#dictWhy').value = '';
    $('#dictMsg').textContent = '加好了';
    setTimeout(() => { $('#dictMsg').textContent = ''; }, 3000);
    loadSay();
  } catch (e) { alert(e.message); }
};

export function drawDict(rules) {
  const wrap = $('#dictList');
  if (!rules.length) return wrap.replaceChildren(el('div', { class: 'empty' }, '詞庫還是空的'));
  const t = el('table', {}, el('thead', {}, el('tr', {},
    el('th', {}, '原文'), el('th', {}, '唸法'), el('th', {}, '為什麼'),
    el('th', {}, '誰加的'), el('th', {}, ''))));
  const tb = el('tbody');
  for (const r of rules) {
    tb.append(el('tr', { style: r.enabled === false ? 'opacity:.4' : '' },
      el('td', {}, r.from), el('td', {}, r.to),
      el('td', { style: 'color:var(--dim);font-size:12.5px' }, r.why || '—'),
      el('td', { style: 'color:var(--dim);font-size:12.5px' },
        [r.by || '—', (r.at || '').slice(5, 10)].filter(Boolean).join('・')),
      el('td', {}, el('button', { class: 'ghost tiny', onclick: async () => {
        try {
          await api('/api/pronounce', {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: r.from, enabled: r.enabled === false }),
          });
          loadSay();
        } catch (e) { alert('更新失敗：' + e.message); }
      } }, r.enabled === false ? '啟用' : '停用'))));
  }
  t.append(tb);
  wrap.replaceChildren(t);
}

