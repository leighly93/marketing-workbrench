// @ts-nocheck
'use strict';

/**
 * 單筆工作的內容：句子、標注、重點詞、動態、頁型、執行記錄與檔案。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得（測試可換成假的 fs／子程序）。
 */

module.exports = function createRoutes(ctx) {
  const { fs, path, config: { ROOT, SHOTS_DIR, WORKSPACE_ROOT }, store: STORE, send, sendFile, readJson, ensureDir, rmrf, jobPath,
    getJob, saveJob, isRunJs, pagesOf, readJobEmphasis, saveJobEmphasis, emphasisOf, readJobMotion, saveJobMotion,
    EMPHASIS_EDITABLE, MOTION_EDITABLE, MOTION_ASSET_DIR, readSteps } = ctx;
    const execFileSync = (...a) => ctx.childProcess.execFileSync(...a);

  return async function handle({ req, res, url, p, seg, admin }) {
    // 句子清單：交給 auto-shot.js 算（--sentences），確保前台看到的句子
    // 跟配圖用的句子是同一套切法。前台的標注頁存的是這裡的 sentence 編號。
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'sentences') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      const sp = jobPath(job.id, 'input', 'script.txt');
      if (!fs.existsSync(sp)) return send(res, 404, { error: '找不到腳本' });
      try {
        const out = execFileSync('node', [path.join(SHOTS_DIR, 'auto-shot.js'), '--sentences', `--script=${sp}`],
          { cwd: ROOT, encoding: 'utf-8', timeout: 20000 });
        return send(res, 200, JSON.parse(out));
      } catch (e) {
        return send(res, 500, { error: '句子切分失敗：' + e.message });
      }
    }

    // 人工標注：哪張圖配在哪一句、框哪裡、要不要滑動
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'annotations') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      const f = jobPath(job.id, 'input', 'annotations.json');
      if (req.method === 'GET') {
        const data = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : { shots: [] };
        return send(res, 200, data);
      }
      if (req.method === 'PUT') {
        const body = await readJson(req);
        const data = { shots: Array.isArray(body.shots) ? body.shots : [] };
        ensureDir(path.dirname(f));
        fs.writeFileSync(f, JSON.stringify(data, null, 2));
        // ⚠️ 這支正在跑的話，input/ 早就被複製到 public/ 了。
        // auto-shot 是在 run.js 最後才執行，所以現在補寫一份到 public/ 還來得及 ——
        // 這就是「等 HeyGen 的時候順便標注」能生效的關鍵。
        // ⚠️ 只有 'preparing' 才補寫 —— 那代表「這支正佔著 ROOT 在跑」。
        //    'queued' 的還沒開始，它的 input/ 之後會整包複製到 ROOT/public，本來就會帶到；
        //    現在補寫反而會蓋掉別支正在跑的工作。
        if (job.status === 'preparing') {
          fs.writeFileSync(path.join(ROOT, 'public', 'annotations.json'), JSON.stringify(data, null, 2));
        }
        job.annotationCount = data.shots.length;
        saveJob(job);
        // 這支的配圖計畫已經算完了 → 這次存的標注不會進計畫。以前這裡照樣回 ok，
        // 前台顯示「已儲存」，使用者到配圖計畫才發現圖不見（2026-08-21 回報）。
        // 真的沒吃到的那幾筆，buildPlanView 的 pendingAnnots 會讓前台自動補回去。
        // 'draft' 也算吃得到：重新出片複製出來的工作停在 draft 等人確認，它根本還沒開始跑，
        // submit 之後 doPrepare 會把 input/ 整包複製過去。少了它，使用者在確認關卡改完框會看到
        // 紅字「這支的配圖計畫已經算完，這筆不會自動進去」—— 完全相反，而且會讓人以為白改了。
        const applied = ['draft', 'queued', 'preparing', 'detached'].includes(job.status);
        return send(res, 200, { ok: true, count: data.shots.length, applied });
      }
    }

    /**
     * 字幕重點詞（2026-09-17）。跟 /annotations 同一個形狀：GET 讀、PUT 存，存的是
     * 工作自己的 input/emphasis.json。
     *
     * ⚠️ 這裡**不**寫 ROOT —— 跟 annotations 不同。annotations 要趕在 run.js 最後的
     *    auto-shot 之前補進 ROOT/public 才生效；重點詞是 render 階段才讀的，doRender
     *    會在 restoreWorkspace 之後統一寫進去。提早寫只會污染別支正在跑的工作。
     *
     * 能不能標的界線就是「還沒開始 render」。rendering 之後改了也進不了這支成品，
     * 與其讓人白標，不如擋下來說清楚（前台也不會在那些狀態畫出這一區）。
     */
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'emphasis') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      if (req.method === 'GET') {
        const own = readJobEmphasis(job);
        const marks = own.length ? own : emphasisOf(jobPath(job.id, 'state'));
        return send(res, 200, { marks });
      }
      if (req.method === 'PUT') {
        if (!EMPHASIS_EDITABLE.includes(job.status))
          return send(res, 400, { error: '這支已經開始出片了，重點詞改了也進不去' });
        const body = await readJson(req);
        const marks = saveJobEmphasis(job, body.marks);
        job.emphasisCount = marks.length;
        saveJob(job);
        return send(res, 200, { ok: true, marks, count: marks.length });
      }
    }

    /**
     * 動態小影片（2026-09-18）。跟 /emphasis 同一個形狀：GET 讀、PUT 存，
     * 存的是工作自己的 input/motion.json。
     *
     * ⚠️ 時機比重點詞緊：動態是在 **prepare 階段**就 render 的（配圖計畫頁才預覽得到），
     *    所以在 preparing 標的要立刻補進 ROOT/public，才趕得上 run.js 的 renderMotionClips。
     *    判斷條件跟 annotations 一樣只看 'preparing' —— 那代表這支正佔著 ROOT；
     *    'queued' 的還沒開始，它的 input/ 之後會整包複製過去。
     *
     * ⚠️ 趕不上也沒關係：doRender 會在 restoreWorkspace 之後把最新設定寫回去，
     *    再用 --if-changed 決定要不要重做。所以不管什麼時候標都進得了成品。
     */
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'motion') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      if (req.method === 'GET') {
        return send(res, 200, { entries: readJobMotion(job) });
      }
      if (req.method === 'PUT') {
        if (!MOTION_EDITABLE.includes(job.status))
          return send(res, 400, { error: '這支已經開始出片了，動態改了也進不去' });
        const body = await readJson(req);
        const entries = saveJobMotion(job, body.entries);
        if (job.status === 'preparing') {
          const f = path.join(ROOT, 'public', 'motion.json');
          if (entries.length) {
            ensureDir(path.dirname(f));   // 不假設 public/ 一定在（clearWorkspaceInputs 之後可能還沒建回來）
            fs.writeFileSync(f, JSON.stringify(entries, null, 2) + '\n');
          } else rmrf(f);
        }
        job.motionCount = entries.length;
        saveJob(job);
        return send(res, 200, { ok: true, entries, count: entries.length });
      }
    }

    /**
     * 系統判定的頁型（2026-09-17）。配圖計畫頁本來就有（planView.pages），
     * 這支是給**手動標記頁**用的 —— 準備中還沒有 planView，但截圖分析
     *（analyze:app-images）是在準備階段跟 HeyGen 平行跑的，那時候就有結果了。
     *
     * ⚠️ 讀哪一份要看狀態：正在跑的那支，ROOT 就是它的工作區；已經跑完的看自己的快照。
     *    不能一律讀 ROOT —— 那會把**別支正在跑的工作**的頁型秀給這支看。
     */
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'pages' && req.method === 'GET') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      const mine = ['preparing', 'detached'].includes(job.status) && isRunJs(job.pid);
      const pages = pagesOf(mine ? ROOT : jobPath(job.id, 'state'));
      return send(res, 200, { pages });
    }

    // 步驟記錄（_meta/steps.json）：run.js 與伺服器各記各的步驟，前台拿去畫進度。沒檔就是空陣列。
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'steps' && req.method === 'GET') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      return send(res, 200, { steps: readSteps(job).steps });
    }

    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'log') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      const f = jobPath(job.id, 'log.txt');
      const text = fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : '';
      return send(res, 200, { text });
    }

    // 檔案：縮圖 / 截圖 / 成品
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'file') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      const name = path.basename(decodeURIComponent(seg.slice(4).join('/')));
      // ''、'.'、'..' 的 basename 會讓下面的 jobPath 解回「資料夾本身」而不是檔案。
      // 路徑是 basename 過的，跳不出工作目錄，但拿資料夾去開 stream 會炸（見 sendFile）。
      if (!name || name === '.' || name === '..') return send(res, 404, { error: '找不到檔案' });
      // 成品在成品庫，不在 jobs/ 底下（只存一份）
      const arc = (job.outputs || []).find((o) => o.name === name && o.archive);
      if (arc) {
        const f = path.resolve(WORKSPACE_ROOT, arc.archive);
        if (f.startsWith(STORE.directory(job.id) + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile())
          return sendFile(req, res, f, url.searchParams.get('dl') === '1');
      }
      for (const d of ['out', 'thumbs', 'state/public', 'input', `input/${MOTION_ASSET_DIR}`]) {
        const f = jobPath(job.id, d, name);
        // isFile：上面成品那條跟下面靜態檔那條本來就有，只有這個迴圈漏了。
        if (fs.existsSync(f) && fs.statSync(f).isFile())
          return sendFile(req, res, f, url.searchParams.get('dl') === '1');
      }
      return send(res, 404, { error: '找不到檔案' });
    }
  };
};
