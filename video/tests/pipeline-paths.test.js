'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { applicationPath } = require('../../shared/paths');

const repository = path.resolve(__dirname, '..', '..');
const sourcePipeline = path.join(repository, 'video', 'pipeline');
const script = '# 合成發音規則\n===\n合成標題\n===\n(shot:示意)今天市場穩定。(shot:示意)\n';

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value));
}

function fixture(t, scripts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '影片 產線路徑測試 '));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = applicationPath(root);
  fs.mkdirSync(path.join(app, 'public'), { recursive: true });
  fs.mkdirSync(path.join(app, 'src', 'Focusstock'), { recursive: true });
  fs.mkdirSync(path.join(root, 'shared'), { recursive: true });
  for (const name of ['paths.js', 'job-store.js']) fs.copyFileSync(path.join(repository, 'shared', name), path.join(root, 'shared', name));
  fs.symlinkSync(path.join(repository, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  const pipe = path.join(root, 'video', 'pipeline');
  // 產線腳本會讀版型設定表，整個 video/templates 一起放進合成副本。
  fs.cpSync(path.join(repository, 'video', 'templates'), path.join(root, 'video', 'templates'), { recursive: true });
  for (const name of scripts) {
    // 'subtitles/x.js' 這種帶資料夾的名字相對於 video/；沒帶的放 video/pipeline/
    const destination = name.includes('/') ? path.join(root, 'video', name) : path.join(pipe, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(name.includes('/') ? path.join(repository, 'video', name) : path.join(sourcePipeline, name), destination);
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
    ['--require', guard, name.includes('/') ? path.join(root, 'video', name) : path.join(pipe, name), ...args], {
      cwd, encoding: 'utf8', timeout: 15000,
      env: { PATH: process.env.PATH, WORKBENCH_CALLER_CWD: root, OCR_ENGINE: 'tesseract' },
    });
  return { root, app, pipe, run };
}

// 版型素材與稿件解析的測試在 video/templates/（assets.test.js、parse-shots.test.js、cli.test.js）。
// use-brand.js 服務的是 gen-video.js（Lumina）那條線：把整個品牌資料夾複製到 public/。
test('品牌素材從 storage/shared-assets 整包複製到 public', (t) => {
  const { root, app, run } = fixture(t, ['use-brand.js']);
  for (const name of ['frame.png', 'outro.mp4', 'bgm.wav']) write(path.join(root, 'storage', 'shared-assets', 'chouma-kline', name), `合成品牌素材:${name}`);
  run('use-brand.js', ['chouma-kline']);
  assert.equal(fs.readFileSync(path.join(app, 'public', 'frame.png'), 'utf8'), '合成品牌素材:frame.png');
});

// parse-script.js 寫的 overlays／textcards.generated.json 仍被共用的 timeline.ts 靜態 import。
test('通用稿件解析沿用原 marker 契約，生成檔寫到 src', (t) => {
  const { app, run } = fixture(t, ['parse-script.js', 'script-utils.js']);
  write(path.join(app, 'public', 'script.txt'), script);
  write(path.join(app, 'src', 'video-meta.json'), { headerDate: '0101' });
  run('parse-script.js');
  assert.ok(fs.existsSync(path.join(app, 'src', 'overlays.generated.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(app, 'src', 'video-meta.json'), 'utf8')).titleText, '合成標題');
  assert.equal(JSON.parse(fs.readFileSync(path.join(app, 'src', 'video-meta.json'), 'utf8')).headerDate, '0101', '其他欄位要保留');
});

test('auto-shot 從不同 CWD 解析相對 job/input/images，--out 指向系統產線暫存', (t) => {
  const { root, app, pipe, run } = fixture(t, ['auto-shot.js', 'script-utils.js', 'shot-memory.js', 'image-size.js']);
  const images = { images: [{ file: 'fixture.png', width: 100, height: 100, words: [] }] };
  write(path.join(root, 'storage', 'jobs', 'fixture', 'input', 'script.txt'), script);
  write(path.join(app, 'src', 'app-images.generated.json'), images);
  const args = ['--script=jobs/fixture/input/script.txt', '--sentences'];
  assert.deepEqual(JSON.parse(run('auto-shot.js', args, root)), JSON.parse(run('auto-shot.js', args, app)));
  write(path.join(root, 'storage', 'jobs', 'fixture', 'images.json'), images);
  write(path.join(root, 'storage', 'jobs', 'fixture', 'suggest.json'), []);
  fs.mkdirSync(path.join(root, 'storage/tmp/pipeline-output'), { recursive: true });
  run('auto-shot.js', ['--script=jobs/fixture/input/script.txt', '--images=jobs/fixture/images.json', '--suggest-cells=jobs/fixture/suggest.json', '--out', 'storage/tmp/pipeline-output/fixture.json']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'storage', 'tmp', 'pipeline-output', 'fixture.json'), 'utf8')), []);
  assert.equal(fs.existsSync(path.join(app, 'out')), false);
});

test('發音檢查 CLI 及 opts.root=workspace 均使用 app 字幕與原套件', (t) => {
  const { root, app, run } = fixture(t, ['subtitles/check-pronunciation.js']);
  const subtitles = { segments: [{ words: [{ word: '你', start: 0, end: 1 }] }] };
  write(path.join(app, 'src', 'subtitles.json'), subtitles);
  write(path.join(app, 'src', 'subtitles.original.json'), subtitles);
  const result = JSON.parse(run('subtitles/check-pronunciation.js', ['--json']));
  assert.equal(result.checked, 1);
  assert.equal(result.needInstall, undefined);
  assert.equal(require(path.join(root, 'video', 'subtitles', 'check-pronunciation.js')).check({ root }).checked, 1);
});

test('備份跨 app/workspace 保存、重跑去重，舊兩參數介面保持可用', (t) => {
  const { root, app, pipe } = fixture(t, ['public-utils.js']);
  const { backupJob } = require(path.join(pipe, 'public-utils.js'));
  write(path.join(app, 'public', 'script.txt'), script);
  write(path.join(app, 'public', 'heygen.mp4'), '合成影片內容');
  const backup = backupJob(app, 'dapan', root);
  assert.ok(backup.startsWith(path.join(root, 'storage', 'tmp', 'backups', 'unassigned') + path.sep));
  assert.equal(fs.readFileSync(path.join(backup, 'heygen.mp4'), 'utf8'), '合成影片內容');
  assert.equal(backupJob(app, 'dapan', root), null);
  assert.equal(fs.existsSync(path.join(app, 'backups')), false);
  const legacy = path.join(root, '舊介面合成副本');
  write(path.join(legacy, 'public', 'script.txt'), script);
  assert.ok(backupJob(legacy, 'dapan').startsWith(path.join(legacy, 'storage', 'tmp', 'backups', 'unassigned') + path.sep));
});

test('OCR 腳本在鏡像目錄可載入共用路徑，沒有憑證且不呼叫外部 OCR', (t) => {
  const { root, app, pipe, run } = fixture(t, ['analyze-app-images.js', 'ocr-engine.js', 'ocr-vision.swift', 'image-size.js']);
  run('analyze-app-images.js');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(app, 'src', 'app-images.generated.json'), 'utf8')), { images: [] });
  assert.equal(fs.existsSync(path.join(root, '.env')), false);
});

