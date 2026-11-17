'use strict';

// 檢查 Claude 排的配圖（2026-11-17 使用者定案「Start 1 and 2」）：
// Claude 排好就直接出片 → 修正紀錄與記憶庫不再長東西。成品頁逐段標錯、給正確答案，
// 寫進修正紀錄（Claude排錯）、正確框學進記憶庫；「照修正重新出片」鎖住人改的段落。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { applicationPath } = require('../paths');
const { fixture, write, loadServer, workFile } = require('./隔離服務');

const APP = applicationPath(path.resolve(__dirname, '../..'));
const R = require(path.join(APP, 'scripts/claude-review'));

const ROWS = [
  { i: 0, src: 'shot1.png', phrase: '外資賣超816億', startCharIdx: 10, endCharIdx: 17,
    region: { x: 0, y: 100, w: 600, h: 120 }, cell: { x: 10, y: 120, w: 100, h: 30 }, imageWidth: 600, imageHeight: 400 },
  { i: 1, src: 'shot2.png', phrase: '類股重挫', startCharIdx: 18, endCharIdx: 23,
    region: { x: 0, y: 0, w: 600, h: 200 }, cell: { x: 180, y: 250, w: 100, h: 40 }, imageWidth: 600, imageHeight: 400 },
  { i: 2, src: 'shot3.png', phrase: '台積電法說', startCharIdx: 24, endCharIdx: 30, region: null, cell: null, imageWidth: 600, imageHeight: 400 },
];
const IMAGES = ['shot1.png', 'shot2.png', 'shot3.png', 'shot4.png'];

test('檢查結果整理：不認得的判斷、對不到的列丟掉；圖只能換成這支有的', () => {
  const items = R.normalizeItems([
    { i: 0, verdict: 'ok' },
    { i: 1, verdict: 'wrongBox', cell: { x: 20.4, y: 30, w: 200, h: 50 }, note: ' 要框綠色長條 ' },
    { i: 2, verdict: 'wrongImage', src: 'evil/../../x.png' },
    { i: 9, verdict: 'other' },
    { i: 0, verdict: 'whatever' },
  ], ROWS, IMAGES);
  assert.deepEqual(items.map((x) => [x.i, x.verdict]), [[0, 'ok'], [1, 'wrongBox'], [2, 'wrongImage']]);
  assert.deepEqual(items[1].cell, { x: 20, y: 30, w: 200, h: 50 });
  assert.equal(items[1].note, '要框綠色長條');
  assert.equal(items[2].src, 'shot3.png', '不在這支的圖不能換過去');
});

test('修正紀錄：沒問題的不記、同一個判斷重送不重記；記憶庫只學有給正確框的', () => {
  const items = R.normalizeItems([
    { i: 0, verdict: 'ok' },
    { i: 1, verdict: 'wrongBox', cell: { x: 20, y: 30, w: 200, h: 50 }, region: { x: 0, y: 0, w: 600, h: 120 } },
    { i: 2, verdict: 'noShot' },
  ], ROWS, IMAGES);
  const first = R.correctionRows(items, ROWS);
  assert.deepEqual(first.rows.map((r) => [r.type, r.kind, r.phrase]), [['Claude排錯', '框錯位置', '類股重挫'], ['Claude排錯', '不該放截圖', '台積電法說']]);
  assert.deepEqual(first.rows[0].autoCell, { x: 180, y: 250, w: 100, h: 40 });
  assert.deepEqual(first.rows[0].manualCell, { x: 20, y: 30, w: 200, h: 50 });
  assert.equal(R.correctionRows(items, ROWS, first.sigs).rows.length, 0, '重送同樣的判斷不重記');
  const mem = R.memoryItems(items, ROWS);
  assert.deepEqual(mem.map((m) => [m.src, m.phrase]), [['shot2.png', '類股重挫']]);
});

