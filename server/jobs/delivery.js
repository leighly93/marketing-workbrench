// @ts-nocheck
'use strict';

/**
 * 成品收尾（響度正規化＋faststart）與成品存放位置。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得（測試可換成假的 fs／子程序）。
 */

module.exports = function create(ctx) {
  const { fs, path, config: { ROOT }, store: STORE, ensureDir, outputName } = ctx;
    const spawn = (...a) => ctx.childProcess.spawn(...a);

  // ── 交付規格（客戶／平台會逐項驗的 12 項）─────────────
  // 分析與實測依據：docs/video-delivery-spec.md
  //
  // Remotion 那邊只給 `--crf 23`，沒有任何編碼參數控制，所以有五項一定不合規：
  //   響度（−12 LUFS、True Peak +0.2 dBTP＝已在削波）／色彩標籤（bt470bg＋full range，
  //   是錯的標籤不是只有沒填）／yuvj420p／GOP 250（x264 預設）／Level 4.0。
  // 修法不是改渲染，是在「收成品」這一步用 ffmpeg 轉一次交付檔。
  // ⚠️ 渲染流程一個字都沒動 —— run.js／remotion.config.ts／npm run render:* 全部原樣。
  //
  // 舊規則（已被下面那段取代，留著看沿革）：只有白名單裡的直式會轉交付規格，
  //   橫式（output-dapan-landscape）過不了規格第 4 項「1080×1920 直式、不加黑邊」；
  //   投廣版與投廣模板（output.mp4）使用者定案不套 —— 那兩個版型 2026-09-22 已整組移除。
  /**
   * 2026-09-17 使用者定案：**所有成品都做收尾**，不再分「只有直式要轉」。
   * 舊規則是為了完整交付規格那 23 秒的成本才挑著做；現在收尾只要 0.6 秒（視訊 copy），
   * 全部做的好處是**音量一致** —— 橫式與投廣版以前完全沒正規化，音量看 HeyGen 那次多大聲。
   * 沒有音軌的檔案會在 measureLoudness 失敗，由呼叫端的 try/catch 退回原始檔（見 doRender）。
   */

  /** 跑一次 ffmpeg，不阻塞 event loop（轉一支 1080×1920 要一兩分鐘，execFileSync 會讓整個前台卡死） */
  function runFfmpeg(args, onStderr) {
    return new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', args, { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
      let tail = '';
      child.stderr.on('data', (b) => {
        const s = b.toString();
        if (onStderr) onStderr(s);
        tail = (tail + s).slice(-20000); // 只留尾巴：loudnorm 的 JSON 在最後，錯誤訊息也在最後
      });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(tail) : reject(new Error(`ffmpeg 結束碼 ${code}：${tail.slice(-800)}`))));
    });
  }

  // `-fps_mode` 是 ffmpeg 5.0 才有的（4.x 只有 `-vsync`）。本機是哪一版不一定，
  // 猜錯整條轉檔就掛掉退回 copyFileSync＝規格白做，所以問一次、記起來。
  let fpsModeSupported = null;

  /**
   * Pass 1：量測響度。
   *
   * ⚠️ TP 目標寫 −1.5 而不是規格的 −1：AAC 是有損編碼，壓完峰值會往上回彈。
   *    2026-08-21 實測 −1 出來的成品量到 −0.9 dBTP，剛好超規格 0.1，所以留 0.5 dB 邊際。
   *    兩趟的 I／TP／LRA 目標必須一致（target_offset 是照這組目標算的）。
   * 兩趟是必要的 —— 單趟 loudnorm 走 dynamic 模式會做動態壓縮，語音聽起來會怪；
   * 兩趟用線性增益，聽感不變，代價只是多花兩三秒。
   */
  async function measureLoudness(file) {
    const out = await runFfmpeg([
      '-hide_banner', '-nostats', '-i', file,
      '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-',
    ]);
    const start = out.lastIndexOf('{');
    const end = out.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('loudnorm 沒有回傳 JSON');
    const m = JSON.parse(out.slice(start, end + 1));
    for (const k of ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset']) {
      if (m[k] === undefined || m[k] === '-inf' || m[k] === 'inf') throw new Error(`loudnorm 的 ${k} 量不出來（${m[k]}）`);
    }
    return m;
  }

  /**
   * 成品收尾：**只做響度正規化與 faststart，視訊直接 copy 不重新編碼**。
   *
   * 2026-09-17 使用者定案：投放平台那份交付規格（H.264 High 4.1／GOP 15／bt709 三欄／
   * CRF 21 + maxrate 5M／CFR 30）**已經沒有這個規定了**，整套拿掉。留下的兩項不是規格、是實用：
   *   ① `loudnorm I=-14 TP=-1.5` —— 每支影片音量一致。少了它，音量就看 HeyGen／MiniMax
   *      那次輸出多大聲，支跟支之間會有落差。
   *   ② `+faststart` —— moov 放檔頭，前台線上播放不必先載完整個檔（成品 30MB 上下，差別明顯）。
   *
   * ⚠️ `-c:v copy` 是這次最大的改變：Remotion 出來的已經是 H.264 CRF 23，再編一次只是多一次
   *    失真加一兩分鐘。現在只重編音訊（loudnorm 必須重編），所以**檔案大小≒原檔、耗時剩幾秒**。
   *    哪天對方又要求特定視訊規格，把舊參數加回來即可（git 記錄裡有完整那一份）。
   *
   * loudnorm 仍是 two-pass（先 measureLoudness 量、再把量到的值餵回去）—— 單 pass 的動態壓縮
   * 會讓旁白忽大忽小。`aresample=48000` 不能省：loudnorm 內部會把音訊升到 192 kHz。
   */
  async function finalizeOutput(from, to, onProgress) {
    const m = await measureLoudness(from);
    const tmp = to + '.finalize.tmp.mp4';
    try {
      await runFfmpeg([
        '-y', '-hide_banner', '-nostats', '-i', from,
        '-c:v', 'copy',
        '-af', `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}`
          + `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}`
          + ':linear=true,aresample=48000',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
        '-movflags', '+faststart',
        tmp,
      ], onProgress);
      fs.renameSync(tmp, to); // 轉完才就位 —— 中途失敗不會在成品庫留半支
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      throw e;
    }
    return m;
  }

  /**
   * 把成品另存到成品庫，檔名取成人看得懂的：
   *   jobs/<日期>_<標題>_<完整ID>/landscape.mp4
   * jobs/ 會被自動清掉，這裡不會 —— 這才是「以後還找得到」的那一份。
   */
  function archivePath(job, outName) {
    const dir = STORE.directory(job.id, job);
    ensureDir(dir);
    const name = outputName(outName);
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    let dest = path.join(dir, name);
    let n = 2;
    while (fs.existsSync(dest)) dest = path.join(dir, `${base}(${n++})${ext}`);
    return dest;
  }

  return { runFfmpeg, measureLoudness, finalizeOutput, archivePath };
};