test('有工作 ID 的產線備份各自歸回工作，不共用去重狀態或另建根 backups', (t) => {
  const { root, app, pipe } = fixture(t, ['public-utils.js']);
  const { backupJob } = require(path.join(pipe, 'public-utils.js'));
  const previous = process.env.WORKBENCH_JOB_ID;
  write(path.join(app, 'public/script.txt'), '同一份合成稿件');
  write(path.join(app, 'public/heygen.mp4'), '同一份合成講者');
  try {
    for (const id of ['first-job', 'second-job']) {
      write(path.join(root, 'storage', 'jobs', id, '_meta/job.json'), { id, status: 'review' });
      process.env.WORKBENCH_JOB_ID = id;
      const backup = backupJob(app, 'dapan', root);
      assert.ok(backup.startsWith(path.join(root, 'storage', 'jobs', id, '_meta/backups/pipeline-snapshot') + path.sep));
      assert.equal(fs.readFileSync(path.join(backup, 'script.txt'), 'utf8'), '同一份合成稿件');
      assert.equal(backupJob(app, 'dapan', root), null);
    }
  } finally {
    if (previous === undefined) delete process.env.WORKBENCH_JOB_ID;
    else process.env.WORKBENCH_JOB_ID = previous;
  }
  assert.equal(fs.existsSync(path.join(root, 'backups')), false);
  assert.equal(fs.existsSync(path.join(root, 'storage/tmp/backups')), false);
});

test('App 定位 CLI 的圖片參數從 app CWD 仍可取得 workspace/jobs 素材', (t) => {
  const { root, app, pipe, run } = fixture(t, ['app-locate.js']);
  // 定位演算法另有 OCR 契約；這裡只替換其邊界以驗證 CLI 傳入的真實圖片位置。
  write(path.join(pipe, 'app-locator.js'), 'exports.locate = (file) => ({ok:false,file});');
  write(path.join(pipe, 'app-locators.json'), { pages: { fixture: { targets: { body: {} } } } });
  const image = path.join(root, 'storage', 'jobs', 'fixture', 'input', 'image.png');
  write(image, '合成圖片');
  assert.equal(JSON.parse(run('app-locate.js', ['jobs/fixture/input/image.png', 'fixture.body'])).file, fs.realpathSync(image));
});
