'use strict';

const fs = require('node:fs');
const path = require('node:path');

function folderName(job) {
  const id = String(job.id);
  if (!id || !/^[\w-]+$/.test(id)) throw new Error('無效的工作 ID');
  const date = /^\d{8}/.test(id) ? `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}` : String(job.createdAt || '').slice(0, 10).replace(/[^\d-]/g, '') || '日期未詳';
  const title = Array.from(String(job.title || '未命名工作').replace(/[\r\n]+/g, '').replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_').trim()).slice(0, 50).join('') || '未命名工作';
  return `${date}_${title}_${id}`;
}

function outputName(name) {
  if (/landscape/i.test(name)) return '橫式.mp4';
  if (/-ad\.mp4$/i.test(name) || name === 'output.mp4') return '投廣版.mp4';
  if (/^output-(dapan|midday|usstock|institution|focusstock)\.mp4$/i.test(name)) return '直式.mp4';
  return path.basename(name);
}

function createJobStore(root, io = fs) {
  const base = path.join(root, '工作紀錄');
  const locations = new Map();
  function scan() {
    const jobs = [];
    if (!io.existsSync(base)) return jobs;
    for (const entry of io.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(base, entry.name);
      const file = path.join(dir, '_製作資料', 'job.json');
      if (!io.existsSync(file)) continue;
      const job = JSON.parse(io.readFileSync(file, 'utf8'));
      folderName(job); // 驗證 ID，避免錯誤紀錄覆蓋其他工作。
      if (locations.has(job.id) && locations.get(job.id) !== dir) throw new Error(`重複工作 ID：${job.id}`);
      locations.set(job.id, dir);
      jobs.push(job);
    }
    return jobs;
  }
  function directory(id, job) {
    if (!locations.has(id)) scan();
    if (!locations.has(id)) {
      if (!job || job.id !== id) throw new Error(`找不到工作位置：${id}`);
      locations.set(id, path.join(base, folderName(job)));
    }
    return locations.get(id);
  }
  function locate(id, ...parts) {
    const dir = directory(id);
    parts = parts.flatMap((p) => String(p).split(/[\/\\]/));
    if (parts[0] === 'input') {
      if (parts[1] === 'script.txt') return path.join(dir, '稿件.txt', ...parts.slice(2));
      return path.join(dir, '素材', ...parts.slice(1));
    }
    if (parts[0] === 'state') return path.join(dir, '_製作資料', '快照', ...parts.slice(1));
    return path.join(dir, '_製作資料', ...parts);
  }
  return { base, scan, directory, path: locate };
}

module.exports = { createJobStore, folderName, outputName };
