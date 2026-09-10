import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
} from 'remotion';
import {
  INSTITUTION_BGM,
  INSTITUTION_INTRO_SEC,
  INSTITUTION_SHOTS,
  INSTITUTION_FOCUS_RUNS,
  INSTITUTION_TOTAL_DURATION_SEC,
  HEYGEN_DURATION_SEC,
  VIDEO_FPS,
  VIDEO_WIDTH,
  VIDEO_HEIGHT,
  secToFrame,
  type InstitutionFocusRun,
} from './institution-timeline';
import { frameSpan } from '../timeline';
import { Subtitles } from '../Subtitles';
import videoMeta from '../video-meta.json';

/**
 * 三大法人 composition（直式 1080×1920）。
 *
 * 跟大盤小報（../DapanXiaobao/DapanComposition.tsx）是**同一個模子、各自獨立**的兩條產線
 * （天條 #4 精神：不共用容易互相拖累的渲染邏輯檔），只共用 ../Subtitles.tsx。
 * 差異：金橘配色版型、固定主播 avatar、以及日期/標題在版面上的座標不同。
 *
 * 版型（2026-08-10 使用者提供參考圖量測）：
 *   - 開場卡（institution-intro-frame.jpg，1 秒）：金橘背景，「三大法人」白底方塊是印死的美術，
 *     動態疊：日期（白框上方、置中、白色斜體大字）＋標題兩行（白框下方、第一行白、其餘黃）。
 *   - 主段：講者全螢幕 + 常駐 header（institution-header-overlay.png：CMoney logo＋右側「三大法人」白框）
 *     ＋日期（左側深色 bar、白色斜體）＋字幕（沿用大盤小報底部置中樣式）。
 *   - 只有直式，沒有橫式。
 */

/**
 * ⚠️⚠️ 版面定案值（使用者逐版微調拍板，勿隨意覆蓋）⚠️⚠️
 *
 * 2026-08-10 由使用者一版一版調出來的座標；2026-08-12 曾因為改用到「調整前的舊版檔案」
 * 而被整組蓋回預設值（開場日期跑掉、bar 日期變小、講者沒下移），花了時間才發現。
 * 之後要改這支 composition，請務必先確認手上的檔案含有這個區塊，再動手。
 * 所有版面數字集中在這裡，不要散回 JSX 裡寫死。
 */
const LAYOUT = {
  /** 開場卡日期：270px、往下 30、往左 20（2026-08-10 定案） */
  introDate: { top: 410, left: -20, width: 1080, fontSize: 270 },
  /** 開場卡標題 */
  introTitle: { top: 1030, fontSize: 90 },
  /** 主段 header bar 日期：123→143px（再 +20）、往右 15（2026-08-10 定案） */
  mainDate: { top: 112, left: 45, width: 400, fontSize: 143 },
  /** 日期陰影：淺一點、再擴散一點（2026-08-10 定案） */
  dateShadow: '5px 3px 14px rgba(0,0,0,0.45)',
  /** 講者整體下移 100px（2026-08-10 定案） */
  speakerOffsetY: 100,
};

function fadeProgress(
  frame: number,
  start: number,
  end: number,
  fadeSec: number,
): number {
  const dur = end - start;
  if (dur <= 0) return frame >= start && frame <= end ? 1 : 0;
  const fade = Math.min(
    Math.round(fadeSec * VIDEO_FPS),
    Math.floor((dur - 1) / 2),
  );
  if (fade <= 0) return frame >= start && frame <= end ? 1 : 0;
  return interpolate(
    frame,
    [start, start + fade, end - fade, end],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );
}

