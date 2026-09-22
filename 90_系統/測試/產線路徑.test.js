'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { applicationPath } = require('../paths');

const repository = path.resolve(__dirname, '../..');
const sourceApp = applicationPath(repository);
const script = '# 合成發音規則\n===\n合成標題\n===\n(shot:示意)今天市場穩定。(shot:示意)\n';

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value));
}

function fixture(t, scripts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '影片 產線路徑測試 '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = applicationPath(root);
  fs.mkdirSync(path.join(app, 'public'), { recursive: true });
  fs.mkdirSync(path.join(app, 'src', 'Focusstock'), { recursive: true });
  for (const name of ['paths.js', '工作儲存.js']) fs.copyFileSync(path.join(repository, '90_系統', name), path.join(root, '90_系統', name));
  fs.symlinkSync(path.join(sourceApp, 'node_modules'), path.join(app, 'node_modules'), 'dir');
  for (const name of scripts) {
    const destination = path.join(app, 'scripts', name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(sourceApp, 'scripts', name), destination);
  }
  // 複製正式程式到合成副本；不複製 .env、憑證或目前使用者工作。
  // 外部 OCR 本身不在這組測試範圍，只允許版本檢查的合成回覆。
  const guard = path.join(root, '禁止外部呼叫.cjs');
  write(guard, `const cp = require('node:child_process');
const blocked = () => { throw new Error('隔離測試禁止網路及外部程序'); };
cp.exec = cp.execSync = cp.execFile = cp.spawn = cp.spawnSync = blocked;
cp.execFileSync = (cmd, args) => {
  if (cmd === 'tesseract' && args.length === 1 && args[0] === '--version') return Buffer.from('fixture');
  return blocked();
};
global.fetch = blocked;
require('node:http').request = require('node:https').request = blocked;
`);
  const run = (name, args = [], cwd = app) => execFileSync(process.execPath,
    ['--require', guard, path.join(app, 'scripts', name), ...args], {
      cwd, encoding: 'utf8', timeout: 15000,
      env: { PATH: process.env.PATH, WORKBENCH_CALLER_CWD: root, OCR_ENGINE: 'tesseract' },
    });
  return { root, app, run };
}

// 2026-09-22：三大法人／焦點股日報／投廣模板整組移除，這裡只剩現存的三個版型。
// use-brand.js 留著 —— 它服務的是 gen-video.js（Lumina）那條線，不是被刪的投廣版型。
test('固定素材從 workspace/共用素材 複製到 app/public，保留內容且不產生第二份來源', (t) => {
  const templates = [['dapan', '大盤小報'], ['midday', '盤中焦點'], ['usstock', '美股焦點']];
  const { root, app, run } = fixture(t, [...templates.map(([name]) => `use-${name}-assets.js`), 'use-brand.js']);
  for (const [template, brand] of templates) {
    for (const name of ['intro-frame.jpg', 'header-overlay.png', 'bgm.wav', 'intro-frame_Horizontal.png']) {
      write(path.join(root, '共用素材', brand, name), Buffer.from(`合成素材:${brand}:${name}\0\xff`));
    }
    run(`use-${template}-assets.js`);
    for (const [source, destination] of [['intro-frame.jpg', `${template}-intro-frame.jpg`], ['header-overlay.png', `${template}-header-overlay.png`], ['bgm.wav', `${template}-bgm.wav`]]) {
      assert.deepEqual(fs.readFileSync(path.join(root, '共用素材', brand, source)), fs.readFileSync(path.join(app, 'public', destination)));
    }
  }
  for (const name of ['frame.png', 'outro.mp4', 'bgm.wav']) write(path.join(root, '共用素材', '籌碼K線', name), `合成品牌素材:${name}`);
  run('use-brand.js', ['籌碼K線']);
  assert.equal(fs.readFileSync(path.join(app, 'public', 'frame.png'), 'utf8'), '合成品牌素材:frame.png');
  assert.equal(fs.existsSync(path.join(app, 'assets')), false);
  assert.equal(fs.existsSync(path.join(root, 'public')), false);
});

// 2026-09-22：parse-institution-script.js／parse-focusstock-script.js 隨版型移除。
// parse-script.js 留著 —— 它寫的 overlays／textcards.generated.json 仍被共用的 timeline.ts 靜態 import。
test('四種稿件解析沿用原 marker 契約，生成檔只寫 app/src', (t) => {
  const parsers = ['parse-dapan-script.js', 'parse-midday-script.js', 'parse-usstock-script.js', 'parse-script.js'];
  const { root, app, run } = fixture(t, [...parsers, 'script-utils.js']);
  write(path.join(app, 'public', 'script.txt'), script);
  for (const name of parsers) run(name);
  const shots = JSON.parse(fs.readFileSync(path.join(app, 'src', 'DapanXiaobao', 'dapan-shots.generated.json'), 'utf8'));
  assert.equal(shots[0].src, '示意.png');
  assert.equal(fs.existsSync(path.join(root, 'src')), false);
});

