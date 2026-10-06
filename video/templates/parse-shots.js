// @ts-check
'use strict';

/**
 * 稿件 → 配圖計畫（純函式，不碰檔案）。
 *
 * 解析 script.txt 內的 (shot:名稱)…(shot:名稱) 標記，換算成字幕時間軸用的字元索引。
 * 只處理 (shot:)，不含 (imageN)／(logo)／(text:)；黃框由 auto-shot 與前台人工標注決定。
 *
 * 字元索引的座標系是「發音替換後、清洗過的字」（必須跟字幕時間軸同一套）；
 * 要顯示／記錄的字一律取原稿（2026-09-11 使用者定案：替換後的字只用在送去配音）。
 */
const { getBodyWithVoiceMap, cleanBodyWithIndex } = require('../pipeline/script-utils');

const ANCHOR_LEN = 3;
// 大小寫不分；(shot:名稱:選項) 的選項目前不解析。
const SHOT_PATTERN = /\(shot:([^():]+)(?::([^)]*))?\)([\s\S]*?)\(shot:\1\)/gi;
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', ''];

/**
 * @param {string} name 標記裡的截圖名稱
 * @param {(file: string) => boolean} exists public/ 裡有沒有這個檔
 * @returns {string} 實際檔名；都找不到就假設是 .png
 */
function findShotSrc(name, exists) {
  for (const ext of IMAGE_EXTS) {
    if (exists(name + ext)) return name + ext;
  }
  return name + '.png';
}

/**
 * @param {string} scriptRaw script.txt 全文
 * @param {{ exists?: (file: string) => boolean }} [options]
 * @returns {{ shots: Array<{src: string, startCharIdx: number, endCharIdx: number, startAnchor: string, endAnchor: string, _phrase: string}>, skipped: string[] }}
 */
function parseShots(scriptRaw, { exists = () => false } = {}) {
  const { body, origChars } = getBodyWithVoiceMap(scriptRaw);
  const cleanedChars = cleanBodyWithIndex(body);
  const original = origChars(cleanedChars);
  const toCleaned = new Map();
  cleanedChars.forEach((c, i) => toCleaned.set(c.origIdx, i));

  const shots = [];
  const skipped = [];
  for (const m of body.matchAll(SHOT_PATTERN)) {
    const name = m[1];
    const start = m.index + m[0].indexOf(m[3]);
    let startCharIdx = -1;
    let endCharIdx = -1;
    for (let bi = start; bi < start + m[3].length; bi++) {
      const ci = toCleaned.get(bi);
      if (ci === undefined) continue;
      if (startCharIdx < 0) startCharIdx = ci;
      endCharIdx = ci;
    }
    if (startCharIdx < 0) { skipped.push(name); continue; }
    const phrase = original.slice(startCharIdx, endCharIdx + 1).join('');
    shots.push({
      src: findShotSrc(name, exists),
      startCharIdx,
      endCharIdx,
      startAnchor: phrase.slice(0, ANCHOR_LEN),
      endAnchor: phrase.slice(-ANCHOR_LEN),
      _phrase: phrase,
    });
  }
  return { shots, skipped };
}

/**
 * 稿件標題：取「內文前一段」。使用者的 script.txt 常多打一個空的 === 區塊（4 段），
 * 取 parts[length-2] 對標準 3 段與多一段兩種情況都抓得對。
 * @param {string} scriptRaw
 */
function titleFromScript(scriptRaw) {
  const parts = scriptRaw.split('===');
  return parts.length >= 3 ? parts[parts.length - 2].trim() : '';
}

/**
 * 台北時間的 MMDD，給開場日期牌。
 * @param {Date} [now]
 */
function headerDateOf(now = new Date()) {
  const taipei = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  return String(taipei.getMonth() + 1).padStart(2, '0') + String(taipei.getDate()).padStart(2, '0');
}

module.exports = { parseShots, findShotSrc, titleFromScript, headerDateOf, ANCHOR_LEN };
