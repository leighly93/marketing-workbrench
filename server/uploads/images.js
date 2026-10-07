// @ts-nocheck
'use strict';

/**
 * 上傳檔案：圖片格式嗅探與轉檔、事後補圖的命名與同步。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得（測試可換成假的 fs／子程序）。
 */

module.exports = function create(ctx) {
  const { fs, path, config: { ROOT }, imageSize, jobPath, saveJob, appendLog } = ctx;
    const execFileSync = (...a) => ctx.childProcess.execFileSync(...a);

  // ── 上傳圖片的格式防呆 ────────────────────────────────────────────
  // 前台的檔名規則是「不是 .jpg 就叫 .png」（index.html 的 `ups`），**不看內容** ——
  // 所以同事從 Chrome 右鍵存下來的 .webp、從 iPhone 相簿拿的 .heic，
  // 都會變成「副檔名寫 png、內容不是 png」的檔案。
  // tesseract 只吃 png/jpg，讀不出來就沒有 OCR → 沒有聚焦、也沒有截圖，
  // 而版面偵測是**背景執行**的，同事只會看到「影片出來了但圖都沒放」，看不出哪裡錯。
  // 所以在收檔的當下就嗅探真實格式：能轉的當場轉掉，不能轉的擋下來把話講清楚。
  const IMAGE_KIND_LABEL = {
    webp: 'WebP（多半是從網頁右鍵存下來的）',
    heic: 'HEIC（iPhone 照片）',
    gif: 'GIF', bmp: 'BMP', tiff: 'TIFF',
  };

  /** 讀前 16 bytes 認格式。認不出來回 null（不要用副檔名猜，那正是這個坑的成因）。 */
  function sniffImageKind(file) {
    const b = Buffer.alloc(16);
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      fs.readSync(fd, b, 0, 16, 0);
    } catch (_) {
      return null;
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
    }
    if (b.subarray(0, 4).toString('hex') === '89504e47') return 'png';
    if (b.subarray(0, 3).toString('hex') === 'ffd8ff') return 'jpeg';
    if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
    // heic/heif/avif 都是 ISO-BMFF：第 5~8 byte 是 'ftyp'
    if (b.subarray(4, 8).toString('latin1') === 'ftyp') return 'heic';
    if (b.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
    if (b.subarray(0, 2).toString('latin1') === 'BM') return 'bmp';
    const t = b.subarray(0, 4).toString('hex');
    if (t === '49492a00' || t === '4d4d002a') return 'tiff';
    return null;
  }

  /**
   * 原地轉檔。兩個工具都試，回傳成功的那個的名字、都失敗回 null。
   *   sips   —— macOS 內建，**HEIC 只有它一定讀得動**，不必 brew 裝東西
   *   ffmpeg —— 專案本來就在用，webp/gif/bmp/tiff 很穩
   * 順序是「先 sips 後 ffmpeg」：這台是 Mac，內建的那個不用擔心沒裝。
   */
  function convertImageInPlace(file, targetExt) {
    const tmp = file + '.converting.' + targetExt;
    const attempts = [
      ['sips', ['-s', 'format', targetExt === 'jpg' ? 'jpeg' : 'png', file, '--out', tmp]],
      // -frames:v 1 -update 1：動畫 GIF／多頁 TIFF 只取第一張。
      // 少了這兩個旗標，ffmpeg 會想寫成一連串檔案、然後整個失敗（實測動畫 GIF 會被擋掉）。
      ['ffmpeg', ['-v', 'error', '-y', '-i', file, '-frames:v', '1', '-update', '1', tmp]],
    ];
    for (const [cmd, args] of attempts) {
      try {
        // execFileSync 會擋住整個 event loop，所以一定要有 timeout ——
        // 不然一張壞掉的大圖可以讓整台伺服器卡住，其他同事會以為前台掛了。
        execFileSync(cmd, args, { stdio: 'ignore', timeout: 60_000 });
        if (fs.existsSync(tmp) && fs.statSync(tmp).size > 0) {
          fs.renameSync(tmp, file);
          return cmd;
        }
      } catch (_) { /* 換下一個工具 */ }
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
    return null;
  }

  /**
   * 收檔後檢查一張圖能不能用。
   * 回 null＝不用管（不是圖，或格式本來就對）；回 { error } ＝擋下來；回 { converted, tool } ＝轉好了。
   */
  /**
   * 事後補上傳時，下一張截圖要叫什麼名字。
   * 一律 shot<N>，N 取 input/ 裡現有 shotN 的最大值 +1（不是「數量 +1」——
   * 刪過檔的話數量會跟編號對不起來，就會撞名蓋掉別人的圖）。
   * 保險起見再檢查一次檔案存不存在，撞到就往下找。
   */
  function nextShotName(job, ext) {
    const dir = jobPath(job.id, 'input');
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) {}
    let n = 0;
    for (const f of names) {
      const m = f.match(/^shot(\d+)\./i);
      if (m) n = Math.max(n, parseInt(m[1], 10));
    }
    let cand;
    do { n += 1; cand = `shot${n}${ext}`; } while (names.includes(cand) || fs.existsSync(path.join(dir, cand)));
    return cand;
  }

  /**
   * 工作送出之後才補進來的截圖，要自己送到「這支工作正在用的那幾份」。
   *
   * 三個地方，缺一個就會有一種靜默失敗：
   *   ① job.files —— 前台的標注頁與配圖計畫都是照這個清單畫圖的，不補就看不到新圖。
   *   ② ROOT/public —— 這支**正在跑**（preparing）的話，input/ 早就整包複製過去了，
   *      現在補寫還來得及被 run.js 最後才跑的 auto-shot／auto-focus 與 render 讀到。
   *      跟 PUT /annotations 同一個道理、同一個條件：**只有 preparing**。
   *      'queued' 不能補寫 —— 它還沒開始，input/ 之後會整包複製過去本來就會帶到，
   *      現在寫進去反而會蓋掉**別支正在跑**的工作（2026-08-21 已經踩過一次）。
   *   ③ state/public 快照 —— doRender() 是 clearWorkspaceInputs() 之後從快照還原的，
   *      只寫 ROOT/public 的話，準備跑完之後補的圖會在還原那一刻被清掉 → remotion 找不到檔案。
   *      快照還不存在（還在準備中）就不用寫，doPrepare 結尾自己會把 ROOT/public 凍進去。
   */
  /**
   * 事後補上傳的截圖，要把「別支工作留下的同名分析」作廢。
   *
   * ⚠️ 2026-09-14 使用者回報「8月營收／大戶狂賣／散戶 的顯示區域框錯」的根因：
   *   `src/app-images.generated.json` 是**工作區共用**的產線檔，不是 per-job 的；那支分析在
   *   doPrepare 一開頭就跑完了，**事後**補上傳的圖從來沒被它看過。偏偏補上傳一律照
   *   `shot<N>` 依序命名（nextShotName 只看這支工作的 input/），很容易跟上一支工作的
   *   同名圖撞名 —— 於是檔案裡查得到 `shot2.jpg`，寫的卻是**別張圖**的尺寸與 OCR 結果。
   *   0914 那支：三張圖實際都是 869×1884，檔裡寫 shot2=1179×1066、shot3=1031×1589。
   *   `region`（顯示區域）與 `cell`（黃框）存的是原圖像素座標，縮放比一錯整塊就位移＋縮放：
   *   使用者圈的營收表格變成長條圖、圈的大戶賣超變成別的區塊。
   *   （2026-09-01 只補了「查不到那一筆 → 退到標注自帶尺寸」，查得到但是別張圖擋不住。）
   *
   * 作法是把那一筆改成「只剩實際尺寸」的最小筆，不是整筆刪掉：
   *   - 留 file/width/height → 下游拿得到正確縮放比，人工圈的框位置就對了。
   *   - 頁型、股名、topicBox、逐字框全部清掉 → 那些是別張圖的 OCR，留著會讓自動配圖
   *     照別張圖的座標亂框（比沒有更糟）。清成「未知頁面」＝這張沒被分析過，如實。
   *   - 不整筆刪：auto-shot.js 在 `imgs` 空掉時會直接 fail，出片就掛了。
   * 這張圖真正的分析結果要等下一次 analyze-app-images 才會有（重跑整支就會重算）。
   */
  function invalidateStaleAnalysis(job, name, dest) {
    const size = imageSize(dest);
    if (!size) return;
    const files = [
      path.join(ROOT, 'src', 'app-images.generated.json'),
      jobPath(job.id, 'state', 'src', 'app-images.generated.json'),
    ];
    let fixed = null;
    for (const f of files) {
      if (!fs.existsSync(f)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(f, 'utf-8'));
        const list = Array.isArray(data.images) ? data.images : null;
        if (!list) continue;
        const i = list.findIndex((m) => m.file === name);
        if (i < 0) continue;   // 沒撞名＝沒有假資料，下游的「退到標注尺寸」本來就會處理
        const was = list[i];
        if (was.width === size.width && was.height === size.height
            && was.page === 'unknown' && !was.topicBox) continue;   // 已經是最小筆，不用重寫
        fixed = fixed || { w: was.width, h: was.height };
        list[i] = {
          file: name,
          width: size.width,
          height: size.height,
          page: 'unknown',
          pageLabel: '未知頁面',
          isStockPage: false,
          stockName: null,
          stockNameAlts: [],
          stockCode: null,
          topic: null,
          topicTerms: null,
          topicBox: null,
          words: [],
          _staleCleared: true,   // 給人看的：這筆是被作廢的，不是分析出來的
        };
        fs.writeFileSync(f, JSON.stringify(data, null, 2));
      } catch (_) {}
    }
    if (fixed) {
      appendLog(job, `   ↳ ${name} 撞到舊工作留下的同名分析（${fixed.w}×${fixed.h}），`
        + `已改回這張圖的實際尺寸 ${size.width}×${size.height} 並清掉舊的辨識結果`);
    }
  }

  function publishLateUpload(job, name, dest) {
    try {
      if (!Array.isArray(job.files)) job.files = [];
      if (!job.files.includes(name)) job.files.push(name);
      // planView 是「準備中」那一刻算好凍起來的，補上傳的圖不在裡面 —— 縮圖牆（planView.images）
      // 是照它畫的，不補的話重新整理一次新圖就不見了（前台當下是自己把檔名塞進去的）。
      if (job.planView && Array.isArray(job.planView.images)
          && !job.planView.images.includes(name)) job.planView.images.push(name);
      saveJob(job);
    } catch (_) {}
    const copies = [];
    try {
      if (job.status === 'preparing') {
        const to = path.join(ROOT, 'public', name);
        fs.copyFileSync(dest, to);
        copies.push('public/');
      }
      const snap = jobPath(job.id, 'state', 'public');
      if (fs.existsSync(snap)) {
        fs.copyFileSync(dest, path.join(snap, name));
        copies.push('state');
      }
    } catch (e) {
      appendLog(job, `⚠️ ${name} 補進工作區時出錯：${e.message}（檔案已存在 input/，可重新上傳）`);
      return;
    }
    appendLog(job, `➕ 事後補上傳截圖 ${name}${copies.length ? `（已同步到 ${copies.join('、')}）` : ''}`);
    invalidateStaleAnalysis(job, name, dest);
  }

  function ensureUsableImage(dest) {
    const ext = path.extname(dest).toLowerCase();
    if (ext !== '.png' && ext !== '.jpg' && ext !== '.jpeg') return null; // heygen.mp4 之類的走這裡
    const want = ext === '.png' ? 'png' : 'jpeg';
    const kind = sniffImageKind(dest);
    if (kind === want) return null;
    if (!kind) return { error: '這個檔看起來不是圖片（認不出格式）。請改用 PNG 或 JPG 的截圖。' };
    // kind 是 png/jpeg 但跟副檔名對不上（.jpg 裡裝 png）也一起轉正 ——
    // 下游有些地方是用副檔名判斷的，留著遲早會踩到。
    const tool = convertImageInPlace(dest, ext === '.png' ? 'png' : 'jpg');
    if (!tool) {
      const label = IMAGE_KIND_LABEL[kind] || kind.toUpperCase();
      return {
        error: `這張圖是 ${label}，這台機器轉不過來。`
          + '請在 Mac 上用「預覽程式 → 檔案 → 轉存…」存成 PNG 再上傳一次。',
      };
    }
    return { converted: kind, tool };
  }

  return { IMAGE_KIND_LABEL, sniffImageKind, convertImageInPlace, nextShotName, invalidateStaleAnalysis, publishLateUpload, ensureUsableImage };
};
