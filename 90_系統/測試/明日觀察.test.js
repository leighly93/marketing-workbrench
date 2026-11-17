'use strict';

// 結尾「明天要看幾件事」（2026-11-16）：位置程式找、件數照實際講到的、排法程式決定。
// 不呼叫真的 claude：只測純邏輯（outlook.js、motion-engine 的驗證、shot-planner 的讓位、render-motion 的對時）。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { applicationPath } = require('../paths');

const APP = applicationPath(path.resolve(__dirname, '../..'));
const outlook = require(path.join(APP, 'scripts/outlook'));
const planner = require(path.join(APP, 'scripts/shot-planner'));
const engine = require(path.join(APP, 'scripts/motion-engine'));
const { finishOutlook } = require(path.join(APP, 'scripts/render-motion'));

/** 照「。」分句、「，」分子句做出 units（跟 auto-shot --sentences 同形狀） */
function unitsOf(text) {
  const units = [];
  let sid = 0;
  let idx = 0;
  for (const s of text.split('。').filter(Boolean)) {
    for (const c of s.split('，').filter(Boolean)) {
      units.push({ i: units.length, sid, text: c, startCharIdx: idx, endCharIdx: idx + c.length - 1 });
      idx += c.length + 1;
    }
    sid++;
  }
  return units;
}
const BODY = '今天大盤上漲。外資買超百億。台積電創高。電子股強彈。航運走弱。金融持平。成交量放大。'
  + '櫃買指數也收紅。記憶體族群量增。被動元件持續強勢。散戶融資增加。';
const said = (units, o) => units.slice(o.from, o.to + 1).map((u) => u.text).join('|');

test('有件數＋第一第二第三：從觸發句到最後一點，再見不算；序號就是件數', () => {
  const u = unitsOf(BODY + '明天有三件事要注意。第一，美國CPI公布。第二，台積電法說會。第三，外資期貨空單變化。我們明天見。');
  const o = outlook.findOutlook(u);
  assert.equal(said(u, o), '明天有三件事要注意|第一|美國CPI公布|第二|台積電法說會|第三|外資期貨空單變化');
  assert.deepEqual(o.markers, ['第一', '第二', '第三']);
  assert.equal(o.count, 3);
});

test('說三件、只講兩件：件數照實際的序號', () => {
  const u = unitsOf(BODY + '明天要看三件事。第一，美國CPI。第二，台積電法說。');
  const o = outlook.findOutlook(u);
  assert.equal(o.count, 2);
});

test('「首先…最後」只當參考，不硬性規定件數（最後常是收尾提醒）', () => {
  const u = unitsOf(BODY + '明天要看兩件事，首先是聯準會會議紀要，再來是輝達財報，最後提醒大家控制持股。謝謝收看。');
  const o = outlook.findOutlook(u);
  assert.deepEqual(o.markers, ['首先', '再來', '最後']);
  assert.equal(o.count, null);
});

test('沒講件數也做（一件也算）；中段的「明天」不會被當成結尾', () => {
  const u = unitsOf('明天觀察外資動向。' + BODY + BODY + '明天最大的催化事件是大立光法說，展望決定光學族群方向。');
  const o = outlook.findOutlook(u);
  assert.equal(said(u, o), '明天最大的催化事件是大立光法說|展望決定光學族群方向');
  assert.deepEqual(o.markers, []);
});

test('「第一季」「三大法人」不是序號／件數；沒有結尾展望就回 null', () => {
  assert.equal(outlook.findOutlook(unitsOf(BODY + '三大法人買超。第一季營收創高。')), null);
  assert.deepEqual(outlook.findMarkers('明天看三件事，第一季營收，第一金走勢').markers, []);
});

test('排法：每項旁白都短 → 同一個畫面；有一項講得長、只有一項、或重點字太長 → 一點一個畫面', () => {
  const short = '明天有三件事。第一，美國CPI公布。第二，台積電法說會。第三，外資期貨空單。';
  const items = [{ text: 'CPI公布', at: '第一' }, { text: '台積電法說', at: '第二' }, { text: '期貨空單', at: '第三' }];
  assert.equal(outlook.outlookLayout(items, short), 'all');
  const long = '明天有兩件事。第一，美國CPI公布，如果高於預期，聯準會降息的機率就會下降，科技股壓力會很大。第二，台積電法說會。';
  assert.equal(outlook.outlookLayout(items.slice(0, 2), long), 'paged');
  assert.equal(outlook.outlookLayout(items.slice(0, 1), short), 'paged');
  assert.equal(outlook.outlookLayout([{ text: '外資台指期空單連三天增加', at: '第一' }, items[1]], short), 'paged');
});

