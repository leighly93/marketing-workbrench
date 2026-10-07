<script setup>
// 跟我說：回報唸錯的詞、自由留言。管理者另有收件匣與共用詞庫管理。
// 存 data/messages.jsonl（append-only）。⚠️ 不要改存在 job.json 裡 —— 同事按「刪除工作」時會連同紀錄一起消失。
import { onMounted, ref } from 'vue';
import { api, json, when } from '../lib/api.js';
import { addDictRuleConfirming } from '../lib/dict.js';
import { admin } from '../stores/health.js';
import { lastJob } from '../stores/job.js';
import { owner, who } from '../stores/owner.js';

const word = ref(''), suggest = ref(''), why = ref(''), note = ref('');
const wordMsg = ref(''), noteMsg = ref('');
const messages = ref([]), rules = ref([]);
const dictFrom = ref(''), dictTo = ref(''), dictWhy = ref(''), dictMsg = ref('');

async function sendSay(payload, msgRef, okText) {
  if (!who()) { alert('上面先填一下「你是誰」，我才知道是誰回報的。'); return false; }
  msgRef.value = '送出中…';
  try {
    await json('POST', '/api/messages', { ...payload, by: who(), job: lastJob.value });
    msgRef.value = okText; setTimeout(() => { msgRef.value = ''; }, 4000);
    if (admin.value) load();
    return true;
  } catch (e) { msgRef.value = ''; alert('送不出去：' + e.message); return false; }
}
async function sendWord() {
  if (!word.value.trim()) return alert('還沒填「唸錯的詞」');
  if (!suggest.value.trim()) return alert('還沒填「建議怎麼寫」—— 只說唸錯了我沒辦法改，要給我一個寫法');
  if (await sendSay({ kind: 'pronounce', word: word.value.trim(), suggest: suggest.value.trim(), why: why.value.trim() }, wordMsg, '收到了，謝謝！我會加進共用詞庫。')) { word.value = ''; suggest.value = ''; why.value = ''; }
}
async function sendNote() {
  if (!note.value.trim()) return alert('留言是空的');
  if (await sendSay({ kind: 'note', text: note.value.trim() }, noteMsg, '收到了，謝謝！')) note.value = '';
}
async function load() {
  if (!admin.value) return;
  const [inbox, dict] = await Promise.all([api('/api/messages').catch(() => ({ messages: [] })), api('/api/pronounce').catch(() => ({ rules: [] }))]);
  // 未讀在前，其餘照時間新到舊
  messages.value = [...(inbox.messages || [])].sort((a, b) => (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0) || (a.at < b.at ? 1 : -1));
  rules.value = dict.rules || [];
}
onMounted(load);
function meta(m) {
  return [m.by, when(m.at), m.job ? '工作 ' + m.job : null,
    m.kind === 'pronounce' ? (m.auto ? '唸法・出片時帶上' : '唸法回報') : m.kind === 'page-pin' ? '📌 記下的頁' : '留言'].filter(Boolean).join('・');
}
async function setStatus(id, status) {
  try { await json('POST', '/api/messages/status', { id, status }); load(); } catch (e) { alert('更新失敗：' + e.message); }
}
async function collect(m) {
  try {
    if (!(await addDictRuleConfirming({ from: m.word, to: m.suggest, why: m.why || '', by: m.by, fromMessage: m.id }))) return;
    await setStatus(m.id, 'done');
  } catch (e) { alert('收錄失敗：' + e.message); }
}
async function addDict() {
  if (!dictFrom.value.trim() || !dictTo.value.trim()) return alert('原文跟唸法都要填');
  try {
    if (!(await addDictRuleConfirming({ from: dictFrom.value.trim(), to: dictTo.value.trim(), why: dictWhy.value.trim(), by: who() }))) return;
    dictFrom.value = ''; dictTo.value = ''; dictWhy.value = '';
    dictMsg.value = '加好了'; setTimeout(() => { dictMsg.value = ''; }, 3000);
    load();
  } catch (e) { alert(e.message); }
}
async function toggleRule(r) {
  try { await json('PATCH', '/api/pronounce', { from: r.from, enabled: r.enabled === false }); load(); } catch (e) { alert('更新失敗：' + e.message); }
}
</script>

