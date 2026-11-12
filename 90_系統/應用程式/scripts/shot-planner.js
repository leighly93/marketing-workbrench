'use strict';

/**
 * Claude 排配圖的純邏輯（2026-11-12）—— 不碰檔案、不呼叫服務，測試在 90_系統/測試/Claude排配圖.test.js。
 *
 * 使用者定案（2026-11-12）：「連圖片辨識都由 Claude 來，APP 截圖都像 skill 那樣呈現，先不管人工的設定了」。
 * 第一步（這支）：Claude 看稿件的子句清單＋所有截圖，決定**哪張圖配哪幾個子句**，並給卡片上方的小標題；
 * 同時決定動態小影片放哪（2026-11-12 使用者定案：開頭一段、結尾總結一段，整支不要 3 段）。
 * 第二步（cell-picker.js 的 withCrop）：每段再各問一次要裁哪一塊做卡片、金框框哪裡。
 * 子句的切法與字元索引一律來自 auto-shot.js --sentences，這裡不另切一套。
 */

const SYSTEM_PROMPT =
  '你是財經短影音的剪輯助手：幫每張 APP 截圖找到旁白正在講它的那幾句。只輸出 JSON，不要說明文字，不要 markdown 圍欄。';

/** 截圖上的 OCR 文字摘要，幫它對得上旁白（太長的截掉） */
function ocrSummary(words, max = 160) {
  const t = (Array.isArray(words) ? words : []).map((w) => String(w.t || '').trim()).filter(Boolean).join(' ');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * @param units  [{ i, text, startCharIdx, endCharIdx }]（auto-shot --sentences 的 units）
 * @param images [{ file, label, ocr }]，順序就是附圖的順序
 */
/** 開頭／結尾動態可以挑的子句範圍：前 25%、後 25%（至少各 3 句） */
function motionWindows(units) {
  const n = units.length;
  const k = Math.max(3, Math.ceil(n * 0.25));
  return { head: units.slice(0, Math.min(n, k)), tail: units.slice(Math.max(0, n - k)) };
}

function buildPrompt({ units, images, note = '' }) {
  const win = motionWindows(units);
  const range = (list) => (list.length ? `U${list[0].i}～U${list[list.length - 1].i}` : '（無）');
  return [
    `這支財經短影音附了 ${images.length} 張 APP 截圖（依序是：${images.map((im) => im.label).join('、')}）。`,
    '下面是旁白，切成子句、每句有編號 U：',
    units.map((u) => `U${u.i}：${u.text}`).join('\n'),
    '',
    '每張截圖上 OCR 讀到的字（幫你對照，以圖為準）：',
    images.map((im) => `${im.label}：${im.ocr || '（沒讀到字）'}`).join('\n'),
    '',
    '請決定每張截圖要在旁白講到哪幾句時出現：',
    '1. 只有旁白**正在講圖上的內容**（圖上的數字、個股、指數、表格項目）才配圖；開場、結論、抽象評論、圖上沒有的東西不要配。',
    '2. 一段配 1～4 個連續子句。同一張圖**連續**講好幾項（例：「聯發科大漲、台達電漲停、日月光也強彈」）要合成**一段**，',
    '   title 用總稱（例：「電子股強彈」）—— 影片裡是同一張卡片、金框跟著旁白往下移。中間隔了別的內容才分成兩段。',
    '3. 段落不能重疊，照旁白順序排。沒有適合的句子的截圖可以不用。',
    '4. title 是卡片上方的小標題，2～8 個字，點出這段在看什麼（例：「加權指數」「今日漲停」「台積電貢獻」「量能觀察」），不要整句旁白。',
    '',
    '另外選「動態卡片」（重點整理的動畫字卡，會蓋住整個畫面）的位置：',
    `5. **剛好 2 段：開頭一段、結尾總結一段**，整支不要第 3 段。開頭那段只能在 ${range(win.head)} 裡挑，結尾那段只能在 ${range(win.tail)} 裡挑。`,
    '6. 每段 2～6 個連續子句，挑適合整理成重點的句子（關鍵數字、結論、明天要注意的事），**不能跟上面的截圖段重疊**。',
    '',
    ...(note ? [
      `剪輯師對這支片的指示（優先照做；但動態仍是開頭、結尾各一段，段落不能重疊，格式照下面）：${note}`,
      '',
    ] : []),
    '只輸出 JSON：{"segments":[{"image":"shot1.jpg","from":"U3","to":"U4","title":"加權指數","why":"一句話"}],'
      + '"motions":[{"from":"U0","to":"U2","why":"開頭"},{"from":"U40","to":"U43","why":"結尾總結"}]}',
  ].join('\n');
}

function lastJsonObject(text) {
  return require('./cell-picker').lastJsonObject(text);
}

/**
 * 解析並驗證：圖要存在、子句要存在、from ≤ to、最多 4 句、段落不重疊（重疊的後者丟掉）。
 * 回傳 [{ src, startCharIdx, endCharIdx, title, why }]，照字元位置排序；格式不對回 null。
 */
function parseReply(text, { units, files }) {
  const o = lastJsonObject(text);
  if (!o || !Array.isArray(o.segments)) return null;
  const byId = new Map(units.map((u) => [`U${u.i}`, u]));
  const order = new Map(units.map((u, k) => [`U${u.i}`, k]));
  const fileSet = new Set(files);
  const segs = [];
  for (const s of o.segments) {
    if (!s || !fileSet.has(String(s.image))) continue;
    const from = String(s.from); const to = String(s.to || s.from);
    if (!byId.has(from) || !byId.has(to)) continue;
    let a = order.get(from); let b = order.get(to);
    if (a > b) [a, b] = [b, a];
    if (b - a > 3) b = a + 3;
    const ua = units[a]; const ub = units[b];
    if (ua.startCharIdx == null || ub.endCharIdx == null) continue;
    const title = typeof s.title === 'string' ? s.title.trim().replace(/[「」"]/g, '').slice(0, 10) : '';
    segs.push({
      src: String(s.image),
      startCharIdx: ua.startCharIdx,
      endCharIdx: ub.endCharIdx,
      title,
      why: typeof s.why === 'string' ? s.why.trim().slice(0, 200) : '',
    });
  }
  segs.sort((x, y) => x.startCharIdx - y.startCharIdx);
  const out = [];
  for (const s of segs) {
    const prev = out[out.length - 1];
    if (prev && s.startCharIdx <= prev.endCharIdx) continue;
    out.push(s);
  }
  return mergeSameImage(out, units);
}

/**
 * 同一張圖、中間沒有夾別的子句的相鄰段落併成一段（標題用第一段的）。
 * Claude 有時會把「聯發科、台達電、日月光」拆成三段，影片就會變成同一張圖左右輪播三次；
 * 使用者要的是同一張卡片、金框往下移（2026-11-12）。併完最多 6 個子句。
 */
function mergeSameImage(segs, units) {
  const unitsIn = (a, b) => units.filter((u) => u.startCharIdx >= a && u.endCharIdx <= b).length;
  const out = [];
  for (const s of segs) {
    const prev = out[out.length - 1];
    const between = prev ? units.filter((u) => u.startCharIdx > prev.endCharIdx && u.endCharIdx < s.startCharIdx).length : 1;
    if (prev && prev.src === s.src && between === 0 && unitsIn(prev.startCharIdx, s.endCharIdx) <= 6) {
      prev.endCharIdx = s.endCharIdx;
      continue;
    }
    out.push({ ...s });
  }
  return out;
}

/**
 * 動態卡片的位置：子句要存在、最多 8 句、不能跟截圖段或彼此重疊；超過 2 段只留最前與最後。
 * 回傳 [{ startCharIdx, endCharIdx, why }]，排不出來回空陣列。
 */
function parseMotions(text, { units, segments }) {
  const o = lastJsonObject(text);
  if (!o || !Array.isArray(o.motions)) return [];
  const order = new Map(units.map((u, k) => [`U${u.i}`, k]));
  const taken = (segments || []).map((s) => [s.startCharIdx, s.endCharIdx]);
  const overlaps = (a, b) => taken.some(([x, y]) => !(b < x || a > y));
  const out = [];
  const list = o.motions
    .map((m) => {
      if (!m || !order.has(String(m.from))) return null;
      let a = order.get(String(m.from));
      let b = order.has(String(m.to)) ? order.get(String(m.to)) : a;
      if (a > b) [a, b] = [b, a];
      if (b - a > 7) b = a + 7;
      return { startCharIdx: units[a].startCharIdx, endCharIdx: units[b].endCharIdx,
        why: typeof m.why === 'string' ? m.why.trim().slice(0, 200) : '' };
    })
    .filter((m) => m && m.startCharIdx != null && m.endCharIdx != null)
    .sort((x, y) => x.startCharIdx - y.startCharIdx);
  // 開頭那段要落在前 25% 的子句裡、結尾那段落在後 25%，不在範圍內的不採用
  const win = motionWindows(units);
  const inWin = (m, list) => list.length > 0
    && m.startCharIdx >= list[0].startCharIdx && m.endCharIdx <= list[list.length - 1].endCharIdx;
  for (const m of list) {
    if (overlaps(m.startCharIdx, m.endCharIdx)) continue;
    if (!inWin(m, win.head) && !inWin(m, win.tail)) continue;
    taken.push([m.startCharIdx, m.endCharIdx]);
    out.push(m);
  }
  const head = out.find((m) => inWin(m, win.head));
  const tail = [...out].reverse().find((m) => inWin(m, win.tail) && m !== head);
  return [head, tail].filter(Boolean);
}

module.exports = { SYSTEM_PROMPT, ocrSummary, buildPrompt, parseReply, parseMotions, motionWindows, mergeSameImage };
