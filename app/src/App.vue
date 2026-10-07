<script setup>
import { onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { admin, forceUnlock, health, mock, pollHealth, reloadNeeded, stale, startHealthPolling, statusPill } from './stores/health.js';
import { editorOpen } from './stores/editor.js';
import BoxEditor from './components/editor/BoxEditor.vue';

const route = useRoute();
onMounted(async () => { await pollHealth(); startHealthPolling(); });

const NAV = [
  { to: '/', label: '儀表板', match: (r) => r.name === 'dashboard' },
  { to: '/jobs', label: '工作列表', match: (r) => r.name === 'jobs' || r.name === 'job' },
  { to: '/new', label: '＋ 新增任務', match: (r) => r.name === 'new', accent: true },
  { to: '/say', label: '跟我說', match: (r) => r.name === 'say' },
  { to: '/fix', label: '修正紀錄', match: (r) => r.name === 'fix', adminOnly: true },
];
</script>

<template>
  <header class="sticky top-0 z-20 flex items-center gap-4 border-b border-line bg-white px-5 py-3">
    <h1 class="m-0 text-[17px] font-semibold tracking-wide">大眾短影音出片工具</h1>
    <nav class="ml-3 flex gap-1">
      <template v-for="n in NAV" :key="n.to">
        <RouterLink v-if="!n.adminOnly || admin" :to="n.to" :data-nav="n.to"
          class="rounded-lg px-3.5 py-1.5 text-sm no-underline"
          :class="n.match(route) ? 'bg-soft font-semibold text-ink' : (n.accent ? 'text-accent' : 'text-dim')">{{ n.label }}</RouterLink>
      </template>
    </nav>
    <span class="flex-1"></span>
    <span v-if="mock" id="mockMode" class="pill mock" title="WORKBENCH_MOCK=1：HeyGen／MiniMax／字幕／OCR 都是本機假資料，成品不能發布">🧪 模擬模式</span>
    <span v-if="admin && health && health.diskMB != null" id="disk" class="pill" title="工作紀錄佔用空間；影片、稿件與素材會持續保留。">💾 {{ health.diskMB }} MB</span>
    <span id="status" class="pill" :class="statusPill.tone" :title="statusPill.title"
      :style="{ cursor: admin && statusPill.lock ? 'pointer' : 'default' }" @click="forceUnlock">{{ statusPill.text }}</span>
  </header>

  <main class="mx-auto max-w-[1240px] px-5 pb-24 pt-6">
    <RouterView />
  </main>

  <div v-if="reloadNeeded" class="reload">
    <span>🔄 <b>網頁檔案已經更新</b> —— 你這個分頁載入的還是舊版，畫面上看到的不是最新的。</span>
    <button @click="location.reload()">重新整理</button>
  </div>

  <!-- 「伺服器跑舊版」提醒：固定在底部的覆蓋層，pointer-events:none，不吃掉底下按鈕的點擊。
       第二句分兩版：同事看到的是「該做什麼」，Leighly 看到的是「怎麼重開」。 -->
  <div v-if="stale" class="stale">
    程式碼已經更新，但伺服器還在跑舊版 —— 網頁上看到的還是舊設定。<br>
    <span v-if="!admin">這頁還是可以正常看，資料都是對的。只是先別按「開始出片」，出來的會是舊設定 —— 等伺服器重開之後再出片就好。</span>
    <span v-else>重開才會生效：<code>sudo launchctl kickstart -k system/com.cmoney.marketing-video-studio</code>　或終端機打 <code>studio</code></span>
  </div>

  <BoxEditor v-if="editorOpen" />
</template>
