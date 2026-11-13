'use strict';

// 補充數字字卡（2026-11-13 使用者選定，cmoney-ad-subtitles skill 的「補充數字字卡」）。
// 不呼叫真的 claude：只測解析與接線。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { applicationPath } = require('../paths');

const APP = applicationPath(path.resolve(__dirname, '../..'));
const planner = require(path.join(APP, 'scripts/shot-planner'));

// 21uc「滿場綠油油」的旁白片段
const UNITS = [
  { i: 0, text: '誰在賣？', startCharIdx: 0, endCharIdx: 3 },
  { i: 1, text: '外資今天在上市賣超816億，', startCharIdx: 4, endCharIdx: 16 },
  { i: 2, text: '投信今天買了88.7億，', startCharIdx: 17, endCharIdx: 27 },
  { i: 3, text: '還是擋不住。', startCharIdx: 28, endCharIdx: 33 },
  { i: 4, text: '今天下跌家數1,438家，', startCharIdx: 34, endCharIdx: 45 },
  { i: 5, text: '是上漲的3.6倍。', startCharIdx: 46, endCharIdx: 54 },
];
const reply = (facts) => JSON.stringify({ segments: [], motions: [], facts });
const F = (from, to, items) => ({ from, to, items });

test('字卡：數字要逐字出現在那幾句旁白（千分位不計），主詞 2～6 字，最多兩項', () => {
  const ok = planner.parseFacts(reply([
    F('U1', 'U2', [{ label: '外資賣超', value: '816億', tone: 'down' }, { label: '投信買超', value: '88.7億', tone: 'up' }]),
    F('U4', 'U5', [{ label: '下跌家數', value: '1438家', tone: 'down' }, { label: '跌漲比', value: '3.6倍', tone: 'weird' }]),
  ]), { units: UNITS });
  assert.equal(ok.length, 2);
  assert.deepEqual(ok[0], { startCharIdx: 4, endCharIdx: 27, items: [
    { label: '外資賣超', value: '816億', tone: 'down' }, { label: '投信買超', value: '88.7億', tone: 'up' }] });
  assert.equal(ok[1].items[1].tone, 'gold', '不認得的 tone 用金色');

  // 數字對不上（自己換算、算錯）→ 整張不要
  assert.deepEqual(planner.parseFacts(reply([F('U1', 'U1', [{ label: '外資賣超', value: '816.5億', tone: 'down' }])]), { units: UNITS }), []);
  assert.deepEqual(planner.parseFacts(reply([F('U1', 'U2', [{ label: '外資賣超', value: '816億' }, { label: '投信', value: '90億' }])]), { units: UNITS }), []);
  // 數字出現在別句（不在 from～to 裡）也不行
  assert.deepEqual(planner.parseFacts(reply([F('U1', 'U1', [{ label: '投信買超', value: '88.7億' }])]), { units: UNITS }), []);
  // 主詞太長、沒有數字、超過 3 句
  assert.deepEqual(planner.parseFacts(reply([F('U1', 'U1', [{ label: '外資今天在上市賣超', value: '816億' }])]), { units: UNITS }), []);
  assert.deepEqual(planner.parseFacts(reply([F('U3', 'U3', [{ label: '擋不住', value: '很多' }])]), { units: UNITS }), []);
  assert.deepEqual(planner.parseFacts(reply([F('U1', 'U5', [{ label: '外資賣超', value: '816億' }])]), { units: UNITS }), []);
  assert.deepEqual(planner.parseFacts('不是 JSON', { units: UNITS }), []);
});

test('字卡不壓到截圖段、動態段或彼此，整支最多 3 張', () => {
  const taken = [{ startCharIdx: 30, endCharIdx: 40 }];
  const r = planner.parseFacts(reply([
    F('U1', 'U1', [{ label: '外資賣超', value: '816億' }]),
    F('U1', 'U2', [{ label: '投信買超', value: '88.7億' }]),
    F('U4', 'U4', [{ label: '下跌家數', value: '1,438家' }]),
  ]), { units: UNITS, taken });
  assert.deepEqual(r.map((f) => [f.startCharIdx, f.endCharIdx]), [[4, 16]]);
  const many = planner.parseFacts(reply([0, 1, 2, 4, 5].map((k) => F(`U${k}`, `U${k}`,
    [{ label: '數字', value: ['', '816億', '88.7億', '', '1,438家', '3.6倍'][k] || '1' }]))), { units: UNITS });
  assert.ok(many.length <= 3);
});

test('prompt 要求補充字卡：只放沒配圖沒動態的句子、數字照原文、0～3 張', () => {
  const p = planner.buildPrompt({ units: UNITS, images: [{ file: 'shot1.png', label: '圖1（shot1.png）', ocr: '' }] });
  assert.match(p, /補充字卡/);
  assert.match(p, /沒有配截圖、也不在動態卡片裡/);
  assert.match(p, /數字一定要照旁白原文/);
  assert.match(p, /"facts":\[/);
});

test('接線：排配圖寫 claude-facts.json → parse 寫進 video-meta.factCards（沒有就清空）→ 橫式畫面畫 FactCards；換工作清掉', () => {
  const plan = fs.readFileSync(path.join(APP, 'scripts/claude-shot-plan.js'), 'utf8');
  assert.match(plan, /unlinkSync\(FACTS_OUT\)/, '上一支的字卡要先清');
  assert.match(plan, /parseFacts\(plan\.reply/);
  assert.match(plan, /taken: shots\.concat\(plan\.motions/, '要避開延到句尾後的截圖段');
  const parse = fs.readFileSync(path.join(APP, 'scripts/parse-dapan-script.js'), 'utf8');
  assert.match(parse, /claude-facts\.json/);
  assert.match(parse, /meta\.factCards = factCards/);
  const comp = fs.readFileSync(path.join(APP, 'src/DapanXiaobao/DapanLandscapeComposition.tsx'), 'utf8');
  assert.match(comp, /<FactCards[\s\S]*blockers=\{\[\.\.\.DAPAN_SHOTS, \.\.\.MOTION_RUNS\]\}/);
  const fc = fs.readFileSync(path.join(APP, 'src/DapanXiaobao/FactCards.tsx'), 'utf8');
  assert.match(fc, /const MIN_SEC = 1\.5/);
  const server = fs.readFileSync(path.join(APP, 'server/index.js'), 'utf8');
  assert.match(server, /rmrf\(path\.join\(pub, 'claude-facts\.json'\)\)/);
  const engine = fs.readFileSync(path.join(APP, 'scripts/cell-picker-engine.js'), 'utf8');
  assert.match(engine, /reply: r\.text/);
});

test('卡片背景不放金色星點（2026-11-12 使用者：「背景不要有閃閃亮亮的」）', () => {
  const src = fs.readFileSync(path.join(APP, 'src/DapanXiaobao/AppCardShots.tsx'), 'utf8');
  assert.doesNotMatch(src, /SPARKS|Sparkle/);
});