test('卡片標題由程式給，件數跟著實際項目數', () => {
  assert.deepEqual(outlook.outlookHeading('明天', 3), { kicker: '明日觀察', title: '明天要看|三件事' });
  assert.deepEqual(outlook.outlookHeading('下週', 2), { kicker: '下週觀察', title: '下週要看|兩件事' });
  assert.deepEqual(outlook.outlookHeading('明天', 1), { kicker: '明日觀察', title: '明天|關鍵焦點' });
});

test('motion-engine：outlook 參數驗證丟掉 Claude 的標題、太長的說明不放；說明裡的數字也要對原文', () => {
  const spec = engine.validate({ template: 'outlook', title: '明天|五大重點', when: '明天',
    items: [{ text: 'CPI', note: '高於預期壓抑降息', at: '第一' }, { text: '法說', note: '這是一個非常非常非常非常非常非常非常非常非常長的說明句子' }] });
  assert.equal(spec.title, undefined);
  assert.equal(spec.items[0].note, '高於預期壓抑降息');
  assert.equal(spec.items[1].note, undefined);
  assert.equal(engine.validate({ template: 'outlook', items: [] }), null);
  const bad = engine.checkAgainstSource({ template: 'outlook', items: [{ text: 'CPI', note: '年增3.5%' }] }, '明天美國CPI公布');
  assert.equal(bad.length, 1);
  assert.equal(engine.withOutlookHeading({ ...spec }).title, '明天要看|兩件事');
});

test('shot-planner：有明日觀察時 Claude 只排開頭動態、結尾那段固定是 outlook，截圖讓開', () => {
  const u = unitsOf(BODY + '明天有兩件事要注意。第一，美國CPI公布。第二，台積電法說會。');
  const o = outlook.findOutlook(u);
  const prompt = planner.buildPrompt({ units: u, images: [{ file: 'shot1.png', label: 'shot1.png', ocr: '' }], outlook: o });
  assert.match(prompt, /只要開頭 1 段/);
  assert.match(prompt, /明日觀察動畫/);
  const reply = JSON.stringify({ motions: [{ from: 'U0', to: 'U1' }, { from: `U${o.from}`, to: `U${o.to}` }] });
  const motions = planner.parseMotions(reply, { units: u, segments: [], outlook: o });
  assert.equal(motions.length, 2);
  assert.equal(motions[1].kind, 'outlook');
  assert.equal(motions[1].count, 2);
  assert.equal(motions[1].startCharIdx, u[o.from].startCharIdx);
  // 截圖段：整段在裡面的丟掉，蓋到開頭的裁到前一句
  const range = { startCharIdx: u[o.from].startCharIdx, endCharIdx: u[o.to].endCharIdx };
  const { kept, dropped } = planner.clipSegments([
    { src: 'a.png', startCharIdx: u[o.from - 1].startCharIdx, endCharIdx: u[o.from + 1].endCharIdx },
    { src: 'b.png', startCharIdx: u[o.from + 2].startCharIdx, endCharIdx: u[o.from + 2].endCharIdx },
  ], range, u);
  assert.deepEqual(kept.map((s) => [s.src, s.endCharIdx]), [['a.png', u[o.from - 1].endCharIdx]]);
  assert.deepEqual(dropped.map((s) => s.src), ['b.png']);
});

test('render-motion：序號件數對得上就用序號對時；一點一頁時第一頁最晚 1.2 秒出來', () => {
  const text = '明天有兩件事要注意。第一，美國CPI公布，如果高於預期，聯準會降息機率就會下降，科技股壓力很大。第二，台積電法說會。';
  const times = [...text].map((_, k) => ({ start: k * 0.2, end: k * 0.2 + 0.2 }));
  const range = { startCharIdx: 0, endCharIdx: text.length - 1, startSec: 0, endSec: text.length * 0.2 };
  const planned = { template: 'outlook', when: '明天',
    items: [{ text: 'CPI公布', at: '美國CPI' }, { text: '台積電法說', at: '找不到的片段' }] };
  const spec = finishOutlook(planned, { kind: 'outlook', markers: ['第一', '第二'], count: 2 }, range, { times, text }, text);
  assert.equal(spec.layout, 'paged');
  assert.equal(spec.items[0].atSec, 1.2);               // 「第一」在第 10 字 = 2 秒 → 提前到 1.2 秒
  assert.equal(spec.items[1].atSec, Number((text.indexOf('第二') * 0.2).toFixed(3)));
});
