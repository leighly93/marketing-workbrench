// @ts-nocheck
'use strict';

/**
 * 產線子程序：run.js 與動態渲染的啟動、辨認與停止。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得（測試可換成假的 fs／子程序）。
 */

module.exports = function create(ctx) {
  const { fs, path, process, config: { ROOT, VIDEO_DIR, PIPELINE_DIR }, jobPath, ensureDir, appendLog, saveJob } = ctx;
    const spawn = (...a) => ctx.childProcess.spawn(...a);
    const execFileSync = (...a) => ctx.childProcess.execFileSync(...a);

  // ── 執行 run.js ───────────────────────────
  /** pid 還活著，而且真的是我們的 run.js（防 pid 被回收後誤判） */
  function isRunJs(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); } catch (_) { return false; }
    try {
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' });
      return /run\.js/.test(out);
    } catch (_) { return false; }
  }

  /**
   * 停掉一支正在跑的 run.js（2026-09-17 使用者要求「取消鈕要一直在」）。
   *
   * ⚠️ 殺的是**整個 process group** 不是單一 pid —— runPipeline 是 detached 起的，
   *    run.js 自己還會 spawn ffmpeg／remotion／whisper。只殺 run.js 會留下孤兒程序
   *    繼續吃 CPU 跟寫 public/。group 殺不掉才退回殺單一 pid。
   * ⚠️ 一定要 SIGTERM 不要 SIGKILL：run.js 的 SIGTERM handler 會清掉 .run.lock
   *   （見 run.js 的 main()）。KILL 不給它機會清，下一支工作會卡在「排隊等它結束」。
   */
  function stopRunJs(job) {
    if (!isRunJs(job.pid)) return false;
    try { process.kill(-job.pid, 'SIGTERM'); return true; } catch (_) {}
    try { process.kill(job.pid, 'SIGTERM'); return true; } catch (_) { return false; }
  }

  /**
   * 跑 run.js。
   *
   * ⚠️ 兩個關鍵決定（2026-08-17 與使用者討論後定案的「方案 C」）：
   *
   *  1. 輸出「直接寫進 log 檔」，不經過父程序的管道。
   *     以前是 child.stdout → appendLog；伺服器一被關掉，管道就斷了，
   *     run.js 還在跑但 log 完全沒東西，而且它可能因為 EPIPE 直接死掉。
   *
   *  2. detached：讓它有自己的程序群組。
   *     在終端機按 Ctrl+C 時，訊號是送給「整個前景程序群組」的 —— 不 detached
   *     就會連 run.js 一起殺掉，HeyGen 生成到一半的點數就白花了。
   *
   * 合起來的效果：伺服器可以隨時關、隨時重開，正在跑的那支會自己跑完，
   * 講者影片會留在 public/heygen.mp4，重新建立工作勾「用現成的講者影片」就零成本接回。
   */
  function runPipeline(job, args) {
    return new Promise((resolve, reject) => {
      appendLog(job, `\n$ node run.js ${args.join(' ')}\n`);
      const logPath = jobPath(job.id, 'log.txt');
      ensureDir(path.dirname(logPath));
      const fd = fs.openSync(logPath, 'a');
      let child;
      try {
        child = spawn('node', [path.join(VIDEO_DIR, 'run.js'), ...args], {
          cwd: ROOT,
          env: { ...process.env, FORCE_COLOR: '0', WORKBENCH_JOB_ID: job.id },
          detached: true,
          stdio: ['ignore', fd, fd],
        });
      } finally {
        fs.closeSync(fd); // 父程序不需要留著這個 fd，子程序自己有一份
      }
      job.pid = child.pid;
      job.pidArgs = args.join(' ');
      saveJob(job);
      child.unref(); // 不要讓子程序撐住父程序的 event loop
      child.on('error', reject);
      child.on('close', (code) => {
        job.pid = null;
        code === 0 ? resolve() : reject(new Error(`run.js 結束碼 ${code}，詳見執行記錄`));
      });
    });
  }

  /** 動態渲染跑太久就停掉。沒有這道上限的話，卡死的子程序會讓 busy 永遠是 true、整條佇列停擺。 */
  const MOTION_TIMEOUT_MS = 300000;

  /** 正在跑的動態渲染 { jobId, child, stopped }。busy 擋著，同時只會有一支 */
  let motionRun = null;

  /**
   * 跑一次 render-motion.js，不阻塞 event loop。
   *
   * ⚠️ 2026-09-21 從 spawnSync 改過來。一段 17.9 秒的動態要渲 31 秒，spawnSync 會把整個
   *    event loop 綁住那麼久 —— 前台完全沒反應（連 3 秒輪詢都停了），同事同時在標注或
   *    傳截圖也一起卡住。理由與寫法都跟 runFfmpeg 一樣（2026-08 為了 ffmpeg 改過一次）。
   * ⚠️ stdout 與 stderr 都要收進 log：render-motion 成功時會把「這段為什麼跳過」寫在
   *    stderr，那是前台唯一看得到的線索（2026-09-18 踩過）。
   * ⚠️ 子程序要記在 motionRun 上 —— 取消鍵只認得 run.js（stopRunJs 靠 job.pid），
   *    動態這支是 server 自己 spawn 的，不記起來就殺不到（見 stopMotion）。
   * ⚠️ 版型一定要傳：它決定出幾支（只有大盤小報有橫式）與安全區。
   *    不傳的話這一關會退回「只出直式」，大盤小報的橫式就沒有動態。
   */
  function runMotion(job) {
    return new Promise((resolve, reject) => {
      const child = spawn('node',
        [path.join(PIPELINE_DIR, 'render-motion.js'), '--if-changed', `--template=${job.template}`],
        { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: MOTION_TIMEOUT_MS, killSignal: 'SIGTERM' });
      const run = { jobId: job.id, child, stopped: false };
      motionRun = run;
      let said = '';
      const collect = (b) => { said = (said + b.toString()).slice(-20000); };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const clear = () => { if (motionRun === run) motionRun = null; };
      child.on('error', (e) => { clear(); reject(e); });
      child.on('close', (code, signal) => {
        clear();
        if (said.trim()) appendLog(job, `\n${said.trim()}\n`);
        if (run.stopped) return reject(new Error('動態渲染已被取消'));
        if (signal) return reject(new Error(`render-motion 被 ${signal} 中止（超過 ${MOTION_TIMEOUT_MS / 1000} 秒沒跑完？）`));
        if (code !== 0) return reject(new Error(`render-motion 結束碼 ${code}`));
        resolve();
      });
    });
  }

  /**
   * 停掉正在跑的動態渲染（取消鍵用）。
   *
   * stopRunJs 殺的是 run.js，靠的是 job.pid；動態這支不在 job 上，所以要另外一條。
   * 只停這一支工作自己的 —— 取消排隊中的 B 不能把正在跑的 A 打斷。
   */
  function stopMotion(job) {
    if (!motionRun || motionRun.jobId !== job.id) return false;
    motionRun.stopped = true;
    try { motionRun.child.kill('SIGTERM'); return true; } catch (_) { return false; }
  }

  return { isRunJs, stopRunJs, runPipeline, runMotion, stopMotion };
};
