// @ts-check
'use strict';

/**
 * APP 截圖分析（OCR 版面偵測）：在呼叫 HeyGen 之前就開始，跟生成平行跑。
 *   ① 省時間：等影片的 3–5 分鐘就把 OCR 做完
 *   ② 及早失敗：圖有問題／沒裝 tesseract 一開始就知道，不必等生成完、白花額度
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TEMPLATE_ASSET_PATTERN } = require('../templates/registry');

/** public/ 裡要分析的截圖：檔名不限（常是手機相機命名），排除套版素材。 @param {string} publicDir */
function screenshotsIn(publicDir) {
  return fs.existsSync(publicDir)
    ? fs.readdirSync(publicDir).filter((f) => /\.(png|jpg|jpeg)$/i.test(f) && !TEMPLATE_ASSET_PATTERN.test(f))
    : [];
}

/**
 * 重新出片時沿用上一支的 APP 截圖分析結果（2026-09-18）。
 *
 * 為什麼值得做：重新出片的截圖是伺服器原封不動複製過來的，OCR 結果不可能不一樣。
 * 實測一支 8 張截圖的工作，準備階段 22 秒裡有 18 秒花在這段分析 —— 使用者要等，
 * 等到的卻是跟上一支一模一樣的東西。
 *
 * ⚠️ 只在**每一張都對得上**時才沿用，否則照常重跑：
 *   檔名集合要一樣（少一張、多一張都不算），而且每一張的 md5 都要一樣（換過內容就不算）。
 *   沿用檔 app-images.reuse.json 是伺服器在 redo 時寫進 input/ 的（見 server/index.js），
 *   裡面存的 sources 就是當時那批截圖的 md5。這裡重新算一次比對，不相信檔案裡寫的。
 *   —— 這條規則的意義：OCR 行為完全沒有改，只是省掉「算出同一個答案」的那一次。
 *
 * @returns {boolean} true = 已經把結果寫好，不用再跑分析
 */
/**
 * @param {string[]} shots
 * @param {{ publicDir: string, outputFile: string, log: (m: string) => void }} o
 */
function reuseAppImages(shots, { publicDir, outputFile, log }) {
  const cacheFile = path.join(publicDir, 'app-images.reuse.json');
  if (!fs.existsSync(cacheFile)) return false;
  try {
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    const sources = cache.sources || {};
    if (!Array.isArray(cache.images) || !cache.images.length) return false;
    /** @type {Record<string, string>} */
    const now = {};
    for (const name of shots) now[name] = crypto.createHash('md5').update(fs.readFileSync(path.join(publicDir, name))).digest('hex');
    const a = Object.keys(now).sort();
    const b = Object.keys(sources).sort();
    if (a.length !== b.length || a.some((k, i) => k !== b[i])) return false;
    if (a.some((k) => now[k] !== sources[k])) return false;
    fs.writeFileSync(outputFile, JSON.stringify({ images: cache.images }, null, 2));
    log(`⏩ ${a.length} 張截圖跟工作 ${cache.from} 完全相同（md5 逐張比對過），沿用它的版面偵測結果，省下重跑一次 OCR`);
    return true;
  } catch (_) {
    return false; // 沿用只是最佳化，看不懂就照常重跑
  }
}

/**
 * @param {{ projectDir: string, runBackground: (cmd: string, label: string) => Promise<any>, log: (m: string) => void }} deps
 * @returns {Promise<any> | null} 背景分析；沒有要分析的圖或沿用成功時是 null
 */
function startImageAnalysis({ projectDir, runBackground, log }) {
  const publicDir = path.join(projectDir, 'public');
  const shots = screenshotsIn(publicDir);
  if (shots.length === 0) {
    log('ℹ️ public/ 沒有 image*.png，略過 APP 截圖分析');
    return null;
  }
  if (reuseAppImages(shots, { publicDir, outputFile: path.join(projectDir, 'src', 'app-images.generated.json'), log })) return null;
  log(`🔎 開始 APP 截圖分析（${shots.length} 張，與 HeyGen 生成平行進行）`);
  return runBackground('npm run analyze:app-images', 'APP 截圖分析');
}

module.exports = { startImageAnalysis, reuseAppImages, screenshotsIn };
