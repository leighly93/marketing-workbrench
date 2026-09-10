/**
 * 三大法人專用時間軸設定。
 *
 * 跟大盤小報（./DapanXiaobao/dapan-timeline.ts）一樣、只是各自獨立（天條 #4 精神延伸）：
 *   - dapan-timeline.ts        讀 dapan-shots.generated.json
 *   - institution-timeline.ts  讀 institution-shots.generated.json（三大法人 (shot:) 專用）
 *
 * 影片尺寸/幀率/heygen 時長從 ../timeline.ts re-export（stage 0 transcribe 共用產出）。
 */

import subtitleData from '../subtitles.json';
import generatedShots from './institution-shots.generated.json';
import generatedFocuses from './institution-focus.generated.json';
import regionsData from './institution-regions.generated.json';
import {
  VIDEO_FPS,
  VIDEO_WIDTH,
  VIDEO_HEIGHT,
  HEYGEN_DURATION_SEC,
  secToFrame,
} from '../timeline';

export { VIDEO_FPS, VIDEO_WIDTH, VIDEO_HEIGHT, HEYGEN_DURATION_SEC, secToFrame };

// 開場卡（institution-intro-frame.jpg）固定顯示 1 秒
export const INSTITUTION_INTRO_SEC = 1;
// 三大法人沒有 outro，總長 = 開場卡 + heygen 期（只有直式）
export const INSTITUTION_TOTAL_DURATION_SEC =
  INSTITUTION_INTRO_SEC + HEYGEN_DURATION_SEC;

export const INSTITUTION_BGM = {
  src: 'institution-bgm.wav',
  volume: 0.15,
  fadeInSec: 1.0,
  fadeOutSec: 2.0,
};

// ---------------- char-index → 秒數（同 dapan-timeline，不共用同一份渲染邏輯檔） --------
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
};

export type InstitutionShot = {
  src: string;
  startSec: number;
  endSec: number;
};

export const INSTITUTION_SHOTS: InstitutionShot[] = (generatedShots as GeneratedShot[])
  .flatMap((g) => {
    const t = resolveByCharIdx(g.startCharIdx, g.endCharIdx);
    if (!t) return [];
    return [{ src: g.src, startSec: t.start, endSec: t.end }];
  })
  .sort((a, b) => a.startSec - b.startSec);

// ---------------- 聚焦效果（focus）：講到某段數據時把資訊圖捲到該區塊、壓暗其餘、框住某格 ----------
// 版面座標（區塊帶 + 逐字框）由 scripts/analyze-institution-image.js 用 OCR 產出，不寫死。
type Box = { x: number; y: number; w: number; h: number };
type RegionsFile = {
  imageFile?: string;
  imageWidth: number;
  imageHeight: number;
  sections: Record<string, { top: number; bottom: number }>;
  words: Array<{ t: string; x: number; y: number; w: number; h: number; c: number }>;
};
const REGIONS = regionsData as RegionsFile;

type GeneratedFocus = {
  section: string;
  cellText: string;
  startCharIdx: number;
  endCharIdx: number;
  _phrase?: string;
  // 前台手動標記給的原圖座標。有 region 就不必用 section 查區塊帶、
  // 有 cell 就不必用 cellText 去 OCR 逐字框比對（那是會框到隔壁格的那一步）。
  region?: Box;
  cell?: Box;
  // 2026-08-21 起配圖計畫也能改三大法人，所以一列不再一定是「那張版面圖」：
  //   src 省略        → 版面圖（＝以前的行為，往前相容）
  //   src 是別張截圖  → 那張截圖，尺寸要自己帶（版面圖的 OCR 尺寸對它無效）
  //   wholePage: true → 整張蓋滿（(shot:) 標記的段併進來時就是這種）
  src?: string;
  imageWidth?: number;
  imageHeight?: number;
  wholePage?: boolean;
};

