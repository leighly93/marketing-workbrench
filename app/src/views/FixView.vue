<script setup>
// 修正紀錄（管理者）：「AI 原本怎麼配，人改成什麼」。某一類一直出現 → 規則庫還缺那塊。
import { onMounted, ref } from 'vue';
import { api } from '../lib/api.js';

const d = ref(null);
const err = ref('');
onMounted(async () => { try { d.value = await api('/api/corrections'); } catch (e) { err.value = e.message; } });

const fmtCell = (c, sz) => !c ? '—'
  : sz ? `${Math.round(c.x / sz.w * 100)},${Math.round(c.y / sz.h * 100)}% ${Math.round(c.w / sz.w * 100)}×${Math.round(c.h / sz.h * 100)}%`
       : `${Math.round(c.x)},${Math.round(c.y)} ${Math.round(c.w)}×${Math.round(c.h)}`;
const fmtArrow = (a, sz) => !a ? null
  : '箭頭 ' + (sz ? `${Math.round(a.x1 / sz.w * 100)},${Math.round(a.y1 / sz.h * 100)}%→${Math.round(a.x2 / sz.w * 100)},${Math.round(a.y2 / sz.h * 100)}%`
    : `${Math.round(a.x1)},${Math.round(a.y1)}→${Math.round(a.x2)},${Math.round(a.y2)}`) + (a.color ? ` ${a.color}` : '');
const pair = (r, cell, region, arrow) => [cell ? '黃框 ' + fmtCell(cell, r.size) : null, region ? '區域 ' + fmtCell(region, r.size) : null, fmtArrow(arrow, r.size)].filter(Boolean).join('　') || '整張顯示';

function before(r) {
  if (r.type === '改框') return `${r.autoCellText || ''} ${pair(r, r.autoCell, r.autoRegion, r.autoArrow)}`;
  if (r.type === '改時間') return `${r.auto}　${r.autoPhrase || ''}`;
  if (r.type === '新增一段') return (r.autoCoveredBy || []).join('、') || '（原本沒有圖）';
  if (r.type === '人工標記') {
    // 「原本」是空的有三種：AI 真的不配圖、對照組整份沒排出來、舊紀錄比對用錯欄位。只有第一種能說「AI 不配圖」。
    const blank = { noCounterfactual: '（比不出來：這一支對照組一段都沒排，多半是頁型沒認出來）', legacyNoSrc: '（比不出來：舊紀錄沒記到 AI 配了哪張圖）' }[r.autoKind] || '（AI 本來不配圖）';
    return r.from ? `${r.from}　${r.autoCellText || ''} ${pair(r, r.autoCell, r.autoRegion, null)}`.trim() : blank;
  }
  return r.from || '—';
}
function after(r) {
  if (r.type === '改框') return pair(r, r.manualCell, r.manualRegion, r.manualArrow);
  if (r.type === '改時間') return `${r.manual}　${r.manualPhrase || ''}`;
  if (r.type === '新增一段') return `${r.from}　${r.manual || ''}`;
  if (r.type === '人工標記') return `${r.to}　${pair(r, r.manualCell, r.manualRegion, r.manualArrow)}`;
  return r.to || '—';
}
const reason = (r) => [...((r.reason && r.reason.tags) || []), (r.reason && r.reason.note) || ''].filter(Boolean).join('／') || '—';
</script>

<template>
  <div class="card">
    <h2>修正紀錄</h2>
    <div class="note">這頁記錄「AI 原本怎麼配，人改成什麼」。<br>某一類修正一直出現 → 規則庫還缺那塊，值得回頭修。<br>某一類連續兩三週都沒人改 → 那部分可以放心不用看了。</div>
    <div v-if="err" class="note bad mt-3">{{ err }}</div>
    <div v-else-if="!d" class="empty">讀取中…</div>
    <div v-else-if="!d.total" class="empty">還沒有人改過任何配圖 —— 目前為止 AI 排的都被直接採用了</div>
    <template v-else>
      <div class="my-4 flex flex-wrap gap-2.5"><span v-for="(v, k) in d.byType" :key="k" class="pill">{{ k }}　{{ v }} 次</span></div>
      <div class="mb-3 flex flex-wrap gap-1.5">
        <span v-for="[k, v] in Object.entries(d.byTag || {}).sort((x, y) => y[1] - x[1])" :key="k" class="pill">{{ k }}　{{ v }} 次</span>
        <span v-if="d.noReason" class="pill" style="opacity:.6">沒填原因　{{ d.noReason }} 筆</span>
      </div>
      <div class="tip mb-3">{{ d.logged ? `共 ${d.total} 筆，修正紀錄會持續保留，工作移除後也能查閱。` : `共 ${d.total} 筆。下次按「確認，開始出片」時會自動保存修正紀錄。` }}</div>
      <table class="list">
        <thead><tr><th>類型</th><th>那一段旁白</th><th>原本</th><th>改成</th><th>AI 當時的判斷</th><th>人給的原因</th></tr></thead>
        <tbody>
          <tr v-for="(r, i) in d.rows" :key="i">
            <td>{{ r.type }}</td><td>{{ r.phrase }}</td>
            <td class="hint">{{ before(r) }}<div v-if="r.systemCell || r.systemWhy" style="margin-top:5px;color:#c98a00">系統原本會框「{{ r.systemCellText || '—' }}」　{{ fmtCell(r.systemCell, r.size) }}（來源：{{ r.systemWhy || '規則判定' }}）</div></td>
            <td class="text-xs">{{ after(r) }}</td>
            <td class="hint">{{ r.autoWhy || '—' }}</td>
            <td class="text-xs" style="color:#c98a00">{{ reason(r) }}</td>
          </tr>
        </tbody>
      </table>
    </template>
  </div>
</template>
