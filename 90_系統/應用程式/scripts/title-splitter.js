'use strict';

/**
 * 大盤小報標題拆行（2026-11-12）的純邏輯 —— 不碰檔案、不呼叫服務，測試在 90_系統/測試/標題拆行.test.js。
 *
 * 使用者定案：「建立工作那標題改一行就好，之後給 Claude 自己辨識」。
 * 右側面板標題第一句白、第二句黃（DapanLandscapeComposition.tsx），所以要拆在「語意的斷點」：
 * 前半是事件／數字，後半是問句或結論（例：「盤中翻紅尾盤跌掉 800 點」／「發生什麼事?」）。
 * Claude 只能決定**從哪裡切**，不能改字：兩行接起來（去掉空白）一定要等於原標題，不然不採用，
 * 交給渲染端的 splitTitle()（title-layout.ts，在標點切）當後備。
 */

const SYSTEM_PROMPT = '你是財經短影音的標題排版助手。只輸出 JSON，不要說明文字，不要 markdown 圍欄。';

function buildPrompt(title) {
  return [
    `這是一支台股短影音的標題：「${title}」`,
    '影片右側會把標題排成兩行：第一行白字、第二行黃字（黃字是重點、比較搶眼）。',
    '請決定從哪裡切成兩行：',
    '1. **一個字都不能改、不能增刪**，只決定切點；標點留在原本那一行。',
    '2. 切在語意的斷點：前半是事件或數字，後半是問句、轉折或結論（例：「盤中翻紅尾盤跌掉 800 點」／「發生什麼事?」；',
    '   「暴漲近2,000點」／「但這3個訊號還沒到位」）。',
    '3. 不要把數字和單位拆開（「800 點」「2,000點」），不要把一個詞拆成兩半。',
    '4. 兩行盡量都不要超過 11 個字；真的切不出好斷點就切在最接近中間的詞與詞之間。',
    '只輸出 JSON：{"lines":["第一行","第二行"]}',
  ].join('\n');
}

const squash = (s) => String(s || '').replace(/\s+/g, '');

/** 解析並驗證：剛好兩行、都不是空的、接起來等於原標題（空白不計）；不符合回 null */
function parseReply(text, title) {
  const o = require('./cell-picker').lastJsonObject(text);
  if (!o || !Array.isArray(o.lines) || o.lines.length !== 2) return null;
  const lines = o.lines.map((l) => String(l || '').trim());
  if (lines.some((l) => !l)) return null;
  if (squash(lines.join('')) !== squash(title)) return null;
  return lines;
}

/** 稿件標題段要不要交給 Claude 拆：只有一行、而且不是空的 */
function needsSplit(title) {
  const lines = String(title || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length === 1;
}

module.exports = { SYSTEM_PROMPT, buildPrompt, parseReply, needsSplit };
