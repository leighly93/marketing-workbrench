'use strict';

// 模擬模式整條出片（不含 Remotion 渲染）：在隔離工作區跑 run.js --stop-before-render，
// 確認 素材 → 模擬配音／講者影片 → 備份 → 加速 → 截圖分析 → 模擬轉錄 → 字幕校正 → 配圖計畫 都接得起來。
// 渲染那一段由 npm run e2e 從工作台 API 一路跑到成品。需要 ffmpeg 與 bash。
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { createSandbox } = require('../../tools/sandbox');

const has = (cmd, args) => { try { execFileSync(cmd, args, { stdio: 'ignore' }); return true; } catch (_) { return false; } };
const ready = has('ffmpeg', ['-version']) && has('bash', ['-c', 'exit 0']);

const SCRIPT = '台積電→台基電\n===\n今日盤勢\n===\n今天台股上漲兩百點，台積電(image1)領軍走強(image1)。外資買超百億，電子股全面翻紅。\n';

describe.skipIf(!ready)('模擬出片（WORKBENCH_MOCK=1）', () => {
  let sb;
  beforeAll(() => {
    sb = createSandbox({ env: { WORKBENCH_MOCK: '1' }, prefix: 'workbench-mock-pipeline-' });
    const pub = sb.path('video', 'remotion', 'public');
    fs.writeFileSync(path.join(pub, 'script.txt'), SCRIPT);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=750x1334', '-frames:v', '1', path.join(pub, 'image1.png')]);
  });
  afterAll(() => sb && sb.cleanup());

  // 步驟記錄跟工作台一樣用 WORKBENCH_STEPS_FILE 指定（正式服務是 jobs/<id>/_meta/steps.json）。
  const stepsFile = () => sb.path('storage', 'tmp', 'steps.json');
  const run = (...args) => spawnSync(process.execPath, [sb.path('video', 'run.js'), '--template=midday', ...args], {
    cwd: sb.path('video', 'remotion'), encoding: 'utf8',
    // 不繼承外面的金鑰：證明模擬模式真的不需要它們
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, WORKBENCH_MOCK: '1', WORKBENCH_STEPS_FILE: stepsFile() },
  });
  const src = (...p) => sb.path('video', 'remotion', 'src', ...p);
  const json = (...p) => JSON.parse(fs.readFileSync(src(...p), 'utf8'));
  const stepsById = () => Object.fromEntries(JSON.parse(fs.readFileSync(stepsFile(), 'utf8')).steps.map((s) => [s.id, s]));

  test('跑到配圖計畫停下，各步產物齊全', () => {
    const r = run('--stop-before-render');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/模擬模式/);
    expect(r.stdout).toMatch(/--stop-before-render/);

    const pub = sb.path('video', 'remotion', 'public');
    expect(fs.existsSync(path.join(pub, 'minimax.mp3'))).toBe(true);
    // 加速過的講者影片帶記號；長度與 video-meta 一致
    const comment = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags=comment', '-of', 'default=nw=1:nk=1', path.join(pub, 'heygen.mp4')], { encoding: 'utf8' });
    expect(comment).toMatch(/marketing-video:sped/);
    const meta = json('video-meta.json');
    expect(meta.heygenDurationSec).toBeGreaterThan(3);
    expect(meta.titleText).toBe('今日盤勢');

    // 字幕：發音替換還原成稿件原字，時間在影片長度內
    const subs = json('subtitles.json');
    const text = subs.segments.map((s) => s.text).join('');
    expect(text).toContain('台積電');
    expect(text).not.toContain('台基電');
    expect(subs.segments.at(-1).end).toBeLessThanOrEqual(meta.heygenDurationSec + 0.05);

    // 截圖分析（mock OCR）與配圖計畫：手動標記的那一段排進計畫
    expect(json('app-images.generated.json').images).toHaveLength(1);
    const plan = json('MiddayFocus', 'midday-shots.generated.json');
    expect(plan.some((shot) => JSON.stringify(shot).includes('image1'))).toBe(true);

    // 備份在加速之前：沒有記號的原速影片
    const backups = fs.readdirSync(sb.path('storage', 'tmp', 'backups', 'unassigned'), { recursive: true }).map(String);
    expect(backups.some((f) => f.endsWith('heygen.mp4'))).toBe(true);

    expect(fs.existsSync(sb.path('.run.lock'))).toBe(false);

    // 步驟記錄：每一步都有、沒 render 的那步沒有
    const steps = stepsById();
    for (const id of ['assets', 'generate', 'image-analysis', 'backup', 'speed', 'transcribe', 'shots', 'motion-clips']) {
      expect(['ok', 'warning'], `${id} 應該有紀錄`).toContain(steps[id] && steps[id].status);
    }
    expect(steps.transcribe).toMatchObject({ status: 'ok', label: '字幕轉錄', attempt: 1 });
    expect(steps.shots).toMatchObject({ status: 'ok', label: '配圖計畫' });
    expect(steps.render).toBeUndefined();
  }, 120000);

  test('沿用現成影片重跑（--skip-generate）不會重複加速', () => {
    const r = run('--stop-before-render', '--skip-generate');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/之前就被加速過了/);
    // 同一個記錄檔再跑一次：generate 這次是 skipped，transcribe 是第二次
    const steps = stepsById();
    expect(steps.generate).toMatchObject({ status: 'skipped', note: '用現成的講者影片' });
    expect(steps.transcribe).toMatchObject({ status: 'ok', attempt: 2 });
  }, 120000);
});