export const InstitutionComposition: React.FC = () => {
  const introFrames = secToFrame(INSTITUTION_INTRO_SEC);
  const heygenFrames = secToFrame(HEYGEN_DURATION_SEC);
  const totalFrames = secToFrame(INSTITUTION_TOTAL_DURATION_SEC);

  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {/* === 開場卡：institution-intro-frame.jpg 顯示 1 秒 === */}
      <Sequence from={0} durationInFrames={introFrames}>
        <AbsoluteFill>
          <Img
            src={staticFile('institution-intro-frame.jpg')}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </AbsoluteFill>
        {/* 日期：白框上方、整幅置中（實測「三大法人」白框 y764–992、cx≈540）。第一版預設值。 */}
        <InstitutionDateBadge {...LAYOUT.introDate} />
        {/* 標題：白框下方（box 底 ≈992），第一行白、其餘黃。第一版預設值。 */}
        <InstitutionTitleCard {...LAYOUT.introTitle} />
      </Sequence>

      {/* === 主段：主講者影片期 === */}
      <Sequence from={introFrames} durationInFrames={heygenFrames}>
        {/* 主軌：講者影片，objectFit cover 置中填滿直式畫布（來源不論橫直都能填） */}
        <AbsoluteFill style={{ transform: `translateY(${LAYOUT.speakerOffsetY}px)` }}>
          <OffthreadVideo
            src={staticFile('heygen.mp4')}
            volume={1.5}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              objectPosition: 'center center',
            }}
          />
        </AbsoluteFill>

        {/* 截圖段：全螢幕切換（v1，INSTITUTION_SHOTS 目前為空） */}
        {INSTITUTION_SHOTS.map((shot, idx) => {
          const { from, durationInFrames } = frameSpan(shot.startSec, shot.endSec);
          return (
            <Sequence
              key={`${shot.src}-${idx}`}
              from={from}
              durationInFrames={durationInFrames}
            >
              <InstitutionShotImage src={shot.src} durationInFrames={durationInFrames} />
            </Sequence>
          );
        })}

        {/* 聚焦段：講到某段數據時，蓋掉講者、把資訊圖捲到該區塊、壓暗其餘、框住某格。
            座標由 OCR（analyze-institution-image.js）產出，區塊/黃框都不寫死。
            疊在講者之上、字幕/header/日期之下（下面那三層仍在最上層）。 */}
        {/* 2026-08-21 起以 run 為單位（連續、同一張圖的段落已在 timeline 併好）：
            整段只淡入一次、淡出一次，段落之間只把顯示區域與黃框滑過去，不重新淡入。 */}
        {INSTITUTION_FOCUS_RUNS.map((run, idx) => {
          const { from, durationInFrames } = frameSpan(run.startSec, run.endSec);
          return (
            <Sequence key={`focus-${idx}`} from={from} durationInFrames={durationInFrames}>
              <InstitutionFocusRunLayer run={run} durationInFrames={durationInFrames} />
            </Sequence>
          );
        })}

        {/* 字幕層：沿用大盤小報／投廣模板同一套（底部置中、未修改） */}
        <Subtitles />

        {/* 常駐 header bar：金橘 bar + CMoney logo + 右側「三大法人」白框 */}
        <AbsoluteFill style={{ pointerEvents: 'none' }}>
          <Img
            src={staticFile('institution-header-overlay.png')}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </AbsoluteFill>
        {/* 日期：主段左側深色 bar（實測白框 x461–998 / y139–249；日期擺白框左邊的深色區）。第一版預設值。 */}
        <InstitutionDateBadge {...LAYOUT.mainDate} />
      </Sequence>

      {/* === BGM：跨整支影片墊底，頭尾淡入淡出 === */}
      {/* loop：BGM 比影片短時自動從頭接著播，鋪滿整支（2026-08-21 焦點股踩到：
          bgm 52 秒、影片 92 秒，後面 40 秒是無聲）。
          loopVolumeCurveBehavior="extend"＝volume 收到的 f 是整支影片的 frame，
          不是每圈重新從 0 算 —— 否則下面的淡入會在每一圈開頭重新觸發一次。 */}
      <Audio
        loop
        loopVolumeCurveBehavior="extend"
        src={staticFile(INSTITUTION_BGM.src)}
        volume={(f) => {
          const fadeIn = secToFrame(INSTITUTION_BGM.fadeInSec);
          const fadeOut = secToFrame(INSTITUTION_BGM.fadeOutSec);
          if (f < fadeIn) return INSTITUTION_BGM.volume * (f / fadeIn);
          if (f > totalFrames - fadeOut)
            return INSTITUTION_BGM.volume * Math.max(0, (totalFrames - f) / fadeOut);
          return INSTITUTION_BGM.volume;
        }}
      />
    </AbsoluteFill>
  );
};