test('照修正重新出片：有框的鎖住、只換圖的變提示、不放截圖的讓開；只說錯的寫成指示', () => {
  const items = R.normalizeItems([
    { i: 0, verdict: 'wrongImage', src: 'shot4.png' },                                   // 只換圖、沒畫框
    { i: 1, verdict: 'wrongBox', cell: { x: 20, y: 30, w: 200, h: 50 } },                 // 有框
    { i: 2, verdict: 'noShot' },
  ], ROWS, IMAGES);
  const f = R.fixedPlan(items, ROWS);
  assert.deepEqual(f.hints, [{ startCharIdx: 10, endCharIdx: 17, src: 'shot4.png' }]);
  assert.deepEqual(f.fixed.map((x) => [x.src, x.startCharIdx, x.cell]), [['shot2.png', 18, { x: 20, y: 30, w: 200, h: 50 }]]);
  assert.deepEqual(f.noShot, [{ startCharIdx: 24, endCharIdx: 30 }]);
  const vague = R.normalizeItems([{ i: 1, verdict: 'wrongBox', note: '框太下面' }], ROWS, IMAGES);
  assert.equal(R.fixedPlan(vague, ROWS).fixed.length, 0, '沒給答案就不鎖');
  assert.match(R.autoNote(vague, ROWS), /「類股重挫」上次框錯位置：框太下面/);
});

/** 一支 Claude 排好、出完片的大盤小報 */
function claudeJob(root, id = '20261117-090000-cl01') {
  write(path.join(root, '工作紀錄', id, '_製作資料', 'job.json'), {
    id, template: 'dapan', owner: 'Ryan', title: '台股重挫', status: 'done', emotion: 'calm',
    createdAt: '2026-11-17T01:00:00.000Z', outputs: [{ name: 'output-dapan.mp4' }],
    planView: { rows: ROWS, images: IMAGES, chars: [] },
  });
  write(workFile(root, id, 'input', 'script.txt'), '===\n===\n台股重挫\n===\n內文\n');
  for (const f of IMAGES) write(workFile(root, id, 'input', f), '截圖');
  write(workFile(root, id, 'state', 'public', 'claude-annotations.json'), { by: 'claude', shots: [{ src: 'shot1.png', startCharIdx: 10, endCharIdx: 17 }] });
  write(workFile(root, id, 'state', 'public', 'heygen.mp4'), '講者影片');
  write(workFile(root, id, 'state', 'src', 'app-images.generated.json'), { images: IMAGES.map((f) => ({ file: f, width: 600, height: 400, page: 'sectorBars' })) });
  return id;
}
const 假子程序 = { spawn: () => ({ pid: 4242, unref() {}, on() {} }), execFileSync: () => '' };

