import subtitleData from '../subtitles.json';
import generatedMotion from './motion.generated.json';

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

type GeneratedMotion = {
  /** 直式那支的檔名（相對於 public/） */
  src: string;
  /** 橫式那支的檔名。只出直式的版型不會有這欄。 */
  srcLandscape?: string;
  startCharIdx: number;
  endCharIdx: number;
  /** 給人看的：這段對應的原稿文字 */
  _phrase?: string;
};

export type MotionRun = {
  src: string;
  srcLandscape?: string;
  startSec: number;
  endSec: number;
  startCharIdx: number;
  endCharIdx: number;
};

/**
 * 解不出時間的段落直接丟掉（跟配圖同一個規則）——
 * 寧可這支沒有動態，也不要用錯的時間貼上去蓋住講者。
 */
export const MOTION_RUNS: MotionRun[] = (generatedMotion as GeneratedMotion[])
  .flatMap((g) => {
    const t = resolveByCharIdx(g.startCharIdx, g.endCharIdx);
    if (!t) return [];
    return [{
      src: g.src,
      srcLandscape: g.srcLandscape,
      startSec: t.start,
      endSec: t.end,
      startCharIdx: g.startCharIdx,
      endCharIdx: g.endCharIdx,
    }];
  })
  .sort((a, b) => a.startSec - b.startSec);
