// 共用發音詞庫（管理者）。伺服器有兩種「軟擋」會回 400 —— 那不是錯誤，是提醒，按確定就帶 force 再送一次：
//   ① `short: true`  → 原文只有兩個字（台股公司名大多是兩個字，這是最常用的情況）
//   ② `clash: [...]` → 跟詞庫裡現有規則重疊
// ⚠️ 判斷「這是軟擋還是真錯誤」一定要看這兩個欄位，不要比對錯誤訊息的中文（2026-08-21 踩過）。
//    單字（一個字）是硬擋、沒有這兩個欄位，就會照原樣往外丟 —— 那是刻意的。
import { json } from './api.js';

export function isSoftBlock(e) {
  return !!(e && e.data && (e.data.short || (e.data.clash && e.data.clash.length)));
}

export function addDictRule(rule, force) {
  return json('POST', '/api/pronounce', { ...rule, ...(force ? { force: true } : {}) });
}

/** 加一條規則，遇到軟擋就問一次、確定後帶 force 重送。回傳 true = 真的加進去了 */
export async function addDictRuleConfirming(rule) {
  try { await addDictRule(rule, false); }
  catch (e) {
    if (!isSoftBlock(e)) throw e;
    if (!confirm(e.message)) return false;
    await addDictRule(rule, true);
  }
  return true;
}
