'use strict';

/**
 * 頁型代號 → 給 Claude 看的中文名稱與裁切提示（2026-11-12）。
 *
 * 來源：90_系統/資料/page-samples/page-types.json（2026-09-03 人確認過的「頁型圖鑑」，26 型）。
 * analyze-app-images.js 判出來的 page 是英文代號（realtime-trend、market…），以前原樣丟給 Claude，
 * 它看不懂；這裡翻成圖鑑的中文名稱，常見頁再附一句「卡片怎麼裁、框框哪裡」。
 *
 * 使用者 2026-11-12 點名最常出現的四種畫面（大盤小報）：
 *   個股 · 即時（大戶散戶）—— 聯發科、台積電那種個股頁（realtime-trend）
 *   大盤 · 台灣指數       —— 走勢圖＋加權／櫃買／台指電子盤三磚＋焦點快訊（market）
 *   大盤 · 加權貢獻排行   —— 大盤頁往下捲，正貢獻／負貢獻兩欄前 5 名（market-contrib）
 * APP 畫面固定，所以幾何交給程式規則（cell-picker.js stockCrop／changeCellIn），Claude 只判斷內容。
 * 只是提示文字：改這裡不影響頁型辨識與配圖記憶的 key。
 */

const PAGES = {
  'realtime-trend': { zh: '個股 · 即時（大戶散戶）', hint: '個股頁：上方是股價區（股名代號、股價、漲跌、總量、屬性），中間分時走勢，下方大戶散戶圖。' },
  realtime: { zh: '個股 · 即時（五檔）' },
  kline: { zh: '個股 · K線' },
  'chip-daily': { zh: '個股 · 籌碼日報' },
  'main-force': { zh: '個股 · 主力' },
  'legal-person': { zh: '個股 · 法人' },
  'big-holder': { zh: '個股 · 大戶' },
  revenue: { zh: '個股 · 營收' },
  margin: { zh: '個股 · 資券' },
  'bull-bear': { zh: '個股 · 多空' },
  'target-price': { zh: '個股 · 法人目標' },
  earnings: { zh: '個股 · 獲利' },
  'stock-other': { zh: '個股 · 其他分頁' },
  market: {
    zh: '大盤 · 台灣指數',
    hint: '大盤頁：上方加權指數走勢圖，下面三張小磚（加權指數／櫃買指數／台指電子盤或台指期貨），再下面焦點快訊、電子／金融指數列。'
      + '講加權漲跌 → 卡片裁走勢圖到三張小磚，框加權那張磚。',
  },
  'market-contrib': {
    zh: '大盤 · 加權指數貢獻排行',
    hint: '大盤頁往下捲的「加權指數貢獻排行」：左欄正貢獻點數、右欄負貢獻點數，各列前 5 名（股名、代號、貢獻點數）。'
      + '卡片裁「加權指數貢獻排行」標題到第 5 名；講到哪一檔就框那一格（股名＋代號＋點數），不要框到上方的指數小磚。',
  },
  'contrib-rank': { zh: '指數 · 貢獻排行（股票／股價／漲跌幅／貢獻點數表）' },
  'index-kline': { zh: '指數 · K線（加權／櫃買）' },
  'industry-live': { zh: '大盤 · 產業即時' },
  'us-markets': { zh: '大盤 · 美股行情' },
  'portfolio-institutions': { zh: '庫存 · 三大法人' },
  'portfolio-main-force': { zh: '庫存 · 主力籌碼' },
  'portfolio-news': { zh: '庫存 · 事件新聞' },
  watchlist: { zh: '自選股清單' },
  'industry-list': { zh: '族群／產業清單' },
  'us-kline': { zh: '美股個股 · K線' },
  'focus-rank': { zh: '焦點股 · 排行榜' },
  'focus-list': { zh: '焦點股 · 個股清單' },
  'infographic-institution': { zh: '三大法人數據速覽（自製資訊圖）' },
};

/** 頁型中文名稱；未知或沒收錄回空字串 */
function pageName(page) {
  return (PAGES[page] && PAGES[page].zh) || '';
}

/** 給 Claude 的一行頁型說明（名稱＋常見頁的裁切提示）；未知回空字串 */
function pageLine(page) {
  const p = PAGES[page];
  if (!p) return '';
  return p.hint ? `系統判斷的頁面類型：${p.zh}。${p.hint}` : `系統判斷的頁面類型：${p.zh}`;
}

module.exports = { PAGES, pageName, pageLine };
