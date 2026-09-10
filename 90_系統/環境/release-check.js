'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const errors = [];
const { spawnSync } = require('node:child_process');
const ignored = spawnSync('git', ['check-ignore', '--no-index', '-z', '--stdin'], { cwd: root, input: files.join('\0') + '\0', encoding: 'utf8' });
if (ignored.status !== 0 && ignored.status !== 1) throw new Error('無法核對 Git 忽略規則');
for (const file of ignored.stdout.split('\0').filter(Boolean)) errors.push(`${file}: 已被忽略但仍受 Git 追蹤`);
let bytes = 0;
for (const file of files) {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) { errors.push(`${file}: 已追蹤檔案不存在`); continue; }
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile()) { errors.push(`${file}: 不收錄連結或特殊檔案`); continue; }
  bytes += stat.size;
  if (/\.ttf$/i.test(file)) {
    const font = fs.readFileSync(absolute);
    if (font.length < 12 || font.readUInt32BE(0) !== 0x00010000) errors.push(`${file}: 字型格式錯誤`);
  }
  if (stat.size > 50 * 1024 * 1024) errors.push(`${file}: 超過第一版單檔 50 MiB 範圍`);
  if ((/^(工作紀錄|99_封存|90_系統\/資料)\//.test(file) && !/\/README\.md$/.test(file)) || /(^|\/)(node_modules|\.env|\.google-creds\.json|\.cmd-queue|\.cmd-status|\.git)(\/|$)/.test(file)) errors.push(`${file}: 不應公開的本機資料`);
  if (stat.size > 5 * 1024 * 1024) continue;
  const content = fs.readFileSync(absolute);
  if (content.includes(0)) continue;
  const text = content.toString('utf8');
  const patterns = [/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/, /\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{20,}/];
  if (patterns.some((pattern) => pattern.test(text))) errors.push(`${file}: 疑似憑證，不輸出內容`);
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`公開收錄檢查通過：${files.length} 檔，${(bytes / 1024 / 1024).toFixed(1)} MiB；沒有大型單檔或已知憑證格式。`);
