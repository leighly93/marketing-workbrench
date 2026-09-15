/**
 * public/ 衛生工具：自動清理殘留 + 自動備份工作檔。
 *
 * 背景：public/ 是 Remotion 每次 render 前「臨時組裝」的暫存區，use-<版型>-assets.js 會把
 * 共用素材/<版型>/ 的素材複製進來（帶版型前綴，如 institution-bgm.wav）。但複製後沒人清，
 * 於是每跑一個版型就留一份，最後三個版型的 bgm/overlay/intro 全堆在 public/ → 又肥又亂。
 *
 * 這支提供兩個函式，由 run.js 在對的時機呼叫：
 *   cleanStaleStaging(projectDir, activeTemplate)
 *     — 只保留「當前版型」的套版素材，刪掉其他版型的殘留（源頭都在 共用素材/，隨時可再複製回來）。
 *   backupJob(projectDir, template, backupRoot = projectDir)
 *     — 把難重來的工作檔（script.txt / heygen.mp4 / image.png）快照到 backups/<時間>-<版型>/。
 *       用「heygen 沒變就不重複備份」避免每次 --skip-generate 重 render 都塞一份 42MB。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 已知的版型前綴（帶前綴的檔案 = 該版型的套版素材，可安全清理/重建）
const TEMPLATE_PREFIXES = ['dapan', 'focusstock', 'institution', 'midday', 'usstock'];
// 備份保留幾份「重量級」快照（含 heygen.mp4），超過就刪最舊的
const KEEP_HEAVY_BACKUPS = 15;

function humanSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + 'MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + 'KB';
  return bytes + 'B';
}

function tsStamp() {
  // Asia/Taipei 的 YYYYMMDD-HHMMSS
  const now = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' })
  );
  const p = (n) => String(n).padStart(2, '0');
  return (
    now.getFullYear() +
    p(now.getMonth() + 1) +
    p(now.getDate()) +
    '-' +
    p(now.getHours()) +
    p(now.getMinutes()) +
    p(now.getSeconds())
  );
}

/**
 * 清掉 public/ 裡「非當前版型」的套版素材殘留。
 * 只刪符合 `<其他版型前綴>-*` 的檔（例：active=institution 時刪 dapan-* / focusstock-*）。
 * 工作檔（heygen.mp4 / image.png / script.txt…）、共用檔（logo.png / 字型）、
 * 一般命名檔（frame.png / outro.mp4）一律不動。
 */
function cleanStaleStaging(projectDir, activeTemplate) {
  const publicDir = path.join(projectDir, 'public');
  if (!fs.existsSync(publicDir)) return;
  const others = TEMPLATE_PREFIXES.filter((p) => p !== activeTemplate);
  let removed = 0;
  let freed = 0;
  for (const name of fs.readdirSync(publicDir)) {
    const isStale = others.some((p) => name.startsWith(p + '-'));
    if (!isStale) continue;
    const fp = path.join(publicDir, name);
    try {
      const st = fs.statSync(fp);
      if (st.isFile()) {
        freed += st.size;
        fs.unlinkSync(fp);
        removed++;
      }
    } catch (_) {}
  }
  if (removed > 0) {
    console.log(
      `🧹 清理 public/ 殘留：刪除 ${removed} 個非「${activeTemplate}」版型素材，釋放 ${humanSize(
        freed
      )}`
    );
  } else {
    console.log('🧹 public/ 已乾淨，無殘留可清');
  }
}

function fileSig(fp) {
  try {
    const st = fs.statSync(fp);
    return st.size + '-' + Math.round(st.mtimeMs);
  } catch (_) {
    return null;
  }
}

function md5(fp) {
  try {
    return crypto.createHash('md5').update(fs.readFileSync(fp)).digest('hex');
  } catch (_) {
    return null;
  }
}

/**
 * 從 projectDir/public 備份到 backupRoot/backups/<時間>-<版型>/。
 * 舊的兩參數呼叫保留同一根目錄；現行 run.js 明確傳入工作副本作 backupRoot。
 * 去重：只有當 heygen.mp4「內容有變」或 script.txt「內容有變」時才建立新快照，
 * 避免同一支 heygen 重複 render 一直塞 42MB。
 * 回傳被建立的備份資料夾路徑，或 null（無變更、略過）。
 */
function backupJob(projectDir, template, backupRoot = projectDir) {
  const publicDir = path.join(projectDir, 'public');
  const backupsDir = process.env.WORKBENCH_JOB_ID
    ? require('../../工作儲存').createJobStore(backupRoot).path(process.env.WORKBENCH_JOB_ID, '備份', '產線快照')
    : path.join(backupRoot, '90_系統', '製作備份', '未指定工作');
  const heygen = path.join(publicDir, 'heygen.mp4');
  const script = path.join(publicDir, 'script.txt');
  const image = path.join(publicDir, 'image.png');

  if (!fs.existsSync(heygen) && !fs.existsSync(script)) {
    return null; // 沒東西可備份
  }
  if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });

  const statePath = path.join(backupsDir, '.last.json');
  let last = {};
  if (fs.existsSync(statePath)) {
    try {
      last = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    } catch (_) {}
  }

  const heygenSig = fileSig(heygen);
  const scriptHash = md5(script);
  const changed =
    heygenSig !== last.heygenSig || scriptHash !== last.scriptHash;

  if (!changed) {
    console.log('💾 備份：heygen 與 script 皆無變更，略過（避免重複備份）');
    return null;
  }

  let dir = path.join(backupsDir, tsStamp() + '-' + template);
  // 同一秒內若已存在（極少見的秒級重跑），加序號避免覆蓋
  let suffix = 2;
  while (fs.existsSync(dir)) {
    dir = path.join(backupsDir, tsStamp() + '-' + template + '-' + suffix++);
  }
  fs.mkdirSync(dir, { recursive: true });
  const copied = [];
  for (const [src, name] of [
    [script, 'script.txt'],
    [heygen, 'heygen.mp4'],
    [image, 'image.png'],
  ]) {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(dir, name));
      copied.push(name);
    }
  }
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify(
      { template, timestamp: tsStamp(), files: copied, heygenSig },
      null,
      2
    )
  );
  fs.writeFileSync(
    statePath,
    JSON.stringify({ heygenSig, scriptHash, template }, null, 2)
  );
  console.log(`💾 已備份工作檔 → ${dir}/（${copied.join(', ')}）`);

  // 工作與未指定工作的製作備份均保留，不在出片時自動淘汰。
  return dir;
}

module.exports = { cleanStaleStaging, backupJob, TEMPLATE_PREFIXES };
