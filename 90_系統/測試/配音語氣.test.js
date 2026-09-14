'use strict';

// 配音語氣（MiniMax 的 emotion）只開放兩個值，而且**白名單一定要在伺服器端**。
// 前台不畫 whisper 擋得住同事，擋不住直接打 /api/jobs 的人 ——
// 而 whisper 配 speech-2.8 不是音色變掉，是配音那一步整支失敗（API 回 2013）：
// 那時 HeyGen 的點數已經花掉了，退不回來。
// 另一半是「前台給的值 ⊆ 伺服器白名單」：兩份清單各自寫在自己的檔案裡，
// 哪天有人只改一邊（例如前台多加一顆 calm 或 whisper），這裡要先響。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { repository, fixture, loadServer } = require('./隔離服務');
const { applicationPath } = require('../paths');

const 稿件 = { template: 'dapan', title: '合成標題', body: '這是合成稿件。' };

test('建立工作時語氣只收白名單的值，其餘一律當預設的流暢', async (t) => {
  const root = fixture(t);
  const request = loadServer(root);
  const 建立 = async (emotion) => {
    const res = await request('POST', '/api/jobs', emotion === undefined ? 稿件 : { ...稿件, emotion });
    assert.equal(res.status, 200);
    return res.body.job.emotion;
  };

  assert.equal(await 建立('happy'), 'happy', '選了開心卻沒存下來');
  assert.equal(await 建立('fluent'), 'fluent');
  assert.equal(await 建立('whisper'), 'fluent',
    'whisper 進到 job 裡就會在配音那一步整支失敗（speech-2.8 不支援），必須擋在建立時');
  assert.equal(await 建立('sad'), 'fluent', '九個合法值不代表前台開放，白名單以外一律當預設');
  assert.equal(await 建立(''), 'fluent', '空字串＝不送 emotion 欄位，那是「自動挑」，不是這裡的選項');
  assert.equal(await 建立(undefined), 'fluent',
    '沒帶欄位＝舊工作重跑的情況，要拿到預設值而不是 undefined（run.js 會收到 --emotion=undefined）');
});

test('前台的語氣按鈕與伺服器白名單是同一組值', () => {
  const 取清單 = (file, re) => {
    const m = fs.readFileSync(file, 'utf8').match(re);
    assert.ok(m, `找不到 EMOTIONS 清單：${file}（改名或改寫法時這個測試要跟著改）`);
    return [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
  };
  // 伺服器：const EMOTIONS = ['fluent', 'happy'];
  const 伺服器 = 取清單(applicationPath(repository, 'server/index.js'), /\nconst EMOTIONS = (\[[^\]]*\]);/);
  // 前台：const EMOTIONS = [['fluent', '流暢'], ['happy', '開心']];　只取值，不取按鈕文字
  const 前台 = 取清單(applicationPath(repository, 'server/public/app.js'), /\nconst EMOTIONS = (\[\[[\s\S]*?\]\]);/)
    .filter((v, i, all) => all.indexOf(v) === i);

  assert.deepEqual(前台, 伺服器,
    `前台按鈕 ${前台.join('／')} 與伺服器白名單 ${伺服器.join('／')} 不一致：`
    + '前台多出來的值會被伺服器默默換成預設（同事選了沒作用），少的那個則是白開放。');
  assert.equal(伺服器.includes('whisper'), false,
    'whisper 配 speech-2.8 會讓整支出片失敗（API 回 2013），不能出現在前台開放的清單裡');
  assert.equal(伺服器[0], 'fluent', '第一個是預設值 —— 2026-09-14 使用者定案預設走流暢');
});
