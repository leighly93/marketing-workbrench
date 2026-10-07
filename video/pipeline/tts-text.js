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
 * TTS 走本檔的 cleanScript()，字幕走 script-utils.js 的 cleanBodyWithIndex()。
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
 * 位置與 stripSpeechHyphens() 同一個理由：TTS 走 cleanScript()，
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

/** 實際送 TTS 的文字：清洗後套發音替換（配音念的就是這份；模擬轉錄也拿它當「聽到的內容」）。 */
function ttsText(raw) {
  let text = cleanScript(raw);
  for (const rule of parseVoiceReplacements(raw)) text = text.split(rule.from).join(rule.to);
  return text;
}

module.exports = { parseVoiceReplacements, stripSpeechHyphens, digitsToCn, numFix, cleanScript, ttsText };
