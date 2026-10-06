// @ts-check
'use strict';

/**
 * 把版型的固定素材從 storage/shared-assets/<dir>/ 複製到 Remotion 的 public/，用版型前綴命名。
 *
 * 一律用 copyFileSync：fs.cpSync 覆蓋掛載碟上既有檔案時會先 truncate、再因 EACCES 失敗，留下 0 byte 壞檔。
 */
const path = require('node:path');

/**
 * @param {{ assets: { dir: string, files: Record<string, string> } }} template 版型設定（registry）
 * @param {{ assetsRoot: string, publicDir: string, fs?: typeof import('node:fs') }} options
 * @returns {{ copied: Array<{ from: string, to: string, size: number }>, empty: string[] }}
 * @throws 來源資料夾不存在或缺檔時（一個都不複製）
 */
function copyTemplateAssets(template, { assetsRoot, publicDir, fs = require('node:fs') }) {
  const sourceDir = path.join(assetsRoot, template.assets.dir);
  if (!fs.existsSync(sourceDir)) throw new Error(`找不到資料夾 ${sourceDir}`);
  const entries = Object.entries(template.assets.files);
  const missing = entries.map(([from]) => from).filter((from) => !fs.existsSync(path.join(sourceDir, from)));
  if (missing.length) throw new Error(`${sourceDir} 缺少檔案：${missing.join(', ')}`);

  fs.mkdirSync(publicDir, { recursive: true });
  const copied = [];
  const empty = [];
  for (const [from, to] of entries) {
    const source = path.join(sourceDir, from);
    const size = fs.statSync(source).size;
    // 0 byte 多半是上傳／同步沒完成；照樣複製，但回報出去讓人知道。
    if (size === 0) empty.push(from);
    fs.copyFileSync(source, path.join(publicDir, to));
    copied.push({ from, to, size });
  }
  return { copied, empty };
}

module.exports = { copyTemplateAssets };
