'use strict';

/**
 * Claude 挑框的純邏輯（2026-11-11）—— 不碰檔案、不呼叫服務，測試在 90_系統/測試/Claude挑框.test.js。
 *
 * 分工（ocr-engine.js 檔頭「VLM 插槽」那段的做法）：
 *   OCR 負責「字在哪」：每個詞框編號 W1、W2…，同一高度的排成一列 R1、R2…
 *   Claude 只負責「這句旁白在講哪幾個」：回傳編號，**不自己報座標**
 *   框＝挑中的詞框聯集再外擴一點；最後用數字比對驗算一次（VLM 會在錯的圖上畫出漂亮的框而不舉手）。
 *
 * 2026-11-12 實測後修正（暴漲近2,000點那支：Claude 都認得旁白在講哪一項，但 3 段框都沒對上）：
 *   ① 它常挑整列 —— 使用者個股漲跌只框漲跌幅；大盤在總覽頁框整張指數小卡、在報價頁只框漲跌那行
 *      （看過 266 個人工框歸納的）
 *      → prompt 寫明這套習慣，清單附上每個詞框的位置，讓它分得出同一列的左右。
 *   ② 人工框裡常常一個 OCR 字都沒有（「聯電漲超過5%」「京元電亮燈漲停」）→ 允許它在 OCR 漏讀時
 *      自己給 box 座標，結果標成 source:'claude-box'，評估時跟 OCR 編號挑出來的分開看。
 *   座標一律用「送給 Claude 的縮圖尺寸」溝通（清單也換算成同一個尺寸），回來再換回原圖像素。
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

/**
 * 編號：回傳 { words: Map(W編號→詞框), rows: Map(R編號→[W編號]), listing: 給 Claude 看的文字 }
 * `scale` 是送給 Claude 的縮圖比例：清單上的座標換算成縮圖尺寸，跟它看到的圖對得上。
 */
function candidates(words, scale = 1) {
  const rows = rowsOf(words);
  const byWord = new Map();
  const byRow = new Map();
  const lines = [];
  const k = (n) => Math.round(n * scale);
  let n = 0;
  rows.forEach((row, ri) => {
    const rid = `R${ri + 1}`;
    const ids = [];
    const parts = row.map((w) => {
      const id = `W${++n}`;
      byWord.set(id, w);
      ids.push(id);
      return `${id}「${w.t.trim()}」x${k(w.x)}`;
    });
    byRow.set(rid, ids);
    lines.push(`${rid}（y≈${k(row[0].cy)}）：${parts.join(' ')}`);
  });
  return { words: byWord, rows: byRow, listing: lines.join('\n') };
}

const SYSTEM_PROMPT =
  '你是財經短影音的配圖助手：在 APP 截圖上挑出旁白正在講的那一塊。只輸出 JSON，不要說明文字，不要 markdown 圍欄。';

