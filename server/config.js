// @ts-check
'use strict';

/**
 * 工作台的路徑與設定（全部由 repository 根與環境變數算出來，不讀模組自己的位置）。
 * 測試傳入合成的 root，就整個指向暫存目錄。
 */
const path = require('node:path');
const { dataPath } = require('../shared/paths');

/**
 * @param {{ root: string, env?: NodeJS.ProcessEnv }} input
 */
function createConfig({ root, env = process.env }) {
  // ROOT 是 Remotion 專案（video/remotion）：出片時讀寫的 src/ 與 public/ 都在這裡。
  const ROOT = path.join(root, 'video', 'remotion');
  const VIDEO_DIR = path.join(root, 'video');
  return {
    WORKSPACE_ROOT: root,
    ROOT,
    VIDEO_DIR,
    PIPELINE_DIR: path.join(VIDEO_DIR, 'pipeline'),
    SHOTS_DIR: path.join(VIDEO_DIR, 'shots'),
    WEB_DIR: path.join(root, 'app'),
    SERVER_DIR: path.join(root, 'server'),
    PORT: Number(env.PORT || 4000),
    HOST: env.HOST || '127.0.0.1',
    // 用 http://mkt-video.local:4000/?k=YOUR_ADMIN_KEY 開一次網頁，伺服器會存成 HttpOnly cookie
    // 並轉回不含暗號的網址；之後的 API 只認 cookie，暗號不會留在網址列、歷史紀錄或 API 網址。
    // 換暗號改 .env 的 ADMIN_KEY，改完要重開伺服器。設成空字串＝關掉遠端管理，只剩本機。
    ADMIN_KEY: env.ADMIN_KEY || '',
    // append-only 彙總檔：一行一筆 JSON。
    // 為什麼要另外一份 —— corrections 原本只存在 jobs/<id>/job.json，前台按「刪除」就一起消失
    // （2026-08-18 實際狀況：19 支只剩 2 支留著）。這份換電腦、重裝、刪工作都不會丟。
    CORRECTIONS_LOG: dataPath(root, 'corrections.jsonl'),
    // 同事的留言／唸法回報。同樣是 append-only —— 理由同上，留言更不該跟著工作被清掉。
    // 「已讀／收錄」不是就地改，是再追加一行 { op:'status', id, status }，讀的時候摺疊起來。
    MESSAGES_LOG: dataPath(root, 'messages.jsonl'),
    // 共用發音詞庫。只有管理者能改，每支影片送出前自動併進 script.txt 的發音替換段。
    PRONOUNCE_PATH: dataPath(root, 'pronounce.json'),
  };
}

module.exports = { createConfig };
