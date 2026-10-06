// @ts-check
'use strict';

/**
 * 講者影片加速 125%（保持音調），用 ffmpeg。
 *
 * 全流程只准加速一次：
 *   ・同一輪：createSpeedUp 回傳的物件記住「這一輪已經加速過」，第二個呼叫點會被擋下並印警告
 *     （2026-08-17 兩個加速點守門不一致，被連續加速成 1.5 倍，斷句壓爛）
 *   ・跨輪：加速過的檔案寫進容器 comment 記號；拿它再跑 --skip-generate 不會變 1.56 倍
 *     （2026-08-21 「用現成的講者影片」開放給所有同事後，不能再靠人記得加 --no-speed）
 * 備份（backupJob）在加速之前做，所以備份檔沒有記號、是原速 —— 拿備份重跑會正常加速，這是對的。
 *
 * ⚠️ 加速只有 ffmpeg 這一條路。2026-08-19 試過讓 HeyGen 直接生 1.25 倍速（voice_settings.speed），
 *    實測只短 2%、扣點一樣，已拆掉（見 providers/heygen.js 的 VOICE_LOCALE 註解）。
 */
const path = require('node:path');

const SPEED_FACTOR = 1.25;
const SPED_TAG = 'marketing-video:sped';

/**
 * @param {{
 *   exec?: (cmd: string, args: string[], options: object) => string | Buffer,
 *   rename?: (from: string, to: string) => void,
 *   log?: (m: string) => void,
 * }} [deps]
 */
function createSpeedUp({
  exec = require('node:child_process').execFileSync,
  rename = require('node:fs').renameSync,
  log = console.log,
} = {}) {
  let applied = false;

  /** 這支影片是不是我們加速過的？讀不到就當成沒有（維持會加速的行為）。 @param {string} file */
  function alreadySpedUp(file) {
    try {
      const out = exec('ffprobe', ['-v', 'error', '-show_entries', 'format_tags=comment', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf-8' });
      return String(out).includes(SPED_TAG);
    } catch (_) {
      return false;
    }
  }

  /**
   * @param {string} file 講者影片（會被覆蓋）
   * @param {string} who 哪個呼叫點（擋下重複加速時印出來）
   * @returns {boolean} 這次有沒有真的加速
   */
  function speedUp(file, who) {
    if (applied) {
      log(`⚠️ heygen.mp4 這一輪已經加速過了，略過「${who}」的重複加速（避免 compounding）`);
      return false;
    }
    if (alreadySpedUp(file)) {
      log(`⏩ 這支 heygen.mp4 之前就被加速過了（檔案裡有記號），略過「${who}」的加速 —— 不然會變 ${(SPEED_FACTOR * SPEED_FACTOR).toFixed(2)} 倍`);
      applied = true;
      return false;
    }
    log(`加速影片 ${Math.round(SPEED_FACTOR * 100)}%（保持音調）`);
    const fast = path.join(path.dirname(file), 'heygen_fast.mp4');
    exec('ffmpeg', ['-y', '-i', file,
      '-filter_complex', `[0:v]setpts=PTS/${SPEED_FACTOR}[v];[0:a]atempo=${SPEED_FACTOR}[a]`,
      '-map', '[v]', '-map', '[a]', '-metadata', `comment=${SPED_TAG}=${SPEED_FACTOR}`, fast],
    { cwd: path.dirname(file), stdio: 'inherit' });
    rename(fast, file);
    applied = true;
    log('加速完成，覆蓋 heygen.mp4（已蓋上記號，之後重跑不會再加速一次）');
    return true;
  }

  return { speedUp, alreadySpedUp };
}

module.exports = { createSpeedUp, SPEED_FACTOR, SPED_TAG };
