/**
 * 讀圖片尺寸（純 JS，不依賴外部工具）：PNG 讀 IHDR、JPEG 掃 SOF 標記，都失敗才退回 ffprobe。
 *
 * ⚠️ 一定要讀得到尺寸，否則聚焦效果算不出縮放比例、整個失效
 *（2026-08-12 踩到：使用者的截圖是 .jpeg，原本只支援 PNG 而全部回 null）。
 *
 * 2026-09-14 從 analyze-app-images.js 抽出來共用：伺服器在「事後補上傳截圖」時也要量原圖，
 * 才能把 app-images.generated.json 裡**別支工作留下的同名舊分析**作廢（見 server/index.js
 * 的 invalidateStaleAnalysis）。同一套讀法只留一份，免得兩邊對同一張圖量出不同答案。
 */

const fs = require('fs');
const { execFileSync } = require('child_process');

function imageSize(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (_) { return null; }
  // PNG
  if (buf.length > 24 && buf.toString('ascii', 12, 16) === 'IHDR') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG：掃 SOF0~SOF15（略過 SOF4/SOF8/SOF12 這些非影格標記）
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      const isSOF =
        marker >= 0xc0 && marker <= 0xcf &&
        marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  // 退路：ffprobe（流程本來就依賴 ffmpeg）
  try {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file],
      { encoding: 'utf-8' }
    ).trim();
    const m = /^(\d+)x(\d+)/.exec(out);
    if (m) return { width: +m[1], height: +m[2] };
  } catch (_) {}
  return null;
}

/**
 * 決定一段配圖要用哪個原圖尺寸。
 *
 * ⚠️ 2026-09-14 踩到的坑（使用者回報「8月營收／大戶狂賣／散戶 顯示區域框錯」）：
 *   `app-images.generated.json` 是**工作區共用**的產線檔，不是 per-job 的。事後補上傳的截圖
 *   照 `shot<N>` 依序命名，於是很容易跟**上一支工作**的同名圖撞名 —— 那一筆分析還在檔案裡，
 *   尺寸卻是別張圖的（0914 那支：shot2 真的是 869×1884，檔裡寫 1179×1066；shot3 寫 1031×1589）。
 *   `region`／`cell` 存的是「原圖像素座標」，縮放比一錯，圈選的那塊就整個位移＋縮放，
 *   使用者圈的營收表格變成長條圖、圈的大戶賣超變成別的區塊。
 *   以前只擋「查不到那一筆」（→ 退到標注自帶的尺寸），查得到但**內容是別張圖**擋不住。
 *
 * 所以：標注自己量到的尺寸（前台 img.naturalWidth/Height，必定是這支工作正在看的那張圖）
 * 一律優先於分析檔；只有標注沒帶尺寸時才用分析檔。
 *
 * @param {{width?:number,height?:number}|null|undefined} img  app-images.generated.json 的那一筆
 * @param {{imgW?:number,imgH?:number}|null|undefined} ann     人工標注（前台量到的原圖尺寸）
 * @returns {{width:number|undefined, height:number|undefined, stale:boolean}}
 */
function pickImageSize(img, ann) {
  const aW = ann && typeof ann.imgW === 'number' && ann.imgW > 0 ? ann.imgW : undefined;
  const aH = ann && typeof ann.imgH === 'number' && ann.imgH > 0 ? ann.imgH : undefined;
  const iW = img && typeof img.width === 'number' && img.width > 0 ? img.width : undefined;
  const iH = img && typeof img.height === 'number' && img.height > 0 ? img.height : undefined;
  if (aW && aH) {
    return { width: aW, height: aH, stale: !!(iW && iH) && (iW !== aW || iH !== aH) };
  }
  return { width: iW, height: iH, stale: false };
}

module.exports = { imageSize, pickImageSize };
