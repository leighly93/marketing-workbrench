// 事後補上傳截圖（手動標記、配圖計畫、截圖面板共用）。
// 走的是建立工作時同一支 upload handler，只是帶 auto=1 讓伺服器排下一個 shotN ——
// 前台自己算編號的話，兩個同事同時上傳就會撞名，把對方的圖蓋掉（而且舊標注還指著那個檔名）。
import { upload } from './api.js';
import { isShotFile, shotExt } from './files.js';

/**
 * @param {object} job
 * @param {File[]} files
 * @param {(text: string) => void} progress
 * @returns {Promise<string[]>} 伺服器排好的檔名；失敗會丟錯，但已經傳上去的會先回報給 progress
 */
export async function uploadMoreShots(job, files, progress = () => {}) {
  const bad = files.find((f) => !isShotFile(f));
  if (bad) throw new Error(`「${bad.name}」不是圖片檔，這裡只能補截圖。`);
  const added = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    progress(`上傳 ${i + 1}/${files.length}（${(f.size / 1048576).toFixed(1)} MB）…`);
    const r = await upload(`/api/jobs/${job.id}/upload?auto=1&ext=${encodeURIComponent(shotExt(f))}`, f);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const e = new Error(`上傳「${f.name}」失敗（${r.status}）${j.error ? '：' + j.error : ''}`);
      e.added = added;   // 前面幾張可能已經上去了 —— 讓呼叫端看得到目前的狀態
      throw e;
    }
    const ok = await r.json().catch(() => ({}));
    if (ok.name) added.push(ok.name);   // 檔名是伺服器排的，一定要用它回傳的那個
  }
  progress(`已上傳 ${added.length} 張`);
  return added;
}

/** 建立階段（草稿）的上傳：檔名固定 shotN／heygen.mp4，同名重傳就是覆蓋。 */
export async function uploadNamed(job, file, name) {
  const r = await upload(`/api/jobs/${job.id}/upload?name=${encodeURIComponent(name)}`, file);
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(`上傳「${file.name}」失敗（${r.status}）${j.error ? '：' + j.error : ''}`);
  }
  return r.json().catch(() => ({}));
}

/** 開一個隱藏的檔案選擇器，回傳選到的檔案（取消回空陣列）。 */
export function pickFiles({ accept = 'image/*', multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept; input.multiple = multiple; input.hidden = true;
    input.onchange = () => { resolve([...input.files]); input.remove(); };
    document.body.append(input);
    input.click();
  });
}
