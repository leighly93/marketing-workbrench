// 框選編輯器的狀態（全頁只有一個編輯器，由 App.vue 掛在 body 上）。
// 開啟時傳進一份「要編的東西」的副本，按完成才透過 onDone 回寫；取消就丟掉。
import { reactive, ref } from 'vue';
import { ARROW_DEFAULT } from '../lib/arrows.js';

export const editorOpen = ref(false);

/**
 * ctx 的欄位：
 *   job、images（縮圖列）、title、mode: 'annot'|'shot'、arrowAllowed
 *   src、region、cell、arrow、arrowColor、from、to（字元範圍）、natW、natH
 *   chars、units、charSec、usedRanges（別的段落佔了哪些字，畫底線與「會蓋掉誰」）
 *   onDone(result)：result = { src, region, cell, arrow, startCharIdx, endCharIdx, imgW, imgH }
 */
export const ed = reactive({ ctx: null });

export function openEditor(ctx) {
  ed.ctx = {
    mode2: ctx.mode === 'annot' ? 'region' : 'cell',
    drag: null, natW: null, natH: null, note: '',
    arrowColor: (ctx.arrow && ctx.arrow.color) || ARROW_DEFAULT,
    ...ctx,
    region: ctx.region ? { ...ctx.region } : null,
    cell: ctx.cell ? { ...ctx.cell } : null,
    arrow: ctx.arrow ? { ...ctx.arrow } : null,
  };
  if (!ed.ctx.arrowAllowed) ed.ctx.arrow = null;
  editorOpen.value = true;
}

export function closeEditor() {
  editorOpen.value = false;
  ed.ctx = null;
}
