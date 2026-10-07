// @ts-nocheck
'use strict';

/**
 * 字幕重點詞與動態小影片的設定：正規化、存在工作 input/、寫進工作區。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得（測試可換成假的 fs／子程序）。
 */

module.exports = function create(ctx) {
  const { fs, path, config: { ROOT }, jobPath, ensureDir, rmrf } = ctx;

  /** 字幕重點詞的存放位置（2026-09-17）。所有版型共用一份 —— 字幕本身就只有一份。 */
  const EMPHASIS_FILE = 'src/emphasis.generated.json';
  const MOTION_FILE = 'src/MotionClip/motion.generated.json';
  const MOTION_SIG_FILE = 'src/MotionClip/motion-sig.generated.json';
  /**
   * 動態小影片存進工作的哪裡（2026-09-21）。
   *
   * 放 input/（就是「素材」）底下的子目錄，理由是使用者把它歸類成素材
   *（「他跟 heygen 影片一樣算是素材」），而**子目錄**這個選擇讓三條路徑自動做對事：
   *   ・重新出片複製素材時有 isFile() 過濾 → 不會把舊動態帶到新工作（新工作會自己重產）
   *   ・backupJobArtifacts 同樣有 isFile() 過濾 → 不佔備份空間（motion.json 還在就能重產）
   *   ・使用者在 Finder 裡一眼看得出這幾支跟截圖、heygen.mp4 不是同一類東西
   * 唯一要另外處理的是 stageJobInputs 的 copyRecursive（見那裡）。
   */
  const MOTION_ASSET_DIR = 'motion';
  /** 動態可以改到什麼時候：跟重點詞一樣，界線是「還沒開始 render」。 */
  const MOTION_EDITABLE = ['draft', 'queued', 'preparing', 'detached', 'review', 'approved'];

  /**
   * 還來得及標重點詞的狀態（2026-09-17）。界線是「這支還沒開始 render」——
   * 只要 doRender 還沒跑，標記就進得了成品。
   * 跟標注頁開放的那一組（draft/queued/preparing/detached）一致，再加上確認關卡
   * 前後的 review 與 approved：使用者在計畫頁按了「確認，開始出片」之後還沒真的
   * 開始 render，那段時間本來就有「↩ 退回確認」可以反悔，重點詞沒道理反而改不了。
   */
  const EMPHASIS_EDITABLE = ['draft', 'queued', 'preparing', 'detached', 'review', 'approved'];

  /** 讀某個根目錄下的重點詞標記；壞掉或沒有就當成沒標。 */
  function emphasisOf(baseDir) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(baseDir, EMPHASIS_FILE), 'utf-8'));
      return (Array.isArray(j.marks) ? j.marks : [])
        .filter((m) => Number.isInteger(m?.startCharIdx) && Number.isInteger(m?.endCharIdx));
    } catch (_) { return []; }
  }

  /**
   * 正規化重點詞：排序、去重、合併重疊與相鄰，順便丟掉負數與頭尾相反的。
   * ⚠️ 前台 toggleEmph() 用的是同一條規則 —— 兩邊不一致的話，「已標 N 處」在送出前後會跳號。
   */
  function normalizeEmphasis(marks) {
    const clean = [];
    for (const m of Array.isArray(marks) ? marks : []) {
      const a = Number(m?.startCharIdx), b = Number(m?.endCharIdx);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) continue;
      clean.push({ startCharIdx: Math.min(a, b), endCharIdx: Math.max(a, b) });
    }
    clean.sort((x, y) => x.startCharIdx - y.startCharIdx);
    const merged = [];
    for (const m of clean) {
      const last = merged[merged.length - 1];
      if (last && m.startCharIdx <= last.endCharIdx + 1) {
        last.endCharIdx = Math.max(last.endCharIdx, m.endCharIdx);
      } else merged.push({ ...m });
    }
    return merged;
  }

  /**
   * 把重點詞寫進 ROOT。
   * ⚠️ 跟 applyPlanEdits 一樣要寫 **ROOT** 不是快照 —— run.js --render-only 只讀 ROOT
   *（2026-08-18 那個「人工框選一直不見」的坑，同一條路）。
   */
  function writeEmphasis(marks) {
    const merged = normalizeEmphasis(marks);
    const f = path.join(ROOT, EMPHASIS_FILE);
    ensureDir(path.dirname(f));
    fs.writeFileSync(f, JSON.stringify({ marks: merged }, null, 2) + '\n');
    return merged;
  }

  /**
   * 每支工作自己的重點詞（2026-09-17）。
   *
   * ⚠️ 為什麼不存 ROOT：ROOT 是**共用**工作區，同一時間只屬於正在跑的那一支。
   *    重點詞要能在「準備中」「待確認」「排隊等出片」三個階段都標，那幾個階段 ROOT
   *    可能正被別支佔著 —— 寫進去會污染別人。放 input/ 跟 annotations.json 同一層：
   *      ① backupJobArtifacts 備份 input/ 全部，它跟著被保住
   *      ② 重新出片（redo）整包帶走 input/，標記自動跟著新工作走
   *    真正寫進 ROOT 的時機只有一個：doRender 的 restoreWorkspace 之後。
   */
  function jobEmphasisFile(job) { return jobPath(job.id, 'input', 'emphasis.json'); }

  /**
   * 動態小影片的設定（2026-09-18）。存在工作自己的 input/motion.json。
   *
   * 為什麼是 input/：`stageJobInputs` 會把整個 input/ 複製進 ROOT/public，
   * 而 render-motion.js 讀的就是 public/motion.json —— 不必另外接線。
   * 「重新出片」整包帶走 input/，動態設定也自動跟著新工作走。
   */
  function jobMotionFile(job) { return jobPath(job.id, 'input', 'motion.json'); }

  function readJobMotion(job) {
    try {
      const j = JSON.parse(fs.readFileSync(jobMotionFile(job), 'utf-8'));
      return normalizeMotion(j);
    } catch (_) { return []; }
  }

  /**
   * 只留下能用的欄位，而且**只收一段**（使用者定案：每支預設 1 段）。
   * spec 原樣保留 —— 它的驗證在 motion-engine.js，那裡才知道三種模板各要什麼。
   */
  function normalizeMotion(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((m) => m && Number.isInteger(m.startCharIdx) && Number.isInteger(m.endCharIdx)
        && m.endCharIdx >= m.startCharIdx)
      .slice(0, 1)
      .map((m) => ({
        startCharIdx: m.startCharIdx,
        endCharIdx: m.endCharIdx,
        ...(m.keyword ? { keyword: String(m.keyword).slice(0, 40) } : {}),
        ...(m.spec && typeof m.spec === 'object' ? { spec: m.spec } : {}),
      }));
  }

  function saveJobMotion(job, raw) {
    const entries = normalizeMotion(raw);
    ensureDir(path.dirname(jobMotionFile(job)));
    if (entries.length === 0) { rmrf(jobMotionFile(job)); return []; }
    fs.writeFileSync(jobMotionFile(job), JSON.stringify(entries, null, 2) + '\n');
    return entries;
  }

  function readJobEmphasis(job) {
    try {
      const j = JSON.parse(fs.readFileSync(jobEmphasisFile(job), 'utf-8'));
      return normalizeEmphasis(j.marks);
    } catch (_) { return []; }
  }

  function saveJobEmphasis(job, marks) {
    const merged = normalizeEmphasis(marks);
    const f = jobEmphasisFile(job);
    ensureDir(path.dirname(f));
    fs.writeFileSync(f, JSON.stringify({ marks: merged }, null, 2) + '\n');
    return merged;
  }

  return { EMPHASIS_FILE, MOTION_FILE, MOTION_SIG_FILE, MOTION_ASSET_DIR, MOTION_EDITABLE, EMPHASIS_EDITABLE, emphasisOf, normalizeEmphasis, writeEmphasis, jobEmphasisFile, jobMotionFile, readJobMotion, normalizeMotion, saveJobMotion, readJobEmphasis, saveJobEmphasis };
};
