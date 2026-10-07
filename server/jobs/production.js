// @ts-nocheck
'use strict';

/**
 * 出片兩段：準備（跑到配圖計畫）與渲染（收成品），以及每支跑完後的備份。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得（測試可換成假的 fs／子程序）。
 */

module.exports = function create(ctx) {
  const { fs, path, config: { ROOT, WORKSPACE_ROOT, SHOTS_DIR }, TEMPLATES, outputPath, jobPath, jobDir, ensureDir, rmrf, nowISO,
    appendLog, saveJob, runPipeline, runMotion, clearWorkspaceInputs, stageJobInputs, snapshotWorkspace, restoreWorkspace,
    collectMotionAssets, buildPlanView, applyPlanEdits, recordCorrections, learnFromEdits, writeEmphasis, readJobEmphasis,
    readJobMotion, normalizeEmotion, archivePath, finalizeOutput, MOTION_FILE } = ctx;
    const execFileSync = (...a) => ctx.childProcess.execFileSync(...a);

  /**
   * 「對照組」計畫：假裝沒有人工標注，讓自動判定自己排一次。
   *
   * 為什麼要這一步（2026-08-21 使用者定案「要，而且要真的比對」）：
   * 手動標記過的句子，auto-shot／auto-focus 是**完全不碰**的 —— 標注直接變成計畫的一部分。
   * 所以那些句子在修正紀錄裡沒有「AI 的版本」可以比，等於最有價值的訊號（人覺得需要自己標）
   * 一筆都沒留下。這裡多跑一次同一支腳本、只是加上 `--no-annots`，就得到「AI 本來會怎麼配」。
   *
   * 安全性：
   *   - 一定帶 `--out` 寫到 `jobs/<id>/auto-noannots.json`，**不會碰到要 render 的計畫檔**。
   *   - 不呼叫 HeyGen、不重新轉字幕，只是重跑判定，幾秒鐘的事。
   *   - 整段包在 try 裡，失敗就當沒有對照組（修正紀錄少一種類型，不影響出片）。
   *   - 沒有任何標注就不用跑（多數情況），省下這幾秒。
   */
  function buildCounterfactual(job) {
    try {
      const annFile = jobPath(job.id, 'input', 'annotations.json');
      if (!fs.existsSync(annFile)) return;
      const shots = (JSON.parse(fs.readFileSync(annFile, 'utf-8')).shots || []).filter((a) => a && a.src);
      if (!shots.length) return;

      const out = jobPath(job.id, 'auto-noannots.json');
      // 2026-09-22：planKind 'focus'（三大法人）移除後只剩 auto-shot.js 這一條路。
      execFileSync('node', [path.join(SHOTS_DIR, 'auto-shot.js'), '--write', '--out', out, '--no-annots'],
        { cwd: ROOT, stdio: 'ignore', timeout: 120000 });

      const n = JSON.parse(fs.readFileSync(out, 'utf-8')).length;
      appendLog(job, `\n🔬 對照組：不看手動標記的話，自動判定會排 ${n} 段（只用來寫修正紀錄，不影響出片）\n`);
    } catch (e) {
      appendLog(job, `\n⚠️ 對照組計算失敗（不影響出片，只是修正紀錄少一項）：${e.message}\n`);
    }
  }

  async function doPrepare(job) {
    job.status = 'preparing';
    job.startedAt = nowISO();
    saveJob(job);

    clearWorkspaceInputs();
    stageJobInputs(job);

    // 發音替換是「默默套用」的（使用者定案，畫面上不顯示），但出現怪唸法時
    // 總要查得到是不是它搞的 —— 所以在執行記錄留一行。前台完全看不到這段。
    const vr = job.voiceRules || {};
    if ((vr.own || []).length || (vr.shared || []).length) {
      appendLog(job, `\n🗣  發音替換：本支 ${(vr.own || []).length} 條`
        + `${(vr.own || []).length ? '（' + vr.own.join('、') + '）' : ''}`
        + `　共用詞庫 ${(vr.shared || []).length} 條`
        + `${(vr.shared || []).length ? '（' + vr.shared.join('、') + '）' : ''}\n`);
    }

    const args = [`--template=${job.template}`, '--stop-before-render'];
    if (job.skipGenerate) args.push('--skip-generate');
    if (job.noSpeed) args.push('--no-speed');
    // 一律明講，不靠 run.js 的預設 —— 出片當下用的是哪個語氣要留在執行記錄裡（run.js 配音那行會印）。
    args.push(`--emotion=${normalizeEmotion(job.emotion)}`);
    await runPipeline(job, args);

    buildCounterfactual(job);
    snapshotWorkspace(job);
    job.planView = buildPlanView(job);
    job.preparedAt = nowISO();

    if (job.autoApprove) {
      // 一段式：不停下來，直接接著 render
      job.status = 'approved';
      job.approvedAt = nowISO();
      job.approvedBy = '（自動出片）';
      appendLog(job, '\n⏩ 已勾選「直接出片」，跳過人工確認\n');
      // 2026-08-25：按「標好了，直接出片」也要留下修正紀錄、也要學進記憶庫。
      // 在這之前這兩支只在 /approve handler 呼叫，而這條路完全繞過它 —— 同事一按那顆按鈕，
      // 這支工作的 data/corrections.jsonl 與 data/shot-memory.json 就什麼都不會寫
      // （0825 那支實測：修正紀錄最後一筆還停在前一支）。
      // edits 傳空陣列：這條路沒人在計畫頁改過東西，能記能學的全部在 annotations.json 裡，
      // recordCorrections 的「人工標記 vs 對照組」與 learnFromEdits 都會自己去讀。
      recordCorrections(job, job.planView, []);
      learnFromEdits(job, []);
    } else {
      job.status = 'review';
    }
    saveJob(job);
  }

  async function doRender(job) {
    job.status = 'rendering';
    saveJob(job);

    restoreWorkspace(job);
    // ⚠️ 要在 restoreWorkspace 之後（ROOT 才是 render 讀的那一份），跟 applyPlanEdits 同一時機。
    //    來源是工作自己的 input/emphasis.json，不分是在標注頁、計畫頁還是排隊階段標的
    //    ——「直接出片」那條路不經過計畫頁，以前就是在這裡整個漏掉。
    {
      const marks = writeEmphasis(readJobEmphasis(job));
      if (marks.length) appendLog(job, `\n🖍 字幕重點詞 ${marks.length} 處\n`);
    }
    // 動態小影片：同一個時機、同一個理由。快照裡是 prepare 當時的結果，但人可能在
    // 配圖計畫頁又改過、或才第一次標（「直接出片」那條路也不經過計畫頁）。
    // 先把最新設定寫回工作區，再用 --if-changed 決定要不要重做 —— 沒改就 0.09 秒跳過。
    // ⚠️ 失敗一律降級成「這支沒有動態」，跟 run.js 那邊同一個原則。
    try {
      const mf = path.join(ROOT, 'public', 'motion.json');
      const motion = readJobMotion(job);
      if (motion.length) fs.writeFileSync(mf, JSON.stringify(motion, null, 2) + '\n');
      else rmrf(mf);
      // 輸出進 log、子程序可被取消、跑太久會被停掉，全都在 runMotion 裡。
      await runMotion(job);
      // 報**實際產出**的段數，不是前台標了幾段 —— 參數產不出來時 render-motion 會寫入空陣列，
      // 印設定的數字就變成「log 說有 1 段、影片裡卻什麼都沒有」（2026-09-19 踩過）。
      let made = 0;
      try { made = JSON.parse(fs.readFileSync(path.join(ROOT, MOTION_FILE), 'utf-8')).length; } catch (_) {}
      if (motion.length) {
        appendLog(job, made
          ? `\n🎬 動態小影片 ${made} 段\n`
          : `\n⚠️ 標了 ${motion.length} 段動態，但一段都沒產出（原因見上面）——這支影片不會有動態\n`);
      }
    } catch (e) {
      // 取消不是「失敗」—— 照原樣寫成「這支沒有動態」會讓人以為出片還在跑、只是少了動態。
      if (job.status !== 'cancelled') {
        appendLog(job, `\n⚠️ 動態小影片重算失敗（不影響出片，只是這支沒有動態）：${e.message}\n`);
        try { fs.writeFileSync(path.join(ROOT, MOTION_FILE), '[]\n'); } catch (_) {}
      }
    }
    // ⚠️ 動態渲染那段時間取消鍵是**按得動的**（2026-09-21 改成非同步之後才會這樣；
    //    以前 event loop 被 spawnSync 綁住，請求根本進不來）。按了就到此為止 ——
    //    再往下走會 applyPlanEdits、真的出片，最後一句 job.status = 'done' 還會把
    //    cancelled 蓋掉，變成「按了取消卻拿到成品」，而且製作快照已經被取消那邊刪了。
    if (job.status === 'cancelled') {
      appendLog(job, '\n⛔ 動態渲染已停止，這支不再往下出片\n');
      return;
    }
    if (job.pendingEdits && job.pendingEdits.length) {
      applyPlanEdits(job, job.pendingEdits);
      // 「人工標記」那一類不是這一步套用的（它是標注頁的產物，只為了寫修正紀錄而記），
      // 算進來會讓這行數字看起來比實際改動多（2026-08-21）。
      const applied = (job.corrections || []).filter((c) => c.type !== '人工標記').length;
      appendLog(job, `\n✏️  已套用 ${applied} 項人工修正\n`);
    }

    const args = [`--template=${job.template}`, '--render-only'];
    const renderFrom = Date.now() - 3000; // 容忍一點時鐘誤差
    await runPipeline(job, args);

    // 收成品
    // ⚠️ 只收「這次真的重新產生」的檔。out/ 底下的檔名是固定的，上一支的成品會一直留著；
    //    不比對時間就會把舊檔當成這次的成果交出去
    //   （2026-08-17 實際踩到：只出客製版，卻附上四天前的投廣版）。
    // 成品只存「一份」，放在成品庫。網頁直接從那裡播、從那裡下載。
    // 不再在 jobs/<id>/out 留第二份 —— 同一支大盤存兩份就是 276MB，純浪費
    //（2026-08-17 使用者點出來的）。成品庫失敗才退回 jobs/ 當保險。
    job.finishedAt = nowISO();
    job.outputs = [];
    const fallbackDir = jobPath(job.id, 'out');
    for (const rel of TEMPLATES[job.template].outputs) {
      const from = outputPath(WORKSPACE_ROOT, rel);
      if (!fs.existsSync(from)) continue;
      if (fs.statSync(from).mtimeMs < renderFrom) {
        appendLog(job, `⏭  略過 ${rel}：這次沒有重新產生，是上一支留下的舊檔\n`);
        continue;
      }
      const name = path.basename(rel);
      let size = fs.statSync(from).size;
      try {
        const dest = archivePath(job, name);
        // 2026-09-17 起**每一支成品都收尾**（含橫式與投廣版），不再只挑直式。
        // ⚠️ 收尾失敗一定要退回 copyFileSync —— 不能因為 ffmpeg 掛掉就沒有成品。
        appendLog(job, `\n🎛  ${name} 收尾（響度 −14 LUFS／TP −1.5 ＋ faststart，視訊不重編）…\n`);
        try {
          const m = await finalizeOutput(from, dest);
          size = fs.statSync(dest).size;
          appendLog(job, `   ✅ 收尾完成（源響度 ${m.input_i} LUFS／TP ${m.input_tp} dBTP → −14／−1.5）\n`);
        } catch (e) {
          appendLog(job, `   ⚠️ 收尾失敗，改用原始渲染檔（音量沒正規化）：${e.message}\n`);
          fs.copyFileSync(from, dest);
        }
        job.outputs.push({ name, size, archive: path.relative(WORKSPACE_ROOT, dest) });
      } catch (e) {
        ensureDir(fallbackDir);
        fs.copyFileSync(from, path.join(fallbackDir, name));
        job.outputs.push({ name, size });
        appendLog(job, `⚠️ 存進成品庫失敗，先留在工作區：${e.message}\n`);
      }
    }
    if (!job.outputs.length) throw new Error('render 跑完了，但找不到輸出檔案。請看執行記錄。');

    // 動態小影片落地（2026-09-21）。實作在 collectMotionAssets()。
    // 存不進去不影響影片本身 —— 動態早就貼進成品了，這裡只是多留一份可下載的素材。
    job.motionClips = [];
    try {
      job.motionClips = collectMotionAssets(job);
      if (job.motionClips.length)
        appendLog(job, `\n🎬 動態素材 ${job.motionClips.length} 支已存進「素材／動態」，成品頁可以單獨下載\n`);
    } catch (e) {
      appendLog(job, `\n⚠️ 動態素材沒能存進工作（影片本身不受影響）：${e.message}\n`);
    }

    job.status = 'done';
    job.archived = job.outputs.map((o) => o.archive).filter(Boolean);
    if (job.archived.length) appendLog(job, '\n📁 成品庫：\n   ' + job.archived.join('\n   ') + '\n');

    // ── 唸法：不自動判、請人回報 ──────────────
    // 這裡以前會跑 check-pronunciation 然後把候選字寫進 job.pronounce。2026-08-27 拿掉了：
    // 判得不準（見檔頭註解），而人本來就會把每一支聽過一遍。改成提醒他去回報就好。
    appendLog(job, '\n🗣 出片完成，聽到唸錯的字可以回報 —— '
      + '工作頁「發音回報」那張卡片（就在成品下面），填「唸錯的詞」跟「該怎麼寫」送出即可。\n');

    // 保留製作快照，供歷史查閱與重跑使用。
    saveJob(job);
  }

  /**
   * 把一支工作的原始輸入備份至該工作 _meta/backups/job-backup/。
   * 2026-09-03 使用者定案：備份 = input/ 全部（heygen.mp4、截圖、script.txt、annotations.json）
   *   + job.json + log.txt；排除 state/、thumbs/、衍生的 *.json。
   * 為什麼不沿用 run.js 的 backupJob()：那支只存 public/heygen.mp4 + script.txt，
   *   截圖與 annotations.json 從來沒被備份過，prune 一刪就沒了（2026-09-02 實際發生：07g0 的 input/ 消失）。
   * input/ 內同名同大小就跳過（prepare 與 render 各會經過一次 .finally，heygen.mp4 不要複製兩次）；
   * job.json / log.txt 很小且會一直變，每次都覆蓋。
   * 寫失敗只寫進 log 警告，絕對不能影響出片。
   * ⚠️ 尚未做保留期限（heygen.mp4 幾天後清掉）—— 使用者還沒定案，先只加不刪。
   */
  function backupJobArtifacts(job) {
    if (!job || !job.id) return;
    const src = jobDir(job.id);
    const dst = jobPath(job.id, 'backups', 'job-backup');
    const copy = (from, to, skipIfSameSize) => {
      if (!fs.existsSync(from)) return;
      if (skipIfSameSize && fs.existsSync(to) && fs.statSync(to).size === fs.statSync(from).size) return;
      ensureDir(path.dirname(to));
      fs.copyFileSync(from, to);
    };
    try {
      const input = jobPath(job.id, 'input');
      copy(jobPath(job.id, 'input', 'script.txt'), path.join(dst, 'input', 'script.txt'), false);
      if (fs.existsSync(input)) {
        for (const n of fs.readdirSync(input)) {
          const f = path.join(input, n);
          if (fs.statSync(f).isFile()) copy(f, path.join(dst, 'input', n), true);
        }
      }
      copy(path.join(src, 'job.json'), path.join(dst, 'job.json'), false);
      copy(path.join(src, 'log.txt'), path.join(dst, 'log.txt'), false);
    } catch (e) {
      try { appendLog(job, `\n⚠️ 工作備份失敗（不影響出片）：${e.message}\n`); } catch (_) {}
    }
  }

  /**
   * 舊清理入口保留，但不刪除永久工作資料。
   * 回傳釋出的位元組數。啟動時與每支工作跑完後都會呼叫。
   */
  function pruneOldJobs() {
    // 工作紀錄是永久資料；不依時間、狀態或缺片清理輸入、影片與快照。
    // 暫存清理需另設明確範圍，目前此舊入口保留為無副作用操作。
    return 0;
  }

  return { buildCounterfactual, doPrepare, doRender, backupJobArtifacts, pruneOldJobs };
};
