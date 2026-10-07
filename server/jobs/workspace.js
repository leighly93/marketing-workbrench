// @ts-nocheck
'use strict';

/**
 * 共用工作區（video/remotion 的 public/ 與 src/ 產出物）：清場、快照、還原、放入這支的輸入。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得（測試可換成假的 fs／子程序）。
 */

module.exports = function create(ctx) {
  const { fs, path, config: { ROOT, WORKSPACE_ROOT }, TEMPLATE_ASSET_PATTERN, jobPath, copyRecursive, rmrf, ensureDir,
    writeEmphasis, MOTION_FILE, MOTION_SIG_FILE, MOTION_ASSET_DIR } = ctx;

  // ⚠️ 2026-09-22：listBrands()（掃 storage/shared-assets/ 底下有 frame.png 的資料夾當投廣品牌清單）
  //    隨投廣模板一起移除。素材資料夾 storage/shared-assets/qizhang-kline、storage/shared-assets/chouma-kline **留著**，
  //    未來節目改名為籌K／起K 系列時要沿用那套外框與 deeplink。
  //    ⚠️ 要重新做品牌選擇時別直接復活這個函式：它是「掃資料夾名」的，
  //       節目資料夾一旦放了 frame.png 就會混進品牌清單。

  // public/ 裡屬於「套版素材」的檔案，清場時不要動（run.js 會自己重新複製，
  // 但留著可以少複製一次；字型更是絕對不能刪）。跟 analyze-app-images.js 同一條規則。
  const TEMPLATE_ASSET = new RegExp(String.raw`${TEMPLATE_ASSET_PATTERN.source}|^outro\.mp4$|^\.`, 'i');

  // 快照要保存哪些檔案：public/ 整包 ＋ src/ 底下的產出物。
  // 這些是「上一段跑完的成果」，後半段 render 完全靠它們。
  // base：拍快照時掃工作區（ROOT），還原時要掃**快照本身** —— 2026-10-01 踩過：
  //   還原時掃 ROOT 的話，clearWorkspaceInputs 剛刪掉的動態指紋檔就不在清單裡，
  //   快照裡有也不還原，--if-changed 永遠判成「有變」，確認後動態一定重做、字卡被重寫。
  function snapshotTargets(base = ROOT) {
    const list = ['public'];
    const src = path.join(base, 'src');
    const walk = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
        else if (/\.generated\.json$/.test(e.name) || /^subtitles(\.original)?\.json$/.test(e.name))
          list.push('src/' + r);
      }
    };
    if (fs.existsSync(src)) walk(src, '');
    return list;
  }

  const LOCK = path.join(WORKSPACE_ROOT, '.run.lock');

  function clearWorkspaceInputs() {
    // ⚠️ 字幕重點詞是**唯一一個不會被重新產生**的 generated 檔（2026-09-17）：
    //    shots／subtitles／video-meta 每支工作都重算一次覆蓋掉，只有它是人工標的，
    //    沒標就沒有任何一步會寫它。不清掉的話，下一支會**繼承上一支的標記**，
    //    而且字元索引是別份腳本的 —— 成品裡會有幾個毫不相干的字莫名其妙放大變黃。
    //    跟「撞名截圖用到上一支的尺寸」同一類的殘留。
    //    restoreWorkspace 也走這支，清完才從快照還原，所以重跑舊工作照樣拿回自己的標記。
    // ⚠️ 要放在下面那個 early return **之前** —— 它清的是 public，跟這個檔沒關係。
    //    ⚠️ 清空不刪除：Subtitles.tsx 靜態 import 它，檔案不在 Remotion 就 bundle 不了
    //       （跟下面 motion.generated.json 同一個道理，2026-09-19 兩個都踩過）。
    writeEmphasis([]);
    // ⚠️ 動態小影片的產出同理（2026-09-18）。render-motion 正常跑完會自己覆蓋成 []，
    //    但 run.js 若在**轉字幕那一步就失敗**根本走不到它，上一支的動態就留在這裡，
    //    下一支 render 時會貼上別支影片的畫面。指紋檔一起清，免得 --if-changed 誤判成「沒變」。
    //    ⚠️ 這個檔要「清空」不能「刪掉」：motion-timeline.ts 靜態 import 它，
    //       檔案不在的話 Remotion 連 bundle 都過不了，render-motion 一開跑就炸。
    try { fs.writeFileSync(path.join(ROOT, MOTION_FILE), '[]\n'); } catch (_) {}
    rmrf(path.join(ROOT, MOTION_SIG_FILE));   // 指紋檔沒有人 import，刪掉即可
    const pub = path.join(ROOT, 'public');
    if (!fs.existsSync(pub)) return;
    for (const n of fs.readdirSync(pub)) {
      if (TEMPLATE_ASSET.test(n)) continue;
      if (/\.(png|jpg|jpeg|mp4|txt|wav|mp3|m4a|aac)$/i.test(n)) rmrf(path.join(pub, n));
    }
    // 標注檔要指名清掉。不能用 *.json 一律清 —— deeplinks.json 是投廣品牌素材。
    rmrf(path.join(pub, 'annotations.json'));
    // 重新出片的 OCR 沿用檔同理（2026-09-18）。run.js 那邊本來就會逐張比對 md5、對不上不沿用，
    // 所以留著也不會誤用；但殘留檔本身就是坑（同一類的「撞名截圖用到上一支的尺寸」踩過），
    // 這支工作沒帶沿用檔就不該在 public 看到別人的。
    rmrf(path.join(pub, 'app-images.reuse.json'));
  }

  function snapshotWorkspace(job) {
    const dst = jobPath(job.id, 'state');
    rmrf(dst);
    for (const rel of snapshotTargets()) copyRecursive(path.join(ROOT, rel), path.join(dst, rel));
  }

  function restoreWorkspace(job) {
    const src = jobPath(job.id, 'state');
    if (!fs.existsSync(src)) throw new Error('找不到這支工作的快照，可能已被清理。請重新建立。');
    clearWorkspaceInputs();
    for (const rel of snapshotTargets(src)) {
      const from = path.join(src, rel);
      if (fs.existsSync(from)) copyRecursive(from, path.join(ROOT, rel));
    }
  }

  /**
   * 把這次 render 出來的動態 mp4 複製進工作的「素材／動態」，回傳 [{name, size}]。
   *
   * 為什麼需要：render 出來的檔躺在**共用**工作區的 public/，下一支出片就被清掉 ——
   * 出一支沒一支。使用者要的是「前期容易失敗、要改手動的時候，有這個可另外下載的素材
   * 會很方便」，所以在這裡留一份，並用 _niceName 那個看得懂的檔名
   *（在這之前 _niceName 只被 render-motion 寫出來，全專案沒有人讀它）。
   *
   * 抽成獨立函式是為了測得到 —— doRender 整條要真的 render 影片才跑得起來。
   */
  function collectMotionAssets(job) {
    // ⚠️ 先清再寫：重跑時這支可能不再有動態，舊檔留著會被當成這次的產物。
    const dir = jobPath(job.id, 'input', MOTION_ASSET_DIR);
    rmrf(dir);
    const clips = [];
    const gen = JSON.parse(fs.readFileSync(path.join(ROOT, MOTION_FILE), 'utf-8'));
    for (const clip of Array.isArray(gen) ? gen : []) {
      // 橫式不一定有 —— 只出直式的版型用 --only=p，那時 srcLandscape 是空的。
      for (const [srcKey, nameKey] of [['src', '_niceName'], ['srcLandscape', '_niceNameLandscape']]) {
        if (!clip[srcKey]) continue;
        const from = path.join(ROOT, 'public', path.basename(clip[srcKey]));
        if (!fs.existsSync(from)) continue;
        // basename：_niceName 是拿腳本內容組出來的，不給它機會跳出這個目錄
        const name = path.basename(clip[nameKey] || clip[srcKey]);
        ensureDir(dir);
        fs.copyFileSync(from, path.join(dir, name));
        clips.push({ name, size: fs.statSync(from).size });
      }
    }
    return clips;
  }

  function stageJobInputs(job) {
    // ⚠️ 跳過 input/動態/：那裡放的是**上一次出片的產物**，不是這次的輸入。
    //    複製進 public/ 只是白佔空間（一支約 3MB），而且 render-motion 本來就會重產。
    copyRecursive(jobPath(job.id, 'input'), path.join(ROOT, 'public'), [MOTION_ASSET_DIR]);
    copyRecursive(jobPath(job.id, 'input', 'script.txt'), path.join(ROOT, 'public', 'script.txt'));
  }

  return { TEMPLATE_ASSET, LOCK, snapshotTargets, clearWorkspaceInputs, snapshotWorkspace, restoreWorkspace, collectMotionAssets, stageJobInputs };
};
