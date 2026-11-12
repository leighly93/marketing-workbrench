'use strict';

/**
 * Claude 挑框的純邏輯（2026-11-11）—— 不碰檔案、不呼叫服務，測試在 90_系統/測試/Claude挑框.test.js。
 *
 * 分工（ocr-engine.js 檔頭「VLM 插槽」那段的做法）：
 *   OCR 負責「字在哪」：每個詞框編號 W1、W2…，同一高度的排成一列 R1、R2…
 *   Claude 只負責「這句旁白在講哪幾個」：回傳編號，**不自己報座標**
 *   框＝挑中的詞框聯集再外擴一點；最後用數字比對驗算一次（VLM 會在錯的圖上畫出漂亮的框而不舉手）。
 */

/** 依高度把詞框排成列。中心高度差超過該列字高的 0.6 倍就換一列。 */
function rowsOf(words) {
  const ws = (Array.isArray(words) ? words : [])
    .filter((w) => w && typeof w.t === 'string' && w.t.trim()
      && [w.x, w.y, w.w, w.h].every((n) => typeof n === 'number' && Number.isFinite(n)) && w.w > 0 && w.h > 0)
    .map((w) => ({ ...w, cy: w.y + w.h / 2 }))
    .sort((a, b) => a.cy - b.cy || a.x - b.x);
  const rows = [];
  for (const w of ws) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(w.cy - row.cy) <= 0.6 * Math.max(row.h, w.h)) {
      row.words.push(w);
      row.cy = row.words.reduce((s, x) => s + x.cy, 0) / row.words.length;
      row.h = Math.max(row.h, w.h);
    } else {
      rows.push({ cy: w.cy, h: w.h, words: [w] });
    }
  }
  return rows.map((r) => r.words.sort((a, b) => a.x - b.x));
}

/** 編號：回傳 { words: Map(W編號→詞框), rows: Map(R編號→[W編號]), listing: 給 Claude 看的文字 } */
function candidates(words) {
  const rows = rowsOf(words);
  const byWord = new Map();
  const byRow = new Map();
  const lines = [];
  let n = 0;
  rows.forEach((row, ri) => {
    const rid = `R${ri + 1}`;
    const ids = [];
    const parts = row.map((w) => {
      const id = `W${++n}`;
      byWord.set(id, w);
      ids.push(id);
      return `${id}「${w.t.trim()}」`;
    });
    byRow.set(rid, ids);
    lines.push(`${rid}（y≈${Math.round(row[0].cy)}）：${parts.join(' ')}`);
  });
  return { words: byWord, rows: byRow, listing: lines.join('\n') };
}

const SYSTEM_PROMPT =
  '你是財經短影音的配圖助手：在 APP 截圖上挑出旁白正在講的那一塊。只輸出 JSON，不要說明文字，不要 markdown 圍欄。';

function buildPrompt({ phrase, page, listing, width, height }) {
  return [
    '這是一張 APP 截圖，影片播到下面這句旁白時會顯示它，要用黃框框出旁白正在講的那一塊。',
    '',
    `旁白：「${phrase}」`,
    page && page !== 'unknown' ? `系統判斷的頁面類型：${page}` : '',
    `截圖原尺寸：${width}×${height}`,
    '',
    'OCR 讀到的文字（W 是詞框編號，同一列的字排在同一行，R 是列編號）：',
    listing,
    '',
    '規則：',
    '1. 只能從上面的編號挑，不要自己報座標。可以挑整列（rows）或個別詞框（words），兩者會合併成一個框。',
    '2. 挑旁白**這一句**真正在講的數字或項目（例：講「南亞漲 7.17%」就挑南亞那一列），不要框整頁、不要框頁面標題。',
    '3. 旁白講的東西圖上找不到、或這句只是在講整張圖的大意，就回 none: true，不要硬框。',
    '4. OCR 偶爾讀錯字（例：6.3 讀成 @.3），看圖確認位置就好。',
    '',
    '輸出格式：{"rows":["R3"],"words":["W12"],"why":"一句話說明挑的是什麼","none":false}',
  ].filter((s) => s !== '').join('\n');
}

/** 解析 Claude 的回覆；格式不對回 null。只留下真的存在的編號。 */
function parseReply(text, cands) {
  if (typeof text !== 'string') return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o;
  try { o = JSON.parse(m[0]); } catch (_) { return null; }
  if (!o || typeof o !== 'object') return null;
  const why = typeof o.why === 'string' ? o.why.trim().slice(0, 200) : '';
  if (o.none === true) return { none: true, ids: [], why };
  const ids = new Set();
  for (const r of Array.isArray(o.rows) ? o.rows : []) {
    for (const id of cands.rows.get(String(r)) || []) ids.add(id);
  }
  for (const w of Array.isArray(o.words) ? o.words : []) {
    if (cands.words.has(String(w))) ids.add(String(w));
  }
  if (!ids.size) return { none: true, ids: [], why: why || '回覆的編號都不存在' };
  return { none: false, ids: [...ids], why };
}

/** 挑中的詞框聯集，外擴 pad px，夾在圖內。 */
function unionBox(boxes, pad, width, height) {
  if (!boxes.length) return null;
  let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
  for (const b of boxes) {
    x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h);
  }
  x1 = Math.max(0, Math.floor(x1 - pad)); y1 = Math.max(0, Math.floor(y1 - pad));
  x2 = Math.min(width || Infinity, Math.ceil(x2 + pad)); y2 = Math.min(height || Infinity, Math.ceil(y2 + pad));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** 抓數字（全形轉半形、拿掉千分位）。單一位數太常見，不拿來驗算。 */
function numbersIn(s) {
  const half = String(s || '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[．]/g, '.')
    .replace(/(\d)[,，](?=\d{3})/g, '$1');
  return (half.match(/\d+(?:\.\d+)?/g) || []).filter((n) => n.length >= 2);
}

/**
 * 數字驗算：框裡讀到的數字有沒有出現在旁白裡。
 *   pass ＝至少一個對得上；fail ＝兩邊都有數字但一個都對不上；none ＝有一邊沒有數字，無從驗算。
 * OCR 讀錯的數字（@.3）會讓正確的框也判 fail，所以這裡**只記錄、不擋**，評估時再看。
 */
function numberCheck(boxText, phrase) {
  const a = numbersIn(boxText);
  const b = new Set(numbersIn(phrase));
  if (!a.length || !b.size) return 'none';
  return a.some((n) => b.has(n)) ? 'pass' : 'fail';
}

function iou(a, b) {
  if (!a || !b || !(a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0)) return null;
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? +(inter / uni).toFixed(3) : null;
}

module.exports = {
  SYSTEM_PROMPT, rowsOf, candidates, buildPrompt, parseReply, unionBox, numbersIn, numberCheck, iou,
};
