'use strict';

/**
 * Claude 挑框的引擎層（2026-11-11）—— 產線唯一的入口，跟 ocr-engine.js／motion-engine.js 同一個模式。
 *
 * 現階段是**旁觀模式**：只在「確認，開始出片」之後於背景跑，結果寫進
 * 90_系統/資料/claude-cells.jsonl 跟人工最後畫的框比對，**不進影片、不進配圖計畫**。
 * 準確率夠了才另外決定要不要讓它出現在配圖計畫頁當建議。
 *
 * ── 開關（.env）────────────────────────────────────────────────
 *   CELL_PICKER 沒設        → claude-cli
 *   CELL_PICKER=claude-cli  → claude -p（訂閱，不需要 API key），附截圖＋OCR 詞框清單
 *   CELL_PICKER=off         → 不呼叫任何服務，伺服器也不會啟動背景比對
 *
 * ── 輸入輸出 ──────────────────────────────────────────────────
 *   pick({ imagePath, words, width, height, phrase, page })
 *     words  OCR 詞框 [{t,x,y,w,h}]（原圖像素、左上原點；app-images.generated.json 的 words）
 *   → { status: 'picked', cell, ids, text, why, verify }   挑到了（cell 是原圖像素座標）
 *   → { status: 'none', why }                             Claude 說這句在圖上找不到／不該框
 *   → { status: 'failed', error }                         沒裝、沒登入、逾時、回覆格式不對
 *   → { status: 'off' }                                   開關關著
 *   一律不丟例外。
 *
 * ── 能力限制 ──────────────────────────────────────────────────
 *   只能從 OCR 讀到的字裡挑：OCR 沒讀到的圖表、色塊框不到。
 *   模型＝訂閱帳號的預設模型（claude -p 不指定 --model），版本跟著 Claude Code 更新。
 *   每段一次呼叫，約 15～40 秒、16K 上下的 input token（多半是 CLI 本身的固定開銷）。
 */

const { runClaude } = require('./claude-cli');
const picker = require('./cell-picker');

const ENGINE = (process.env.CELL_PICKER || 'claude-cli').toLowerCase();
/** 詞框外擴多少 px 當作黃框邊距 */
const PAD = 12;

function enabled() {
  return ENGINE !== 'off';
}

function pick({ imagePath, words, width, height, phrase, page }) {
  if (!enabled()) return { status: 'off' };
  if (ENGINE !== 'claude-cli') return { status: 'failed', error: `不認得的 CELL_PICKER：${ENGINE}` };
  const cands = picker.candidates(words);
  if (!cands.words.size) return { status: 'failed', error: '這張圖沒有 OCR 詞框可以挑' };
  const prompt = picker.buildPrompt({ phrase, page, listing: cands.listing, width, height });
  const r = runClaude({ prompt, system: picker.SYSTEM_PROMPT, images: [imagePath] });
  if (!r.ok) return { status: 'failed', error: r.error };
  const reply = picker.parseReply(r.text, cands);
  if (!reply) return { status: 'failed', error: `回覆不是預期的 JSON：${r.text.slice(0, 200)}` };
  if (reply.none) return { status: 'none', why: reply.why };
  const boxes = reply.ids.map((id) => cands.words.get(id));
  const text = boxes.map((b) => b.t.trim()).join(' ');
  return {
    status: 'picked',
    cell: picker.unionBox(boxes, PAD, width, height),
    ids: reply.ids,
    text,
    why: reply.why,
    verify: picker.numberCheck(text, phrase),
  };
}

module.exports = { pick, enabled, ENGINE };
