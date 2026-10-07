// @ts-nocheck
'use strict';

/**
 * 工作：列表、建立、上傳、送出、重新出片、單筆讀取與刪除。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得（測試可換成假的 fs／子程序）。
 */

module.exports = function createRoutes(ctx) {
  const { fs, path, crypto, process, timers, store: STORE, TEMPLATES, isMockMode, isAdmin, clientIp, send, readJson, nowISO,
    ensureDir, rmrf, jobPath, newId, saveJob, appendLog, getJob, allJobs, addJob, removeJob, refreshDetached, isBusy, publicJob,
    tick, normalizeEmotion, mergeVoiceRules, voiceRuleHits, voiceSection, buildScript, reportOwnVoiceRules, nextShotName,
    ensureUsableImage, IMAGE_KIND_LABEL, publishLateUpload, buildPlanView, pendingAnnotsOf } = ctx;

  return async function handle({ req, res, url, p, seg, admin }) {
    if (p === '/api/jobs' && req.method === 'GET') {
      refreshDetached();
      return send(res, 200, { jobs: allJobs().slice(0, 50).map((j) => publicJob(j, admin)), busy: isBusy() });
    }

    if (p === '/api/jobs' && req.method === 'POST') {
      const body = await readJson(req);
      if (!TEMPLATES[body.template]) return send(res, 400, { error: '版型不對' });
      if (TEMPLATES[body.template].disabled) return send(res, 400, { error: '這個版型目前關閉中' });
      if (!body.body || !body.body.trim()) return send(res, 400, { error: '腳本是空的' });
      // 標題：行數一律以版型設定為準；每行字數只有「不能換行」的模板（投廣）才截斷。
      // 會換行的模板讓標題超過上限，交給 composition 自動換行（2026-08-17 使用者定案）。
      const tcfg = TEMPLATES[body.template].title || { lines: 2, per: 12, wrap: true };
      const title = String(body.title || '').split('\n')
        .map((l) => (tcfg.wrap ? l.trim() : l.trim().slice(0, tcfg.per))).filter(Boolean)
        .slice(0, tcfg.lines).join('\n');
      const job = {
        id: newId(),
        template: body.template,
        owner: (body.owner || '').trim() || '未署名',
        title,
        status: 'draft', // 上傳完檔案才轉 queued
        createdAt: nowISO(),
        // 送出這支的機器 IP。owner 是自己填的、可以亂填，這欄是佐證「到底哪台送的」。
        // 只在建立當下記一次（核准／取消／刪除都不記）；只有管理者拿得到（見 publicJob）。
        ip: clientIp(req),
        skipGenerate: !!body.skipGenerate,
        noSpeed: !!body.noSpeed,
        withAd: !!body.withAd,
        emotion: normalizeEmotion(body.emotion),
        brand: body.brand ? String(body.brand) : null,
        autoApprove: !!body.autoApprove,
        // 模擬模式建立的工作永遠帶著標記：之後關掉模擬模式，也認得出哪些成品是假的
        ...(isMockMode(process.env) ? { mock: true } : {}),
      };
      // 共用詞庫在這裡就併進 script.txt —— 之後整條 pipeline 都不知道有這回事，
      // 而且這支工作的 script.txt 永遠留著「當時實際套了哪些規則」。
      const { own, shared } = mergeVoiceRules(body.voice);
      job.voiceRules = {
        own: own.map((r) => `${r.from}→${r.to}`),
        shared: shared.map((r) => `${r.from}→${r.to}`),
        // 只有打中內文的那幾條才會進 hit —— 前台顯示的是這個，不是整本詞庫。
        // 算的是 body.body（＝腳本內文），標題不送 TTS、不套發音替換。
        hit: voiceRuleHits(body.body, [
          ...own.map((r) => ({ ...r, src: 'own' })),
          ...shared.map((r) => ({ ...r, src: 'shared' })),
        ]),
      };
      STORE.directory(job.id, job);
      ensureDir(jobPath(job.id, 'input'));
      fs.writeFileSync(jobPath(job.id, 'input', 'script.txt'),
        buildScript({ voice: voiceSection(own, shared), title, body: body.body }));
      addJob(job);
      saveJob(job);
      reportOwnVoiceRules(job, own);
      return send(res, 200, { job: publicJob(job, admin) });
    }

    // 上傳單一檔案：整個 request body 就是檔案內容（不用 multipart，省一個相依套件）
    // ?auto=1&ext=.png → 檔名交給伺服器排（手動標記頁的「＋ 上傳更多截圖」走這條）。
    // ⚠️ 編號一定要伺服器算：前台自己算的話，兩個人同時補圖就會撞到同一個 shotN，
    //    後上傳的直接蓋掉先上傳的，而且既有標注還指著那個檔名 → 圖被換掉且完全沒有提示。
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'upload' && req.method === 'POST') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      const auto = url.searchParams.get('auto') === '1';
      let name;
      if (auto) {
        const ext = /^\.jpe?g$/i.test(url.searchParams.get('ext') || '') ? '.jpg' : '.png';
        name = nextShotName(job, ext);
      } else {
        name = path.basename(url.searchParams.get('name') || '');
      }
      if (!name) return send(res, 400, { error: '缺少檔名' });
      const dest = jobPath(job.id, 'input', name);
      ensureDir(path.dirname(dest));
      // ⚠️ auto 模式要先把檔名佔起來。下面是 await（串流寫檔），一次選 3 張的話
      //    三個請求會在任何一個真正寫進去之前都算到同一個編號 → 互相覆蓋。
      if (auto) fs.writeFileSync(dest, '');
      await new Promise((ok, bad) => {
        const ws = fs.createWriteStream(dest);
        req.pipe(ws);
        ws.on('finish', ok);
        ws.on('error', bad);
      });
      // 副檔名是前台按「不是 jpg 就叫 png」硬取的，跟內容無關 —— 這裡才是第一次看到真正的位元組。
      const fix = ensureUsableImage(dest);
      if (fix && fix.error) {
        try { fs.unlinkSync(dest); } catch (_) {}
        return send(res, 400, { error: fix.error });
      }
      if (fix && fix.converted) {
        appendLog(job, `🖼  ${name}：偵測到 ${IMAGE_KIND_LABEL[fix.converted] || fix.converted}，`
          + `已用 ${fix.tool} 自動轉成 ${path.extname(dest).slice(1).toUpperCase()}`);
      }
      // 事後補上傳（工作已經送出去了）→ 要自己把檔案送到「這支工作正在用的那幾份」。
      // 建立工作時（status 'draft'）什麼都不用做：/submit 會重掃 input/，doPrepare 會整包複製。
      if (auto || job.status !== 'draft') publishLateUpload(job, name, dest);
      return send(res, 200, {
        ok: true, name, size: fs.statSync(dest).size,
        converted: (fix && fix.converted) || null,
        files: job.files || null,
      });
    }

    // 上傳完成 → 排進佇列
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'submit' && req.method === 'POST') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      const inputs = fs.readdirSync(jobPath(job.id, 'input'));
      if (fs.existsSync(jobPath(job.id, 'input', 'script.txt'))) inputs.push('script.txt');
      if (job.skipGenerate && !inputs.some((n) => /^heygen\.mp4$/i.test(n)))
        return send(res, 400, { error: '選了「用現成講者影片」，但沒有上傳 heygen.mp4' });
      job.status = 'queued';
      job.files = inputs;
      saveJob(job);
      // setImmediate 不是 tick()，理由同 /approve —— doPrepare 也是同步複製完輸入檔
      // 才交出 event loop，回應要先出去。
      timers.setImmediate(tick);
      return send(res, 200, { job: publicJob(job, admin) });
    }

    /**
     * 重新出片：拿一支既有工作的全部輸入，原封不動再跑一次。
     *
     * 為什麼要有（2026-09-16）：那天字幕時間軸壞掉，同事只能手動重來一次 ——
     * 重貼稿件、重傳兩張截圖、**重畫一次顯示範圍與黃框**。重畫的結果跟原本不一樣
     * （兩份 annotations.json 一個 1128 bytes、一個 936 bytes），等於白做還做走樣。
     * 這些東西每一樣都已經存在工作資料夾裡了，沒有理由要人重做。
     *
     * 帶過去的東西：
     *   script.txt（已含當時實際套用的發音詞庫段）／素材全部（截圖 ＋ annotations.json）
     *   ／講者影片（優先用素材裡的，沒有就用製作快照那份）／版型、語氣、品牌等旗標。
     *
     * ⚠️ 一律 skipGenerate：不呼叫 HeyGen、不呼叫 MiniMax，**不會重新扣點數**。
     * ⚠️ 稿件不給改：annotations.json 是用字元索引（startCharIdx／endCharIdx）定位的，
     *    稿件改一個字，後面的標注就會整段錯位而且不會報錯。要改稿就得開新工作重畫。
     *
     * 2026-09-18 使用者定案：**直接排進佇列，不停在 draft**。
     *   09-17 曾經加過一道 draft 關卡（「確認，開始出片」），本意是讓人先看過標注再跑。
     *   實際用下來變成要按兩顆按鈕，而且第二顆（配圖計畫那關）才是真正看得到東西的地方 ——
     *   draft 那關只看得到自己畫的標注，配圖計畫要等字幕轉完才算得出來。
     *   配圖計畫頁能做的事是 draft 那關的超集（拖框、改範圍、換圖、加減段、上傳更多截圖、
     *   標重點詞），所以少那一關沒有任何功能損失，只少按一顆。
     *
     * ⚠️ autoApprove **不繼承**（2026-09-18 使用者定案）。
     *   來源工作如果開過「標好了，直接出片」，整包複製會把它也帶過來 ——
     *   結果是重新出片跑完就自動核可、直接出片，使用者根本看不到配圖計畫。
     *   但「進來重新出片」的動機本身就是要改東西，系統沒有任何依據知道人什麼時候改完。
     *   所以一律從關閉開始，要自動出片由人在頁面上自己按。
     */
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'redo' && req.method === 'POST') {
      const src = getJob(seg[2]);
      if (!src) return send(res, 404, { error: '找不到工作' });
      // 正在跑的不給重跑：它的製作快照這一刻正在被寫，複製過去的可能是半份。
      // detached 也算 —— 那是「伺服器重開過，但 run.js 還活著在背景跑」。
      if (['preparing', 'rendering', 'detached'].includes(src.status))
        return send(res, 400, { error: '這支還在跑，等它結束再重新出片' });
      // 版型整個被移除 → 複製出來的工作一送出就會失敗，在這裡就講清楚。
      // 只是「關閉中」的版型照樣放行 —— 舊工作本來就還能重跑，只是開不了新的（見上面 TEMPLATES 的註解）。
      if (!TEMPLATES[src.template])
        return send(res, 400, { error: `這支用的版型「${src.template}」已經不在了，沒辦法重跑。` });

      const scriptFrom = jobPath(src.id, 'input', 'script.txt');
      const materialDir = path.dirname(jobPath(src.id, 'input', '_'));
      // 講者影片：素材裡那份是「當初送進去的」，快照那份是「這支實際用來出片的」。
      // 兩份都帶著加速記號判斷（run.js alreadySpedUp），不會被重複加速。
      const heygenFrom = [
        jobPath(src.id, 'input', 'heygen.mp4'),
        jobPath(src.id, 'state', 'public', 'heygen.mp4'),
      ].find((p) => fs.existsSync(p));

      // 版型被移除的舊工作不能重跑：composition、素材與 parse/use script 都不在了，
      // 硬跑只會在 remotion 那一步失敗，不如在這裡講清楚（2026-09-22 移除三大法人等三個版型）。
      if (!TEMPLATES[src.template]) {
        return send(res, 400, {
          error: `這支工作的版型「${src.template}」已經移除，不能重跑。工作與成品都還在，可以照常查看與下載。`,
        });
      }

      const missing = [];
      if (!fs.existsSync(scriptFrom)) missing.push('script.txt');
      if (!heygenFrom) missing.push('講者影片（素材/heygen.mp4 或製作快照）');
      if (missing.length) {
        return send(res, 400, {
          error: `這支工作缺少重跑需要的檔案：${missing.join('、')}。`
            + '（功能上線前的舊工作可能沒有留製作快照，只能重新建立一支。）',
        });
      }

      const job = {
        id: newId(),
        template: src.template,
        owner: src.owner,
        title: src.title,
        status: 'queued',
        createdAt: nowISO(),
        ip: clientIp(req),
        skipGenerate: true,
        noSpeed: !!src.noSpeed,
        withAd: !!src.withAd,
        emotion: normalizeEmotion(src.emotion),
        brand: src.brand ? String(src.brand) : null,
        // 不繼承（見上面的說明）：內容設定照抄，但「要不要停下來等人」這種流程設定要由人重新決定。
        autoApprove: false,
        // 稿件整份照抄，所以當時算出來的命中清單也照抄 —— 不重算，免得詞庫改過之後
        // 記錄跟 script.txt 的實際內容對不起來。
        voiceRules: src.voiceRules || { own: [], shared: [], hit: [] },
        redoOf: src.id,
      };

      STORE.directory(job.id, job);
      ensureDir(jobPath(job.id, 'input'));
      fs.writeFileSync(jobPath(job.id, 'input', 'script.txt'), fs.readFileSync(scriptFrom, 'utf-8'));
      if (fs.existsSync(materialDir)) {
        for (const name of fs.readdirSync(materialDir)) {
          if (name.startsWith('.')) continue;
          const from = path.join(materialDir, name);
          if (!fs.statSync(from).isFile()) continue;
          fs.copyFileSync(from, jobPath(job.id, 'input', name));
        }
      }
      // 素材裡沒有 heygen.mp4（原本是 HeyGen 現生的）→ 從製作快照補一份進去。
      if (!fs.existsSync(jobPath(job.id, 'input', 'heygen.mp4'))) {
        fs.copyFileSync(heygenFrom, jobPath(job.id, 'input', 'heygen.mp4'));
      }
      // OCR 沿用：截圖是原封不動複製過來的，版面偵測結果不可能不一樣。
      // 實測一支 8 張截圖的工作，準備階段 22 秒裡有 18 秒花在這段分析上 —— 重跑純粹是浪費。
      // 這裡把來源快照的結果連同「每張截圖的 md5」寫進新工作的 input/，
      // run.js 在分析前會自己重新算一次 md5 比對，**全部對得上才沿用**；
      // 少一張、多一張、換過一張都會退回照常重跑（見 run.js reuseAppImages）。
      // 沿用失敗不影響出片，最多就是多花那 18 秒，所以整段包在 try 裡。
      const ocrFrom = jobPath(src.id, 'state', 'src', 'app-images.generated.json');
      if (fs.existsSync(ocrFrom)) {
        try {
          const cached = JSON.parse(fs.readFileSync(ocrFrom, 'utf-8'));
          if (Array.isArray(cached.images) && cached.images.length) {
            const inputDir = jobPath(job.id, 'input');
            const sources = {};
            for (const name of fs.readdirSync(inputDir)) {
              if (!/\.(png|jpe?g)$/i.test(name)) continue;
              sources[name] = crypto.createHash('md5')
                .update(fs.readFileSync(path.join(inputDir, name))).digest('hex');
            }
            fs.writeFileSync(jobPath(job.id, 'input', 'app-images.reuse.json'),
              JSON.stringify({ from: src.id, sources, images: cached.images }, null, 2));
          }
        } catch (_) { /* 沿用只是最佳化，壞了就讓它照常重跑 OCR */ }
      }

      job.files = fs.readdirSync(jobPath(job.id, 'input')).filter((n) => !n.startsWith('.'));
      job.files.push('script.txt');
      job.annotationCount = src.annotationCount || 0;

      addJob(job);
      saveJob(job);
      appendLog(job, `♻️ 重新出片：沿用工作 ${src.id} 的稿件、截圖、標注與講者影片。\n`
        + '   不會重新呼叫 HeyGen／MiniMax，也不會重新扣點數。\n'
        + `   帶過來的檔案：${job.files.join('、')}\n`
        + '   直接開始準備（轉字幕、排配圖計畫），跑完會停在「待確認」等你看配圖計畫。\n');
      // setImmediate 不是 tick()，理由同 /approve —— doPrepare 也是同步複製完輸入檔
      // 才交出 event loop，回應要先出去。
      timers.setImmediate(tick);
      return send(res, 200, { job: publicJob(job, admin) });
    }

    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[2] && seg.length === 3 && req.method === 'GET') {
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      // planView 是在「準備中」那一步算好存起來的，所以功能上線前跑的工作
      // 會缺新欄位（例如子句清單 units → 前台的拉範圍會顯示「腳本還在讀…」）。
      // 快照還在的話就地重算，使用者不用重跑一支（2026-08-17 實際踩到）。
      if (job.status === 'review' && !(job.planView && (job.planView.units || []).length)
          && fs.existsSync(jobPath(job.id, 'state'))) {
        try {
          job.planView = buildPlanView(job);
          saveJob(job);
        } catch (_) {}
      }
      // planView 是「準備中」那一刻算好凍起來的，但標注可以在那之後才存進來。
      // 「沒被吃到的標注」很便宜（只讀一個 json，不重畫縮圖），每次都重算 ——
      // 不然剛好卡在計畫算完那一秒存下去的標注，會永遠不出現（2026-08-21）。
      if (job.status === 'review' && job.planView) {
        try { job.planView.pendingAnnots = pendingAnnotsOf(job, job.planView.rows); } catch (_) {}
      }
      return send(res, 200, { job: publicJob(job, admin) });
    }

    // 刪除整筆工作（含影片、紀錄）。只有本機管理者能刪；正在跑的不給刪。
    // （2026-08-18 使用者要求：列表加刪除，但只有我本機可以、別人不行。）
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg[2] && seg.length === 3 && req.method === 'DELETE') {
      if (!isAdmin(req)) return send(res, 403, { error: '只有管理者可以刪除工作' });
      const job = getJob(seg[2]);
      if (!job) return send(res, 404, { error: '找不到工作' });
      if (['preparing', 'rendering'].includes(job.status))
        return send(res, 400, { error: '正在跑的工作不能刪，請先取消或等它結束' });
      rmrf(STORE.directory(job.id));      // 明確刪除整筆工作（含影片、稿件與製作資料）
      removeJob(job.id);
      return send(res, 200, { ok: true });
    }
  };
};
