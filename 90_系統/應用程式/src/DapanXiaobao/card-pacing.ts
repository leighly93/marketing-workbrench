/**
 * 卡片輪播的最短停留（2026-11-18 使用者選「輪播」）—— 純邏輯，測試在 90_系統/測試/卡片輪播停留.test.js。
 *
 * 疊不下的卡（圖太高、或一疊已經 3 張的第 4 張）會一張一張左右輪播。照唸到的時間換卡，
 * 「包含創意、欣興、奇鋐」這種一個股名零點幾秒的，每張都閃一下就過去。
 * 所以每個畫面單位（單張或一疊）至少停 MIN_DWELL_SEC，後面的往後順延（會比旁白晚一點）；
 * 整段時間不夠每張停那麼久時，平均分，不會超出這段卡片區塊（不蓋到後面的講者或動態）。
 *
 *   starts    每個畫面單位原本的出場秒數（照順序）
 *   lasts     每個單位「最後一張卡」進場的秒數（單張＝starts；一疊＝最後疊上去那張）。
 *             停留從這裡算：一疊 3 張剛疊滿就被第 4 張換掉，跟閃一下一樣。
 *   blockEnd  這段卡片區塊結束的秒數
 *   回傳      調整後的出場秒數（同一單位裡的卡一起挪）
 */
export const MIN_DWELL_SEC = 0.8;

export function paceUnits(starts: number[], lasts: number[], blockEnd: number, minDwell: number = MIN_DWELL_SEC): number[] {
  const n = starts.length;
  if (n <= 1) return [...starts];
  const dwell = Math.max(0, Math.min(minDwell, (blockEnd - lasts[0]) / n));
  const out = [starts[0]];
  for (let k = 1; k < n; k++) {
    const prevLast = lasts[k - 1] + (out[k - 1] - starts[k - 1]);
    out.push(Math.max(starts[k], prevLast + dwell));
  }
  return out;
}