export type InstitutionFocus = {
  startSec: number;
  endSec: number;
  src: string;
  imageWidth: number;
  imageHeight: number;
  section: { top: number; bottom: number }; // 圖片座標
  cell: Box | null; // 圖片座標；要高亮的那格（找不到就不畫框）
  // 人工圈的框：畫面上就照人圈的大小畫，不要再套自動留白（那是為 OCR 單字框設計的）
  cellManual?: boolean;
  // 整張蓋滿：不捲動、不壓暗、不畫框
  wholePage?: boolean;
};

// 在指定區塊帶內、找 OCR 逐字框裡包含 cellText 的字（避免撞到「重點」框裡同樣數字）。
function findCellBox(
  cellText: string,
  band: { top: number; bottom: number }
): Box | null {
  if (!cellText) return null;
  const cy = (w: { y: number; h: number }) => w.y + w.h / 2;
  const cands = (REGIONS.words || [])
    .filter((w) => w.c >= 30 && w.t.includes(cellText))
    .filter((w) => cy(w) >= band.top && cy(w) <= band.bottom);
  if (cands.length === 0) return null;
  // 取信心最高的一個
  const best = cands.sort((a, b) => b.c - a.c)[0];
  return { x: best.x, y: best.y, w: best.w, h: best.h };
}

export const INSTITUTION_LAYOUT_IMAGE = REGIONS.imageFile || 'image.png';

export const INSTITUTION_FOCUS: InstitutionFocus[] = (generatedFocuses as GeneratedFocus[])
  .flatMap((f): InstitutionFocus[] => {
    const t = resolveByCharIdx(f.startCharIdx, f.endCharIdx);
    if (!t) return [];
    const src = f.src || INSTITUTION_LAYOUT_IMAGE;
    const isLayout = src === INSTITUTION_LAYOUT_IMAGE;
    // 別張截圖沒有 OCR 尺寸可查 —— 前台改圖時會把量到的原圖尺寸一起送過來
    const imageWidth = f.imageWidth || (isLayout ? REGIONS.imageWidth : 0);
    const imageHeight = f.imageHeight || (isLayout ? REGIONS.imageHeight : 0);
    const base = { startSec: t.start, endSec: t.end, src, imageWidth, imageHeight };

    // 手動標記優先：直接用人圈的座標，不回頭查表
    const band = f.region
      ? { top: f.region.y, bottom: f.region.y + f.region.h }
      : (isLayout ? REGIONS.sections?.[f.section] : undefined);

    // 整張蓋滿：(shot:) 併進來的段、或「別張截圖但沒圈範圍」。
    // ⚠️ 沒有 band 又不當整張處理的話這一列會被 flatMap 丟掉 —— 人明明加了一段卻什麼都沒出來，
    //    是最難查的那種靜默失敗，所以這裡一律退成整張，不要 return []。
    if (f.wholePage || !band) {
      if (isLayout && !f.wholePage && typeof window !== 'undefined') {
        // eslint-disable-next-line no-console
        console.warn(`[institution-focus] 區塊 ${f.section} 不在 regions 內，改成整張顯示`);
      }
      return [{ ...base, section: { top: 0, bottom: imageHeight }, cell: null, wholePage: true }];
    }

    const cell = f.cell ?? (isLayout ? findCellBox(f.cellText, band) : null);
    return [
      {
        ...base,
        section: { top: band.top, bottom: band.bottom },
        cell,
        cellManual: !!f.cell,
      },
    ];
  })
  .sort((a, b) => a.startSec - b.startSec);

