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
 *   → { status: 'picked', source, cell, ids, text, why, verify }   挑到了（cell 是原圖像素座標）
 *        source='ocr'        從 OCR 詞框編號挑的（框＝詞框聯集）
 *        source='claude-box' OCR 沒讀到要框的字，Claude 自己給的座標（評估時分開看）
 *   → { status: 'none', why }                             Claude 說這句在圖上找不到／不該框
 *   → { status: 'failed', error }                         沒裝、沒登入、逾時、回覆格式不對
 *   → { status: 'off' }                                   開關關著
 *   一律不丟例外。
 *
 * ── 能力限制 ──────────────────────────────────────────────────
 *   優先從 OCR 讀到的字裡挑；OCR 漏讀時才讓 Claude 自己給座標（source='claude-box'，精度較差）。
 *   模型＝訂閱帳號的預設模型（claude -p 不指定 --model），版本跟著 Claude Code 更新。
 *   每段一次呼叫，約 15～40 秒、16K 上下的 input token（多半是 CLI 本身的固定開銷）。
 */

const { runClaude, fitSize } = require('./claude-cli');
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
  // 送給 Claude 的是縮到上限內的圖（claude-cli.js 的 fitSize）；清單座標與它回的 box 都用縮圖尺寸
  const fit = fitSize(width, height);
  const scale = fit.scale;
  const cands = picker.candidates(words, scale);
  const prompt = picker.buildPrompt({ phrase, page, listing: cands.listing, width: fit.width, height: fit.height });
  const r = runClaude({ prompt, system: picker.SYSTEM_PROMPT, images: [{ path: imagePath, width, height }] });
  if (!r.ok) return { status: 'failed', error: r.error };
  const reply = picker.parseReply(r.text, cands);
  if (!reply) return { status: 'failed', error: `回覆不是預期的 JSON：${r.text.slice(0, 200)}` };
  if (reply.none) return { status: 'none', why: reply.why };
  if (reply.box) {
    const cell = picker.unscaleBox(reply.box, scale, width, height);
    if (!cell) return { status: 'failed', error: `box 座標不合理：${JSON.stringify(reply.box)}` };
    return { status: 'picked', source: 'claude-box', cell, ids: [], text: '', why: reply.why, verify: 'none' };
  }
  const boxes = reply.ids.map((id) => cands.words.get(id));
  const text = boxes.map((b) => b.t.trim()).join(' ');
  return {
    status: 'picked',
    source: 'ocr',
    cell: picker.unionBox(boxes, PAD, width, height),
    ids: reply.ids,
    text,
    why: reply.why,
    verify: picker.numberCheck(text, phrase),
  };
}

module.exports = { pick, enabled, ENGINE };
