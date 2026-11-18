'use strict';

/**
 * 截圖原始檔名＝出現位置的提示（2026-11-16 使用者定案）—— 純邏輯，測試在 90_系統/測試/截圖檔名提示.test.js。
 *
 * 使用者：「圖片檔名改成腳本文字暗示要出現的位置」「檔名寫旁白裡連續的一小段原文就好，可以辨識就好」。
 *   - 上傳後檔案一律改名 shotN（伺服器排編號），原始檔名另外記在 input/shot-names.json：
 *     { "shot3.png": "外資賣超816億.png" }
 *   - 這裡把原始檔名對到稿件的子句：標點、空白、全半形、大小寫都不計；
 *     對不到原文就容許少量錯字（字元雙連的相似度），但要是唯一最像的那一段才算。
 *   - 一個檔名要涵蓋好幾句：用「_」或「~」隔開頭尾兩段，例「聯發科大漲_日月光強彈.png」。
 *   - 相機編號、螢幕截圖這類檔名本來就對不到任何一段，自然不算提示（照舊全自動）。
 *   - 好幾張圖寫同一段＋結尾編號（2026-11-17「包含創意、欣興、奇鋐1／2／3」）：編號是出場順序，
 *     那段話照順序切給這幾張（splitShared），每張一小段 → 連續短圖會上下疊起來、依序出現。
 *     以前三張都對到同一段，後一張蓋掉前一張，只剩一張。
 *     圖上認得出股名、而且每個股名都在那段話裡 → 照股名在旁白出現的位置放（講到創意才出創意），編號只是退路；
 *     （2026-11-18 使用者：照編號排股票跟旁白對不上。「比唸到早一點出現」在 AppCardShots 的疊卡進場做）
 * units 是 auto-shot.js --sentences 的子句：[{ i, sid, text, startCharIdx, endCharIdx }]。
 */

/** 檔名主體：去副檔名、去「 (1)」「 拷貝」這類系統加的尾巴 */
function stemOf(name) {
  return String(name || '')
    .replace(/^.*[\\/]/, '')
    .replace(/\.[A-Za-z0-9]{2,5}$/, '')
    .replace(/\s*(\(\d+\)|（\d+）|拷貝\s*\d*|副本\s*\d*|copy\s*\d*)$/i, '')
    .trim();
}

/** 比對用的字：全形轉半形、小寫，只留中文、英文、數字 */
function normalize(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{Script=Han}a-z0-9]/gu, '');
}

/** 看起來像不像人寫的提示：要有至少 2 個中文字，或 3 個以上英文字母；純數字（相機編號）不算 */
function looksLikeHint(stem) {
  // 系統自己取的名字：相機／螢幕截圖的前綴拿掉，剩下的是日期時間（數字、at、上午下午）就不是提示
  const t = normalize(stem)
    .replace(/^(img|dsc|pxl|screenshot|screen ?shot|螢幕截圖|螢幕快照|截圖|image|photo|shot|line|messenger)/, '')
    .replace(/at|上午|下午|am|pm/g, '');
  if (/^\d*$/.test(t)) return false;
  return (t.match(/\p{Script=Han}/gu) || []).length >= 2 || (t.match(/[a-z]/g) || []).length >= 3;
}

/** 子句串成一條比對字串，記住每個字屬於哪個子句（units 的陣列位置） */
function indexUnits(units) {
  let all = '';
  const owner = [];
  units.forEach((u, k) => {
    const t = normalize(u.text);
    all += t;
    for (let j = 0; j < t.length; j++) owner.push(k);
  });
  return { all, owner };
}

