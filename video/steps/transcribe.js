// @ts-check
'use strict';

// ── 字幕：轉完要檢查時間軸，壞掉就墊靜音重轉 ────────────
//
// 2026-09-16 出片事故：whisper 把某句的結束時間報成 11.8 秒（那句只有 22 個字），
// 之後整條字幕落後語音 8 秒，結尾 49 個字全擠在最後 0.19 秒 —— 成品是「字幕上到一半就
// 不動了，最後一瞬間閃過」，而 pipeline 一聲不吭照樣出片。
//
// ⚠️ 2026-09-18 之後這個階梯是**第二道**，不是主力。第一道在 video/subtitles/gap-fill.js：
// whisper 漏聽一整段時，直接用稿件字數把那段空白攤平補回來（字幕文字本來就 100% 來自稿件，
// 漏聽缺的只是「每個字落在哪」）—— 那是算得出來的，不必重轉、也不必賭。
// 這個階梯只剩下處理「補不起來」的情況：whisper 不是沒聽到，而是時間軸整體歪掉，
// 空白根本不夠放（實例：09-18 第二次失敗，結尾 20 個字只剩 1.27 秒）。那種才需要換 window 邊界重轉。
//
// 重轉為什麼要墊靜音：whisper.cpp 在這裡是**確定性的**（同一個音檔跑三次結果完全相同），
// 原樣重轉保證再壞一次。實測改 beam-size／threads／max-len 都救不回來，
// 只有「音檔前面墊靜音」有效 —— 它把 whisper 的 30 秒 window 邊界挪開，避開那個解碼失敗點。
// 墊進去的時間由 Adapter 自己減回來，字幕不會整體變慢。
//
// 階梯為什麼是這幾個值（2026-09-18 實測：6 支實際出片的音檔 × 8 個 pad 值，共 48 次轉錄）：
//   ・**壞掉的 pad 值逐支不同**，沒有哪個值是萬靈丹 ——
//     09-16 事故那支只有 pad 0 壞（0.3 以上全正常）；
//     09-18 停在出片前那支反過來，pad 0 正常，壞的是 0.5 與 1.2。
//   ・當時的階梯剛好是 [0, 0.5]，兩階都踩進 09-18 那支的壞點 → 連兩次失敗、停線。
//     這也推翻了 2026-09-17 的判斷「連兩次都壞多半不是換個 window 邊界能解決的」：
//     那支連兩次都壞，但 pad 0.8 一次就正常（279 字完整，對照 pad 0.5 只有 267 字）。
//   ・0.8 與 1.5 在全部 6 支上都正常；間距拉開比多塞近似值有用（0.3 與 0.5 會落在同一個壞點附近）。
// 成本：單次轉錄約 3.6 秒（base q5_1／CPU 4 執行緒／47 秒音檔），跑滿四階也才 15 秒，
// 不值得為了省這 15 秒把一支已經生成完、扣過 HeyGen 點數的片停在出片前。
//
// 實測無效、不要再試的路：`-mc 0`（取消跨 window 的 context 帶入，解碼塌陷的常見嫌疑犯）
// 在 09-18 那支的 pad 0 反而更糟 —— 只轉出 202 字、結尾提早到 39 秒（正常 279 字／47.4 秒）。
const SUBTITLE_PAD_LADDER = [0, 0.8, 1.5, 2.5];
/** video/subtitles/cli.js 的「時間軸判定失敗」結束代碼。 */
const EXIT_TIMELINE_BROKEN = 3;

/**
 * 轉字幕＋校正；時間軸判定失敗就照階梯墊靜音重轉，其他錯誤直接丟出。
 * @param {{ run: (cmd: string) => void, log: (m: string) => void, ladder?: number[] }} deps
 * @returns {number} 最後成功用的 pad 秒數
 */
function transcribeWithRetry({ run, log, ladder = SUBTITLE_PAD_LADDER }) {
  for (let i = 0; i < ladder.length; i++) {
    const pad = ladder[i];
    run(pad ? `npm run transcribe -- --pad=${pad}` : 'npm run transcribe');
    try {
      run('npm run correct-subtitles');
      if (i > 0) log(`✅ 墊 ${pad} 秒靜音之後時間軸正常了（第 ${i + 1} 次轉字幕）`);
      return pad;
    } catch (e) {
      // 只有時間軸判定失敗才重試；缺檔之類是真的壞了，往上丟，不要空轉。
      if (/** @type {any} */ (e).status !== EXIT_TIMELINE_BROKEN) throw e;
      const next = ladder[i + 1];
      if (next === undefined) {
        throw new Error(
          `字幕時間軸連續 ${ladder.length} 次都判定壞掉（墊了 ${ladder.slice(1).join('、')} 秒靜音都沒救回來），已停在出片前。\n`
          + '   壞掉的細節看上面 correct-subtitles 印的訊息。\n'
          + '   這表示連「用稿件把漏聽的空白攤平」都補不起來 —— whisper 不是沒聽到，\n'
          + '   是時間軸整體歪掉、空白根本不夠放那些字，補了也只是讓它閃得比較平均。\n'
          + '   ⚠️ 這支不要按「重新出片」—— whisper 是確定性的，同一支配音會再走一次一模一樣的\n'
          + '      四個 pad、得到一模一樣的四次失敗，只是白等。\n'
          + '   要救就得換一支配音：改一下稿件的斷句（讓配音節奏不同），再出一支。',
        );
      }
      log(`🔁 字幕時間軸判定失敗（第 ${i + 1} 次，${pad ? `墊了 ${pad} 秒` : '沒墊靜音'}）。`
        + `改成墊 ${next} 秒靜音、換一個 whisper window 邊界重轉…`);
    }
  }
  return ladder[ladder.length - 1];
}

module.exports = { transcribeWithRetry, SUBTITLE_PAD_LADDER, EXIT_TIMELINE_BROKEN };
