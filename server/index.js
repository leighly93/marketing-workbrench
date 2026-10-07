#!/usr/bin/env node
/**
 * 出片前台（server）
 * ─────────────────────────────────────────────────────────────
 * 跑在 Leighly 的 Mac 上，同事用瀏覽器連進來出片。
 *
 *   啟動：node server/index.js          （或 npm run studio）
 *   同事連：http://<這台 Mac 的 IP>:4000
 *
 * 設計重點（2026-08-13 討論定案）：
 *   1. 零外部依賴 —— 只用 Node 內建模組。不用 npm install，少一個會壞的環節。
 *   2. 嚴格排隊 —— 整條流程共用同一個 public/，所以一次只跑一支。
 *      使用者的實際用量是「日報13:30／大盤14:00／三大法人16:00，各一兩支」，
 *      撞車機率極低，而 render 實測只要 1~2 分鐘（出片兩支約 2~3 分鐘），
 *      所以不做資料夾隔離 —— 那要動四個 composition 的資料流，不划算。
 *   3. 兩段式，但審核關卡可關 —— 前半段算出配圖計畫後停下來給人看，
 *      確認後才 render。建立工作時勾「直接出片」就變回一段式。
 *      使用者原話：「我甚至不想做兩段式，最終想要一段式」。
 *   4. 審核不卡別人 —— 前半段跑完就把工作區快照起來、放開，
 *      下一支可以立刻開始。不會有人去吃午餐就全公司停擺。
 *   5. 修正紀錄 —— 存「AI 原本的計畫」vs「人改成什麼」。
 *      這是判斷「什麼時候可以安心關掉審核」的依據，不然永遠不敢關。
 */

'use strict';

// 啟動入口：只負責開 port、印開機訊息與關機提示。功能都在 app.js 組起來的各模組裡。
const http = require('node:http');
const path = require('node:path');
const { createWorkbench } = require('./app');

const workbench = createWorkbench({ root: path.resolve(__dirname, '..') });
const { config } = workbench;
const server = http.createServer(workbench.route);

// 連 port 都還沒開就掛掉的情況，要講人話。
// 最常見的是「上一個伺服器忘了關」—— 丟一坨 stack trace 沒有任何幫助
//（2026-08-17 使用者實際遇到）。
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  ❌ Port ${config.PORT} 已經有人在用了 —— 多半是上一個伺服器還開著。`);
    console.error('');
    console.error('     先把舊的關掉，再重開：');
    console.error(`       lsof -ti:${config.PORT} | xargs kill`);
    console.error('       npm run studio');
    console.error('');
    console.error('     裝成背景服務的話改用：');
    console.error('       launchctl kickstart -k gui/$(id -u)/com.cmoney.marketing-video-studio');
    console.error('');
  } else {
    console.error('\n  ❌ 伺服器啟動失敗：' + e.message + '\n');
  }
  process.exit(1);
});

// 關掉伺服器時講清楚：正在跑的那支不會被殺掉，也不會浪費 HeyGen 點數。
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (workbench.isBusy()) {
      console.log('');
      console.log('  ⚠️  有工作正在跑 —— 它會繼續在背景完成，HeyGen 點數不會浪費。');
      console.log('     重開後那支會顯示「背景執行中」，跑完會告訴你怎麼接回。');
    }
    console.log('\n  伺服器已關閉\n');
    process.exit(0);
  });
}

server.listen(config.PORT, config.HOST, () => {
  workbench.pruneOldJobs();
  const ip = workbench.lanIP();
  console.log('');
  console.log('  🎬  出片前台已啟動');
  console.log('  ─────────────────────────────────');
  console.log(`  你自己：   http://localhost:${config.PORT}`);
  console.log(`  同事連：   http://${ip}:${config.PORT}`);
  console.log('');
  console.log(`  工作資料夾：${path.relative(process.cwd(), workbench.JOBS_DIR)}/  （${workbench.allJobs().length} 筆，${(workbench.dirSize(workbench.JOBS_DIR) / 1048576).toFixed(0)} MB）`);
  console.log('  工作保留：  影片、稿件、素材與快照不會依日期自動清除');
  console.log(`  成品庫：    ${path.relative(process.cwd(), workbench.JOBS_DIR)}/  （不會自動清，這份要自己管）`);
  console.log('  按 Ctrl+C 結束');
  console.log('');
  workbench.tick();
});

module.exports = server;
