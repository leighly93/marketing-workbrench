'use strict';

// 2026-11-12 7eov「只差 80 點」：Claude 排了 4 張卡片，卻因為回 shot1.jpg（實際 shot1.png）整批被丟，
// log 寫成「Claude 判斷沒有句子適合配圖」、這支沒出片。同一支的大盤三磚頁（台指電子盤）與
// 大盤頁往下捲的「加權指數貢獻排行」也都被判成未知頁。不呼叫真的 claude：用 CLAUDE_BIN 換成假的腳本。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applicationPath } = require('../paths');

const ROOT = path.resolve(__dirname, '../..');
const APP = applicationPath(ROOT);
const planner = require(path.join(APP, 'scripts/shot-planner'));
const pages = require(path.join(APP, 'scripts/app-pages'));

const UNITS = [
  { i: 0, text: '今天大盤跌了292點，', startCharIdx: 0, endCharIdx: 9 },
  { i: 1, text: '但台積電一檔股票，', startCharIdx: 10, endCharIdx: 17 },
  { i: 2, text: '就把指數拉低了316點。', startCharIdx: 18, endCharIdx: 28 },
];
const FILES = ['shot1.png', 'shot2.png', 'shot3.png', 'shot4.png'];

test('圖名：完整檔名 → 去掉副檔名 → 「圖N」，都對不上才丟', () => {
  assert.equal(planner.resolveImage('shot2.png', FILES), 'shot2.png');
  assert.equal(planner.resolveImage('shot1.jpg', FILES), 'shot1.png');
  assert.equal(planner.resolveImage('SHOT4.JPEG', FILES), 'shot4.png');
  assert.equal(planner.resolveImage('圖3', FILES), 'shot3.png');
  assert.equal(planner.resolveImage('圖3（shot3.png）', FILES), 'shot3.png');
  assert.equal(planner.resolveImage('shot9.png', FILES), null);
  assert.equal(planner.resolveImage('圖9', FILES), null);
  assert.equal(planner.resolveImage('', FILES), null);
  // 同名不同副檔名有兩張 → 不猜
  assert.equal(planner.resolveImage('a.gif', ['a.png', 'a.jpg']), null);
});

test('7eov 實際回覆：shot*.jpg 對到 shot*.png，四段都留下', () => {
  const reply = JSON.stringify({ segments: [
    { image: 'shot1.jpg', from: 'U0', to: 'U0', title: '加權指數' },
    { image: 'shot4.jpg', from: 'U1', to: 'U2', title: '台積電貢獻' },
  ] });
  const segs = planner.parseReply(reply, { units: UNITS, files: FILES });
  assert.deepEqual(segs.map((s) => [s.src, s.startCharIdx, s.endCharIdx]), [['shot1.png', 0, 9], ['shot4.png', 10, 28]]);
});

test('prompt 範例的檔名用這支實際的第一張圖，不再寫死 shot1.jpg', () => {
  const p = planner.buildPrompt({ units: UNITS, images: [{ file: 'shot1.png', label: '圖1（shot1.png，大盤 · 台灣指數）', ocr: '' }] });
  assert.match(p, /"image":"shot1\.png"/);
  assert.doesNotMatch(p, /shot1\.jpg/);
  assert.match(p, /照抄上面括號裡的檔名/);
  assert.match(p, /圖1（shot1\.png，大盤 · 台灣指數）/);
});

test('頁型中文名稱與常見頁提示（頁型圖鑑）', () => {
  assert.equal(pages.pageName('realtime-trend'), '個股 · 即時（大戶散戶）');
  assert.equal(pages.pageName('unknown'), '');
  assert.equal(pages.pageLine('unknown'), '');
  assert.equal(pages.pageLine(undefined), '');
  assert.match(pages.pageLine('market'), /大盤 · 台灣指數.*三張小磚/);
  assert.match(pages.pageLine('market-contrib'), /加權指數貢獻排行.*正貢獻.*負貢獻/);
  const card = require(path.join(APP, 'scripts/cell-picker')).buildCardPrompt({
    steps: [{ id: 'U1', text: '台積電拉低 316 點' }], page: 'market-contrib', listing: '', width: 1206, height: 2622 });
  assert.match(card, /系統判斷的頁面類型：大盤 · 加權指數貢獻排行/);
  assert.doesNotMatch(card, /頁面類型：market-contrib/);
});

/** 從原始碼取出 PAGE_SIGNATURES_V2 與 detectPage 的判斷法（那支一載入就跑 OCR，不能 require） */
function v2Detect() {
  const src = fs.readFileSync(path.join(APP, 'scripts/analyze-app-images.js'), 'utf8');
  const body = src.slice(src.indexOf('const PAGE_SIGNATURES_V2 = ['), src.indexOf('];', src.indexOf('const PAGE_SIGNATURES_V2 = [')) + 2);
  const sigs = new Function(`${body}; return PAGE_SIGNATURES_V2;`)();
  return (text) => {
    for (const sig of sigs) {
      if (!sig.all.every((k) => text.includes(k))) continue;
      if ((sig.none || []).some((k) => text.includes(k))) continue;
      return sig.page;
    }
    return 'unknown';
  };
}

test('頁型規則：台指電子盤的大盤頁、往下捲的加權指數貢獻排行（7eov 的 OCR 原文）', () => {
  const detect = v2Detect();
  // shot1：三磚第三張是「台指電子盤」，「盤」讀成「般」
  assert.equal(detect('今日量縮19.2%> 46122 加權指數 44920.14 焦點快訊 櫃買指數 369.24 台指電子般 45167'), 'market');
  // shot4：上面露著三磚，下面是貢獻排行
  assert.equal(detect('大盤 討論 台灣產業即時 加權指數 櫃買指數 台指電子盤 444920.14 加權指數貢獻排行 更多> 聯發科 台積電'), 'market-contrib');
  // 原本的規則照舊
  assert.equal(detect('晨報 加權指數 櫃買指數 台指期貨 焦點快訊'), 'market');
  assert.equal(detect('加權指數 成交量 MACD'), 'index-kline');
  assert.equal(detect('2454 總量 11663 屬性 大戶累積買超 散戶累積買超'), 'realtime-trend');
});
