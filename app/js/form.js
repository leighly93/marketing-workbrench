// 建立工作表單：標題、截圖欄位、唸法、現成講者影片、語氣與送出。

import { $, api, el } from './dom.js';
import { go } from './shell.js';
import { EMOTIONS, S } from './state.js';


// 出片卡片裡兩組並排的小選項各自的說明（2026-09-14）。
// 講者影片那組操作的是 #skipGenerate 這個藏起來的 checkbox —— 它仍然是狀態來源。
export const EMOTION_TIP = '講漲勢、好消息用「開心」；重挫、壞消息用「流暢」（平穩）。'
  + '<b>不選擇預設就是流暢。</b>';
export const EMOTION_TIP_OFF = '用現成的講者影片不會重新配音 —— 這支的語氣就是那支影片原本的。';
export const HEYGEN_MODES = [
  [false, '重新生成', '會呼叫 HeyGen 生成一支新的講者影片。'],
  [true, '用現成的', '不呼叫 HeyGen、<b>不扣點數</b> —— 拿一支之前的講者影片重跑就好。'],
];


// ── 標題 ──────────────────────────────────
export function titleCfg() {
  return (S.TPLS[S.tpl] && S.TPLS[S.tpl].title) || { lines: 2, per: 12, where: '' };
}
export function titleLines() {
  return S.titleVals.slice(0, titleCfg().lines).map((v) => v.trim()).filter(Boolean);
}
// 送出按鈕帶版型名（2026-09-14 使用者：同事會按錯版型）。
// 按鈕本來就已經是版型色（button.go 吃 --accent，盤中焦點是橘的），加上名字變成
// 顏色＋文字雙重提示，而且是在**手指按下去的那一刻**看到，比多一層彈窗有用。
// ⚠️ 送出過程會把文字換成「建立工作…／上傳 1/3…」，失敗時要用這支還原，不能寫死「開始出片」。
export function submitLabel() {
  // 上傳中斷過就直接講「繼續」—— 同事最怕的是「剛剛已經按過了，再按一次會不會變成兩支」。
  // 檔案全上去、掛在最後那一步 /submit 的情況也要有話講 —— 按鈕寫「開始出片」
  // 卻不跳確認視窗（續傳不再問一次）會讓人以為按錯了。
  if (S.pending && S.pending.sig === formSig()) {
    const left = S.pending.total - S.pending.done.length;
    return left > 0 ? `繼續上傳剩下的 ${left} 個檔案` : '繼續送出這支工作';
  }
  const t = (S.TPLS[S.tpl] || {}).label;
  return t ? `開始出片：${t}` : '開始出片';
}

export function drawTitle() {
  const cfg = titleCfg();
  const wrap = $('#titleLines');
  const rows = [];
  for (let i = 0; i < cfg.lines; i++) {
    // 會換行的模板（焦點股／大盤／三大法人）：字數只是「參考」，可以超過 —— 超過只是自動換行、字級不變。
    // 只有不能換行的投廣模板（cfg.wrap === false）才用 maxlength 硬擋，因為上方 bar 沒換行空間。
    //（2026-08-17 使用者：除投廣外，字數限制只是參考，為什麼不能輸入超過。）
    if (!cfg.wrap) S.titleVals[i] = (S.titleVals[i] || '').slice(0, cfg.per);
    const cnt = el('span', { class: 'cnt' });
    const inp = el('input', {
      type: 'text', value: S.titleVals[i] || '',
      ...(cfg.wrap ? {} : { maxlength: cfg.per }),
      placeholder: cfg.lines === 1 ? '' : (i === 0 ? '第一行' : '第二行'),
      oninput: (e) => { S.titleVals[i] = e.target.value; paint(); },
    });
    const paint = () => {
      const n = (S.titleVals[i] || '').trim().length;
      const over = cfg.wrap && n > cfg.per;
      cnt.textContent = n ? n + '/' + cfg.per + (over ? '・會換行' : '') : '';
      cnt.classList.toggle('over', over);
    };
    paint();
    rows.push(el('div', { class: 'tline' }, inp, cnt));
  }
  wrap.replaceChildren(...rows);
  // 標題前面掛版型名（「大盤小報標題」）—— 同事會在選錯版型的情況下把標題打完，
  // 這裡多兩個字就多一次自我檢查。drawTitle() 每次換版型都會跑（boot2 呼叫）。
  $('#titleLabel').textContent = ((S.TPLS[S.tpl] || {}).label || '影片') + '標題';
  $('#submit').textContent = submitLabel();
  $('#twhere').textContent = cfg.where;
}


