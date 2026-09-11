/**
 * 大盤小報專用時間軸設定。
 *
 * 跟 ../timeline.ts 是平行的兩份設定，不共用 overlay 來源（天條 #4 精神延伸）：
 *   - ../timeline.ts   讀 overlays.generated.json（現有模板 (imageN)/(shot:)/(logo)）
 *   - dapan-timeline.ts 讀 dapan-shots.generated.json（大盤小報 (shot:) 專用）
 *
 * 影片尺寸/幀率/heygen 時長是 stage 0（transcribe）共用產出，兩邊都從 ../timeline.ts
 * re-export 讀，不重複定義；只有「這次要疊什麼圖 / 用什麼 BGM / 開場卡多長」是 dapan 專屬。
 */

import subtitleData from '../subtitles.json';
import { buildShotRuns, markRunCuts, type ShotBox } from '../ShotFocus';
import generatedShots from './dapan-shots.generated.json';
import {
  VIDEO_FPS,
  VIDEO_WIDTH,
  VIDEO_HEIGHT,
  HEYGEN_DURATION_SEC,
  secToFrame,
} from '../timeline';

export { VIDEO_FPS, VIDEO_WIDTH, VIDEO_HEIGHT, HEYGEN_DURATION_SEC, secToFrame };

// 開場卡（intro-frame.jpg）固定顯示 1 秒
export const DAPAN_INTRO_SEC = 1;
// 大盤小報沒有 outro（不催下載），總長 = 開場卡 + heygen 期
export const DAPAN_TOTAL_DURATION_SEC = DAPAN_INTRO_SEC + HEYGEN_DURATION_SEC;

// 橫式版（DapanXiaobaoLandscape）沒有開場卡，影片直接開始，總長 = heygen 期
export const DAPAN_LANDSCAPE_DURATION_SEC = HEYGEN_DURATION_SEC;

export const DAPAN_BGM = {
  src: 'dapan-bgm.wav',
  volume: 0.15,
  fadeInSec: 1.0,
  fadeOutSec: 2.0,
};

// ---------------- char-index → 秒數（複製自 ../timeline.ts 的 resolveByCharIdx，
// 因為那支沒 export、且天條 #4 精神延伸不共用同一份渲染邏輯檔） ----------------
type ScriptCharTime = { start: number; end: number };
type WhisperOutput = { _scriptCharTimes?: ScriptCharTime[]; _scriptText?: string };
const subtitles = subtitleData as WhisperOutput;
const SCRIPT_CHAR_TIMES: ScriptCharTime[] = subtitles._scriptCharTimes ?? [];
/** cleaned script 原文，跟 SCRIPT_CHAR_TIMES 同長度、同索引（correct-subtitles.js 第 8b 步寫入；舊 state 沒有 → ''）。 */
const SCRIPT_TEXT: string = subtitles._scriptText ?? '';

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
  imageWidth?: number | null;
  imageHeight?: number | null;
};

export type DapanShot = {
  src: string;
  startSec: number;
  endSec: number;
  /** 腳本字元範圍（含）—— joinPunctuationAdjacent 要看兩段之間夾了什麼字 */
  startCharIdx: number;
  endCharIdx: number;
  cell?: ShotBox;
  region?: ShotBox;
  cellText?: string;
  /** 人工框：渲染時只留一點視覺呼吸，不套 OCR 用的自動留白 */
  cellManual?: boolean;
  isColumn?: boolean;
  wholePage?: boolean;
  imageWidth?: number | null;
  imageHeight?: number | null;
};

export const DAPAN_SHOTS: DapanShot[] = (generatedShots as GeneratedShot[])
  .flatMap((g) => {
    const t = resolveByCharIdx(g.startCharIdx, g.endCharIdx);
    if (!t) return [];
    return [
      {
        src: g.src,
        startSec: t.start,
        endSec: t.end,
        startCharIdx: g.startCharIdx,
        endCharIdx: g.endCharIdx,
        cell: g.cell,
        region: g.region,
        cellText: g.cellText,
        cellManual: g._manualCell,
        isColumn: g.isColumn,
        wholePage: g.wholePage,
        imageWidth: g.imageWidth,
        imageHeight: g.imageHeight,
      },
    ];
  })
  .sort((a, b) => a.startSec - b.startSec);

if (typeof window !== 'undefined') {
  // eslint-disable-next-line no-console
  console.log(
    `[dapan-timeline] ${(generatedShots as GeneratedShot[]).length} 個截圖標記 → 命中 ${DAPAN_SHOTS.length} 個`,
    DAPAN_SHOTS
  );
}