const bigrams = (s) => {
  const out = new Map();
  for (let i = 0; i + 1 < s.length; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
};
function dice(a, b) {
  const A = bigrams(a); const B = bigrams(b);
  let hit = 0; let total = 0;
  for (const v of A.values()) total += v;
  for (const v of B.values()) total += v;
  for (const [g, v] of A) hit += Math.min(v, B.get(g) || 0);
  return total ? (2 * hit) / total : 0;
}

/** 模糊比對的門檻：雙連字有六成對得上；第二像的要差 0.1 以上，否則算不清楚是哪裡 */
const FUZZY_MIN = 0.6;
const FUZZY_GAP = 0.1;

/**
 * 一段提示字在稿件哪裡。回傳 { from, to, how } | { ambiguous: true } | null。
 * from／to 是 units 的陣列位置。
 */
function locate(part, idx) {
  const p = normalize(part);
  if (p.length < 2) return null;
  const hits = [];
  for (let k = idx.all.indexOf(p); k >= 0; k = idx.all.indexOf(p, k + 1)) hits.push(k);
  if (hits.length === 1) return { from: idx.owner[hits[0]], to: idx.owner[hits[0] + p.length - 1], how: 'exact' };
  if (hits.length > 1) return { ambiguous: true };
  if (p.length < 4) return null;
  // 對不到原文：在稿件上滑一個同長的窗（±1 字），找雙連字最像的那一段
  const scored = [];
  for (const len of [p.length - 1, p.length, p.length + 1]) {
    for (let k = 0; k + len <= idx.all.length; k++) scored.push({ k, len, s: dice(p, idx.all.slice(k, k + len)) });
  }
  scored.sort((a, b) => b.s - a.s);
  const best = scored[0];
  if (!best || best.s < FUZZY_MIN) return null;
  // 跟最佳那段重疊的窗是同一個地方，不算競爭者
  const rival = scored.find((x) => x.k + x.len <= best.k || x.k >= best.k + best.len);
  if (rival && best.s - rival.s < FUZZY_GAP) return { ambiguous: true };
  return { from: idx.owner[best.k], to: idx.owner[best.k + best.len - 1], how: 'fuzzy' };
}

/** 一個提示最多涵蓋幾個子句（跟 Claude 排配圖合併後的上限一樣） */
const MAX_UNITS = 6;

/**
 * 原始檔名 → 提示位置。回傳 { from, to, name, how } 或 { skip: 原因 }。
 *   name  檔名主體（給 Claude 看、也當沒有小標題時的備用）
 */
/** 檔名結尾的出場編號：「…奇鋐3」「…奇鋐_3」「…奇鋐(3)」→ { base, seq: 3 } */
function splitSeq(stem) {
  const m = String(stem).match(/^(.*?)[\s_\-－—#]*[(（]?(\d{1,2})[)）]?$/);
  return m && m[1] && looksLikeHint(m[1]) ? { base: m[1], seq: Number(m[2]) } : null;
}

function hintFor(origName, units) {
  const stem = stemOf(origName);
  if (!looksLikeHint(stem)) return { skip: 'not-hint' };
  const idx = indexUnits(units);
  const whole = locate(stem, idx);
  if (whole && !whole.ambiguous && whole.how === 'exact') return { from: whole.from, to: whole.to, name: stem, how: 'exact' };
  // 整個檔名對不準時，看是不是「原文＋出場編號」—— 去掉編號後對得到，就記下編號
  const sq = splitSeq(stem);
  if (sq) {
    const b = locate(sq.base, idx);
    if (b && !b.ambiguous) return { from: b.from, to: b.to, name: stem, how: b.how, seq: sq.seq };
  }
  if (whole && !whole.ambiguous) return { from: whole.from, to: whole.to, name: stem, how: whole.how };
  // 「頭_尾」：兩段各自找得到，就涵蓋從頭到尾
  const parts = stem.split(/[_~～]+/).map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const a = locate(parts[0], idx);
    const b = locate(parts[parts.length - 1], idx);
    if (a && b && !a.ambiguous && !b.ambiguous && b.to >= a.from && b.to - a.from < MAX_UNITS) {
      return { from: a.from, to: b.to, name: stem, how: a.how === 'exact' && b.how === 'exact' ? 'exact' : 'fuzzy' };
    }
  }
  if (whole && whole.ambiguous) return { skip: 'ambiguous', name: stem };
  return { skip: 'not-found', name: stem };
}

/**
 * 一整批：names＝{ shot3.png: '外資賣超816億.png' } → { hints: { shot3.png: {from,to,name,how} }, notes: [文字說明] }
 * notes 給 log 用：看起來像提示、卻對不到或對到好幾處的檔名要講出來，剪輯師才知道要改檔名。
 */
function resolveHints(names, units, { labels = {} } = {}) {
  const hints = {};
  const notes = [];
  for (const [file, orig] of Object.entries(names || {})) {
    const h = hintFor(orig, units);
    if (h.skip === 'not-hint') continue;
    if (h.skip === 'ambiguous') { notes.push(`${file}（${h.name}）在稿件裡出現不只一次，請多寫幾個字`); continue; }
    if (h.skip) { notes.push(`${file}（${h.name}）在稿件裡找不到，照舊自動配`); continue; }
    if (h.to - h.from + 1 > MAX_UNITS) { notes.push(`${file}（${h.name}）涵蓋太多句，照舊自動配`); continue; }
    hints[file] = h;
  }
  return { hints: splitShared(hints, units, labels), notes };
}

/**
 * 好幾張圖指到同一段話：照出場編號（沒有編號照 shotN 順序）把那段切給它們。
 *   句子夠分 → 一張分幾個子句；不夠分 → 照字數平均切（startCharIdx／endCharIdx）。
 * 切過的提示帶 order（第幾張／共幾張），applyHints 一律照切好的位置放，不沿用 Claude 配的較大範圍。
 *   labels  { file: ['奇鋐', ...] } 圖上的股名（含別名）。整組每張都在那段話裡找得到、位置各不相同 → 照股名位置切；
 *           否則照編號平均切。
 */
function splitShared(hints, units, labels = {}) {
  const groups = new Map();
  for (const [file, h] of Object.entries(hints)) {
    const key = `${h.from}-${h.to}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }
  const out = { ...hints };
  for (const files of groups.values()) {
    if (files.length < 2) continue;
    files.sort((a, b) => ((hints[a].seq ?? 1e9) - (hints[b].seq ?? 1e9)) || a.localeCompare(b, undefined, { numeric: true }));
    const { from, to } = hints[files[0]];
    const m = to - from + 1;
    const k = files.length;
    const a0 = units[from].startCharIdx;
    const b0 = units[to].endCharIdx;
    const byName = placeByName(files, labels, units, from, to);
    if (byName) {
      // 第一張從這段話開頭就出來；後面每張從唸到股名的地方開始
      const starts = byName.map((x, j) => (j === 0 ? a0 : x.start));
      byName.forEach(({ file }, j) => {
        out[file] = { ...hints[file], order: [j + 1, k], group: `${from}-${to}`, by: 'name',
          startCharIdx: starts[j], endCharIdx: j + 1 < k ? starts[j + 1] - 1 : b0 };
      });
      continue;
    }
    files.forEach((f, j) => {
      const part = { ...hints[f], order: [j + 1, k], group: `${from}-${to}` };
      if (m >= k) {
        part.from = from + Math.floor((j * m) / k);
        part.to = from + Math.floor(((j + 1) * m) / k) - 1;
      } else {
        part.startCharIdx = a0 + Math.floor((j * (b0 - a0 + 1)) / k);
        part.endCharIdx = a0 + Math.floor(((j + 1) * (b0 - a0 + 1)) / k) - 1;
        // 子句還是記整段（給 Claude 看的提示用），實際位置看字元
      }
      out[f] = part;
    });
  }
  return out;
}

/**
 * 每張圖的股名在 units[from..to] 第一次出現的位置（清洗後字元索引）。有一張找不到、或兩張撞同一處 → null。
 * 子句的字（原稿）跟字元索引（替換後）長度可能不同，所以位置照子句內的比例換算。
 */
function placeByName(files, labels, units, from, to) {
  const placed = [];
  for (const f of files) {
    const names = (labels[f] || []).map(normalize).filter((x) => x.length >= 2);
    if (!names.length) return null;
    let best = null;
    for (let u = from; u <= to && best == null; u++) {
      const t = normalize(units[u].text);
      for (const nm of names) {
        const k = t.indexOf(nm);
        if (k < 0) continue;
        const len = units[u].endCharIdx - units[u].startCharIdx + 1;
        const pos = units[u].startCharIdx + Math.floor((k / Math.max(1, t.length)) * len);
        if (best == null || pos < best) best = pos;
      }
    }
    if (best == null) return null;
    placed.push({ file: f, start: best });
  }
  placed.sort((a, b) => a.start - b.start);
  for (let j = 1; j < placed.length; j++) if (placed[j].start <= placed[j - 1].start) return null;
  return placed;
}

module.exports = { stemOf, normalize, looksLikeHint, locate, hintFor, resolveHints, splitShared, splitSeq, placeByName, indexUnits, dice };
