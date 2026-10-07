// 手動標記（準備中就能標）與事後補上傳截圖。

import { ARROW_DEFAULT, arrowSVG, arrowShaftPx, hasArrow } from './arrows.js';
import { $, api, el } from './dom.js';
import { drawEdColors, drawStrip, loadEdImage, setEdArrow, setEdMode } from './editor.js';
import { drawEmph } from './emphasis.js';
import { loadJob } from './job-detail.js';
import { motionBox } from './motion.js';
import { emphasisBox, shotFigures } from './plan.js';
import { drawRange } from './range.js';
import { S } from './state.js';

// ── 標注（HeyGen 還在跑的時候就能做）────────


/**
 * 標注頁的截圖總覽（2026-09-17）。跟配圖計畫頁那面牆共用 shotFigures()，
 * 差別只在「用了幾次」數的是 ANNOTS、點一下是加標注而不是加計畫段。
 */
export function drawAnnotWall(job) {
  const wrap = $('#annotWall');
  if (!wrap) return;
  const imgs = (job.files || []).filter((f) => /\.(png|jpe?g)$/i.test(f));
  if (!imgs.length) return wrap.replaceChildren();
  const count = {};
  for (const a of S.ANNOTS) count[a.src] = (count[a.src] || 0) + 1;
  const used = imgs.filter((n) => count[n]).length;
  wrap.replaceChildren(
    el('div', { style: 'font-size:12.5px;color:var(--dim);margin-bottom:8px' },
      `全部截圖 ${imgs.length} 張，已經用了 ${used} 張　—　`
      + '點一下就用它加一段；同一張可以點多次、各自標不同區塊。'),
    el('div', { class: 'shots' },
      ...shotFigures(job, imgs, count, S.ANNOT_PAGES, (n) => addAnnot(job, n))));
}

