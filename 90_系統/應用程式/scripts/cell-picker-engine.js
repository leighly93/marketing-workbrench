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
 *        source='ocr+box'    編號挑到一部分，其餘 OCR 沒讀到的由 Claude 補座標，兩者合併
 *        added               程式自動補進來的編號（漲跌點數＋漲跌幅、▲ 誤讀字，見 cell-picker.js）
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

function pick({ imagePath, words, width, height, phrase, page, withCrop = false }) {
  if (!enabled()) return { status: 'off' };
  if (ENGINE !== 'claude-cli') return { status: 'failed', error: `不認得的 CELL_PICKER：${ENGINE}` };
  // 送給 Claude 的是縮到上限內的圖（claude-cli.js 的 fitSize）；清單座標與它回的 box 都用縮圖尺寸
  const fit = fitSize(width, height);
  const scale = fit.scale;
  const cands = picker.candidates(words, scale);
  const prompt = picker.buildPrompt({ phrase, page, listing: cands.listing, width: fit.width, height: fit.height, withCrop });
  const r = runClaude({ prompt, system: picker.SYSTEM_PROMPT, images: [{ path: imagePath, width, height }] });
  if (!r.ok) return { status: 'failed', error: r.error };
  const reply = picker.parseReply(r.text, cands);
  if (!reply) return { status: 'failed', error: `回覆不是預期的 JSON：${r.text.slice(0, 200)}` };
  // 卡片裁切（withCrop 才有）：一定要包住黃框，見 cell-picker.js 的 fitCrop
  const cropOf = (cell) => (withCrop
    ? { crop: picker.fitCrop(reply.crop ? picker.unscaleBox(reply.crop, scale, width, height) : null, cell, width, height) }
    : {});
  if (reply.none) return { status: 'none', why: reply.why, ...cropOf(null) };
  const extra = reply.box ? picker.unscaleBox(reply.box, scale, width, height) : null;
  if (!reply.ids.length) {
    if (!extra) return { status: 'failed', error: `box 座標不合理：${JSON.stringify(reply.box)}` };
    return { status: 'picked', source: 'claude-box', cell: extra, ids: [], text: '', why: reply.why, verify: 'none', ...cropOf(extra) };
  }
  const ids = picker.expandChange(reply.ids, cands);
  const boxes = ids.map((id) => cands.words.get(id));
  const text = boxes.map((b) => b.t.trim()).join(' ');
  const ocrCell = picker.unionBox(boxes, PAD, width, height);
  const cell = extra ? picker.unionBox([ocrCell, extra], 0, width, height) : ocrCell;
  return {
    ...cropOf(cell),
    status: 'picked',
    // ocr＝全部從編號挑；ocr+box＝編號挑到的再加上 Claude 補的座標（OCR 只讀到一部分）
    source: extra ? 'ocr+box' : 'ocr',
    cell,
    ids,
    added: ids.filter((id) => !reply.ids.includes(id)),
    text,
    why: reply.why,
    verify: picker.numberCheck(text, phrase),
  };
}

/**
 * 卡片版挑框（2026-11-12）：一段一張卡片，金框跟著每一句移動。
 *   steps [{ id: 'U12', text, startCharIdx, endCharIdx }]
 *   → { status: 'picked', crop, stock, steps: [{ id, cell|null, source, text, why }] } | { status: 'failed', error }
 *   stock＝股價卡（裁切左右整張寬、沒框的句子自動框漲跌幅，source='auto-change'）
 * crop 一定包住所有句子的金框（cell-picker.js 的 fitCrop）。
 */
