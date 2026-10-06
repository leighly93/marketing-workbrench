#!/usr/bin/env node
// @ts-check
'use strict';

/**
 * 版型命令列入口：讀參數、讀寫檔、呼叫 Remotion。邏輯在 parse-shots.js、assets.js、registry.js。
 *
 *   node video/templates/cli.js assets --template=dapan   複製固定素材到 public/
 *   node video/templates/cli.js parse  --template=dapan   稿件 → 配圖計畫，日期與標題寫進 video-meta.json
 *   node video/templates/cli.js render --template=dapan   渲染這個版型的所有成品到 storage/tmp/pipeline-output/
 *
 * npm 入口：npm run template -- <指令> --template=<版型>
 */
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { workspaceRoot, sharedAssetsPath, outputPath } = require('../../shared/paths');
const { getTemplate, planPath } = require('./registry');
const { parseShots, titleFromScript, headerDateOf } = require('./parse-shots');
const { copyTemplateAssets } = require('./assets');

const REMOTION_ROOT = path.resolve(__dirname, '..', 'remotion');

/**
 * @param {{ template: string, root?: string, fs?: typeof import('node:fs'), log?: (m: string) => void }} o
 */
function assetsCommand({ template, root = REMOTION_ROOT, fs = require('node:fs'), log = console.log }) {
  const t = getTemplate(template);
  const { copied, empty } = copyTemplateAssets(t, {
    assetsRoot: sharedAssetsPath(workspaceRoot(root)), publicDir: path.join(root, 'public'), fs,
  });
  for (const name of empty) log(`⚠️  ${t.assets.dir}/${name} 是 0 byte（可能上傳／同步沒完成），目標檔也會是壞檔`);
  for (const c of copied) log(`  ✓ ${t.assets.dir}/${c.from}  →  public/${c.to}（${c.size} bytes）`);
  log(`✅ ${t.label}套版素材已複製（共 ${copied.length} 項）`);
  return copied;
}

/**
 * @param {{ template: string, root?: string, now?: Date, fs?: typeof import('node:fs'), log?: (m: string) => void }} o
 */
function parseCommand({ template, root = REMOTION_ROOT, now = new Date(), fs = require('node:fs'), log = console.log }) {
  const t = getTemplate(template);
  const publicDir = path.join(root, 'public');
  const scriptPath = path.join(publicDir, 'script.txt');
  if (!fs.existsSync(scriptPath)) throw new Error(`找不到 ${scriptPath}`);
  const scriptRaw = fs.readFileSync(scriptPath, 'utf-8');

  const { shots, skipped } = parseShots(scriptRaw, { exists: (file) => fs.existsSync(path.join(publicDir, file)) });
  for (const name of skipped) log(`⚠️  shot「${name}」的內容在清洗後沒有任何字元，已跳過`);
  const plan = path.join(root, planPath(template));
  fs.mkdirSync(path.dirname(plan), { recursive: true });
  fs.writeFileSync(plan, JSON.stringify(shots, null, 2));
  log(`✅ ${t.label}解析完成：${shots.length} 個截圖標記 → ${path.relative(root, plan)}`);
  for (const s of shots) log(`  ${s.src}  char idx：[${s.startCharIdx}, ${s.endCharIdx}]  原句：${s._phrase}`);

  // video-meta.json 是多個步驟共用的檔案：只動 headerDate 與 titleText，其他欄位保留。
  const metaPath = path.join(root, 'src', 'video-meta.json');
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf-8')) : {};
  meta.headerDate = headerDateOf(now);
  const title = titleFromScript(scriptRaw);
  if (title) meta.titleText = title;
  else log('ℹ️  script.txt 沒有標題段（=== 少於 2 個），titleText 不變');
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  log(`✅ video-meta.json：headerDate=${meta.headerDate}${title ? `，titleText=${title.replace(/\n/g, ' / ')}` : ''}`);
  return { shots, meta };
}

/**
 * Remotion 只在 package.json 那層找設定檔，所以從 repository 根執行並指定 --config。
 * @param {{ template: string, root?: string, exec?: typeof execFileSync, log?: (m: string) => void }} o
 */
function renderCommand({ template, root = REMOTION_ROOT, exec = execFileSync, log = console.log }) {
  const t = getTemplate(template);
  const repo = workspaceRoot(root);
  const files = [];
  for (const o of t.outputs) {
    const out = outputPath(repo, o.file);
    log(`🎬 渲染 ${t.label}（${o.label}）→ ${path.relative(repo, out)}`);
    exec('npx', ['remotion', 'render', o.composition, out, `--config=${path.join(root, 'remotion.config.ts')}`],
      { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' });
    files.push(out);
  }
  log(`✅ ${t.label}渲染完成：${files.map((f) => path.relative(repo, f)).join('、')}`);
  return files;
}

/** @type {Record<string, (options: { template: string }) => unknown>} */
const COMMANDS = { assets: assetsCommand, parse: parseCommand, render: renderCommand };

/** @param {string[]} argv */
function main(argv) {
  const [command] = argv;
  const template = (argv.find((a) => a.startsWith('--template=')) || '').split('=')[1] || '';
  if (!Object.hasOwn(COMMANDS, command)) {
    throw new Error(`用法：node video/templates/cli.js <${Object.keys(COMMANDS).join('|')}> --template=<版型>`);
  }
  return COMMANDS[command]({ template });
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (e) { console.error(`❌ ${e instanceof Error ? e.message : e}`); process.exit(1); }
}

module.exports = { assetsCommand, parseCommand, renderCommand, main };
