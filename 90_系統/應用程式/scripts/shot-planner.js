'use strict';

/**
 * Claude 排配圖的純邏輯（2026-11-12）—— 不碰檔案、不呼叫服務，測試在 90_系統/測試/Claude排配圖.test.js。
 *
 * 使用者定案（2026-11-12）：「連圖片辨識都由 Claude 來，APP 截圖都像 skill 那樣呈現，先不管人工的設定了」。
 * 第一步（這支）：Claude 看稿件的子句清單＋所有截圖，決定**哪張圖配哪幾個子句**，並給卡片上方的小標題。
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
function buildPrompt({ units, images }) {
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
    '2. 一段配 1～3 個連續子句；同一張圖可以出現好幾段（例：一張多檔個股的圖，講到哪一檔就配一段）。',
    '3. 段落不能重疊，照旁白順序排。沒有適合的句子的截圖可以不用。',
    '4. title 是卡片上方的小標題，2～8 個字，點出這段在看什麼（例：「加權指數」「今日漲停」「台積電貢獻」「量能觀察」），不要整句旁白。',
    '',
    '只輸出 JSON：{"segments":[{"image":"shot1.jpg","from":"U3","to":"U4","title":"加權指數","why":"一句話"}]}',
  ].join('\n');
}

function lastJsonObject(text) {
  return require('./cell-picker').lastJsonObject(text);
}

/**
 * 解析並驗證：圖要存在、子句要存在、from ≤ to、最多 3 句、段落不重疊（重疊的後者丟掉）。
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
    if (b - a > 2) b = a + 2;
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
  return out;
}

module.exports = { SYSTEM_PROMPT, ocrSummary, buildPrompt, parseReply };