function pickCard({ imagePath, words, width, height, steps, page, note = '' }) {
  if (!enabled()) return { status: 'off' };
  if (ENGINE !== 'claude-cli') return { status: 'failed', error: `不認得的 CELL_PICKER：${ENGINE}` };
  const fit = fitSize(width, height);
  const scale = fit.scale;
  const cands = picker.candidates(words, scale);
  const prompt = picker.buildCardPrompt({ steps, page, listing: cands.listing, width: fit.width, height: fit.height, note });
  const r = runClaude({ prompt, system: picker.SYSTEM_PROMPT, images: [{ path: imagePath, width, height }] });
  if (!r.ok) return { status: 'failed', error: r.error };
  const reply = picker.parseCardReply(r.text, cands, steps.map((x) => x.id));
  if (!reply) return { status: 'failed', error: `回覆不是預期的 JSON：${r.text.slice(0, 200)}` };
  // 股價卡（2026-11-12 使用者定案）：上下照 Claude（股名列～屬性列），左右整張寬；個股被點名一定要框漲跌幅
  const claudeCrop = reply.crop ? picker.unscaleBox(reply.crop, scale, width, height) : null;
  const isStock = reply.stock || picker.looksLikeStockHeader(words || [], claudeCrop, width);
  const stockRegion = isStock && claudeCrop ? picker.stockCrop(claudeCrop, width, words || []) : null;
  const autoChange = () => (stockRegion ? picker.changeCellIn(cands, stockRegion, PAD, width, height) : null);
  const out = steps.map((st) => {
    const one = reply.steps.get(st.id);
    if (!one || one.none) {
      const auto = autoChange();
      if (auto) return { id: st.id, cell: auto.cell, source: 'auto-change', text: auto.text, why: '股價卡：個股被點名就框漲跌幅' };
      return { id: st.id, cell: null, source: null, text: '', why: one ? one.why : '' };
    }
    // 股價卡一律框漲跌幅（Claude 有時框股名、或連股價一起框）；只有這句在講量（總量、量增）才照 Claude 的
    if (stockRegion && !/量/.test(st.text)) {
      const auto = autoChange();
      if (auto) return { id: st.id, cell: auto.cell, source: 'auto-change', text: auto.text, why: one.why };
    }
    const extra = one.box ? picker.unscaleBox(one.box, scale, width, height) : null;
    if (!one.ids.length) return { id: st.id, cell: extra, source: extra ? 'claude-box' : null, text: '', why: one.why };
    const ids = picker.expandChange(one.ids, cands);
    const boxes = ids.map((id) => cands.words.get(id));
    const ocrCell = picker.unionBox(boxes, PAD, width, height);
    return {
      id: st.id,
      cell: extra ? picker.unionBox([ocrCell, extra], 0, width, height) : ocrCell,
      source: extra ? 'ocr+box' : 'ocr',
      text: boxes.map((b) => b.t.trim()).join(' '),
      why: one.why,
    };
  });
  // 卡片要包住每一句的框
  const cells = out.map((x) => x.cell).filter(Boolean);
  const all = cells.length ? picker.unionBox(cells, 0, width, height) : null;
  const crop = picker.fitCrop(stockRegion || (reply.crop ? picker.unscaleBox(reply.crop, scale, width, height) : null), all, width, height);
  return { status: 'picked', crop, stock: !!stockRegion, steps: out, why: reply.why };
}

/**
 * Claude 排配圖第一步（2026-11-12）：所有截圖＋子句清單 → 哪張圖配哪幾句、小標題。
 *   images [{ file, path, width, height, words }]；units 來自 auto-shot --sentences
 *   → { status: 'planned', segments, motions } | { status: 'failed', error } | { status: 'off' }
 *   motions＝動態小影片的位置（開頭一段、結尾一段，不跟截圖段重疊）
 * 跟 pick() 同一個開關（CELL_PICKER=off 就不呼叫）。
 */
function planAssignments({ units, images, note = '' }) {
  if (!enabled()) return { status: 'off' };
  if (ENGINE !== 'claude-cli') return { status: 'failed', error: `不認得的 CELL_PICKER：${ENGINE}` };
  if (!images.length) return { status: 'failed', error: '沒有截圖' };
  if (!units.length) return { status: 'failed', error: '稿件沒有子句' };
  const planner = require('./shot-planner');
  const listed = images.map((im, k) => ({ file: im.file, label: `圖${k + 1}（${im.file}）`, ocr: planner.ocrSummary(im.words) }));
  const prompt = planner.buildPrompt({ units, images: listed, note });
  const r = runClaude({
    prompt,
    system: planner.SYSTEM_PROMPT,
    images: images.map((im) => ({ path: im.path, width: im.width, height: im.height })),
    timeoutMs: 240000,
  });
  if (!r.ok) return { status: 'failed', error: r.error };
  const segments = planner.parseReply(r.text, { units, files: images.map((im) => im.file) });
  if (!segments) return { status: 'failed', error: `回覆不是預期的 JSON：${r.text.slice(0, 200)}` };
  return { status: 'planned', segments, motions: planner.parseMotions(r.text, { units, segments }) };
}

module.exports = { pick, pickCard, planAssignments, enabled, ENGINE };