/**
 * 聚焦段：把三大法人資訊圖（public/image.png）依 OCR 抓到的區塊位置捲到聚焦區、壓暗其餘、
 * 在指定的數字格畫黃框。圖片底下露出的地方壓純黑（不出現講者，天條：三大法人固定這樣做）。
 *
 * 座標換算（跟 mockup 一致）：
 *   sc     = 畫布寬 / 圖片寬（貼齊寬度）
 *   yoff   = FOCUS_TOP − 區塊頂×sc（把區塊頂端捲到 FOCUS_TOP 這條線）
 *   螢幕Y  = 圖片Y×sc + yoff
 * 壓暗用「區塊帶上方一條、下方一條」兩塊半透明黑達成（帶內保持明亮）。
 */
const FOCUS_TOP = 330; // 區塊頂端要落在的螢幕 y（在常駐 header 之下）
const DIM_ALPHA = 0.7; // 區塊帶以外壓暗程度
const HL = '#FFE600'; // 黃框顏色
// 黃框留白：固定 **畫面 px**，人工框、OCR 自動框同值，跟 ../ShotFocus.tsx 的 SHOT_FOCUS.pad 同一個數。
// 2026-09-07 使用者定案「所有黃框不論人工或 OCR 都用人工框那組」。在這之前這裡是
// 人工框 0、自動框依格高 14～46 圖片 px（2026-08-12／08-19 兩次調整），四條產線胖瘦不一。
const CELL_PAD_PX = 10;

// ── 一個 run 的節奏（2026-08-21 使用者定案）────────────────────────────
// 「圖片出現跟結束會淡入淡出比較自然，但連續兩三句都有配圖、一直淡入淡出就很煩。
//   同一張圖不要做淡入淡出，顯示區域不同可以移動顯示區域沒關係。」
/** run 開頭淡入 */
const FOCUS_FADE_IN_SEC = 0.35;
/** run 結尾淡出（2026-08-21 補上；在這之前是硬切） */
const FOCUS_FADE_OUT_SEC = 0.3;
/** run 內段落之間，顯示區域／壓暗帶／黃框滑到新位置要花多久。
    跟 ../ShotFocus.tsx 的 SHOT_FOCUS.transitionSec 同值，三條產線調性一致。 */
const FOCUS_MOVE_SEC = 0.35;

/**
 * 一個 run＝連續、同一張圖的整段時間。
 * 圖片全程掛在畫面上不重新淡入，只有 yoff／壓暗帶／黃框在段落交界平滑移動。
 */