function buildPrompt({ phrase, page, listing, width, height, withCrop = false }) {
  return [
    '這是一張 APP 截圖，影片播到下面這句旁白時會顯示它，要用黃框框出旁白正在講的那一塊。',
    '',
    `旁白：「${phrase}」`,
    require('./app-pages').pageLine(page),
    `圖片尺寸：${width}×${height}（下面的座標與你回的 box 都用這個尺寸，左上角是原點）`,
    '',
    'OCR 讀到的文字（W 是詞框編號、x 是左緣位置；同一列的字排在同一行，R 是列編號）：',
    listing || '（OCR 沒讀到任何字）',
    '',
    '這位剪輯師的框法（照這個習慣挑）：',
    '1. 個股漲跌（例「國巨跌1.85%」「聯發科大漲9.88%」）→ **只框漲跌幅那個數字**（例「(-1.85%)」「▲335 (9.88%)」），不框股名、不框整列。',
    '2. 大盤指數（例「加權指數收在41,661點、漲1,960點」）要先看是哪種畫面：',
    '   - 總覽頁：好幾張小卡片並排，加權指數只是其中一張小卡 → 框**整張加權指數小卡**（標題到漲跌幅那一行）。',
    '   - 大盤自己的報價頁：指數是頁面上方的大字 → 跟個股一樣，**只框漲跌點數／漲跌幅那一行**。',
    '3. 營收年增率、買賣超金額這類單一數字 → 只框那個數字（可以連同緊鄰的單位）。',
    '4. 旁白只是點名、圖上沒有對應的單一數字或區塊，或在講整張圖的大意 → 回 none: true，不要硬框。',
    '',
    '怎麼回：',
    '- 優先從編號挑：words 放詞框編號，rows 放整列（只有整列都是要框的東西才用）。',
    '- 要框的字 OCR 沒讀到（清單裡找不到），用 box: [x, y, w, h] 自己給座標。',
    '- 只讀到一部分（例：讀到「100」但下一行的「(4.68%)」清單裡沒有）→ words 挑讀到的部分，box 補上沒讀到的那塊，兩者會合併成一個框。',
    '- OCR 偶爾讀錯字（例：6.3 讀成 @.3），看圖確認位置就好。',
    '',
    ...(withCrop ? [
      '',
      '另外要決定「卡片」：影片不會放整張截圖，只把講到的那一塊 UI 裁出來做成一張卡片。',
      '- crop: [x, y, w, h] 是要裁出來的那一塊：一張完整的小卡、表頭加相關的幾列、或股價區，要包含框的位置，',
      '  上下左右留一點邊、不要切到字；不要整張截圖（除非整張就是那一塊）。',
      '- 這句旁白講到圖上好幾個項目時（例：「聯發科大漲、台達電漲停、日月光也強彈」），crop 要把**講到的每一項都包進去**；',
      '  框（words／box）仍只框最主要的那一個。',
      '- 就算這句不該框（none: true），crop 也要給。',
      '',
      '只輸出 JSON：{"words":["W12"],"rows":[],"box":null,"crop":[0,300,700,420],"why":"一句話說明框的是什麼","none":false}',
    ] : [
      '只輸出 JSON：{"words":["W12"],"rows":[],"box":null,"why":"一句話說明框的是什麼","none":false}',
    ]),
  ].filter((s) => s !== '').join('\n');
}

/**
 * 從回覆裡取**最後一個**解析得了的 JSON 物件。
 * 2026-11-12 實測：它會先回一份 JSON、接著寫「Wait — …」再改一份，整段當 JSON 解析就失敗。
 */
function lastJsonObject(text) {
  if (typeof text !== 'string') return null;
  let found = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0; let inStr = false; let esc = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try {
          const o = JSON.parse(text.slice(i, j + 1));
          if (o && typeof o === 'object' && !Array.isArray(o)) found = o;
        } catch (_) { /* 不是完整 JSON，往後找 */ }
        i = j;
        break;
      }
    }
  }
  return found;
}

/**
 * 解析 Claude 的回覆；格式不對回 null。只留下真的存在的編號。
 * 沒挑到編號但給了 box（縮圖座標）→ 回 { box }，由呼叫端換回原圖像素。
 */
function parseReply(text, cands) {
  const o = lastJsonObject(text);
  if (!o) return null;
  const why = typeof o.why === 'string' ? o.why.trim().slice(0, 200) : '';
  const c = Array.isArray(o.crop) ? o.crop.map(Number) : null;
  const crop = c && c.length === 4 && c.every(Number.isFinite) && c[2] > 0 && c[3] > 0
    ? { x: c[0], y: c[1], w: c[2], h: c[3] } : null;
  const withCrop = (r) => (crop ? { ...r, crop } : r);
  if (o.none === true) return withCrop({ none: true, ids: [], why });
  const ids = new Set();
  for (const r of Array.isArray(o.rows) ? o.rows : []) {
    for (const id of cands.rows.get(String(r)) || []) ids.add(id);
  }
  for (const w of Array.isArray(o.words) ? o.words : []) {
    if (cands.words.has(String(w))) ids.add(String(w));
  }
  const b = Array.isArray(o.box) ? o.box.map(Number) : null;
  const box = b && b.length === 4 && b.every(Number.isFinite) && b[2] > 0 && b[3] > 0
    ? { x: b[0], y: b[1], w: b[2], h: b[3] } : null;
  if (ids.size && box) return withCrop({ none: false, ids: [...ids], box, why });
  if (ids.size) return withCrop({ none: false, ids: [...ids], why });
  if (box) return withCrop({ none: false, ids: [], box, why });
  return withCrop({ none: true, ids: [], why: why || '回覆的編號都不存在' });
}