<template>
  <div class="card">
    <label>你是誰</label>
    <input type="text" id="sayOwner" v-model="owner" placeholder="王小明">
    <div class="note mt-2">填一次就好，這台電腦的瀏覽器會記住 —— 「新增任務」那頁也會自動帶上同一個名字。</div>
  </div>
  <div class="card">
    <h2>這個詞唸錯了</h2>
    <div class="note">影片裡哪個字唸錯了？寫給我，我會加進共用詞庫，之後每支影片都自動用對的唸法。<br>
      <b>「建議怎麼寫」請填同音字或數字唸法</b>（例：收斂→<b>收練</b>、櫃買→<b>貴買</b>、2330→<b>二三三零</b>），不要填注音 —— AI 不一定吃得懂注音。<br>
      <b>聲調不對也算</b> —— 例如「跌」唸成一聲（正確是ㄉㄧㄝˊ）、「期貨」的期唸成一聲，都寫進來。</div>
    <div class="sayrow mt-3">
      <div><label>唸錯的詞</label><input type="text" v-model="word" placeholder="收斂"></div>
      <div><label>建議怎麼寫</label><input type="text" v-model="suggest" placeholder="收練"></div>
    </div>
    <label>為什麼（選填）</label>
    <input type="text" v-model="why" placeholder="破音字／這是公司名，固定唸法">
    <div class="mt-4 flex items-center gap-2.5"><button class="go" @click="sendWord">送出</button><span class="hint">{{ wordMsg }}</span></div>
  </div>
  <div class="card">
    <h2>其他想跟我說的</h2>
    <div class="note"><b>前台哪裡怪怪的也寫這裡</b> —— 畫面看不懂、按了沒反應、希望多一個什麼功能、流程哪裡卡卡的，都可以。<br>
      我會看到你是誰、什麼時候寫的，如果你是從某一支工作點進來的，也會一起帶上，我才查得到是哪一支。</div>
    <textarea v-model="note" class="mt-3" style="min-height:120px" placeholder="例：配圖計畫那頁的縮圖太小，看不出框到哪裡&#10;例：出片完成後希望可以直接下載，不用再點一層"></textarea>
    <div class="mt-3 flex items-center gap-2.5"><button class="go" @click="sendNote">送出</button><span class="hint">{{ noteMsg }}</span></div>
  </div>

  <template v-if="admin">
    <div class="card" id="sayInboxCard">
      <h2>收件匣</h2>
      <div class="note">同事回報的詞按「收錄」就會進共用詞庫，之後每支影片自動套用。處理過的按「已讀」收起來。</div>
      <div v-if="!messages.length" class="empty">目前沒有任何留言</div>
      <div v-for="m in messages" :key="m.id" class="msg" :class="{ done: m.status === 'done' }">
        <div class="b">
          <template v-if="m.kind === 'pronounce'"><div class="w">{{ m.word }}　→　{{ m.suggest }}</div><div class="m">{{ (m.why ? '原因：' + m.why + '　' : '') + meta(m) }}</div></template>
          <template v-else-if="m.kind === 'page-pin'"><div class="w">📌 {{ m.src }}　系統原判：{{ m.systemPage || '?' }}{{ m.pinned ? '　已存圖' : '' }}</div>
            <div class="m">{{ (m.fingerprint && m.fingerprint.words ? '關鍵字：' + m.fingerprint.words.slice(0, 8).join('、') + '　' : '') + meta(m) }}　→ 批次命名：node video/shots/page-pins.js</div></template>
          <template v-else><div class="w">{{ m.text }}</div><div class="m">{{ meta(m) }}</div></template>
        </div>
        <div class="flex shrink-0 gap-2">
          <button v-if="m.kind === 'pronounce' && m.status !== 'done'" class="ghost tiny" @click="collect(m)">收錄進詞庫</button>
          <button class="ghost tiny" @click="setStatus(m.id, m.status === 'done' ? 'new' : 'done')">{{ m.status === 'done' ? '標回未讀' : '已讀' }}</button>
        </div>
      </div>
    </div>
    <div class="card" id="sayDictCard">
      <h2>共用發音詞庫</h2>
      <div class="note">每支影片送出前會自動套用（同事自己在「唸法」填的優先，重複的以他填的為準）。<br>
        ⚠️ 這是<b>字串取代</b>，不是「詞」取代 —— 單字（例如「玉」）會打中所有含那個字的詞，所以不給加；兩個字會先問一下。<br>
        停用不是刪除，之後想恢復按一下就好。</div>
      <div class="sayrow mt-3">
        <div><label>原文</label><input type="text" v-model="dictFrom" placeholder="采鈺"></div>
        <div><label>怎麼寫才唸得對</label><input type="text" v-model="dictTo" placeholder="彩玉"></div>
      </div>
      <label>為什麼（選填，之後才知道這條能不能刪）</label>
      <input type="text" v-model="dictWhy" placeholder="公司名，固定唸法">
      <div class="mt-4 flex items-center gap-2.5"><button class="go" @click="addDict">加進詞庫</button><span class="hint">{{ dictMsg }}</span></div>
      <div v-if="!rules.length" class="empty">詞庫還是空的</div>
      <table v-else class="list mt-5">
        <thead><tr><th>原文</th><th>唸法</th><th>為什麼</th><th>誰加的</th><th></th></tr></thead>
        <tbody><tr v-for="r in rules" :key="r.from" :style="r.enabled === false ? 'opacity:.4' : ''">
          <td>{{ r.from }}</td><td>{{ r.to }}</td><td class="hint">{{ r.why || '—' }}</td>
          <td class="hint">{{ [r.by || '—', (r.at || '').slice(5, 10)].filter(Boolean).join('・') }}</td>
          <td><button class="ghost tiny" @click="toggleRule(r)">{{ r.enabled === false ? '啟用' : '停用' }}</button></td></tr></tbody>
      </table>
    </div>
  </template>
</template>
