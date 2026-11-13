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
    '"image" 請照抄上面括號裡的檔名（含副檔名）。',
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
    '另外選「補充字卡」（講者畫面上、字幕正上方跳出的小數字卡，例：「外資賣超 816億｜投信買超 88.7億」）：',
    '7. 只放在**沒有配截圖、也不在動態卡片裡**的子句；旁白講到具體的「主詞＋數字」（法人買賣超、漲跌幅、家數、成交金額…）才放。整支 0～3 張，寧少勿多。',
    '8. 每張 1～2 項，每項 label 是主詞（2～6 字，例「外資賣超」「上漲家數」），value 是數字加單位（例「816億」「3.6倍」「-5.4%」），**數字一定要照旁白原文**，不能自己算或換單位。',
    '9. tone：漲、買超、增加 → "up"（紅）；跌、賣超、減少、虧損 → "down"（綠）；其他 → "gold"。from／to 指出那句話的子句範圍（1～3 句）。',
    '',
    ...(note ? [
      `剪輯師對這支片的指示（優先照做；但動態仍是開頭、結尾各一段，段落不能重疊，格式照下面）：${note}`,
      '',
    ] : []),
    // 範例的檔名用這支實際的第一張圖：寫死 shot1.jpg 時，素材是 .png 的那支 Claude 照抄 .jpg，整批對不上（2026-11-12 7eov）
    `只輸出 JSON：{"segments":[{"image":${JSON.stringify((images[0] && images[0].file) || 'shot1.png')},"from":"U3","to":"U4","title":"加權指數","why":"一句話"}],`
      + '"motions":[{"from":"U0","to":"U2","why":"開頭"},{"from":"U40","to":"U43","why":"結尾總結"}],'
      + '"facts":[{"from":"U20","to":"U21","items":[{"label":"外資賣超","value":"816億","tone":"down"},{"label":"投信買超","value":"88.7億","tone":"up"}]}]}',
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
  const segs = [];
  for (const s of o.segments) {
    const image = s ? resolveImage(s.image, files) : null;
    if (!image) continue;
    const from = String(s.from); const to = String(s.to || s.from);
    if (!byId.has(from) || !byId.has(to)) continue;
    let a = order.get(from); let b = order.get(to);
    if (a > b) [a, b] = [b, a];
    if (b - a > 3) b = a + 3;
    const ua = units[a]; const ub = units[b];
    if (ua.startCharIdx == null || ub.endCharIdx == null) continue;
    const title = typeof s.title === 'string' ? s.title.trim().replace(/[「」"]/g, '').slice(0, 10) : '';
    segs.push({
      src: image,
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
 * Claude 回的圖名 → 實際檔名。先比完整檔名；對不上就比去掉副檔名（shot1.jpg ↔ shot1.png，大小寫不計）；
 * 再不行就認「圖2」這種編號（files 的順序就是附圖順序）。都對不上回 null。
 * 2026-11-12 7eov：Claude 照抄 prompt 範例回 shot1.jpg，實際是 shot1.png，整支被判成「沒有句子適合配圖」。
 */
function resolveImage(name, files) {
  const raw = String(name || '').trim();
  if (!raw) return null;
  if (files.includes(raw)) return raw;
  const stem = (f) => String(f).replace(/\.[A-Za-z0-9]+$/, '').toLowerCase();
  const byStem = files.filter((f) => stem(f) === stem(raw));
  if (byStem.length === 1) return byStem[0];
  const m = raw.match(/^圖\s*(\d+)/);
  if (m && files[Number(m[1]) - 1]) return files[Number(m[1]) - 1];
  return null;
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

/**
 * 補充字卡（2026-11-13 使用者選定，cmoney-ad-subtitles skill 的「補充數字字卡」）：
 * 講者畫面、字幕正上方的小數字卡，只放在沒配截圖、也沒動態的句子。
 * 驗證：子句要存在、最多 3 句；不能跟截圖段、動態段或彼此重疊；每項 label 2～6 字、value 要有數字，
 * 而且 value 裡的數字（去掉逗號）一定要出現在那幾句旁白裡 —— 財經影片放錯數字比少一張卡嚴重。
 * 整支最多 3 張。回傳 [{ startCharIdx, endCharIdx, items: [{ label, value, tone }] }]。
 *   taken：[{ startCharIdx, endCharIdx }]（最終的截圖段＋動態段）
 */
const FACT_TONES = ['up', 'down', 'gold'];
function parseFacts(text, { units, taken = [] }) {
  const o = lastJsonObject(text);
  if (!o || !Array.isArray(o.facts)) return [];
  const order = new Map(units.map((u, k) => [`U${u.i}`, k]));
  const busy = taken.map((t) => [t.startCharIdx, t.endCharIdx]);
  const overlaps = (a, b) => busy.some(([x, y]) => !(b < x || a > y));
  const digits = (str) => String(str).replace(/[,，\s]/g, '');
  const out = [];
  const cands = o.facts.map((f) => {
    if (!f || !order.has(String(f.from))) return null;
    let a = order.get(String(f.from));
    let b = order.has(String(f.to)) ? order.get(String(f.to)) : a;
    if (a > b) [a, b] = [b, a];
    if (b - a > 2) return null;
    const said = digits(units.slice(a, b + 1).map((u) => u.text).join(''));
    const items = (Array.isArray(f.items) ? f.items : []).slice(0, 2).map((it) => {
      const label = String((it && it.label) || '').trim();
      const value = String((it && it.value) || '').trim();
      const nums = value.match(/\d[\d,]*(?:\.\d+)?/g) || [];
      if ([...label].length < 2 || [...label].length > 6 || !value || [...value].length > 9 || !nums.length) return null;
      if (!nums.every((n) => said.includes(digits(n)))) return null;
      return { label, value, tone: FACT_TONES.includes(it.tone) ? it.tone : 'gold' };
    });
    if (!items.length || items.some((x) => !x)) return null;
    return { startCharIdx: units[a].startCharIdx, endCharIdx: units[b].endCharIdx, items };
  }).filter((f) => f && f.startCharIdx != null && f.endCharIdx != null)
    .sort((x, y) => x.startCharIdx - y.startCharIdx);
  for (const f of cands) {
    if (out.length >= 3 || overlaps(f.startCharIdx, f.endCharIdx)) continue;
    busy.push([f.startCharIdx, f.endCharIdx]);
    out.push(f);
  }
  return out;
}

/**
 * 句子最後一張圖留到句子講完（2026-11-12 使用者：「有的圖出現一秒不到就沒了，如果是這段落連續出現圖片後的
 * 最後一張圖，可以讓他多出現到後面句子講完嗎」）。
 * 例：「台郡、和益、德淵，逆勢飆漲停！」Claude 只配到「德淵」兩個字（0.3 秒）→ 德淵那張延到「漲停」講完。
 * 規則：一筆的下一筆（照字元位置）不在同一句（sid 不同）或沒有下一筆 → 結尾延到這句最後一個字；
 * 不跨進下一筆、也不跨進動態卡片。同一句後面還有圖的不延（輪播中間那幾張照旁白換）。
 *   shots   [{ startCharIdx, endCharIdx, ... }]（會複製，不改原物件）
 *   units   auto-shot --sentences 的 units（要有 sid）
 *   motions [{ startCharIdx, endCharIdx }]
 */
function extendToSentenceEnd(shots, units, motions = []) {
  const sorted = [...shots].map((s) => ({ ...s })).sort((a, b) => a.startCharIdx - b.startCharIdx || a.endCharIdx - b.endCharIdx);
  const unitAt = (idx) => units.find((u) => u.startCharIdx <= idx && idx <= u.endCharIdx);
  const sentenceEnd = (sid) => Math.max(...units.filter((u) => u.sid === sid).map((u) => u.endCharIdx));
  for (let k = 0; k < sorted.length; k++) {
    const s = sorted[k];
    const u = unitAt(s.endCharIdx);
    if (!u || u.sid == null) continue;
    const next = sorted[k + 1];
    const nu = next ? unitAt(next.startCharIdx) : null;
    if (nu && nu.sid === u.sid) continue;
    let end = sentenceEnd(u.sid);
    if (next) end = Math.min(end, next.startCharIdx - 1);
    for (const m of motions) if (m.startCharIdx > s.endCharIdx) end = Math.min(end, m.startCharIdx - 1);
    if (end > s.endCharIdx) s.endCharIdx = end;
  }
  return sorted;
}

module.exports = { SYSTEM_PROMPT, ocrSummary, buildPrompt, parseReply, resolveImage, parseMotions, parseFacts, motionWindows, mergeSameImage, extendToSentenceEnd };