test('auto-shot 從不同 CWD 解析相對 job/input/images，--out 指向系統產線暫存', (t) => {
  const { root, app, run } = fixture(t, ['auto-shot.js', 'script-utils.js', 'shot-memory.js', 'image-size.js']);
  const images = { images: [{ file: 'fixture.png', width: 100, height: 100, words: [] }] };
  write(path.join(root, 'jobs', 'fixture', 'input', 'script.txt'), script);
  write(path.join(app, 'src', 'app-images.generated.json'), images);
  const args = ['--script=jobs/fixture/input/script.txt', '--sentences'];
  assert.deepEqual(JSON.parse(run('auto-shot.js', args, root)), JSON.parse(run('auto-shot.js', args, app)));
  write(path.join(root, 'jobs', 'fixture', 'images.json'), images);
  write(path.join(root, 'jobs', 'fixture', 'suggest.json'), []);
  fs.mkdirSync(path.join(root, '90_系統/暫存/產線輸出'), { recursive: true });
  run('auto-shot.js', ['--script=jobs/fixture/input/script.txt', '--images=jobs/fixture/images.json', '--suggest-cells=jobs/fixture/suggest.json', '--out', 'out/fixture.json']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '90_系統', '暫存', '產線輸出', 'fixture.json'), 'utf8')), []);
  assert.equal(fs.existsSync(path.join(app, 'out')), false);
});

test('發音檢查 CLI 及 opts.root=workspace 均使用 app 字幕與原套件', (t) => {
  const { root, app, run } = fixture(t, ['check-pronunciation.js']);
  const subtitles = { segments: [{ words: [{ word: '你', start: 0, end: 1 }] }] };
  write(path.join(app, 'src', 'subtitles.json'), subtitles);
  write(path.join(app, 'src', 'subtitles.original.json'), subtitles);
  const result = JSON.parse(run('check-pronunciation.js', ['--json']));
  assert.equal(result.checked, 1);
  assert.equal(result.needInstall, undefined);
  assert.equal(require(path.join(app, 'scripts/check-pronunciation.js')).check({ root }).checked, 1);
});

test('備份跨 app/workspace 保存、重跑去重，舊兩參數介面保持可用', (t) => {
  const { root, app } = fixture(t, ['public-utils.js']);
  const { backupJob } = require(path.join(app, 'scripts/public-utils.js'));
  write(path.join(app, 'public', 'script.txt'), script);
  write(path.join(app, 'public', 'heygen.mp4'), '合成影片內容');
  const backup = backupJob(app, 'dapan', root);
  assert.ok(backup.startsWith(path.join(root, '90_系統', '製作備份', '未指定工作') + path.sep));
  assert.equal(fs.readFileSync(path.join(backup, 'heygen.mp4'), 'utf8'), '合成影片內容');
  assert.equal(backupJob(app, 'dapan', root), null);
  assert.equal(fs.existsSync(path.join(app, 'backups')), false);
  const legacy = path.join(root, '舊介面合成副本');
  write(path.join(legacy, 'public', 'script.txt'), script);
  assert.ok(backupJob(legacy, 'dapan').startsWith(path.join(legacy, '90_系統', '製作備份', '未指定工作') + path.sep));
});

test('OCR 腳本在鏡像目錄可載入共用路徑，沒有憑證且不呼叫外部 OCR', (t) => {
  const { root, app, run } = fixture(t, ['analyze-app-images.js', 'ocr-engine.js', 'ocr-vision.swift', 'image-size.js']);
  run('analyze-app-images.js');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(app, 'src', 'app-images.generated.json'), 'utf8')), { images: [] });
  assert.equal(fs.existsSync(path.join(root, '.env')), false);
  assert.equal(fs.existsSync(path.join(root, 'src')), false);
});

test('有工作 ID 的產線備份各自歸回工作，不共用去重狀態或另建根 backups', (t) => {
  const { root, app } = fixture(t, ['public-utils.js']);
  const { backupJob } = require(path.join(app, 'scripts/public-utils.js'));
  const previous = process.env.WORKBENCH_JOB_ID;
  write(path.join(app, 'public/script.txt'), '同一份合成稿件');
  write(path.join(app, 'public/heygen.mp4'), '同一份合成講者');
  try {
    for (const id of ['first-job', 'second-job']) {
      write(path.join(root, '工作紀錄', id, '_製作資料/job.json'), { id, status: 'review' });
      process.env.WORKBENCH_JOB_ID = id;
      const backup = backupJob(app, 'dapan', root);
      assert.ok(backup.startsWith(path.join(root, '工作紀錄', id, '_製作資料/備份/產線快照') + path.sep));
      assert.equal(fs.readFileSync(path.join(backup, 'script.txt'), 'utf8'), '同一份合成稿件');
      assert.equal(backupJob(app, 'dapan', root), null);
    }
  } finally {
    if (previous === undefined) delete process.env.WORKBENCH_JOB_ID;
    else process.env.WORKBENCH_JOB_ID = previous;
  }
  assert.equal(fs.existsSync(path.join(root, 'backups')), false);
  assert.equal(fs.existsSync(path.join(root, '90_系統/製作備份')), false);
});

test('App 定位 CLI 的圖片參數從 app CWD 仍可取得 workspace/jobs 素材', (t) => {
  const { root, app, run } = fixture(t, ['app-locate.js']);
  // 定位演算法另有 OCR 契約；這裡只替換其邊界以驗證 CLI 傳入的真實圖片位置。
  write(path.join(app, 'scripts', 'app-locator.js'), 'exports.locate = (file) => ({ok:false,file});');
  write(path.join(app, 'scripts', 'app-locators.json'), { pages: { fixture: { targets: { body: {} } } } });
  const image = path.join(root, 'jobs', 'fixture', 'input', 'image.png');
  write(image, '合成圖片');
  assert.equal(JSON.parse(run('app-locate.js', ['jobs/fixture/input/image.png', 'fixture.body'])).file, fs.realpathSync(image));
});
