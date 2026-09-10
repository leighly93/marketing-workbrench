/**
 * 盤中焦點專用時間軸設定。
 *
 * 跟 ../DapanXiaobao/dapan-timeline.ts 是平行的兩份設定（天條 #4 精神延伸，不抽共用層）：
 *   - dapan-timeline.ts   讀 ../DapanXiaobao/dapan-shots.generated.json（大盤小報，直式＋橫式）
 *   - midday-timeline.ts  讀 ./midday-shots.generated.json（盤中焦點，只有直式）
 *
 * 影片尺寸/幀率/heygen 時長是 stage 0（transcribe）共用產出，從 ../timeline.ts
 * re-export 讀，不重複定義；只有「這次要疊什麼圖 / 用什麼 BGM / 開場卡多長」是盤中焦點專屬。
 *
 * ⚠️ 盤中焦點**只出直式**，所以這裡沒有 *_LANDSCAPE_DURATION_SEC（大盤小報那條是橫式 composition 用的）。
 */

import subtitleData from '../subtitles.json';
import { buildShotRuns, markRunCuts, type ShotBox } from '../ShotFocus';
import generatedShots from './midday-shots.generated.json';
import {
  VIDEO_FPS,
  VIDEO_WIDTH,
  VIDEO_HEIGHT,
  HEYGEN_DURATION_SEC,
  secToFrame,
} from '../timeline';

export { VIDEO_FPS, VIDEO_WIDTH, VIDEO_HEIGHT, HEYGEN_DURATION_SEC, secToFrame };

// 開場卡（midday-intro-frame.jpg）固定顯示 1 秒
export const MIDDAY_INTRO_SEC = 1;
// 盤中焦點沒有 outro（不催下載），總長 = 開場卡 + heygen 期
export const MIDDAY_TOTAL_DURATION_SEC = MIDDAY_INTRO_SEC + HEYGEN_DURATION_SEC;

export const MIDDAY_BGM = {
  src: 'midday-bgm.wav',
  volume: 0.08,
  fadeInSec: 1.0,
  fadeOutSec: 2.0,
};

// ---------------- char-index → 秒數（複製自 ../timeline.ts 的 resolveByCharIdx，
// 因為那支沒 export、且天條 #4 精神延伸不共用同一份渲染邏輯檔） ----------------
type ScriptCharTime = { start: number; end: number };
type WhisperOutput = { _scriptCharTimes?: ScriptCharTime[] };
const subtitles = subtitleData as WhisperOutput;
const SCRIPT_CHAR_TIMES: ScriptCharTime[] = subtitles._scriptCharTimes ?? [];

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

type GeneratedShot = {
  src: string;
  startCharIdx: number;
  endCharIdx: number;
  _phrase?: string;
  /** auto-shot 產生：這段旁白要框圖上的哪一格／哪一欄 */
  cell?: ShotBox;
  /** 人工圈的「顯示區域」：只顯示這塊、其餘壓黑（跟 cell 是兩件事） */
  region?: ShotBox;
  cellText?: string;
  /** 伺服器標記：這個框是人工拖的／伺服器已經留過白的 → 渲染端不要再加自動留白 */
  _manualCell?: boolean;
  isColumn?: boolean;
  wholePage?: boolean;
  pan?: boolean;
  panToY?: number;
  titleY?: number;
  imageWidth?: number | null;
  imageHeight?: number | null;
};

export type MiddayShot = {
  src: string;
  startSec: number;
  endSec: number;
  cell?: ShotBox;
  region?: ShotBox;
  cellText?: string;
  /** 人工框：渲染時只留一點視覺呼吸，不套 OCR 用的自動留白 */
  cellManual?: boolean;
  isColumn?: boolean;
  wholePage?: boolean;
  pan?: boolean;
  panToY?: number;
  titleY?: number;
  imageWidth?: number | null;
  imageHeight?: number | null;
};

export const MIDDAY_SHOTS: MiddayShot[] = (generatedShots as GeneratedShot[])
  .flatMap((g) => {
    const t = resolveByCharIdx(g.startCharIdx, g.endCharIdx);
    if (!t) return [];
    return [
      {
        src: g.src,
        startSec: t.start,
        endSec: t.end,
        cell: g.cell,
        region: g.region,
        cellText: g.cellText,
        cellManual: g._manualCell,
        isColumn: g.isColumn,
        wholePage: g.wholePage,
        pan: g.pan,
        panToY: g.panToY,
        titleY: g.titleY,
        imageWidth: g.imageWidth,
        imageHeight: g.imageHeight,
      },
    ];
  })
  .sort((a, b) => a.startSec - b.startSec);

if (typeof window !== 'undefined') {
  // eslint-disable-next-line no-console
  console.log(
    `[midday-timeline] ${(generatedShots as GeneratedShot[]).length} 個截圖標記 → 命中 ${MIDDAY_SHOTS.length} 個`,
    MIDDAY_SHOTS
  );
}

// 連續同一張圖合併成 run：圖片全程不下畫面、只有黃框移動（與大盤小報／焦點股同一套）
// markRunCuts：連續出現的圖之間不淡出又淡入（2026-08-26 使用者要求，說明見 ../ShotFocus.tsx）。
export const MIDDAY_SHOT_RUNS = markRunCuts(buildShotRuns(MIDDAY_SHOTS, 2.0));
