// @ts-check
'use strict';

/**
 * 隔離工作區：把 repository 的程式（不含工作資料與產線產物）複製到暫存目錄，
 * node_modules 與品牌素材用 junction 指回原處（唯讀用途），再 init 補齊空結構。
 *
 * 給模擬出片的整合測試與 npm run e2e 用：在裡面出片、建工作、開服務都不會碰到
 * 正式的 storage/jobs、video/remotion/public 或 .run.lock。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** 複製的程式碼（相對 repository 根）。 */
const CODE = ['package.json', 'tsconfig.json', '.env.example', 'app', 'server', 'shared', 'video', 'tools/init.js'];
/** junction 指回原處的唯讀內容。 */
const LINKS = ['node_modules', 'storage/shared-assets'];

/**
 * 產線產物與本機編譯物不複製（init 會補空結構）；public/ 只帶進 Git 的字型。
 * @param {string} rel 相對 repository 根，用 / 分隔
 */
function isCopied(rel) {
  if (rel.startsWith('video/remotion/public/')) return rel === 'video/remotion/public/NotoSansTC-VF.ttf';
  if (/\.generated\.json$/.test(rel)) return false;
  if (/^video\/remotion\/src\/(subtitles(\.original)?|video-meta)\.json$/.test(rel)) return false;
  if (/^video\/shots\/ocr-vision(\.tmp-.*)?$/.test(rel)) return false;
  return !/(^|\/)(node_modules|\.cache)(\/|$)/.test(rel);
}

/**
 * @param {{ env?: Record<string, string>, prefix?: string, root?: string }} [options]
 *   env 寫進沙盒的 .env（例如 WORKBENCH_MOCK=1）
 */
function createSandbox({ env = {}, prefix = 'workbench-sandbox-', root = ROOT } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    for (const name of CODE) {
      fs.cpSync(path.join(root, name), path.join(dir, name), {
        recursive: true,
        filter: (from) => isCopied(path.relative(root, from).split(path.sep).join('/')),
      });
    }
    for (const name of LINKS) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.symlinkSync(path.join(root, name), path.join(dir, name), 'junction');
    }
    fs.writeFileSync(path.join(dir, '.env'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
    require(path.join(dir, 'tools', 'init.js')).initialize(dir);
  } catch (e) {
    remove(dir);
    throw e;
  }
  return {
    dir,
    /** @param {...string} segments */
    path: (...segments) => path.join(dir, ...segments),
    cleanup: () => remove(dir),
  };
}

/** junction 先拆再刪，避免遞迴刪到原本的 node_modules。 @param {string} dir */
function remove(dir) {
  for (const name of LINKS) {
    try { fs.unlinkSync(path.join(dir, name)); } catch (_) { try { fs.rmdirSync(path.join(dir, name)); } catch (_) {} }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { createSandbox, isCopied, CODE, LINKS };
