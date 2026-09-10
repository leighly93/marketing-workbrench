/**
 * script.txt 共用清洗工具
 *
 * 對 parse-script.js（算 overlay 的 char-index anchor）與 correct-subtitles.js
 * （字幕 forced alignment 對齊）共用同一套清洗邏輯，避免兩邊定義漂走。
 *
 * 兩邊都在 bodyAfterVoice（內文段套完發音替換的字串）上工作；
 * cleanBodyWithIndex 會把每個 cleaned char 對應的 bodyAfterVoice 原始 index 帶回，
 * 讓 parse-script 能用 (imageN) 標記的 body 位置反查 cleaned 位置。
 */

// 2026-08-10 使用者要求：只在「全形」標點（＋換行）斷句；半形不斷句，且數字裡的半形要保留顯示。
//   - BREAK_RE（斷句＋不顯示）：只留全形 ，。、！？：； 與換行 \n。
//   - 數字用的半形 , . %（44,396 / 1.95%）：兩者都不列入下面任何一組 → 會被「保留成一般字元」，
//     既會顯示在字幕上（字幕文字是從對齊到的腳本字元重建的），又因為不在 BREAK_RE 而不會斷行。
//   - OTHER_PUNCT_RE（略過、不顯示、不斷句）：引號/括號/半形 ! ? : ; 與 ／/ 等，維持濾掉。
// 註：半形 , . % 現在會進入 cleaned chars。Whisper 端（correct-subtitles 的 PUNCT_RE）仍會濾掉它們，
//     對齊時它們成為 scriptExtra、由相鄰 word 收納 → 顯示得出、又不破壞 forced alignment。
const BREAK_RE = /[，。、！？：；\n]/;
const OTHER_PUNCT_RE = /[「」『』"'""''【】〔〕（）()\[\]!?:;／/]/;

function parseVoiceRules(scriptRaw) {
  const rules = [];
  const parts = scriptRaw.split('===');
  if (parts.length < 2) return rules;
  for (const line of parts[0].split('\n')) {
    const m = line.match(/^([^#→\n][^→]*)→(.+)$/);
    if (m) rules.push({ from: m[1].trim(), to: m[2].trim() });
  }
  return rules;
}

/**
 * 套用發音替換：由左到右掃一次，每個位置取「對得上的最長規則」，換過的地方不再被掃。
 *
 * ⚠️ 2026-08-19 改掉原本的「逐條 split/join」寫法。舊寫法會讓**前一條規則的產出被後一條再取代一次**：
 *     規則：南亞科技股份→南亞科技股份有限、南亞科→南亞ㄎㄜ
 *     內文：南亞科技股份公司
 *     舊結果：南亞ㄎㄜ技股份有限公司   ← 第二條打中了第一條的產出
 * 規則只有兩三條時碰不到，但 2026-08-19 開始有「共用發音詞庫」（前台可累積幾十條），
 * 這種互相打架會變成常態，而且是靜默的 —— 沒人看得出來影片為什麼唸怪。
 * 規則之間沒有重疊時，本函式與舊寫法輸出完全相同（已用專案現有腳本比對驗證）。
 */
function applyVoiceRulesForward(text, rules) {
  const list = (rules || []).filter((r) => r && r.from);
  if (!list.length) return text;
  // 長的優先：不然「南亞科」會先吃掉「南亞科技股份」的機會
  const sorted = [...list].sort((a, b) => b.from.length - a.from.length);
  let out = '';
  let i = 0;
  while (i < text.length) {
    let hit = null;
    for (const r of sorted) {
      if (text.startsWith(r.from, i)) { hit = r; break; }
    }
    if (hit) { out += hit.to; i += hit.from.length; }
    else { out += text[i]; i += 1; }
  }
  return out;
}

/**
 * 從 script.txt 取出內文段並套發音替換。
 * 回傳：bodyAfterVoice 字串（保留標記、註解、空白、標點 — 給 parse-script 在上面找 (imageN) 區塊）
 */
function getBodyAfterVoice(scriptRaw) {
  const parts = scriptRaw.split('===');
  const bodyRaw = parts.length >= 3 ? parts[parts.length - 1] : (parts[1] ?? scriptRaw);
  const rules = parseVoiceRules(scriptRaw);
  return applyVoiceRulesForward(bodyRaw, rules);
}

/**
 * 把 bodyAfterVoice 清洗成 cleaned chars，並記錄每個 char 在 bodyAfterVoice 中的原位 origIdx。
 *
 * 清洗動作：
 *  - 移除 (imageN[:opts])、(imageN)、(logo)、(shot:名稱[:opts])、(text:...)、(/text) 標記本身（保留標記內的內容文字）
 *  - 移除 # 註解行、[...] 區塊行
 *  - 把 BREAK_RE（標點 + 換行）標記為「該位置斷句」並跳過
 *  - 跳過 OTHER_PUNCT_RE 與空白
 *
 * 回傳 chars: [{ char, breakAfter, origIdx }]
 */
function cleanBodyWithIndex(bodyAfterVoice) {
  const masked = new Array(bodyAfterVoice.length).fill(false);

  function maskRange(start, len) {
    for (let i = start; i < start + len; i++) masked[i] = true;
  }

  // 標記本身（保留內容）；大小寫不分，(Logo)/(IMAGE1)/(Shot:...) 都認
  for (const m of bodyAfterVoice.matchAll(/\(image\d+(?::[^)]+)?\)/gi)) {
    maskRange(m.index, m[0].length);
  }
  for (const m of bodyAfterVoice.matchAll(/\(logo\)/gi)) {
    maskRange(m.index, m[0].length);
  }
  for (const m of bodyAfterVoice.matchAll(/\(shot:[^)]*\)/gi)) {
    maskRange(m.index, m[0].length);
  }
  // 三大法人聚焦標記 (focus:區塊[:高亮字])…(focus:區塊)：標記本身不顯示、不進 TTS/字幕
  for (const m of bodyAfterVoice.matchAll(/\(focus:[^)]*\)/gi)) {
    maskRange(m.index, m[0].length);
  }
  for (const m of bodyAfterVoice.matchAll(/\(text:[^)]*\)/gi)) {
    maskRange(m.index, m[0].length);
  }
  for (const m of bodyAfterVoice.matchAll(/\(\/text\)/gi)) {
    maskRange(m.index, m[0].length);
  }
  // 註解 / 區塊行（整行）
  for (const m of bodyAfterVoice.matchAll(/^#.*$/gm)) {
    maskRange(m.index, m[0].length);
  }
  for (const m of bodyAfterVoice.matchAll(/^\[.*?\]\s*$/gm)) {
    maskRange(m.index, m[0].length);
  }
  // 雙人模式行首角色標記 [A]/[B]（含前後空白），不影響後面的對話文字
  // 上面那條 ^\[.*?\]\s*$ 只匹配「整行只有 [區塊]」，匹配不到 [A] 文字...
  for (const m of bodyAfterVoice.matchAll(/^[ \t]*\[([AaBb])\][ \t]*/gm)) {
    maskRange(m.index, m[0].length);
  }

  const chars = [];
  for (let i = 0; i < bodyAfterVoice.length; i++) {
    if (masked[i]) continue;
    const ch = bodyAfterVoice[i];
    if (BREAK_RE.test(ch)) {
      // 只剩全形標點與換行會走到這裡（半形 , . ! ? : ; 已移到 OTHER_PUNCT_RE、只略過不斷句），
      // 所以不再需要「小數點兩側是數字就不斷」的特例。
      if (chars.length > 0) {
        chars[chars.length - 1].breakAfter = true;
        // 2026-08-18 使用者：前台「出現在哪一段」要照原稿段落換行。
        // 段落換行＝一個換行後面接的是空白行（\n\s*\n）。標點不算、單一換行不算。
        if (ch === '\n' && /^[ \t]*\r?\n/.test(bodyAfterVoice.slice(i + 1))) {
          chars[chars.length - 1].paraBreak = true;
        }
      }
      continue;
    }
    if (OTHER_PUNCT_RE.test(ch)) continue;
    if (/\s/.test(ch)) continue;
    chars.push({ char: ch, breakAfter: false, paraBreak: false, origIdx: i });
  }
  return chars;
}


/**
 * 兩筆人工標注的出現範圍重疊 → **後標的蓋過先標的**（2026-08-25 使用者定案：「以後標的為主」）。
 *
 * 為什麼需要：0825 大盤那支同時標了 shot1@42~71 與 shot6@42~52，兩段都是人工、又是不同圖，
 * 系統從頭到尾沒有任何地方會處理「人工 vs 人工」的重疊 → 兩張截圖同時疊在畫面上
 * （成品 27.3~28.2 秒實際就是兩張半透明疊著），而且被蓋住那張的標注等於白標。
 *
 * 「後標的」怎麼認：標注檔的陣列順序**就是**標注順序 —— 前台 `addAnnot()` 是 `push`，
 * 列表雖然依圖分組畫，陣列本身是純粹的先後（2026-08-25 讀 index.html 確認）。
 * 所以這裡只要「排在後面的贏」即可，不必另外存時間戳。
 * `(shot:)`／`(focus:)` 這種寫在 script.txt 裡的標記排在標注前面 → 標注頁會贏，合理。
 *
 * 做法是「區間相減」：被蓋住的那筆保留沒被蓋到的部分，蓋在正中間時會裂成前後兩段
 * （同一張圖的話 buildShotRuns 會再把它們併回一個 run，圖不會閃）。
 * 裁完短於 minSec 的碎片直接丟掉，整段被蓋住的也丟掉。
 *
 * @param items   已排好「標注先後」的陣列，每筆要有 startCharIdx／endCharIdx
 * @param durOf   (startCharIdx, endCharIdx) => 秒數；回 null 表示算不出來（就不丟）
 * @param minSec  裁完短於這個秒數就整段丟掉（0 = 只裁不丟）
 * @returns { items, notes } notes 是給執行記錄印的說明
 */
function resolveManualOverlaps(items, { durOf = () => null, minSec = 0 } = {}) {
  const out = [];
  const notes = [];
  const has = (x) => typeof x.startCharIdx === 'number' && typeof x.endCharIdx === 'number';
  items.forEach((it, i) => {
    if (!has(it)) { out.push(it); return; }
    let parts = [[it.startCharIdx, it.endCharIdx]];
    const winners = [];
    for (let j = i + 1; j < items.length; j++) {   // 只有「排在後面的」能蓋過來
      const w = items[j];
      if (!has(w)) continue;
      if (w.endCharIdx < it.startCharIdx || w.startCharIdx > it.endCharIdx) continue;
      const next = [];
      for (const [a, b] of parts) {
        if (w.endCharIdx < a || w.startCharIdx > b) { next.push([a, b]); continue; }
        if (w.startCharIdx > a) next.push([a, Math.min(b, w.startCharIdx - 1)]);
        if (w.endCharIdx < b) next.push([Math.max(a, w.endCharIdx + 1), b]);
      }
      parts = next.filter(([a, b]) => a <= b);
      winners.push(w.src || '後標的');
      if (!parts.length) break;
    }
    if (!winners.length) { out.push(it); return; }
    const label = `${it.src || '這段'}(${it.startCharIdx}~${it.endCharIdx})`;
    if (!parts.length) {
      notes.push(`${label} 整段被 ${winners.join('／')} 蓋住 → 丟掉`);
      return;
    }
    const kept = [];
    for (const [a, b] of parts) {
      const d = durOf(a, b);
      if (d != null && minSec > 0 && d < minSec) {
        notes.push(`${label} 裁成 ${a}~${b} 只剩 ${d.toFixed(1)} 秒（< ${minSec}）→ 丟掉`);
        continue;
      }
      kept.push({ ...it, startCharIdx: a, endCharIdx: b, _trimmedBy: winners.join('／') });
    }
    if (kept.length) {
      notes.push(`${label} 被 ${winners.join('／')} 蓋到 → 裁成 `
        + kept.map((k) => `${k.startCharIdx}~${k.endCharIdx}`).join('、'));
    }
    out.push(...kept);
  });
  return { items: out, notes };
}

module.exports = {
  BREAK_RE,
  OTHER_PUNCT_RE,
  parseVoiceRules,
  applyVoiceRulesForward,
  getBodyAfterVoice,
  cleanBodyWithIndex,
  resolveManualOverlaps,
};
