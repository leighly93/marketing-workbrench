import subtitleData from '../subtitles.json';
import generatedMotion from './motion.generated.json';
import videoMeta from '../video-meta.json';

/**
 * 動態小影片的時間軸：把 `motion.generated.json` 的 charIdx 範圍解成秒數。
 *
 * ⚠️ 這支是**三個版型共用**的（大盤小報／盤中焦點／美股焦點），跟 `*-shots.generated.json`
 * 每個版型各一份的做法不同 —— 因為動態的資料結構與時間解析完全一樣，沒有版型差異，
 * 複製三份只會讓之後改一個行為要改三個地方。版型差異只在「貼在畫面的哪一塊」，
 * 那是 `MotionOverlay` 的 `region` 參數。
 *
 * char-index → 秒數的解法與 `dapan-timeline.ts` 的 `resolveByCharIdx` 相同（那支沒 export）。
 */

type ScriptCharTime = { start: number; end: number };
type WhisperOutput = { _scriptCharTimes?: ScriptCharTime[] };
const SCRIPT_CHAR_TIMES: ScriptCharTime[] =
  (subtitleData as WhisperOutput)._scriptCharTimes ?? [];

function resolveByCharIdx(
  startCharIdx: number,
  endCharIdx: number
): { start: number; end: number } | null {
  if (
    SCRIPT_CHAR_TIMES.length === 0 ||
    startCharIdx < 0 ||
    endCharIdx >= SCRIPT_CHAR_TIMES.length
  ) {
    return null;
  }
  const startT = SCRIPT_CHAR_TIMES[startCharIdx];
  const endT = SCRIPT_CHAR_TIMES[endCharIdx];
  if (!startT || !endT) return null;
  if (endT.end <= startT.start) return null;
  return { start: startT.start, end: endT.end };
}

/**
 * 講者影片有多長。動態的時間軸就是這支影片的時間軸（_scriptCharTimes 是從它的音訊算的），
 * 所以「做在結尾的那段要演到最後」就是演到這個秒數。
 */
const HEYGEN_END_SEC: number =
  Number((videoMeta as { heygenDurationSec?: number }).heygenDurationSec) || 0;

type GeneratedMotion = {
  /** 直式那支的檔名（相對於 public/） */
  src: string;
  /** 橫式那支的檔名。只出直式的版型不會有這欄。 */
  srcLandscape?: string;
  startCharIdx: number;
  endCharIdx: number;
  /** 給人看的：這段對應的原稿文字 */
  _phrase?: string;
  /**
   * 這段做在腳本結尾 → 演到影片結束，不要淡出回講者（2026-09-21 使用者定案）。
   * 由 render-motion 判定並寫進來；這裡不自己猜，因為「算到哪裡算結尾」是產線的規則。
   */
  toEnd?: boolean;
};

export type MotionRun = {
  src: string;
  srcLandscape?: string;
  startSec: number;
  endSec: number;
  startCharIdx: number;
  endCharIdx: number;
  /** 演到影片結束、尾端不淡出 */
  toEnd?: boolean;
};

/**
 * 解不出時間的段落直接丟掉（跟配圖同一個規則）——
 * 寧可這支沒有動態，也不要用錯的時間貼上去蓋住講者。
 */
export const MOTION_RUNS: MotionRun[] = (generatedMotion as GeneratedMotion[])
  .flatMap((g) => {
    const t = resolveByCharIdx(g.startCharIdx, g.endCharIdx);
    if (!t) return [];
    // 做在結尾的那段延到影片結束。HEYGEN_END_SEC 讀不到（0）或比原本還早時維持原樣 ——
    // 寧可照舊淡出，也不要因為一個怪數字把動態切掉或拉過頭。
    const toEnd = !!g.toEnd && HEYGEN_END_SEC > t.end;
    return [{
      src: g.src,
      srcLandscape: g.srcLandscape,
      startSec: t.start,
      endSec: toEnd ? HEYGEN_END_SEC : t.end,
      startCharIdx: g.startCharIdx,
      endCharIdx: g.endCharIdx,
      toEnd,
    }];
  })
  .sort((a, b) => a.startSec - b.startSec);