// ---------------- 聚焦段合併成 run（2026-08-21 使用者要求）----------------------------
/**
 * 把「連續、而且是同一張圖」的聚焦段落併成一個 run。
 *
 * 為什麼（使用者：「連續兩三句都有配圖，圖片一直淡入淡出很煩」）：
 * 原本一段配圖＝一個獨立圖層，每層自己淡入 0.35 秒。實測 2026-08-21 那支三大法人，
 * 9 段配圖**全部都是同一張 shot1.png**，其中 6 段擠在 3.6~17.8 秒（中間空檔只有
 * 0~0.46 秒）→ 同一張圖淡入 6 次；而且那些不到半秒的空檔會讓圖整個消失、露出主播、
 * 再淡回來，比完全不做轉場還吵。
 * 併成 run 之後圖片全程留在畫面上，只有「顯示區域／壓暗帶／黃框」平滑滑到下一個位置。
 *
 * 不併的情況：
 *   - 換了另一張圖（本來就該淡入淡出，這是有意義的轉場）
 *   - 中間空超過 FOCUS_RUN_GAP_SEC（畫面真的回到主播了，再淡入才合理）
 *   - 一邊是「整張蓋滿」一邊是「捲到某區塊」（兩種呈現方式，中間沒有可以插值的東西）
 *
 * 門檻沿用大盤小報／焦點股日報的 buildShotRuns（../ShotFocus.tsx）同一個 2.0 秒，
 * 三條產線行為一致。⚠️ 這裡假設 INSTITUTION_FOCUS 已經照 startSec 排序（上面有 .sort）。
 */
export const FOCUS_RUN_GAP_SEC = 2.0;

export type InstitutionFocusRun = {
  src: string;
  startSec: number;
  endSec: number;
  imageWidth: number;
  imageHeight: number;
  /** 整張蓋滿（不捲動、不壓暗、不畫框）。run 內每一段都一樣，不會混。 */
  wholePage: boolean;
  cells: InstitutionFocus[];
};

/** 這一段是不是「整張蓋滿」。imageWidth/Height 為 0 時算繪端也會退成整張，這裡要一致。 */
function isFullBleed(f: InstitutionFocus): boolean {
  return !!f.wholePage || !f.imageWidth || !f.imageHeight;
}

export const INSTITUTION_FOCUS_RUNS: InstitutionFocusRun[] = (() => {
  const runs: InstitutionFocusRun[] = [];
  for (const f of INSTITUTION_FOCUS) {
    const full = isFullBleed(f);
    // ⚠️ 2026-08-25：跟 ../ShotFocus.tsx 的 buildShotRuns 同步 —— 往回找「最近一個同一張圖」，
    //    不是只看上一筆。中間插一張別的圖就併不起來，同一張圖會多淡入淡出一次（大盤實測到的）。
    //    這支影片剛好九段都同一張圖所以沒踩到，但兩邊必須一致，不然下次三大法人配到兩張圖交錯就會出事。
    let last: InstitutionFocusRun | null = null;
    for (let i = runs.length - 1; i >= 0; i--) {
      if (runs[i].src === f.src && runs[i].wholePage === full) { last = runs[i]; break; }
    }
    if (last && f.startSec - last.endSec <= FOCUS_RUN_GAP_SEC) {
      last.endSec = Math.max(last.endSec, f.endSec);
      last.cells.push(f);
    } else {
      runs.push({
        src: f.src,
        startSec: f.startSec,
        endSec: f.endSec,
        imageWidth: f.imageWidth,
        imageHeight: f.imageHeight,
        wholePage: full,
        cells: [f],
      });
    }
  }
  return runs;
})();

if (typeof window !== 'undefined') {
  // eslint-disable-next-line no-console
  console.log(
    `[institution-timeline] ${(generatedShots as GeneratedShot[]).length} 個截圖標記 → 命中 ${INSTITUTION_SHOTS.length} 個`,
    INSTITUTION_SHOTS
  );
  // eslint-disable-next-line no-console
  console.log(
    `[institution-timeline] ${INSTITUTION_FOCUS.length} 段聚焦 → 併成 ${INSTITUTION_FOCUS_RUNS.length} 個 run（同一張圖、間隔 ≤ ${FOCUS_RUN_GAP_SEC}s 就不重新淡入）`,
    INSTITUTION_FOCUS_RUNS.map((r) => `${r.src} ${r.startSec.toFixed(2)}~${r.endSec.toFixed(2)}s ×${r.cells.length}`)
  );
}
