// 上傳檔案的判斷與命名（建立頁、事後補圖、講者影片三個入口共用同一套標準）。

/**
 * 這個檔能不能當截圖。
 * ⚠️ 不要只認 f.type —— HEIC 在有些系統給的是空字串，而伺服器其實吃得下
 *    （ensureUsableImage 會把 webp／heic／gif／bmp／tiff 自動轉成 png）。
 */
export function isShotFile(f) {
  return /^image\//.test(f.type) || /\.(png|jpe?g|webp|heic|heif|gif|bmp|tiff?)$/i.test(f.name);
}

/** accept 有時擋不住（有些系統 mp4 的 MIME 是空的），所以副檔名也認。 */
export function isVideoFile(f) {
  return /^video\//.test(f.type) || /\.(mp4|mov|m4v)$/i.test(f.name);
}

/** 副檔名規則：不是 jpg 就叫 png。真正的格式由伺服器嗅探後修正（ensureUsableImage）。 */
export function shotExt(f) {
  return /\.jpe?g$/i.test(f.name) ? '.jpg' : '.png';
}

export function isImageName(n) {
  return /\.(png|jpe?g)$/i.test(n);
}

/** 工作裡的截圖檔名（依伺服器給的 files 清單）。 */
export function jobImages(job) {
  return (job.files || []).filter(isImageName);
}

/** 建立階段的截圖編號：shot1、shot2…（既有檔名裡最大的編號 +1）。 */
export function nextShotName(existing, f) {
  let max = 0;
  for (const n of existing) {
    const m = /^shot(\d+)\./i.exec(n);
    if (m) max = Math.max(max, +m[1]);
  }
  return `shot${max + 1}${shotExt(f)}`;
}