// ── 截圖欄位 ──────────────────────────────


$('#picker').onchange = (e) => {
  fillSlotsFrom(S.pickingSlot, [...e.target.files]);
  e.target.value = '';   // 選同一個檔第二次也要能觸發
};

/**
 * 這個檔能不能放進截圖格。
 * ⚠️ 不要只認 f.type —— HEIC 在有些系統給的是空字串，而伺服器其實吃得下
 *    （ensureUsableImage 會把 webp／heic／gif／bmp／tiff 自動轉成 png）。
 *    判斷跟事後補圖那支（uploadMoreShots）刻意用同一套，三個入口不要各有各的標準。
 */
export function isShotFile(f) {
  return /^image\//.test(f.type) || /\.(png|jpe?g|webp|heic|heif|gif|bmp|tiff?)$/i.test(f.name);
}

// 從第 start 格開始往後填：第一張蓋掉 start 那格，其餘往後找空格，沒空格就長一格。
// 點擊選檔（一次可以選好幾張）與拖曳都走這支。
// ⚠️ 以前 #picker 那條是直接 `slots[i] = f`，完全沒有檢查，檢查只寫在拖曳那條：
//    選到 mp4 沒人擋，要等送出、建完工作、上傳被伺服器退件（400）才看得到一句看不懂的錯，
//    而且留下一支卡在「建立中」的工作（2026-09-14）。
export function fillSlotsFrom(start, files) {
  if (start < 0 || !files.length) return;
  const bad = files.filter((f) => !isShotFile(f));
  let i = start;
  for (const f of files.filter(isShotFile)) {
    if (i >= S.slots.length) S.slots.push(null);
    S.slots[i] = f;
    do { i += 1; } while (i < S.slots.length && S.slots[i]);
  }
  drawSlots();
  // 一次選十張、其中三張不是圖片的話，彈三次視窗比不提醒還煩 —— 併成一則。
  if (bad.length) {
    const vid = bad.find((f) => /^video\//.test(f.type) || /\.(mp4|mov|m4v)$/i.test(f.name));
    alert(vid
      // 原本是靜靜忽略 —— 使用者把 mp4 拖進來會以為壞掉（2026-08-13 回報）
      ? '這幾格是放 APP 截圖的。\n\n講者影片預設由系統自己生成，不用上傳。'
      : `「${bad[0].name}」不是圖片檔，這幾格只能放截圖（png、jpg、heic 都可以）。`
        + (bad.length > 1 ? `\n\n另外還有 ${bad.length - 1} 個檔也一樣，都沒有放進去。` : ''));
  }
}

export function drawSlots() {
  const wrap = $('#slots');
  const nodes = S.slots.map((f, i) => {
    const s = el('div', {
      class: 'slot' + (f ? ' filled' : ''),
      onclick: () => { S.pickingSlot = i; $('#picker').click(); },
      ondragover: (e) => { e.preventDefault(); s.classList.add('hot'); },
      ondragleave: () => s.classList.remove('hot'),
      ondrop: (e) => { e.preventDefault(); s.classList.remove('hot'); fillSlotsFrom(i, [...e.dataTransfer.files]); },
    });
    if (f) {
      s.append(
        el('img', { src: URL.createObjectURL(f), alt: '' }),
        el('button', { class: 'x', title: '刪掉這張',
          onclick: (e) => { e.stopPropagation(); S.slots.splice(i, 1); if (S.slots.length < 3) S.slots.push(null); drawSlots(); } }, '✕'),
        el('div', { class: 'tag' }, el('b', {}, '截圖 ' + (i + 1))));
    } else {
      s.append(el('div', { class: 'n' }, '截圖 ' + (i + 1)), el('div', { class: 'h' }, '點擊或拖曳'));
    }
    return s;
  });
  nodes.push(el('div', {
    class: 'slot add',
    onclick: () => { S.slots.push(null); drawSlots(); },
    title: '再新增一張',
  }, '＋'));
  wrap.replaceChildren(...nodes);
  // 換了圖就不是上次那支工作了 —— 按鈕要當場從「繼續上傳剩下的…」變回「開始出片」。
  // （submitLabel() 自己會比對表單特徵，這裡只是給它一次重算的機會。）
  if (S.pending) $('#submit').textContent = submitLabel();
}

// ── 唸法（發音替換）──────────────────────

export function drawVoiceRows() {
  const wrap = $('#voiceRows');
  wrap.replaceChildren(...S.voiceRows.map((r, i) => {
    // 欄位標題只畫在第一列 —— 每列都掛一次會把整張卡片撐成一面標籤牆
    const cell = (key, label, ph) => el('div', {},
      i === 0 ? el('label', {}, label) : '',
      el('input', { type: 'text', value: r[key], placeholder: ph,
        oninput: (e) => { r[key] = e.target.value; syncVoice(); markVoiceDupes(); } }));
    // ✕ 只有兩列以上才出現：只剩一列時還能刪，畫面會整個空掉，同事會以為功能不見了
    const x = S.voiceRows.length > 1
      ? el('button', { class: 'ghost vx', title: '刪掉這一條',
          onclick: () => { S.voiceRows.splice(i, 1); drawVoiceRows(); syncVoice(); } }, '✕')
      : '';
    return el('div', { class: 'sayrow' },
      cell('from', '預想會唸錯的詞', '收斂'), cell('to', '建議怎麼寫', '收練'), x);
  }));
  markVoiceDupes();
}

$('#voiceAdd').onclick = () => {
  S.voiceRows.push({ from: '', to: '' });
  drawVoiceRows();
  const last = $('#voiceRows').lastElementChild;
  if (last) last.querySelector('input').focus();
};

// 這幾格組出來的字串就是送出去的 body.voice。#voice 那個 textarea 還在（hidden），
// 只是改由這裡寫 —— POST 與續傳的表單特徵都讀它，不用各自再認識一次 voiceRows。
export function syncVoice() {
  $('#voice').value = S.voiceRows
    .filter((r) => r.from.trim() && r.to.trim())
    .map((r) => `${r.from.trim()}→${r.to.trim()}`).join('\n');
  // 唸法也算在表單特徵裡：改了就不該再接續上一支（submitLabel 自己會重算）
  if (S.pending) $('#submit').textContent = submitLabel();
}

// 同一個原文填兩次，只有第一條會生效（伺服器是照順序做字串取代，先套先贏）——
// 當場把後面那條標紅，不要等到送出才講。
export function markVoiceDupes() {
  const seen = new Set();
  const rows = [...$('#voiceRows').children];
  S.voiceRows.forEach((r, i) => {
    const from = r.from.trim();
    if (rows[i]) rows[i].classList.toggle('dup', !!from && seen.has(from));
    if (from) seen.add(from);
  });
}

/**
 * 送出前檢查。回傳第一個問題（字串）或 null。
 * 擋的都是「填了卻不會生效」的寫法 —— 以前這些全部被靜默丟掉，這正是要消滅的那件事。
 * 整列空白不算問題：預設就有一列，多數工作不填。
 */
export function voiceProblem() {
  const seen = new Map();
  for (let i = 0; i < S.voiceRows.length; i++) {
    const from = S.voiceRows[i].from.trim();
    const to = S.voiceRows[i].to.trim();
    const at = `第 ${i + 1} 條唸法`;
    if (!from && !to) continue;
    if (!from) return `${at}只填了右邊。左邊要填腳本裡原本的那個詞。`;
    if (!to) return `${at}只填了「${from}」。右邊要填怎麼寫它才唸得對（例如「收練」）。`;
    if (/[→\n]/.test(from + to) || (from + to).includes('->'))
      return `${at}裡不用自己打箭頭 —— 左右兩格各填一個詞就好。`;
    if (from.startsWith('#')) return `${at}的「${from}」以 # 開頭，那在腳本裡是註解的意思，整條不會生效。`;
    if (from === to) return `${at}左右兩格一模一樣（${from}），這樣等於沒有改。`;
    if (seen.has(from)) return `${at}的「${from}」跟第 ${seen.get(from)} 條重複了。`
      + '同一個詞只有前面那條會生效，請刪掉一條。';
    seen.set(from, i + 1);
  }
  return null;
}

// ── 進階：現成講者影片 ──
$('#skipGenerate').onchange = (e) => {
  $('#heygenSlot').style.display = e.target.checked ? 'block' : 'none';
  $('#costWarn').hidden = e.target.checked;   // 用現成影片不呼叫 HeyGen，不扣點數
  // 用現成影片＝不重新配音 → 語氣那組變灰（drawEmotion 自己讀 #skipGenerate）
  drawHeygenMode();
  drawEmotion();
};
export function setHeygen(f) {
  if (!f) return;
  // accept 有時擋不住（有些系統 mp4 的 MIME 是空的），所以副檔名也認
  if (!/^video\//.test(f.type) && !/\.(mp4|mov|m4v)$/i.test(f.name))
    return alert(`「${f.name}」看起來不是影片檔。`);
  S.heygenFile = f;
  $('#vdrop').classList.add('ok');
  $('#heygenName').textContent = `${f.name}　${(f.size / 1048576).toFixed(1)} MB　（點這裡可換掉）`;
}
$('#vdrop').onclick = () => $('#heygenPicker').click();
['dragover', 'dragleave', 'drop'].forEach((ev) =>
  $('#vdrop').addEventListener(ev, (e) => {
    e.preventDefault();
    $('#vdrop').classList.toggle('hot', ev === 'dragover');
    if (ev === 'drop') setHeygen(e.dataTransfer.files[0]);
  }));
$('#heygenPicker').onchange = (e) => { setHeygen(e.target.files[0]); e.target.value = ''; };


// 出片卡片的兩組選項。樣式沿用編輯器的 .modes（等寬、選到的那顆發亮）。
// 用現成的講者影片時不會重新配音 → 語氣那組變灰不給點（.modes.off），
// 但**留在畫面上**，不是隱藏 —— 隱藏會讓整張卡片跳一下，而且看不出為什麼選項不見了。
export function drawEmotion() {
  const off = $('#skipGenerate').checked;
  $('#emotion').className = 'modes' + (off ? ' off' : '');
  $('#emotionTip').innerHTML = off ? EMOTION_TIP_OFF : EMOTION_TIP;
  $('#emotion').replaceChildren(...EMOTIONS.map(([v, label]) =>
    el('div', {
      class: v === S.emotion ? 'on' : '',
      onclick: off ? null : () => { S.emotion = v; drawEmotion(); },
    }, label)));
}

export function drawHeygenMode() {
  const cur = $('#skipGenerate').checked;
  $('#heygenTip').innerHTML = (HEYGEN_MODES.find(([v]) => v === cur) || [])[2] || '';
  $('#heygenMode').replaceChildren(...HEYGEN_MODES.map(([v, label]) =>
    el('div', {
      class: v === cur ? 'on' : '',
      onclick: () => {
        if (v === cur) return;
        $('#skipGenerate').checked = v;
        // 既有的 onchange 不是自動觸發的（程式改 .checked 不會發事件），要自己呼叫
        $('#skipGenerate').onchange({ target: $('#skipGenerate') });
      },
    }, label)));
}

// ── 送出 ──────────────────────────────────
export function formSig() {
  return JSON.stringify([S.tpl, S.emotion, $('#owner').value, titleLines(), $('#body').value,
    $('#voice').value, $('#skipGenerate').checked,
    S.slots.map((f) => f && [f.name, f.size, f.lastModified]),
    S.heygenFile && [S.heygenFile.name, S.heygenFile.size, S.heygenFile.lastModified]]);
}

// 續傳狀態下改腳本＝那已經是另一支影片了，按鈕要當場變回「開始出片」，
// 不然同事看到「繼續」兩個字、按下去卻建出一支新工作。
// 沒有 pending 時什麼都不算 —— 不值得為了每一次按鍵重算一遍表單特徵。
$('#body').addEventListener('input', () => { if (S.pending) $('#submit').textContent = submitLabel(); });

$('#submit').onclick = async () => {
  const btn = $('#submit');
  const imgs = S.slots.filter(Boolean);
  const lines = titleLines();
  if (!$('#body').value.trim()) return alert('腳本是空的');
  if ($('#skipGenerate').checked && !S.heygenFile) return alert('勾了「用現成的講者影片」，請選擇 heygen.mp4');
  const vp = voiceProblem();
  if (vp) return alert(vp);

  const sig = formSig();
  const resume = !!(S.pending && S.pending.sig === sig);
  if (S.pending && !resume) S.pending = null;   // 內容改過了 → 上次那支半成品不要了，從頭建一支

  // 續傳不再問一次：內容跟上次按下確定時**一模一樣**（sig 比對過），
  // 而且按鈕上寫的就是「繼續上傳剩下的 N 個檔案」，不是「開始出片」。
  // 勾了「用現成的講者影片」不呼叫 HeyGen、不扣點數，也不用問
  // 版型放第一行（2026-09-14 使用者：「同事會按錯」）。原生 confirm 不能粗體、不能上色、
  // 也不能置中（Chrome 一律釘在分頁上緣），能強調的只有「排在最前面」與【】。
  // 「按下確定就會扣點數」那句拿掉 —— 按鈕正上方的紅框已經整段在講同一件事，
  // 同一句話講兩次反而讓人整段略過（使用者：「這樣更簡單清楚」）。
  const tplLabel = (S.TPLS[S.tpl] || {}).label || S.tpl;
  const emoLabel = (EMOTIONS.find(([v]) => v === S.emotion) || [])[1] || S.emotion;
  if (!resume && !$('#skipGenerate').checked &&
      !confirm(`這支要出的是【${tplLabel}】\n配音語氣：${emoLabel}\n\n`
        + '確定要開始出片嗎？\n'
        + '送出前再確認一次：版型、腳本、標題、截圖。')) return;

  btn.disabled = true;
  try {
    let jobId;
    if (resume) jobId = S.pending.id;
    else {
      btn.textContent = '建立工作…';
      const { job } = await api('/api/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template: S.tpl, owner: $('#owner').value,
          title: lines.join('\n'), body: $('#body').value, voice: $('#voice').value,
          // noSpeed 的勾選框 2026-08-19 拿掉了（加速已經改在 HeyGen 生成端做，正常出片不會重複）。
          // run.js 的 --no-speed 旗標還在，要用就在終端機下。
          skipGenerate: $('#skipGenerate').checked,
          autoApprove: false, emotion: S.emotion,
        }),
      });
      jobId = job.id;
      S.pending = { id: jobId, sig, done: [], total: 0 };
    }
    const ups = imgs.map((f, i) => ({ f, name: 'shot' + (i + 1) + (/\.jpe?g$/i.test(f.name) ? '.jpg' : '.png') }));
    if (S.heygenFile) ups.push({ f: S.heygenFile, name: 'heygen.mp4' });
    S.pending.total = ups.length;
    for (let i = 0; i < ups.length; i++) {
      if (S.pending.done.includes(ups[i].name)) continue;   // 上次已經傳上去的，不用再傳一遍
      const mb = (ups[i].f.size / 1048576).toFixed(1);
      btn.textContent = `上傳 ${i + 1}/${ups.length}（${mb} MB）…`;
      // ⚠️ 一定要檢查結果。原本沒檢查 → 上傳失敗畫面照樣往下走，
      //    最後才丟一個看不懂的錯（2026-08-13）。
      const r = await fetch(`/api/jobs/${jobId}/upload?name=${ups[i].name}`,
        { method: 'POST', body: ups[i].f });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        // 那支工作在伺服器上已經不見了（被刪掉）→ 續傳沒有意義，下次從頭建一支
        if (r.status === 404) S.pending = null;
        throw new Error(`上傳「${ups[i].f.name}」失敗（${r.status}）${j.error ? '：' + j.error : ''}`);
      }
      S.pending.done.push(ups[i].name);
    }
    btn.textContent = '送出…';
    await api(`/api/jobs/${jobId}/submit`, { method: 'POST' });
    S.pending = null;
    S.slots = [null, null, null]; S.heygenFile = null;
    $('#vdrop').classList.remove('ok');
    $('#heygenName').textContent = '支援 .mp4（會被存成 heygen.mp4）';
    $('#body').value = ''; S.titleVals = ['', ''];
    // 唸法跟著腳本一起清掉（2026-09-14 使用者定案）。下一支是別的稿子，
    // 留著上一支的詞很容易整批被沿用到不該用的地方；真的常出現的詞會被收進共用詞庫，
    // 之後自動套用，不必再靠同事每次手填。
    S.voiceRows = [{ from: '', to: '' }];
    drawSlots(); drawTitle(); drawVoiceRows(); syncVoice();
    S.openJob = jobId; go('job');
  } catch (e) {
    alert('出錯了：' + e.message
      + (S.pending && S.pending.done.length
        ? `\n\n已經傳上去的 ${S.pending.done.length} 個檔案會留著，再按一次只補剩下的。` : ''));
  }
  btn.disabled = false; btn.textContent = submitLabel();
};

