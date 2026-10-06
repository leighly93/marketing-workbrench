// ─────────────────────────────────────────
//  送配音（TTS）前的稿件清洗。純函式，run.js 與測試共用。
//  ⚠️ 只動送 TTS 的那份文字；字幕走 script-utils.js 的 cleanBodyWithIndex()，兩條路不要混用。
// ─────────────────────────────────────────

'use strict';

function parseVoiceReplacements(raw) {
  // 讀取頂部 # 發音替換 區塊（=== 之前）
  const rules = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('===')) break;
    if (line.startsWith('#')) continue;
    const m = line.match(/^(.+?)→(.+)$/);
    if (m) rules.push({ from: m[1].trim(), to: m[2].trim() });
  }
  return rules;
}

/**
 * 送配音前把減號拿掉（**只動送 TTS 的那份，不動稿子、不動字幕**）。
 *
 * 2026-09-01 使用者定案：「送去配音時還是要依照 ，。！？ 斷句換氣，但是遇到其他標點符號
 * 像是 - 就不要，或許送配音前 - 可以先刪掉？但最後字幕還是要出現。」
 *
 * 為什麼這裡是對的位置：配音跟字幕走的是**兩條不同的清洗函式** ——
 * TTS 走本檔的 cleanScript()／cleanSegmentText()，字幕走 script-utils.js 的 cleanBodyWithIndex()。
 * 在 TTS 這條刪掉減號，字幕那條完全不受影響 → 螢幕上照樣是「世芯-KY」，
 * 而且**不需要**靠共用詞庫的 `-KY→KY` ＋ correct-subtitles 第 10 步反向還原繞一圈
 * （那條路只認 -KY，而且反向還原沒有詞邊界，會把字幕裡單獨的 KY 也塞成 -KY）。
 *
 * ⚠️ 數字區間的減號一定要留：「未來 3-5 天」「2023-2024 年」無腦刪會變成「35 天」「20232024 年」，
 *    唸出來直接是錯的。所以規則是「兩邊都是數字就保留，其餘刪掉」。
 * ⚠️ 只處理半形 `-`。全形破折號（—／－）在中文裡本來就是有意義的停頓，不碰。
 */
function stripSpeechHyphens(text) {
  return String(text).replace(/-/g, (m, off, full) => {
    const prev = full[off - 1] || '';
    const next = full[off + 1] || '';
    return /\d/.test(prev) && /\d/.test(next) ? '-' : '';
  });
}

/**
 * 送配音前把「年份」轉成中文數字（**只動送 TTS 的那份，不動稿子、不動字幕**）。
 *
 * 2026-09-01 上線。起因：實測 MiniMax 的 `text_normalization`（官方數字正規化開關）
 * 結論是 **✗ 不採用** —— 使用者：「不好，數字會唸錯」，年份 2026／2027 被唸成
 * 「兩千零二十六」，台灣唸法要逐字「二零二六」。而指數 45,832、價格 1,205、
 * 百分比 6% 本來就唸得對，沒有非開 TN 不可的理由。
 *
 * 位置與 stripSpeechHyphens() 同一個理由：TTS 走 cleanScript()／cleanSegmentText()，
 * 字幕走 script-utils.js 的 cleanBodyWithIndex() —— 在這裡轉，螢幕上照樣顯示「2026」。
 *
 * ⚠️ **股號那條規則已經拿掉，不要加回來。** 原本還有一條「獨立的 4 位數 → 逐字唸」
 *    是給 2454／3034 這種股票代號用的，2026-09-01 使用者說明：
 *    「講股票代號機會偏小，因為之前一直撞牆於是我決定再也不讓 AI 講股票代號」。
 *    稿子裡本來就不會有股號 → 那條規則變成純風險：它會吃掉**任何**沒接單位字的 4 位數。
 *    （而且它本身有個很細的坑：單位字排除清單放了「台」，「2330 台積電」就漏轉 ——
 *      台股一堆公司名首字是量詞：台積電／日月光／萬海／元大／億豐／天鈺／家登。
 *      要復活的話得連這個一起處理，不是把 regex 貼回來就好。）
 * ⚠️ tools/experiments/tts-ab.js 有一份舊副本，只供試聽比對。
 */
const CN_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

function digitsToCn(str) {
  return String(str).split("").map((d) => CN_DIGITS[Number(d)]).join("");
}