export function annotCard(job) {
  const c = el('div', { class: 'card' },
    el('h2', {}, '手動標記　—　請手動標記要顯示的範圍'),
    el('div', { class: 'note', html:
      'HeyGen 生成要好幾分鐘，這段時間可以先把圖標好：<b>哪張圖配在哪一句、框哪裡</b>。<br>'
      + '每張要用的圖都請手動圈出要顯示的範圍；沒圈的截圖不會出現在影片裡。<br>'
      + '<b>標「哪一句」而不是「第幾秒」</b> —— 秒數要等語音轉完字幕才存在，系統會自己換算。<br>'
      + '圖不夠？<b>下面可以再上傳</b>；編輯器裡也有縮圖列可以直接換成別張圖。' }),
    el('div', { id: 'annotList' }),
    // 截圖總覽（2026-09-17 使用者要求，跟配圖計畫頁對齊）：看得出哪張用了幾次、
    // 系統認成什麼頁型，點一下就用那張加一段。以前這塊只長在計畫頁上。
    el('div', { id: 'annotWall', style: 'margin-top:18px' }),
    el('div', { style: 'margin-top:16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
      el('button', { class: 'ghost', onclick: () => addAnnot(job) }, '＋ 加一個標注'),
      // ⚠️ 上傳完只重畫縮圖牆與標注列，不要走 loadJob() —— 跟計畫頁同一個理由：
      //    整頁重畫會把人正在拉的框、加到一半的標注洗掉。
      el('button', { class: 'ghost', onclick: () => pickMoreShots(job, (added) => {
        job.files = job.files || [];
        for (const n of added) if (!job.files.includes(n)) job.files.push(n);
        drawAnnots(job);
      }) }, '＋ 上傳更多截圖'),
      el('span', { id: 'annotUpMsg', style: 'font-size:12.5px;color:var(--dim)' }),
      el('span', { id: 'annotSaved', style: 'font-size:12.5px;color:var(--dim)' })),
    // ⚠️ 排在 autoGoRow 上面 —— 「標好了，直接出片」按下去就進出片佇列，
    //    擺在它下面等於沒機會被看到（跟計畫頁那顆確認鍵同一個坑）。
    emphasisBox(job, () => S.ANNOTS),
    // 動態小影片：跟重點詞一樣排在「標好了，直接出片」上面，不然按鈕一按就看不到了。
    motionBox(job, () => S.ANNOTS),
    autoGoRow(job));

  if (S.annotJobId !== job.id) {
    S.annotJobId = job.id;
    S.ANNOTS = []; S.UNITS = []; S.CHARS = []; S.EMPH = []; S.ANNOT_PAGES = {};
    Promise.all([
      api(`/api/jobs/${job.id}/sentences`).catch(() => ({ units: [] })),
      api(`/api/jobs/${job.id}/annotations`).catch(() => ({ shots: [] })),
      api(`/api/jobs/${job.id}/emphasis`).catch(() => ({ marks: [] })),
      // 頁型：準備中還沒有 planView，所以走自己的端點（計畫頁是從 planView.pages 拿）。
      // 截圖分析跟 HeyGen 平行跑，可能比這裡晚完成 —— 讀不到就先畫「未知頁面」，
      // 下面的輪詢會再補上。
      api(`/api/jobs/${job.id}/pages`).catch(() => ({ pages: {} })),
    ]).then(([sv, av, ev, pv]) => {
      S.UNITS = sv.units || [];
      S.CHARS = sv.chars || [];
      S.ANNOTS = av.shots || [];
      S.ANNOT_PAGES = pv.pages || {};
      S.EMPH = (ev.marks || [])
        .filter((m) => Number.isInteger(m.startCharIdx) && Number.isInteger(m.endCharIdx))
        .map((m) => ({ startCharIdx: m.startCharIdx, endCharIdx: m.endCharIdx }));
      drawAnnots(job);
      // 標過的就展開 —— 建卡片那一刻還沒讀完，收合列上的「已標 N 處」看起來會像沒標。
      const box = $('.emph');
      if (box && S.EMPH.length) box.open = true;
      drawEmph();
    });
  } else setTimeout(() => { drawAnnots(job); drawEmph(); }, 0);
  return c;
}

/**
 * 「標好了，直接出片」——不用守在畫面前等確認關卡（2026-08-19 使用者要求）。
 * 這只是打開 job.autoApprove，伺服器是在 HeyGen／字幕／自動配圖全部跑完的
 * 最後一刻才讀它。所以在那之前隨時可以取消、繼續改標注，都還來得及。
 * ⚠️ 反過來說：標注是那一刻被 auto-shot／auto-focus 讀走的，
 *    「準備中」變成別的狀態之後才改就吃不到了 —— 所以這張卡片只在準備階段出現。
 */
export function autoGoRow(job) {
  const btn = el('button', {});
  const note = el('span', { style: 'font-size:12.5px;color:var(--dim);margin-left:12px' });
  const paint = () => {
    btn.className = job.autoApprove ? 'go' : 'ghost';
    btn.textContent = job.autoApprove ? '✓ 標好了，直接出片' : '標好了，直接出片';
    note.innerHTML = job.autoApprove
      ? 'HeyGen 一生成完就自動接著出片，你可以先去忙別的。<b>還沒開始出片前都可以點一下取消</b>。'
      : '打開的話，HeyGen 跑完就直接出片，不停下來等你確認。';
  };
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const r = await api(`/api/jobs/${job.id}/auto-approve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: !job.autoApprove }),
      });
      job.autoApprove = !!r.job.autoApprove;
      paint();
    } catch (e) { alert('設定失敗：' + e.message); }
    btn.disabled = false;
  };
  paint();
  return el('div', { style: 'margin-top:14px;padding-top:14px;border-top:1px solid var(--line)' },
    btn, note);
}

/** 把字元範圍還原成文字，給列表顯示 */
export function rangeText(a) {
  if (a.startCharIdx == null || !S.CHARS.length) return '（未指定範圍）';
  const lo = Math.min(a.startCharIdx, a.endCharIdx), hi = Math.max(a.startCharIdx, a.endCharIdx);
  const t = S.CHARS.filter((c) => c.i >= lo && c.i <= hi).map((c) => c.c).join('');
  return t || '（找不到這一段）';
}

export function drawAnnots(job) {
  const wrap = $('#annotList');
  if (!wrap) return;
  const imgs = (job.files || []).filter((f) => /\.(png|jpe?g)$/i.test(f));
  if (!S.CHARS.length) return wrap.replaceChildren(
    el('div', { style: 'color:var(--dim);font-size:13.5px;padding:14px 0' }, '正在讀腳本…'));

  // 每張圖一列，各自獨立 —— 使用者原話：「每張圖的選取都是客製化的」（2026-08-17）
  wrap.replaceChildren(...imgs.map((src) => {
    const mine = S.ANNOTS.map((a, k) => ({ a, k })).filter((x) => x.a.src === src);
    const rows = mine.map(({ a, k }) => {
      const box = el('div', { class: 'prev man', onclick: () => editAnnot(job, k) });
      box.append(el('img', { src: `/api/jobs/${job.id}/file/${src}`, alt: '' }));
      const put = (r, cls) => {
        if (!r || !(r.w > 0) || !a.imgW || !a.imgH) return;
        box.append(el('div', { class: cls, style:
          `left:${(r.x / a.imgW) * 100}%;top:${(r.y / a.imgH) * 100}%;`
          + `width:${(r.w / a.imgW) * 100}%;height:${(r.h / a.imgH) * 100}%` }));
      };
      put(a.region, 'bx region');
      put(a.cell, 'bx');
      // 箭頭：跟計畫頁的 preview() 同一套（伺服器縮圖畫不出箭頭，一律前台疊 SVG）
      if (hasArrow(a.arrow) && a.imgW && a.imgH) {
        const w = 120, h = (w * a.imgH) / a.imgW, k2 = w / a.imgW;
        box.append(arrowSVG(w, h, a.arrow.x1 * k2, a.arrow.y1 * k2,
          a.arrow.x2 * k2, a.arrow.y2 * k2, a.arrow.color,
          arrowShaftPx(w, a.imgW, a.imgH, a.region)));
      }
      const bare = !a.region && !a.cell && !hasArrow(a.arrow);
      box.append(el('div', { class: 'hint' }, bare ? '整張顯示・點我改' : '點我改'));
      return el('div', { class: 'an' }, box,
        el('div', { class: 's' },
          el('b', {}, '出現在：' + rangeText(a)),
          el('span', {}, ([a.region ? '有顯示區域' : null, a.cell ? '有黃框' : null,
            hasArrow(a.arrow) ? '有箭頭' : null]
            .filter(Boolean).join('＋') || '整張顯示'))),
        el('button', { class: 'ghost danger', onclick: (ev) => {
          ev.stopPropagation();
          S.ANNOTS.splice(k, 1); saveAnnots(job); drawAnnots(job);
        } }, '刪除'));
    });

    return el('div', { style: 'border-bottom:1px solid var(--line);padding:14px 0' },
      el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:4px' },
        el('b', { style: 'font-size:13.5px' }, src),
        el('span', { style: 'flex:1' }),
        el('button', { class: 'ghost tiny', onclick: () => addAnnot(job, src) },
          mine.length ? '＋ 再加一段' : '＋ 標注這張')),
      ...(rows.length ? rows
        : [el('div', { style: 'display:flex;gap:14px;align-items:center;padding-top:6px' },
            el('div', { class: 'prev', style: 'opacity:.55',
              onclick: () => addAnnot(job, src) },
              el('img', { src: `/api/jobs/${job.id}/file/${src}`, alt: '' }),
              el('div', { class: 'hint' }, '還沒標')),
            el('span', { style: 'font-size:12.5px;color:var(--dim)' },
              '沒圈選的截圖不會出現在影片裡。'))]));
  }));
  // 牆上的「已用 N 次」要跟著標注一起更新 —— 少了這行，點縮圖加完標注、
  // 或刪掉一段之後，次數會停在舊數字。
  drawAnnotWall(job);
}

export async function saveAnnots(job) {
  try {
    const r = await api(`/api/jobs/${job.id}/annotations`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shots: S.ANNOTS }),
    });
    const n = $('#annotSaved');
    if (!n) return;
    // 配圖計畫已經算完之後才存的標注，這支影片吃不到 —— 以前這裡照樣顯示「已儲存」，
    // 使用者以為標好了，到配圖計畫才發現圖不見（2026-08-21）。現在講清楚。
    if (r && r.applied === false) {
      n.style.color = 'var(--bad)';
      n.textContent = `已存 ${S.ANNOTS.length} 筆，但這支的配圖計畫已經算完 —— 這筆不會自動進去，請到下面的「配圖計畫」確認。`;
      return;
    }
    n.style.color = '';
    n.textContent = `已儲存 ${S.ANNOTS.length} 筆`;
    setTimeout(() => { if (n) n.textContent = ''; }, 2500);
  } catch (e) { alert('儲存失敗：' + e.message); }
}

// src 沒帶進來（卡片下方那顆「＋ 加一個標注」就是沒帶）→ 預設用第一張截圖。
// ⚠️ 2026-08-19 使用者回報：原本會 push 一筆 src=undefined 的標注 →
//    編輯器去抓 /api/jobs/<id>/file/undefined（404）→ 畫面一片空白；
//    標注模式又刻意清空圖片列（見 editAnnot 的註解），連換圖都換不了 → 死路。
//    列表是「依圖分組」畫的，那筆也看不到、刪不掉，存下去 auto-shot／auto-focus
//    還會在 `if (!a.src) continue` 直接跳過。
/** 這支工作目前有哪些截圖（標注編輯器的縮圖列與 addAnnot 共用同一份清單） */
export function jobImages(job) {
  return (job.files || []).filter((f) => /\.(png|jpe?g)$/i.test(f));
}

// ── 事後補上傳截圖（2026-09-01）────────

export function pickMoreShots(job, onDone) {
  S.morePickJob = job;
  S.morePickDone = onDone || null;
  $('#morePicker').click();
}
$('#morePicker').onchange = (e) => {
  const files = [...e.target.files];
  e.target.value = '';   // 選同一個檔第二次也要能觸發
  if (S.morePickJob && files.length) uploadMoreShots(S.morePickJob, files, S.morePickDone);
};

export async function uploadMoreShots(job, files, onDone) {
  const msg = () => $('#annotUpMsg') || $('#planUpMsg');
  const added = [];
  const bad = files.find((f) => !/^image\//.test(f.type) && !/\.(png|jpe?g|webp|heic|heif|gif|bmp|tiff?)$/i.test(f.name));
  if (bad) return alert(`「${bad.name}」不是圖片檔，這裡只能補截圖。`);
  let done = 0;
  for (const f of files) {
    if (msg()) msg().textContent = `上傳 ${done + 1}/${files.length}（${(f.size / 1048576).toFixed(1)} MB）…`;
    // 副檔名沿用建立頁的規則：不是 jpg 就叫 png。真正的格式由伺服器嗅探後修正（ensureUsableImage）
    const ext = /\.jpe?g$/i.test(f.name) ? '.jpg' : '.png';
    let r;
    try {
      r = await fetch(`/api/jobs/${job.id}/upload?auto=1&ext=${encodeURIComponent(ext)}`,
        { method: 'POST', body: f });
    } catch (err) {
      if (msg()) msg().textContent = '';
      return alert(`上傳「${f.name}」失敗：${err.message}`);
    }
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      if (msg()) msg().textContent = '';
      // 前面幾張可能已經上去了 —— 讓使用者看得到目前的狀態，不要假裝什麼都沒發生
      if (added.length && onDone) onDone(added);
      else if (added.length) { S.jobSig = null; loadJob(); }
      return alert(`上傳「${f.name}」失敗（${r.status}）${j.error ? '：' + j.error : ''}`);
    }
    // 檔名是伺服器排的（auto=1），一定要用它回傳的那個，前台不要自己猜
    const okBody = await r.json().catch(() => ({}));
    if (okBody.name) added.push(okBody.name);
    done += 1;
  }
  if (msg()) msg().textContent = `已上傳 ${done} 張`;
  setTimeout(() => { if (msg()) msg().textContent = ''; }, 4000);
  if (onDone) return onDone(added);
  S.jobSig = null;
  await loadJob();
}

export function addAnnot(job, src) {
  if (!S.CHARS.length) return alert('腳本還在讀，等一下再試');
  // 沒帶 src（卡片下方那顆按鈕）→ 先開第一張。2026-09-01 起編輯器有縮圖列，
  // 開錯張也能當場換掉，不再是死路。
  const use = src || jobImages(job)[0];
  if (!use) return alert('這支工作沒有上傳截圖，沒有東西可以標注。');
  S.ANNOTS.push({ src: use, startCharIdx: null, endCharIdx: null, region: null, cell: null, arrow: null });
  drawAnnots(job);
  editAnnot(job, S.ANNOTS.length - 1);
}

export function editAnnot(job, k) {
  const a = S.ANNOTS[k];
  S.edCtx = { job, mode: 'annot', k, drag: null, src: a.src, mode2: 'region',
    region: a.region ? { ...a.region } : null,
    cell: a.cell ? { ...a.cell } : null,
    arrow: a.arrow ? { ...a.arrow } : null,
    arrowColor: (a.arrow && a.arrow.color) || ARROW_DEFAULT,
    from: a.startCharIdx ?? null, to: a.endCharIdx ?? null };
  $('#edTitle').textContent = '標注　' + a.src;
  $('#edNote').textContent = '';
  setEdArrow(job);
  drawEdColors();
  setEdMode('region');
  // 縮圖列 2026-09-01 補回來（使用者：「按下去沒有出現給我全部上傳圖片的選項，導致我一直選不到我要的圖」）。
  // ⚠️ 2026-08-17 當初把它清空，是為了擋「第一張圖選好的範圍出現在第二張圖」。
  //    那個真因後來已經在別處各自修掉了，所以現在放回來是安全的：
  //      ① 換圖會清框 —— loadEdImage() 偵測到 src 變了就把 region／cell 清掉並提示（2026-08-25）
  //      ② 框不會再畫歪 —— drawEdBox() 改成像素定位，.ed-strip 也用 width:0;min-width:100%
  //         不再把 modal 撐寬（2026-08-21）
  //    這兩條任何一條被改掉，這裡就要重新評估。
  drawStrip(jobImages(job));
  loadEdImage(a.src);
  drawRange();
  $('#ed').style.display = 'flex';
}