const InstitutionFocusRunLayer: React.FC<{
  run: InstitutionFocusRun;
  durationInFrames: number;
}> = ({ run, durationInFrames }) => {
  const frame = useCurrentFrame();

  // 淡入淡出。
  // ⚠️ 終點是 lastFrame（＝durationInFrames − 1），不是 durationInFrames ——
  //    用後者的話淡出會在「畫面上根本不存在的那一格」才到 0，實際最後一格還有 11% 亮度，
  //    等於淡到一半被硬切掉。
  // ⚠️ budget 保證 fi + fo ≤ lastFrame − 1，也就是中間至少留一格全亮：
  //    ①段落很短時不會「淡入到一半就開始淡出」②插值的關鍵影格不會重複（重複會讓 interpolate 爆掉）。
  const lastFrame = Math.max(0, durationInFrames - 1);
  const budget = Math.max(0, lastFrame - 1);
  const fi = Math.min(Math.round(FOCUS_FADE_IN_SEC * VIDEO_FPS), Math.floor(budget / 2));
  const fo = Math.min(Math.round(FOCUS_FADE_OUT_SEC * VIDEO_FPS), budget - fi);
  const fadeStops: number[] = [];
  const fadeVals: number[] = [];
  if (fi > 0) { fadeStops.push(0, fi); fadeVals.push(0, 1); }
  else { fadeStops.push(0); fadeVals.push(1); }
  if (fo > 0) { fadeStops.push(lastFrame - fo, lastFrame); fadeVals.push(1, 0); }
  const appear = fadeStops.length > 1
    ? interpolate(frame, fadeStops, fadeVals, {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : 1;
  // 進場的輕微上移收斂：只在 run 開頭做一次（不是每一段都做）
  const riseP = fi > 0
    ? interpolate(frame, [0, fi], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
    : 1;
  const rise = (1 - riseP) * 30; // 起始多往下 30px，收斂到 0

  // 整張蓋滿：(shot:) 併進來的段、或人在配圖計畫加了別張截圖但沒圈範圍。
  // 2026-08-21 配圖計畫開放給三大法人之後，一列不再一定是「版面圖上的一個區塊帶」。
  // ⚠️ 這行要在算 sc 之前 —— imageWidth 為 0 時 sc 會變 Infinity，整個版面爆掉。
  if (run.wholePage || !run.imageWidth || !run.imageHeight) {
    return <InstitutionShotImage src={run.src} durationInFrames={durationInFrames} />;
  }

  const sc = VIDEO_WIDTH / run.imageWidth;

  // 每一段的「到位狀態」（都換算成螢幕座標，之後直接對這些數值插值）。
  // 沒有黃框的段落沿用上一段的框幾何，只把 hasCell 降到 0 讓它淡掉 ——
  // 否則框會飛去左上角再淡出，很難看（../ShotFocus.tsx 踩過同樣的坑）。
  let lastCell: { left: number; top: number; width: number; height: number } | null = null;
  const targets = run.cells.map((f) => {
    const yoff = FOCUS_TOP - f.section.top * sc;
    const S = (y: number) => y * sc + yoff; // 圖片Y → 螢幕Y
    // 留白統一 CELL_PAD_PX 畫面 px；geom 是「圖片座標再乘 sc」，所以先換回圖片 px。
    const padImg = CELL_PAD_PX / sc;
    const pad = f.cell ? { x: padImg, top: padImg, bottom: padImg } : null;
    const geom = f.cell && pad
      ? {
          left: (f.cell.x - pad.x) * sc,
          top: S(f.cell.y - pad.top),
          width: (f.cell.w + pad.x * 2) * sc,
          height: (f.cell.h + pad.top + pad.bottom) * sc,
        }
      : lastCell || { left: VIDEO_WIDTH / 2, top: FOCUS_TOP, width: 0, height: 0 };
    if (f.cell && pad) lastCell = geom;
    return {
      t: f.startSec - run.startSec,
      yoff,
      bandTop: S(f.section.top),
      bandBot: S(f.section.bottom),
      hasCell: f.cell ? 1 : 0,
      ...geom,
    };
  });

  // 關鍵影格：在每一段停住，換段前 FOCUS_MOVE_SEC 秒開始滑過去，剛好在新段開始時到位。
  const moveFrames = Math.round(FOCUS_MOVE_SEC * VIDEO_FPS);
  const frames: number[] = [];
  targets.forEach((tg, i) => {
    if (i === 0) { frames.push(0); return; }
    const arrive = Math.round(tg.t * VIDEO_FPS);
    const start = Math.max(frames[frames.length - 1] + 1, arrive - moveFrames);
    frames.push(start);
    frames.push(Math.max(start + 1, arrive));
  });
  type Key = 'yoff' | 'bandTop' | 'bandBot' | 'hasCell' | 'left' | 'top' | 'width' | 'height';
  const at = (key: Key) => {
    const vals: number[] = [];
    targets.forEach((tg, i) => {
      if (i === 0) vals.push(tg[key]);
      else { vals.push(targets[i - 1][key]); vals.push(tg[key]); }
    });
    return frames.length > 1
      ? interpolate(frame, frames, vals, {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
      : vals[0];
  };

  const yoff = at('yoff');
  const bandTop = at('bandTop');
  const bandBot = at('bandBot');
  const cellOpacity = at('hasCell');
  const cell = {
    left: at('left'),
    top: at('top'),
    width: at('width'),
    height: at('height'),
  };

  return (
    <AbsoluteFill style={{ opacity: appear }}>
      {/* 純黑底：蓋掉講者 */}
      <AbsoluteFill style={{ backgroundColor: '#000000' }} />

      {/* 資訊圖（貼齊寬度、依 yoff 捲動） */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: yoff + rise,
          width: VIDEO_WIDTH,
        }}
      >
        <Img src={staticFile(run.src)} style={{ width: VIDEO_WIDTH, display: 'block' }} />
      </div>

      {/* 壓暗：區塊帶上方一條 + 下方一條（帶內保持明亮） */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: VIDEO_WIDTH,
          height: Math.max(0, bandTop + rise),
          backgroundColor: `rgba(0,0,0,${DIM_ALPHA})`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: bandBot + rise,
          width: VIDEO_WIDTH,
          height: Math.max(0, VIDEO_HEIGHT - (bandBot + rise)),
          backgroundColor: `rgba(0,0,0,${DIM_ALPHA})`,
        }}
      />

      {/* 黃色高亮框（含外光暈）。沒有框的段落靠 opacity 淡掉，位置沿用上一段。 */}
      {cellOpacity > 0.01 && (
        <div
          style={{
            position: 'absolute',
            left: cell.left,
            top: cell.top + rise,
            width: cell.width,
            height: cell.height,
            border: `5px solid ${HL}`,
            borderRadius: 16,
            boxShadow: `0 0 18px 4px rgba(255,230,0,0.55)`,
            boxSizing: 'border-box',
            opacity: cellOpacity,
          }}
        />
      )}
    </AbsoluteFill>
  );
};

/** 截圖段全螢幕圖片：淡入淡出，蓋滿整個畫面。
    durationInFrames 有給才會淡出（2026-08-21 補上；在這之前結尾是硬切）。 */
const InstitutionShotImage: React.FC<{ src: string; durationInFrames?: number }> = ({
  src,
  durationInFrames,
}) => {
  const frame = useCurrentFrame();
  const opacity = fadeProgress(frame, 0, durationInFrames ?? 999999, 0.3);
  return (
    <AbsoluteFill style={{ opacity }}>
      <Img
        src={staticFile(src)}
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
    </AbsoluteFill>
  );
};

// 日期牌：讀 video-meta.json.headerDate（MMDD），白色斜體。
// 傳入 left/width 決定水平置中範圍（開場卡＝整幅置中；主段＝左側 bar 內置中）。
const InstitutionDateBadge: React.FC<{
  top: number;
  left: number;
  width: number;
  fontSize: number;
}> = ({ top, left, width, fontSize }) => {
  const headerDate = (videoMeta as any).headerDate ?? '';
  if (!headerDate) return null;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left,
          top,
          width,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            fontFamily:
              '"Noto Sans TC", system-ui, -apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif',
            fontSize,
            fontWeight: 800,
            fontStyle: 'italic',
            color: '#ffffff',
            letterSpacing: -2,
            lineHeight: 1,
            textShadow: LAYOUT.dateShadow,
          }}
        >
          {headerDate}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// 標題卡：只在開場卡顯示，讀 video-meta.json.titleText。第一句白色、其餘黃色（沿用大盤小報配色/描邊）。
const TITLE_COLORS = ['#ffffff', '#FFE600'];

const InstitutionTitleCard: React.FC<{ top: number; fontSize: number }> = ({
  top,
  fontSize,
}) => {
  const title = (videoMeta as any).titleText ?? '';
  if (!title) return null;
  const lines = title.split('\n').filter((l: string) => l.trim());
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: 40,
          right: 40,
          top,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
        }}
      >
        {lines.map((line: string, i: number) => (
          <div
            key={i}
            style={{
              fontFamily:
                '"Noto Sans TC", system-ui, -apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif',
              fontSize,
              fontWeight: 800,
              fontStyle: 'italic',
              color: i === 0 ? TITLE_COLORS[0] : TITLE_COLORS[1],
              lineHeight: 1.4,
              textAlign: 'center',
              WebkitTextStroke: '3px #000000',
              paintOrder: 'stroke fill',
              textShadow: '0 4px 12px rgba(0,0,0,0.5)',
            }}
          >
            {line}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};