test('API：送出檢查寫進修正紀錄；照修正重新出片帶 claude-fixed.json 與自動指示', async (t) => {
  const root = fixture(t);
  const id = claudeJob(root);
  const request = loadServer(root, { childProcess: 假子程序, idleTimers: true });

  const got = await request('GET', `/api/jobs/${id}/claude-review`);
  assert.equal(got.status, 200);
  assert.equal(got.body.rows.length, 3);

  const sent = await request('POST', `/api/jobs/${id}/claude-review`, { by: 'Ryan', items: [
    { i: 0, verdict: 'ok' },
    { i: 1, verdict: 'wrongBox', cell: { x: 20, y: 30, w: 200, h: 50 } },
    { i: 2, verdict: 'other', note: '這段應該放法說會的圖' },
  ] });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.logged, 2);
  const log = fs.readFileSync(path.join(root, '90_系統', '資料', 'corrections.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(log.map((r) => [r.type, r.kind, r.by]), [['Claude排錯', '框錯位置', 'Ryan'], ['Claude排錯', '其他', 'Ryan']]);
  // 第三階段：記下頁型，之後同一種頁面才找得到這些教訓
  assert.equal(log[0].page, 'sectorBars');
  assert.equal(log[0].memKey, 'sectorBars@1.50');
  // 重送一樣的不重記
  const again = await request('POST', `/api/jobs/${id}/claude-review`, { by: 'Ryan', items: sent.body.review.items });
  assert.equal(again.body.logged, 0);

  const redo = await request('POST', `/api/jobs/${id}/redo`, { note: '', useReview: true });
  assert.equal(redo.status, 200);
  const nj = redo.body.job;
  assert.deepEqual(nj.claudeFixed, { fixed: 1, hints: 0, noShot: 0 });
  assert.match(nj.claudeNote, /「台積電法說」上次其他：這段應該放法說會的圖/);
  const dir = fs.readdirSync(path.join(root, '工作紀錄')).find((d) => d.includes(nj.id));
  const fixed = JSON.parse(fs.readFileSync(path.join(root, '工作紀錄', dir, '素材', 'claude-fixed.json'), 'utf8'));
  assert.deepEqual(fixed.fixed.map((x) => [x.src, x.startCharIdx]), [['shot2.png', 18]]);
});

test('API：不是 Claude 排的、或還沒出完片，不能檢查', async (t) => {
  const root = fixture(t);
  const id = claudeJob(root);
  fs.rmSync(workFile(root, id, 'state', 'public', 'claude-annotations.json'));
  const request = loadServer(root, { childProcess: 假子程序, idleTimers: true });
  assert.equal((await request('GET', `/api/jobs/${id}/claude-review`)).status, 400);
});

// ── claude-shot-plan.js 讀 claude-fixed.json ──
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
function planWith(t, fixed, lessons = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-fixed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pub = path.join(dir, 'public');
  fs.mkdirSync(pub);
  const script = '今天台股大漲，收在41661點。聯發科大漲9.88%、台達電漲停。';
  fs.writeFileSync(path.join(pub, 'script.txt'), script);
  fs.writeFileSync(path.join(pub, 'shot1.png'), PNG);
  fs.writeFileSync(path.join(dir, 'images.json'), JSON.stringify({ images: [{ file: 'shot1.png', width: 1, height: 1, page: 'unknown',
    words: [{ t: '聯發科', x: 0, y: 0, w: 1, h: 1 }] }] }));
  fs.writeFileSync(path.join(dir, 'fixed.json'), JSON.stringify(fixed));
  fs.writeFileSync(path.join(dir, 'corrections.jsonl'), lessons.map((r) => JSON.stringify(r)).join('\n'));
  const fake = path.join(dir, 'fake-claude.js');
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs');
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.log'))}, input + '\\n');
const text = JSON.parse(input.trim().split('\\n')[0]).message.content.find((c) => c.type === 'text').text;
const unit = (text.match(/U(\\d+)：聯發科/) || [])[1];
const stepIds = [...text.matchAll(/^(U\\d+)：/gm)].map((m) => m[1]);
const reply = text.includes('子句') ? JSON.stringify({ segments: unit ? [{ image: 'shot1.png', from: 'U' + unit, to: 'U' + unit, title: '聯發科' }] : [], motions: [] })
  : JSON.stringify({ crop: [0, 0, 1, 1], steps: stepIds.map((u) => ({ unit: u, words: ['W1'] })), why: '聯發科' });
console.log(JSON.stringify({ type: 'result', is_error: false, result: reply }));
`);
  fs.chmodSync(fake, 0o755);
  const out = path.join(pub, 'claude-annotations.json');
  const stdout = execFileSync(process.execPath, [path.join(APP, 'scripts/claude-shot-plan.js'),
    `--script=${path.join(pub, 'script.txt')}`, `--images=${path.join(dir, 'images.json')}`, `--public=${pub}`, `--out=${out}`,
    `--motion-out=${path.join(pub, 'claude-motion.json')}`, `--fixed=${path.join(dir, 'fixed.json')}`,
    `--note=${path.join(dir, 'none.txt')}`, `--shot-names=${path.join(dir, 'none.json')}`, `--manual-motion=${path.join(dir, 'none.json')}`,
    `--lessons=${path.join(dir, 'corrections.jsonl')}`],
  { encoding: 'utf8', env: { ...process.env, CLAUDE_BIN: fake, CELL_PICKER: 'claude-cli' } });
  const calls = fs.existsSync(path.join(dir, 'calls.log')) ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8') : '';
  return { stdout, script, calls, data: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null };
}

test('claude-shot-plan：人工鎖住的段落原樣放進去，Claude 排的照常', (t) => {
  const r = planWith(t, { fixed: [{ startCharIdx: 0, endCharIdx: 5, src: 'shot1.png', cell: { x: 0, y: 0, w: 1, h: 1 } }], hints: [], noShot: [] });
  assert.match(r.stdout, /人工修正：1 段照人改的框鎖住/);
  const srcs = r.data.shots.map((s) => [s.startCharIdx, s._claude.cellSource || null]);
  assert.deepEqual(srcs[0], [0, 'manual-review']);
  assert.ok(r.data.shots.some((s) => s.title === '聯發科' && s._claude.cellSource !== 'manual-review'), 'Claude 排的聯發科那段還在');
});

test('claude-shot-plan：標「不該放截圖」的句子，Claude 排的拿掉', (t) => {
  // 字元索引不算標點（auto-shot --sentences 的算法）：聯發科那句是 14 起
  const r = planWith(t, { fixed: [], hints: [], noShot: [{ startCharIdx: 14, endCharIdx: 40 }] });
  assert.match(r.stdout, /那裡有人工修正，拿掉/);
  assert.equal(r.data, null, '這支只剩那一段，拿掉之後就沒有配圖');
});

test('計畫列補上那一段旁白與前後文（Claude 排的 _phrase 常是空的；編輯器要顯示放在哪句話）', () => {
  const chars = [...'今天台股暴跌外資賣超816億類股重挫'].map((c, i) => ({ i, c }));
  const [r] = R.withPhrases([{ i: 0, src: 'shot1.png', phrase: '', startCharIdx: 6, endCharIdx: 13 }], chars);
  assert.equal(r.phrase, '外資賣超816億');
  assert.equal(r.before, '今天台股暴跌');
  assert.equal(r.after, '類股重挫');
  const src = fs.readFileSync(path.join(APP, 'server/public/app.js'), 'utf8');
  // 編輯器顯示全文、可拖選改位置（2026-11-17 使用者：「應該要顯示全文才對」）
  assert.match(src, /mode: 'review', drag: null[\s\S]*?\$\('#edRangeWrap'\)\.hidden = false;\n\s+drawRange\(\);/);
});

test('Claude 沒用到的截圖：指定位置的記成「漏用這張圖」、有框就鎖住、沒框當位置提示；用過的圖或亂給的位置不收', () => {
  const chars = [...'今天台股暴跌外資賣超816億類股重挫台積電法說法說會'].map((c, i) => ({ i, c }));
  const extras = R.normalizeExtras([
    { src: 'shot4.png', verdict: 'missing', startCharIdx: 18, endCharIdx: 22, cell: { x: 1, y: 2, w: 30, h: 10 }, imgW: 600, imgH: 400 },
    { src: 'shot1.png', verdict: 'missing', startCharIdx: 0, endCharIdx: 3 },          // Claude 用過了
    { src: 'shot9.png', verdict: 'missing', startCharIdx: 0, endCharIdx: 3 },          // 不是這支的圖
  ], IMAGES, ROWS, chars);
  assert.deepEqual(extras.map((x) => x.src), ['shot4.png']);
  assert.equal(R.normalizeExtras([{ src: 'shot4.png', verdict: 'missing', startCharIdx: 5, endCharIdx: 999 }], IMAGES, ROWS, chars).length, 0);
  const c = R.correctionRows([], ROWS, [], extras, chars);
  assert.deepEqual(c.rows.map((r) => [r.kind, r.phrase, r.to]), [['漏用這張圖', '台積電法說', 'shot4.png']]);
  assert.equal(R.correctionRows([], ROWS, c.sigs, extras, chars).rows.length, 0, '重送不重記');
  assert.deepEqual(R.memoryItems([], ROWS, extras, chars).map((m) => m.phrase), ['台積電法說']);
  assert.deepEqual(R.fixedPlan([], ROWS, extras).fixed.map((f) => [f.src, f.startCharIdx]), [['shot4.png', 18]]);
  const noBox = R.normalizeExtras([{ src: 'shot4.png', verdict: 'missing', startCharIdx: 18, endCharIdx: 22 }], IMAGES, ROWS, chars);
  assert.deepEqual(R.fixedPlan([], ROWS, noBox).hints, [{ startCharIdx: 18, endCharIdx: 22, src: 'shot4.png' }]);
});

test('放錯句子：人在全文上改的位置要記下來、照修正重出時鎖在新位置；亂給的範圍回到原本的', () => {
  const chars = [...'今天台股暴跌外資賣超816億類股重挫台積電法說法說會'].map((c, i) => ({ i, c }));
  const items = R.normalizeItems([{ i: 1, verdict: 'wrongPlace', startCharIdx: 0, endCharIdx: 5 }], ROWS, IMAGES, chars);
  assert.deepEqual([items[0].startCharIdx, items[0].endCharIdx], [0, 5]);
  const c = R.correctionRows(items, ROWS, [], [], chars);
  assert.equal(c.rows[0].kind, '放錯句子');
  assert.equal(c.rows[0].manualPhrase, '今天台股暴跌');
  assert.deepEqual(R.fixedPlan(items, ROWS).fixed.map((f) => [f.src, f.startCharIdx, f.endCharIdx]), [['shot2.png', 0, 5]]);
  const bad = R.normalizeItems([{ i: 1, verdict: 'wrongPlace', startCharIdx: 5, endCharIdx: 999 }], ROWS, IMAGES, chars);
  assert.deepEqual([bad[0].startCharIdx, bad[0].endCharIdx], [18, 23]);
  const src = fs.readFileSync(path.join(APP, 'server/public/app.js'), 'utf8');
  assert.match(src, /\['wrongPlace', '放錯句子'\]/);
});

// ── 第三階段：以前排錯的教訓給 Claude 看 ──
const L = require(path.join(APP, 'scripts/claude-lessons'));
const pageName = (p) => ({ sectorBars: '類股漲跌', indexChart: '大盤走勢' }[p] || '');
const LESSON_ROWS = [
  { at: '2026-11-17T03:00:00Z', type: 'Claude排錯', kind: '框錯位置', phrase: '類股重挫', from: 'shot2.png', to: 'shot2.png',
    autoCell: { x: 180, y: 250, w: 100, h: 40 }, autoRegion: { x: 0, y: 0, w: 600, h: 200 },
    manualCell: { x: 60, y: 60, w: 300, h: 100 }, manualRegion: { x: 0, y: 0, w: 600, h: 240 },
    size: { w: 600, h: 400 }, page: 'sectorBars', memKey: 'sectorBars@1.50', toPage: 'sectorBars', toMemKey: 'sectorBars@1.50',
    reason: { tags: ['框錯位置'], note: '要框綠色長條' } },
  { at: '2026-11-17T02:00:00Z', type: 'Claude排錯', kind: '放錯句子', phrase: '外資賣超816億', manualPhrase: '今天台股暴跌',
    from: 'shot1.png', to: 'shot1.png', page: 'indexChart', memKey: 'indexChart@0.46', reason: { tags: ['放錯句子'], note: '' } },
  { at: '2026-11-17T01:00:00Z', type: 'Claude排錯', kind: '框錯位置', phrase: '只說錯', from: 'shot2.png', to: 'shot2.png',
    autoCell: { x: 1, y: 1, w: 9, h: 9 }, manualCell: { x: 1, y: 1, w: 9, h: 9 }, size: { w: 600, h: 400 }, memKey: 'sectorBars@1.50' },
  { at: '2026-11-17T00:00:00Z', type: '改框', phrase: '舊的人工修正' },
];

test('教訓：只讀「Claude排錯」、新的在前；排哪張圖配哪句用的那份不含框的問題', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'corrections.jsonl');
  fs.writeFileSync(f, [...LESSON_ROWS].reverse().map((r) => JSON.stringify(r)).join('\n') + '\n壞掉的一行\n');
  const rows = L.read(f);
  assert.deepEqual(rows.map((r) => r.phrase), ['類股重挫', '外資賣超816億', '只說錯']);
  assert.deepEqual(L.planLessons(rows, pageName), ['「大盤走勢」頁被放在「外資賣超816億」，應該放在「今天台股暴跌」']);
  assert.deepEqual(L.read(path.join(dir, 'none.jsonl')), [], '沒有修正紀錄就沒有教訓');
});

test('教訓：框只給同一種頁面、沒給答案的不算；換算成這張圖的座標', () => {
  const rows = LESSON_ROWS.filter((r) => r.type === 'Claude排錯');
  const box = L.boxLessons(rows, 'sectorBars@1.50');
  assert.equal(box.length, 1);
  assert.equal(L.boxLessons(rows, 'indexChart@0.46').length, 0);
  const text = L.boxLessonsText(box, 300, 200);
  assert.match(text, /Claude 裁 \[0, 0, 300, 100\]、框 \[90, 125, 50, 20\] → 人改成 裁 \[0, 0, 300, 120\]、框 \[30, 30, 150, 50\]（要框綠色長條）/);
  assert.equal(L.planLessonsText([]), '');
  assert.equal(L.boxLessonsText([], 1, 1), '');
});

test('教訓有上限：排配圖只附最近 8 筆，不會讓提示越來越長', () => {
  const many = Array.from({ length: 30 }, (_, k) => ({ type: 'Claude排錯', kind: '不該放截圖', phrase: `第${k}句`, page: 'sectorBars',
    at: `2026-11-17T00:${String(k).padStart(2, '0')}:00Z` }));
  const lines = L.planLessons(L.read.length ? many.sort((a, b) => b.at.localeCompare(a.at)) : many, pageName);
  assert.equal(lines.length, L.PLAN_MAX);
  assert.match(lines[0], /第29句/);
});

test('claude-shot-plan：有修正紀錄就把教訓附進兩個 prompt', (t) => {
  const r = planWith(t, { fixed: [], hints: [], noShot: [] }, [
    { at: '2026-11-17T03:00:00Z', type: 'Claude排錯', kind: '不該放截圖', phrase: '收在41661點', page: 'unknown' },
    { at: '2026-11-17T02:00:00Z', type: 'Claude排錯', kind: '框錯位置', phrase: '聯發科', from: 'a.png', to: 'a.png',
      autoCell: { x: 0, y: 0, w: 1, h: 1 }, manualCell: { x: 0, y: 0, w: 1, h: 1 }, manualRegion: { x: 0, y: 0, w: 1, h: 1 },
      size: { w: 1, h: 1 }, memKey: 'unknown-other@1.00', reason: { note: '框整列' } },
  ]);
  assert.match(r.stdout, /附上 1 筆以前排錯的紀錄給 Claude 參考/);
  assert.match(r.stdout, /1 張卡片附上了以前框錯被改過的紀錄/);
  assert.match(r.calls, /以前 Claude 排錯、被剪輯師在成品頁改過的/);
  assert.match(r.calls, /同一種頁面\*\*以前 Claude 框錯/);
});