/**
 * 「只隔標點就接續」（2026-09-07 使用者定案）：
 * 前一段配圖的最後一個字，跟下一段配圖的第一個字之間，如果**一個字都沒有**（只夾標點或空白 ——
 * 逗號、頓號、分號、句號、問號、驚嘆號全算），旁白就是連著講的，中間不該露出講者：
 * 把前一段的結束時間直接延到下一段的開始，後面 buildShotRuns / markRunCuts 看到間隔 0 就會走硬切、不淡。
 *
 * 為什麼不用秒數：逗號停頓 0.2～0.6 秒、句號可能到 1 秒，MiniMax 每次配音又不一樣，
 * 純時間門檻（cutGapSec 0.4）永遠有剛好踩線的案例 —— 0903 Ryan 那支 shot2→shot3 隔 0.34 秒就是。
 * markRunCuts 的 0.4 秒規則**留著當備援**（兩條是「或」）：它管的是中間夾了幾個沒配圖的字、
 * 或標點對時對得怪的情況。
 *
 * 只往後延、不往前拉：後一張圖是跟著那句話的第一個字出現的，提早進來會變成「圖先到、話還沒講」；
 * 前一張多停一下則察覺不到。
 * ⚠️ 目前 cleanBodyWithIndex()（scripts/script-utils.js）會把所有標點與空白**整個拿掉**，
 *    所以 cleaned script 裡「只隔標點」＝「字元索引剛好相鄰」（endCharIdx+1 === startCharIdx），
 *    句號逗號在這一層已經分不出來 —— 這正好就是使用者要的（全算）。
 *    有 _scriptText 就照原文看夾了什麼（哪天清洗規則留下標點也照樣對）；
 *    沒有 _scriptText（舊 state 重 render）就退回看索引相鄰，結果一樣。
 * 「同一張圖」的相鄰段也會被接，對 buildShotRuns 沒影響（它本來就以 2 秒為門檻併同圖）。
 */
const NON_WORD_RE = /^[^\p{L}\p{N}]*$/u;
export function joinPunctuationAdjacent<T extends { startSec: number; endSec: number; startCharIdx: number; endCharIdx: number }>(
  shots: T[],
  scriptText: string = SCRIPT_TEXT
): T[] {
  const sorted = [...shots].sort((a, b) => a.startSec - b.startSec);
  const out = sorted.map((s) => ({ ...s }));
  for (let i = 0; i < out.length - 1; i++) {
    const a = out[i];
    const b = out[i + 1];
    if (b.startCharIdx <= a.endCharIdx) continue;          // 字元範圍重疊／同位 → 不是「前後兩段」
    if (b.startSec <= a.endSec) continue;                    // 時間本來就相接或重疊，沒洞可填
    const adjacent = scriptText
      ? NON_WORD_RE.test(scriptText.slice(a.endCharIdx + 1, b.startCharIdx))
      : b.startCharIdx === a.endCharIdx + 1;
    if (!adjacent) continue;                                 // 中間有字 → 交給時間規則
    a.endSec = b.startSec;
  }
  return out;
}

// 連續同一張圖合併成 run：圖片全程不下畫面、只有黃框移動（與焦點股同一套）
// markRunCuts：連續出現的圖之間不淡出又淡入（2026-08-26 使用者要求，說明見 ../ShotFocus.tsx）。
// joinPunctuationAdjacent：只隔標點的兩段先接起來（2026-09-07），再進上面兩支。
// 直式與橫式兩個 composition 都吃這一份 runs → 一起生效。
export const DAPAN_SHOT_RUNS = markRunCuts(buildShotRuns(joinPunctuationAdjacent(DAPAN_SHOTS), 2.0));

if (typeof window !== 'undefined') {
  // eslint-disable-next-line no-console
  console.log(
    `[dapan-timeline] ${DAPAN_SHOTS.length} 段 → ${DAPAN_SHOT_RUNS.length} 個 run（標點接續：${SCRIPT_TEXT ? '看 _scriptText' : '無 _scriptText，看索引相鄰'}）`,
    DAPAN_SHOT_RUNS.map((r) => `${r.src} ${r.startSec.toFixed(2)}~${r.endSec.toFixed(2)}s${r.cutIn ? ' cutIn' : ''}${r.cutOut ? ' cutOut' : ''}`)
  );
}