/** 縮圖座標換回原圖像素，夾在圖內 */
function unscaleBox(b, scale, width, height) {
  const x = Math.max(0, Math.round(b.x / scale));
  const y = Math.max(0, Math.round(b.y / scale));
  const w = Math.min(width - x, Math.round(b.w / scale));
  const h = Math.min(height - y, Math.round(b.h / scale));
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/**
 * 漲跌組自動補齊（2026-11-12 實測：Claude 只挑到「▲335」沒挑到下一行的「(9.88%)」）。
 * APP 的漲跌點數與漲跌幅是上下兩行，OCR 會分成兩列；▲ 常被讀成「人」「A」而且跟數字分開。
 *   ① 挑到漲跌點數 → 正下方（或正上方）的漲跌幅一起框；反過來也一樣
 *   ② 挑到的數字左邊緊鄰一個 ▲／▼（或誤讀的「人」「A」）→ 一起框
 * OCR 根本沒讀到的那一行補不到 —— 那要靠 Claude 回 box（見 buildPrompt）。
 */
const PCT_RE = /^\(?[+\-−]?\d[\d.,]*%\)?$/;
// ▼ 常被 OCR 讀成 Y／V（「Y-270」「v-55」），後面一定跟著正負號才算
const CHG_RE = /^(?:[▲▼△▽+\-−A人]|[YVvy][+\-−])?\d[\d.,]*$/;
const ARROW_RE = /^[▲▼△▽A人]$/;

function expandChange(ids, cands) {
  const all = [...cands.words.entries()];
  const out = new Set(ids);
  const kind = (t) => (PCT_RE.test(t) ? 'pct' : CHG_RE.test(t) ? 'chg' : null);
  for (const id of ids) {
    const w = cands.words.get(id);
    const t = w.t.trim();
    const k = kind(t);
    for (const [oid, o] of all) {
      if (out.has(oid)) continue;
      const ot = o.t.trim();
      const ok = kind(ot);
      const overlapX = Math.min(w.x + w.w, o.x + o.w) - Math.max(w.x, o.x);
      const gapY = Math.max(o.y - (w.y + w.h), w.y - (o.y + o.h));
      const h = Math.max(w.h, o.h);
      // ① 上下疊的漲跌點數＋漲跌幅
      if (k && ok && k !== ok && overlapX >= 0.4 * Math.min(w.w, o.w) && gapY <= 1.0 * h) out.add(oid);
      // ② 左邊緊鄰的箭頭（同一列、間隔不到半個字高）
      const sameRow = Math.abs((o.y + o.h / 2) - (w.y + w.h / 2)) <= 0.6 * h;
      const gapX = w.x - (o.x + o.w);
      if (k && ARROW_RE.test(ot) && sameRow && gapX >= -2 && gapX <= 0.5 * h) out.add(oid);
    }
  }
  return [...out];
}

/**
 * 卡片裁切範圍收尾：一定要包住黃框（外加 pad）、不能太扁太小、夾在圖內。
 * crop 給不出來就退回「以黃框為中心、寬度整張」的一塊；連黃框都沒有就整張。
 */
function fitCrop(crop, cell, width, height, pad = 24) {
  let c = crop ? { ...crop } : null;
  if (!c && cell) c = { x: 0, y: cell.y - cell.h * 1.5, w: width, h: cell.h * 4 };
  if (!c) return { x: 0, y: 0, w: width, h: height };
  if (cell) {
    const x1 = Math.min(c.x, cell.x - pad); const y1 = Math.min(c.y, cell.y - pad);
    const x2 = Math.max(c.x + c.w, cell.x + cell.w + pad); const y2 = Math.max(c.y + c.h, cell.y + cell.h + pad);
    c = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  const minH = Math.min(height, Math.round(width * 0.18));
  if (c.h < minH) { c.y -= (minH - c.h) / 2; c.h = minH; }
  const x = Math.max(0, Math.round(c.x)); const y = Math.max(0, Math.round(c.y));
  return { x, y, w: Math.min(width - x, Math.round(c.w + (c.x - x))), h: Math.min(height - y, Math.round(c.h + (c.y - y))) };
}

/**
 * 卡片版（2026-11-12 使用者定案，之後固定這樣呈現）：一段配一張卡片，卡片裁切整段共用，
 * **金框跟著每一句往下移**（「聯發科大漲」框聯發科、下一句「台達電漲停」框台達電）。
 * 一次問完整段：crop ＋ 每一句（U 編號）各自框哪裡。
 * @param steps [{ id: 'U12', text: '聯發科大漲9.88%' }]
 */
function buildCardPrompt({ steps, page, listing, width, height, note = '' }) {
  return [
    '這是一張 APP 截圖。影片會把講到的那一塊 UI 裁出來做成一張卡片，旁白一句一句講，金框跟著每一句移到它講的地方。',
    '',
    '這段旁白（依序）：',
    steps.map((s) => `${s.id}：${s.text}`).join('\n'),
    require('./app-pages').pageLine(page),
    `圖片尺寸：${width}×${height}（下面的座標與你回的 crop／box 都用這個尺寸，左上角是原點）`,
    '',
    'OCR 讀到的文字（W 是詞框編號、x 是左緣位置；同一列的字排在同一行，R 是列編號）：',
    listing || '（OCR 沒讀到任何字）',
    '',
    '卡片（crop: [x, y, w, h]）：',
    '- 只裁這段講到的那一塊 UI（完整的小卡、表頭加相關的幾列、股價區），要包含每一句要框的地方，留一點邊、不要切到字；不要整張截圖（除非整張就是那一塊）。',
    '- 講大盤指數（加權指數、櫃買指數的點數與漲跌）時，**上方的走勢圖（K 線／分時圖）也要一起包進去**，畫面比較好看。',
    // 2026-11-12 使用者：「台積電顯示的畫面很怪，應該要顯示股價吧，怎麼圈在大戶散戶那」；
    // 同日再定案範圍：「之後遇到要框選股價的，都以大立光截圖那樣框選，不要出現其他多餘區域」（緯創的股名被切掉、欣興沒框）。
    '- **個股頁**：旁白只是講到這檔股票（點名、漲跌、「撐不住」「重挫」「漲停」這類走勢）→ 卡片＝**股價區**，回 "stock": true。',
    '  範圍固定：上緣從「返回鍵／股名代號」那一列開始（**股名代號一定要露出來**，例「大立光 3008」與下面那行產業），',
    '  下緣到「屬性」那一列（股價、漲跌、總量、屬性標籤）為止。不要狀態列（時間、電量），不要「上市・…」標籤列、',
    '  「可當沖」那列、分頁列、下方走勢圖、大戶散戶、主力、法人、籌碼等區塊。',
    '  只有旁白**明講某個區塊的內容**（例「大戶賣超 2250 張」「外資連 3 天買超」）才裁那個區塊、框那個數字，這時 "stock": false。',
    '',
    '每一句的金框（steps，每個 U 一筆，照順序）：',
    '- 個股漲跌只框漲跌幅那個數字（例「▲335 (9.88%)」），不框股名、不框整列。',
    '- 大盤指數在總覽頁框整張指數小卡；在大盤自己的報價頁只框漲跌那一行。單一數字只框數字。',
    '- 這一句講的是下一檔／下一個項目，框就移到那一項（例：「台達電漲停」框台達電的漲跌幅）。',
    '- 個股被點名（例「就連大哥台積電」「聯發科都撐不住」「欣興等 PCB 族群更是重災區」）算有講到它：框它的漲跌幅（點數＋百分比）。',
    '- 圖上沒有對應的東西（開場、評論、圖上沒有的項目）→ none: true。',
    '- 優先從編號挑（words／rows）；OCR 沒讀到的部分才用 box: [x, y, w, h] 補，兩者會合併。',
    '',
    ...(note ? [`剪輯師對這支片的指示（跟這張圖有關才照做）：${note}`, ''] : []),
    '只輸出 JSON：{"crop":[0,120,1206,300],"stock":false,"steps":[{"unit":"U12","words":["W7"],"rows":[],"box":null,"none":false}],"why":"一句話"}',
  ].filter((x) => x !== '').join('\n');
}

/** 解析卡片版回覆：{ crop, steps: Map(U編號 → { ids, box, none }) , why }；格式不對回 null */
function parseCardReply(text, cands, stepIds) {
  const o = lastJsonObject(text);
  if (!o) return null;
  const c = Array.isArray(o.crop) ? o.crop.map(Number) : null;
  const crop = c && c.length === 4 && c.every(Number.isFinite) && c[2] > 0 && c[3] > 0
    ? { x: c[0], y: c[1], w: c[2], h: c[3] } : null;
  const steps = new Map();
  for (const st of Array.isArray(o.steps) ? o.steps : []) {
    if (!st || !stepIds.includes(String(st.unit))) continue;
    const one = parseReply(JSON.stringify({ ...st, crop: undefined }), cands);
    if (one) steps.set(String(st.unit), one);
  }
  return { crop, stock: o.stock === true, steps, why: typeof o.why === 'string' ? o.why.trim().slice(0, 200) : '' };
}

/**
 * 股價卡的裁切（2026-11-12 使用者給的大立光範例）：左右整張寬（返回鍵、下單鈕都在），
 * 上緣＝股名代號那列（「大立光 3008」，不含狀態列），下緣＝「屬性」那列為止（不含「上市・…」標籤列）。
 * Claude 給的上下緣常常多一列少一列，所以用 OCR 對齊（APP 畫面固定，這些位置每張都一樣）：
 *   ① 股名代號：crop 範圍附近、靠中間、含 4 位數字的最上面那個詞 → 上緣在它上方 0.9 個字高（再高會露出狀態列）
 *   ② 標籤列：代號下方超過 5 個字高、貼左邊（x < 寬 5%）的第一個詞（「上市」）→ 下緣停在那列上方
 *   下緣再用「總量」那列往下 3.4 個字高壓住（標籤列 OCR 漏讀時會抓到下一列）；都對不到就退回 Claude 的上下緣。
 */
function stockCodeWord(words, crop, width) {
  // 股名代號一定在「總量」那列上面（聯發科那張 OCR 漏了股名列，總量「5608」差點被當成代號）
  const vol = words.filter((w) => /總/.test(w.t) && w.y >= crop.y - 60 && w.y <= crop.y + crop.h).sort((a, b) => a.y - b.y)[0];
  return words
    .filter((w) => /\d{4}/.test(w.t) && w.y >= crop.y - 60 && w.y <= crop.y + crop.h
      && (!vol || w.y + w.h <= vol.y + 2)
      && w.x + w.w / 2 > width * 0.25 && w.x + w.w / 2 < width * 0.75)
    .sort((a, b) => a.y - b.y)[0] || null;
}

function stockCrop(crop, width, words = []) {
  if (!crop) return null;
  let top = crop.y;
  let bottom = crop.y + crop.h;
  const code = stockCodeWord(words, crop, width);
  const vol = words.filter((w) => /總/.test(w.t) && w.y >= crop.y - 60 && w.y <= crop.y + crop.h).sort((a, b) => a.y - b.y)[0];
  if (code) {
    top = Math.max(0, Math.round(code.y - 0.9 * code.h));
    const tag = words
      .filter((w) => w.x < width * 0.05 && w.y > code.y + 5 * code.h && w.y < code.y + 14 * code.h)
      .sort((a, b) => a.y - b.y)[0];
    // 「上市」那列 OCR 也可能漏（和益），抓到的會是下一列「可當沖」→ 再用總量那列往下 3.4 個字高壓住
    if (tag) bottom = Math.round(tag.y - 0.5 * code.h);
    if (vol) bottom = Math.min(tag ? bottom : Infinity, Math.round(vol.y + 3.4 * vol.h));
  } else if (vol) {
    bottom = Math.min(bottom, Math.round(vol.y + 3.2 * vol.h));
  }
  return { x: 0, y: top, w: width, h: Math.max(1, bottom - top) };
}

/** Claude 的裁切有包到股名代號那列 → 就是股價卡（不只靠它回 stock: true；它偶爾會漏） */
function looksLikeStockHeader(words, crop, width) {
  if (!crop) return false;
  const code = stockCodeWord(words, crop, width);
  return !!code && code.y >= crop.y - 10 && code.y < width * 0.4;
}

/**
 * 股價卡上的漲跌框（點數＋百分比）。個股被點名一定要框（使用者：「欣興也是，都框選吧」），
 * Claude 回 none、框到股名或連股價一起框時都用這個。
 *   ① crop 範圍內最上面那個有括號的百分比「(4.32%)」→ expandChange 補上面的點數與箭頭
 *   ② OCR 常漏讀百分比，只讀到點數（「A9.0」「v-15」「Y-65」）→ 從點數往下延伸，把正下方那行百分比包進來
 *      （股價區版面固定：百分比在點數正下方，寬約 1.35 倍（至少 5.2 個字高寬，「9.0」這種短點數才包得住「(5.00%)」）、兩行合起來約 3 個字高）
 * 回 { cell, text }（原圖像素，已外擴 pad），找不到回 null。
 */
const SIGNED_CHG_RE = /^(?:[▲▼△▽A人]|[YVvy]?[+\-−])\d[\d.,]*$/;
function changeCellIn(cands, crop, pad, width, height) {
  const inside = (w) => !crop || (w.y + w.h / 2 >= crop.y && w.y + w.h / 2 <= crop.y + crop.h);
  const all = [...cands.words.entries()].filter(([, w]) => inside(w));
  const pct = all.filter(([, w]) => PCT_RE.test(w.t.trim()) && /\(/.test(w.t)).sort((a, b) => a[1].y - b[1].y)[0];
  if (pct) {
    const boxes = expandChange([pct[0]], cands).map((id) => cands.words.get(id));
    // OCR 沒讀到上面那行點數（鴻海「▲2.0」）→ 往上長一行把它包進來
    if (!boxes.some((b) => CHG_RE.test(b.t.trim()))) {
      const p = pct[1];
      boxes.push({ t: '', x: p.x, y: Math.round(p.y - 1.15 * p.h), w: p.w, h: p.h });
    }
    return { cell: unionBox(boxes, pad, width, height), text: boxes.map((b) => b.t.trim()).filter(Boolean).join(' ') };
  }
  const chg = all.filter(([, w]) => SIGNED_CHG_RE.test(w.t.trim())).sort((a, b) => a[1].y - b[1].y)[0];
  if (!chg) {
    // ③ 點數跟百分比都讀壞了（台郡「(9.969」）→ APP 版面固定，照股名代號那列推漲跌欄的位置
    //   （從其他張量的：x 在寬 27%～43%，y 從代號下方 4 個字高起、高 3.8 個字高）
    const code = crop ? stockCodeWord([...cands.words.values()], crop, width) : null;
    if (!code) return null;
    const cell = { x: Math.round(width * 0.272), y: Math.round(code.y + 3.96 * code.h), w: Math.round(width * 0.16), h: Math.round(3.83 * code.h) };
    return { cell, text: '' };
  }
  const w = chg[1];
  const grown = { x: w.x, y: w.y, w: Math.round(Math.max(w.w * 1.35, w.h * 5.2)), h: Math.round(w.h * 2.95) };
  return { cell: unionBox([grown], pad, width, height), text: w.t.trim() };
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
  lastJsonObject,
  SYSTEM_PROMPT, rowsOf, candidates, buildPrompt, parseReply, buildCardPrompt, parseCardReply, expandChange, fitCrop, stockCrop, looksLikeStockHeader, changeCellIn, unscaleBox, unionBox, numbersIn, numberCheck, iou,
};