function numFix(text) {
  // 19xx／20xx 後面接「年」。順便吃掉中間空白 ——「二零二七 年」會在「年」前頓一下。
  // 前面不吃數字／逗號／小數點／減號：「2023-2024 年」整段不動
  //（stripSpeechHyphens 會保留數字間的減號，不排除的話會變成「2023-二零二四年」）。
  return String(text).replace(/(?<![\d,\-.])((?:19|20)\d{2})\s*(?=年)/g, (m, d) => digitsToCn(d));
}

function cleanScript(raw) {
  // 套用發音替換（送 HeyGen 前）
  const voiceRules = parseVoiceReplacements(raw);
  // 移除標題區（=== 以前）
  const parts = raw.split("===");
  const body = parts.length >= 3 ? parts[parts.length - 1] : (parts[1] ?? raw);
  // 移除圖片標記 (imageN)...(imageN)、(logo)...(logo)、(shot:名稱)...(shot:名稱)
  // 大小寫不分(i flag),(Logo)、(IMAGE1)、(Shot:...) 都能正確移除
  let cleaned = body.replace(/\(text:[^)]*\)[\s\S]*?\(\/text\)/gi, "").replace(/\([a-z0-9]+\)/gi, "").replace(/\(shot:[^)]*\)/gi, "");
  // 移除括號內文字
  cleaned = cleaned.replace(/[\[{【（][^\]}\]）】]*[\]}\]）】]/g, "");
  // 移除多餘空白與換行
  cleaned = cleaned.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  // 減號不進 TTS（字幕那條路不受影響，見 stripSpeechHyphens 的註解）
  cleaned = stripSpeechHyphens(cleaned);
  // 年份轉中文數字（同上，只動 TTS 這份）
  cleaned = numFix(cleaned);
  return cleaned;
}

// ── 雙人 path：腳本解析 ─────────────────
// detectMode: 偵測腳本是否含 [A]/[B] 行首標記 → 'dual' 或 'solo'
// 沒有 [A]/[B] → 走現有單人 path（100% 向後相容）
function detectMode(rawScript) {
  const parts = rawScript.split("===");
  const body = parts.length >= 3 ? parts[parts.length - 1] : (parts[1] ?? rawScript);
  return /^[ \t]*\[([AaBb])\]/m.test(body) ? "dual" : "solo";
}

// splitByRole: 把 script.txt 內文依 [A]/[B] 行首標記切段、合併連續同角色段
// 沒標的第一段預設 A；沒標的後續行承襲上一段角色
// 回傳 [{ role: 'A'|'B', text: <已清洗的對話文字> }, ...]
function splitByRole(rawScript, voiceRules) {
  const parts = rawScript.split("===");
  const body = parts.length >= 3 ? parts[parts.length - 1] : (parts[1] ?? rawScript);

  // 套發音替換（保持繁中，跟單人 path 同邏輯）
  let bodyAfterVoice = body;
  for (const rule of voiceRules) {
    bodyAfterVoice = bodyAfterVoice.split(rule.from).join(rule.to);
  }

  const lines = bodyAfterVoice.split("\n");
  let currentRole = "A"; // 預設第一段為 A
  let currentText = "";
  const segments = [];

  function flushSegment() {
    const cleaned = cleanSegmentText(currentText);
    if (cleaned) segments.push({ role: currentRole, text: cleaned });
    currentText = "";
  }

  for (const line of lines) {
    const m = line.match(/^[ \t]*\[([AaBb])\][ \t]*(.*)$/);
    if (m) {
      const newRole = m[1].toUpperCase();
      if (newRole !== currentRole && currentText.trim()) flushSegment();
      currentRole = newRole;
      currentText += (currentText ? " " : "") + m[2];
    } else {
      currentText += (currentText ? " " : "") + line;
    }
  }
  flushSegment();
  return segments;
}

// cleanSegmentText: 單段對話的清洗（跟 cleanScript 同精神，但已切段、只處理單段文字）
function cleanSegmentText(text) {
  let out = text
    .replace(/\(text:[^)]*\)[\s\S]*?\(\/text\)/gi, "")
    .replace(/\([a-z0-9]+\)/gi, "")
    .replace(/\(shot:[^)]*\)/gi, "");
  out = out.replace(/[\[{【（][^\]}\]）】]*[\]}\]）】]/g, "");
  out = out.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  // 跟單人 path 一致：減號不進 TTS、年份轉中文
  out = stripSpeechHyphens(out);
  out = numFix(out);
  return out;
}


module.exports = {
  parseVoiceReplacements, stripSpeechHyphens, digitsToCn, numFix, cleanScript,
  detectMode, splitByRole, cleanSegmentText,
};
