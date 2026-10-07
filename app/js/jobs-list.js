// 工作列表頁。

import { $, api, el } from './dom.js';
import { go } from './shell.js';
import { S } from './state.js';
import { statusText } from './status.js';

// ── 列表 ──
export async function loadJobs() {
  const { jobs } = await api('/api/jobs');
  if (!jobs.length) return $('#jobs').replaceChildren(el('div', { class: 'empty' }, '還沒有任何工作'));
  const t = el('table', {}, el('thead', {}, el('tr', {},
    el('th', {}, '建立時間'), el('th', {}, '版型'), el('th', {}, '標題'),
    el('th', {}, '建立者'), el('th', {}, '狀態'),
    // 來源 IP 與刪除鈕都只有管理者看得到。IP 連資料本身都不會送到同事的瀏覽器
    //（伺服器端 publicJob 就剝掉了），這裡的判斷只是「不要畫一欄空的」。
    S.ADMIN ? el('th', {}, '來源 IP') : '',
    S.ADMIN ? el('th', {}, '') : '')));
  const tb = el('tbody');
  for (const j of jobs) {
    let st = statusText(j);
    if (j.queuePosition > 0) st += `（前面還有 ${j.queuePosition} 支）`;
    tb.append(el('tr', { class: 'jobrow' },
      el('td', { onclick: () => { S.openJob = j.id; go('job'); } }, new Date(j.createdAt).toLocaleString('zh-TW', { hour12: false }).slice(5)),
      el('td', { onclick: () => { S.openJob = j.id; go('job'); } }, (S.TPLS[j.template] || {}).label || j.template),
      el('td', { onclick: () => { S.openJob = j.id; go('job'); } }, (j.mock ? '🧪 ' : '') + (j.title || '—').replace(/\n/g, ' ')),
      el('td', { onclick: () => { S.openJob = j.id; go('job'); } }, j.owner),
      el('td', { onclick: () => { S.openJob = j.id; go('job'); } }, el('span', { class: 'st ' + j.status }, st)),
      // 2026-08-21 之前建立的工作沒記過 IP，補不回來 → 顯示「—」
      S.ADMIN ? el('td', {
        style: 'font-variant-numeric:tabular-nums;color:#8a94a6;font-size:13px',
        onclick: () => { S.openJob = j.id; go('job'); },
      }, j.ip || '—') : '',
      // 刪除鈕：只有本機（管理者）看得到、按得動。正在跑的工作不給刪。
      S.ADMIN ? el('td', {}, el('button', {
        class: 'ghost danger', title: '刪除這筆工作',
        style: 'padding:3px 9px;font-size:13px',
        onclick: async (ev) => {
          ev.stopPropagation();
          if (['preparing', 'rendering'].includes(j.status)) return alert('正在跑的工作不能刪，等它結束或先取消。');
          if (!confirm('刪除這筆工作紀錄與上傳的素材？\n\n（出好的影片已存在「成品」資料夾，不會被刪。）')) return;
          try { await api(`/api/jobs/${j.id}`, { method: 'DELETE' }); loadJobs(); }
          catch (e) { alert('刪除失敗：' + e.message); }
        },
      }, '🗑')) : ''));
  }
  t.append(tb);
  $('#jobs').replaceChildren(t);
}

