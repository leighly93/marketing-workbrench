'use strict';

// 一次性搬移工具。預設只產生計畫；--apply 才執行。完成後不應再次對正式資料執行。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { folderName, outputName } = require('../工作儲存');

function planMigration(root) {
  const files = [];
  const changes = [];
  const jobs = [];
  const assigned = new Set();
  const destinations = new Set();
  const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  function add(source, destination, reason) {
    if (!fs.existsSync(path.join(root, source))) return;
    const stat = fs.lstatSync(path.join(root, source));
    if (stat.isSymbolicLink()) throw new Error(`需人工確認 symlink：${source}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(path.join(root, source))) add(path.join(source, name), path.join(destination, name), reason);
      return;
    }
    if (assigned.has(source)) throw new Error(`來源重複：${source}`);
    if (destinations.has(destination) || fs.existsSync(path.join(root, destination))) throw new Error(`目的地已存在：${destination}`);
    assigned.add(source); destinations.add(destination);
    files.push({ source, destination, reason, bytes: stat.size, sha256: digest(path.join(root, source)) });
  }
  for (const id of fs.readdirSync(path.join(root, 'jobs'))) {
    const source = path.join('jobs', id);
    const jf = path.join(root, source, 'job.json');
    if (!fs.existsSync(jf)) { add(source, path.join('99_封存', '待辨識', '原工作目錄', id), '非工作紀錄項目'); continue; }
    const original = fs.readFileSync(jf, 'utf8');
    const job = JSON.parse(original);
    if (job.id !== id || jobs.some((j) => j.id === id)) throw new Error(`工作 ID 不一致：${id}`);
    const directory = path.join('工作紀錄', folderName(job));
    for (const name of fs.readdirSync(path.join(root, source))) {
      if (name === 'input') {
        for (const n of fs.readdirSync(path.join(root, source, name))) {
          add(path.join(source, name, n), path.join(directory, n === 'script.txt' ? '稿件.txt' : path.join('素材', n)), '工作稿件與素材');
        }
      } else add(path.join(source, name), path.join(directory, '_製作資料', name === 'state' ? '快照' : name), '工作製作資料');
    }
    for (const output of job.outputs || []) {
      const reference = output.archive;
      const sourceOutput = reference && fs.existsSync(path.resolve(root, reference)) ? path.relative(root, path.resolve(root, reference)) : null;
      if (sourceOutput) {
        if (!sourceOutput.startsWith(`成品${path.sep}`)) throw new Error(`成品來源需人工確認：${sourceOutput}`);
        const destination = path.join(directory, outputName(output.name));
        add(sourceOutput, destination, `正式成品：${id}`);
        output.archive = destination;
      }
    }
    if (Array.isArray(job.archived)) {
      const originals = JSON.parse(original).outputs || [];
      const mapped = new Map(originals.map((o, i) => [o.archive, job.outputs[i].archive]));
      job.archived = job.archived.map((ref) => mapped.get(ref) || ref);
    }
    if (JSON.stringify(job) !== JSON.stringify(JSON.parse(original))) changes.push({ file: path.join(directory, '_製作資料', 'job.json'), original, value: job });
    jobs.push({ id, directory, status: job.status });
  }
  // 明確帶 job ID 的備份直接歸回；時間戳備份須稿件與講者影片共同唯一匹配。
  const candidates = new Map();
  for (const job of jobs) {
    for (const input of [path.join('jobs', job.id, 'input'), path.join('backups', 'jobs', job.id, 'input')]) {
      const pair = ['script.txt', 'heygen.mp4'].map((n) => path.join(root, input, n));
      if (!pair.every((p) => fs.existsSync(p))) continue;
      const key = pair.map(digest).join(':');
      if (!candidates.has(key)) candidates.set(key, new Set());
      candidates.get(key).add(job.id);
    }
  }
  const backups = path.join(root, 'backups');
  if (fs.existsSync(backups)) for (const name of fs.readdirSync(backups)) {
    if (name === 'jobs') {
      for (const id of fs.readdirSync(path.join(backups, name))) {
        const job = jobs.find((j) => j.id === id);
        add(path.join('backups', name, id), job ? path.join(job.directory, '_製作資料', '備份', '原工作備份') : path.join('99_封存', '待辨識', '製作備份', 'jobs', id), job ? '備份含完整工作 ID' : '備份無對應工作');
      }
      continue;
    }
    const source = path.join('backups', name);
    const pair = ['script.txt', 'heygen.mp4'].map((n) => path.join(root, source, n));
    const matches = pair.every((p) => fs.existsSync(p)) ? candidates.get(pair.map(digest).join(':')) : null;
    const job = matches && matches.size === 1 ? jobs.find((j) => j.id === [...matches][0]) : null;
    add(source, job ? path.join(job.directory, '_製作資料', '備份', name) : path.join('99_封存', '待辨識', '製作備份', name), job ? '稿件與講者影片雜湊唯一匹配' : '未能唯一確認備份歸屬');
  }
  // 既存 out 全部保留；不憑固定輸出名把試片冒認成正式工作。
  add('out', '99_封存/待辨識/原產線輸出與試片', '既存輸出待辨識，不作缺片工作的替代成品');
  // 沒被工作引用的成品仍保留待辨識。
  function remaining(dir) {
    if (!fs.existsSync(path.join(root, dir))) return;
    for (const name of fs.readdirSync(path.join(root, dir))) {
      const p = path.join(dir, name);
      if (fs.statSync(path.join(root, p)).isDirectory()) remaining(p);
      else if (!assigned.has(p)) add(p, path.join('99_封存', '待辨識', '未對應成品', path.relative('成品', p)), '未對應到 job 的成品');
    }
  }
  remaining('成品');
  add('assets', '共用素材', '共用品牌素材');
  add('04_使用說明/出片工具介紹.pptx', '出片工具介紹.pptx', '根目錄人用入口');
  add('04_使用說明/README.md', '90_系統/維護說明/原使用說明待整合.md', '保留原文，README 整合待後續');
  add('04_使用說明/工作與影片位置.md', '90_系統/維護說明/工作與影片位置.md', '工作儲存說明');
  return { schema: 1, source_cwd: root, created_at: new Date().toISOString(), jobs, files, changes };
}

function applyMigration(root, plan, manifest) {
  if (path.resolve(root) !== plan.source_cwd) throw new Error('CWD 與計畫不符');
  const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  // 在任何搬移前，完整確認來源未變、目的地未被使用。
  for (const f of plan.files) {
    if (hash(path.join(root, f.source)) !== f.sha256 || fs.existsSync(path.join(root, f.destination))) throw new Error(`搬前檢查失敗：${f.source}`);
  }
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify(plan, null, 2) + '\n');
  for (const f of plan.files) {
    const destination = path.join(root, f.destination);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(path.join(root, f.source), destination);
  }
  for (const change of plan.changes) fs.writeFileSync(path.join(root, change.file), JSON.stringify(change.value, null, 2) + '\n');
  const changed = new Map(plan.changes.map((c) => [c.file, c]));
  for (const f of plan.files) {
    f.sha256_after = hash(path.join(root, f.destination));
    if (!changed.has(f.destination) && f.sha256_after !== f.sha256) throw new Error(`搬後內容不符：${f.destination}`);
  }
  function removeEmpty(p) {
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) return;
    for (const name of fs.readdirSync(p)) removeEmpty(path.join(p, name));
    if (!fs.readdirSync(p).length) fs.rmdirSync(p);
  }
  for (const name of ['jobs', '成品', 'assets', 'out', 'backups', '04_使用說明']) removeEmpty(path.join(root, name));
  for (const j of plan.jobs) fs.mkdirSync(path.join(root, j.directory, '素材'), { recursive: true });
  fs.mkdirSync(path.join(root, '90_系統/暫存/產線輸出'), { recursive: true });
  plan.completed_at = new Date().toISOString();
  plan.validation = { preserved_files: plan.files.length - plan.changes.length, updated_job_metadata: plan.changes.length, jobs: plan.jobs.length, errors: [] };
  fs.writeFileSync(manifest, JSON.stringify(plan, null, 2) + '\n');
  return plan.validation;
}

if (require.main === module) {
  const root = path.resolve(__dirname, '../..');
  const plan = planMigration(root);
  const manifest = path.join(root, '99_封存/2026-09-10_工作資料整合/搬移清單.json');
  if (process.argv.includes('--apply')) console.log(JSON.stringify(applyMigration(root, plan, manifest)));
  else console.log(JSON.stringify({ jobs: plan.jobs.length, files: plan.files.length, metadata_changes: plan.changes.length, destinations: [...new Set(plan.files.map((f) => f.destination.split('/').slice(0, 3).join('/')))] }, null, 2));
}
module.exports = { planMigration, applyMigration };
