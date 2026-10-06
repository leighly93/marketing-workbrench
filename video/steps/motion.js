// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 動態小影片（MG）：讀 public/motion.json → render 直式＋橫式 → 寫 motion.generated.json。
 *
 * 排在 transcribeWithRetry() 之後 —— 每一項要在旁白唸到它的那一刻進場，沒有字幕時間軸就算不出來。
 * 排在 prepareShots() 之後 —— 配圖是主，動態是補；之後若要「只在沒配圖的段落放動態」，
 * 計畫已經算好了，直接讀得到。
 *
 * ⚠️ **失敗一律降級成「這支沒有動態」**，跟 auto-shot 同一個原則：
 *    HeyGen 額度已經花掉了，不能因為動態掛掉就沒有成品。
 *    降級時要把 motion.generated.json 清空 —— 不清的話會沿用上一支的內容，
 *    貼上別支影片的動態畫面（而且完全沒有錯誤訊息）。
 */
/**
 * @param {{ projectDir: string, template: string, run: (cmd: string) => void, log: (m: string) => void }} deps
 */
function renderMotionClips({ projectDir, template, run, log }) {
  const generated = path.join(projectDir, 'src', 'MotionClip', 'motion.generated.json');
  // 先清掉上一支殘留的動態檔（不符合版型前綴規則，cleanStaleStaging 不會清）。
  try {
    const pub = path.join(projectDir, 'public');
    for (const f of fs.readdirSync(pub)) {
      if (/^motion-\d+-[pl]\.mp4$/.test(f)) fs.unlinkSync(path.join(pub, f));
    }
  } catch (_) { /* 清不掉不是致命的 */ }

  try {
    run(`npm run render-motion -- --template=${template}`);
    return true;
  } catch (e) {
    log('⚠️ 動態小影片生成失敗（不影響出片，只是這支沒有動態）：' + /** @type {Error} */ (e).message);
    try {
      fs.writeFileSync(generated, '[]\n');
    } catch (e2) {
      log('   ⚠️ 連清空 motion.generated.json 都失敗了，這支可能會帶上上一支的動態：' + /** @type {Error} */ (e2).message);
    }
    return false;
  }
}

module.exports = { renderMotionClips };
