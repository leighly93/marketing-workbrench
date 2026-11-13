import React, { useEffect, useMemo, useState } from 'react';
import {
  AbsoluteFill,
  Easing,
  Sequence,
  continueRender,
  delayRender,
  interpolate,
  staticFile,
  useCurrentFrame,
} from 'remotion';
import { VIDEO_FPS, secToFrame } from '../timeline';
import { SUBTITLE_PHRASES, splitSubtitleByEmphasis } from '../Subtitles';
import { type SerifTone, pickUnderlines, toneFor } from './serif-emphasis';

/**
 * 大盤小報（橫式）明體字幕（2026-11-11 使用者定案，橫式預設使用）。
 *
 * 樣式來源：cmoney-ad-subtitles skill（同事「自動剪輯」系列）：
 *   思源宋體 Black（2026-11-12 起改思源黑體 900，見 FONT_FAMILY）、白字不描邊只加柔和陰影、重點詞直向漸層、
 *   筆刷底線 0.12 秒後在 0.45 秒內由左往右畫出、字幕直接跳切、一次只出一行。
 * 大盤小報另外加了每句都有的半透明黑底框（使用者要求）。
 * 斷句與重點詞標記沿用 ../Subtitles.tsx（不另寫一套）；
 * 重點詞顏色與底線挑選規則在 ./serif-emphasis.ts。
 */

// 2026-11-12 使用者：「字幕字體改成粗黑體，明體有點難閱讀」→ 改用思源黑體（Noto Sans TC 可變字重）的 900。
// 其他樣式（黑底框、重點詞漸層、筆刷底線、跳切）不變；元件名稱沿用 SerifSubtitles 以免牽動呼叫端。
// 原本的明體檔 NotoSerifTC-Black.woff2 還留在 public/，要換回來改這三行即可。
const FONT_FAMILY = 'Noto Sans TC Subtitle';
// 完整字集（不裁字：常用字表缺很多股票名用字，頎、錸、鈺、碁…）。跟 src/fonts.ts 同一個檔。
const FONT_FILE = 'NotoSansTC-VF.ttf';
const FONT_WEIGHT = 900;

const TONE_GRADIENT: Record<SerifTone, string> = {
  gold: 'linear-gradient(180deg, #FFF0AA 0%, #F7CD55 50%, #D69628 100%)',
  red: 'linear-gradient(180deg, #FFB3A8 0%, #FF4B3A 50%, #C81E1E 100%)',
  green: 'linear-gradient(180deg, #C8F7D2 0%, #3DCB6A 50%, #138A3E 100%)',
};
const TONE_LINE: Record<SerifTone, [string, string, string]> = {
  gold: ['#F9DA78', '#F2BE45', '#C98A22'],
  red: ['#FF8A7A', '#F0402F', '#B71C1C'],
  green: ['#9BEFB2', '#34B85E', '#11793A'],
};

/** 字型用 FontFace API 載入，渲染前等它好，避免第一格用到備援字型 */
function useSerifFont() {
  const [handle] = useState(() => delayRender(`load ${FONT_FAMILY}`));
  useEffect(() => {
    const face = new FontFace(FONT_FAMILY, `url('${staticFile(FONT_FILE)}') format('truetype')`, { weight: '100 900' });
    face
      .load()
      .then((f) => {
        document.fonts.add(f);
        continueRender(handle);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[SerifSubtitles] 字型載入失敗：${FONT_FILE}`, err);
        continueRender(handle);
      });
  }, [handle]);
}

const NO_KEYWORDS: string[] = [];

type Seg = { text: string; hl: boolean; tone: SerifTone; underline: boolean };

/**
 * 一句字幕切成重點詞／一般字。重點詞來自配圖計畫頁的標記；
 * `previewKeywords` 只給沒有標記的預覽用（用文字比對）。顏色在這裡依規則決定。
 */
function segmentsFor(text: string, map: number[], previewKeywords: string[]): Seg[] {
  let parts = splitSubtitleByEmphasis(text, map);
  if (!parts && previewKeywords.length > 0) {
    const hl: boolean[] = new Array(text.length).fill(false);
    for (const k of previewKeywords) {
      const at = text.indexOf(k);
      if (at >= 0) for (let i = at; i < at + k.length; i++) hl[i] = true;
    }
    if (hl.some(Boolean)) {
      parts = [];
      for (let i = 0; i < text.length; i++) {
        const last = parts[parts.length - 1];
        if (last && last.hl === hl[i]) last.text += text[i];
        else parts.push({ text: text[i], hl: hl[i] });
      }
    }
  }
  if (!parts) return [{ text, hl: false, tone: 'gold', underline: false }];
  let pos = 0;
  return parts.map((s) => {
    const seg: Seg = {
      ...s,
      tone: s.hl ? toneFor(text, pos, pos + s.text.length) : 'gold',
      underline: false,
    };
    pos += s.text.length;
    return seg;
  });
}

/** 中文字算 1、英數算 0.58，估一行要多寬 */
function visualLength(text: string): number {
  let n = 0;
  for (const ch of text) n += /[\x00-\x7F]/.test(ch) ? 0.58 : 1;
  return n;
}

const BrushUnderline: React.FC<{ tone: SerifTone; id: string }> = ({ tone, id }) => {
  const frame = useCurrentFrame();
  const startF = Math.round(0.12 * VIDEO_FPS);
  const endF = startF + Math.round(0.45 * VIDEO_FPS);
  const p = interpolate(frame, [startF, endF], [0, 100], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  const [a, b, c] = TONE_LINE[tone];
  return (
    <svg
      viewBox="0 0 100 20"
      preserveAspectRatio="none"
      style={{
        position: 'absolute',
        left: '-0.14em',
        right: '-0.14em',
        width: 'calc(100% + 0.28em)',
        bottom: '-0.12em',
        height: '0.42em',
        overflow: 'visible',
      }}
    >
      <defs>
        <linearGradient id={`${id}-g`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={a} />
          <stop offset="55%" stopColor={b} />
          <stop offset="100%" stopColor={c} />
        </linearGradient>
        <clipPath id={`${id}-c`}>
          <rect x="0" y="-5" width={p} height="30" />
        </clipPath>
      </defs>
      {/* 兩端細、中間粗，由左下往右上微微上揚 */}
      <path
        d="M0,15 C18,9 55,5 100,4 L100,6.5 C62,12.5 28,18.5 0,17.4 Z"
        fill={`url(#${id}-g)`}
        clipPath={`url(#${id}-c)`}
      />
    </svg>
  );
};

const SerifLine: React.FC<{
  segs: Seg[];
  fontSize: number;
  pill: boolean;
  lineId: string;
  centerX: number;
  bottom: number;
}> = ({ segs, fontSize, pill, lineId, centerX, bottom }) => (
  <AbsoluteFill style={{ pointerEvents: 'none' }}>
    <div
      style={{
        position: 'absolute',
        left: centerX,
        bottom,
        transform: 'translateX(-50%)',
        whiteSpace: 'nowrap',
        fontFamily: `"${FONT_FAMILY}", "Noto Sans TC", sans-serif`,
        fontWeight: FONT_WEIGHT,
        fontSize,
        lineHeight: 1.25,
        color: '#ffffff',
        padding: pill ? '10px 34px 14px' : 0,
        borderRadius: pill ? 22 : 0,
        backgroundColor: pill ? 'rgba(0, 0, 0, 0.65)' : 'transparent',
      }}
    >
      <span
        style={{
          // 白字不描邊：一圈很淡的貼字暗邊＋柔和下影（模糊 9px、往下 5px）
          filter:
            'drop-shadow(0 0 1.5px rgba(0,0,0,0.7)) drop-shadow(0 0 4px rgba(0,0,0,0.35)) drop-shadow(0 5px 9px rgba(0,0,0,0.6))',
          display: 'inline-block',
        }}
      >
        {segs.map((s, i) =>
          s.hl ? (
            <span key={i} style={{ position: 'relative', display: 'inline-block' }}>
              {s.underline ? <BrushUnderline tone={s.tone} id={`${lineId}-u${i}`} /> : null}
              <span
                style={{
                  position: 'relative',
                  backgroundImage: TONE_GRADIENT[s.tone],
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  color: 'transparent',
                }}
              >
                {s.text}
              </span>
            </span>
          ) : (
            <React.Fragment key={i}>{s.text}</React.Fragment>
          ),
        )}
      </span>
    </div>
  </AbsoluteFill>
);

export type SerifSubtitlesProps = {
  /** 字幕可用寬度的左右邊界（橫式＝左側講者區 0 ~ PANEL_LEFT_X） */
  regionLeft: number;
  regionRight: number;
  /** 字底離畫面底部的距離 */
  bottom: number;
  /** 一行最大字級；放不下自動縮小到 minFontSize */
  fontSize?: number;
  minFontSize?: number;
  /** 每句都墊半透明黑底（2026-11-11 使用者要求：大盤小報字幕要有黑底框） */
  alwaysPill?: boolean;
  /** alwaysPill 關閉時，只有這些時間區間（秒）墊黑底（截圖段） */
  pillRanges?: { startSec: number; endSec: number }[];
  /** 預覽用：沒有重點詞標記時，用文字指定重點詞（顏色與底線照一樣的自動規則） */
  previewKeywords?: string[];
};

export const SerifSubtitles: React.FC<SerifSubtitlesProps> = ({
  regionLeft,
  regionRight,
  bottom,
  fontSize = 68,
  minFontSize = 50,
  alwaysPill = false,
  pillRanges = [],
  previewKeywords = NO_KEYWORDS,
}) => {
  useSerifFont();
  const width = regionRight - regionLeft;
  const usable = width - 120;
  const centerX = regionLeft + width / 2;
  const lines = useMemo(() => {
    const segsList = SUBTITLE_PHRASES.map((p) => segmentsFor(p.text, p.map, previewKeywords));
    const underlined = pickUnderlines(
      SUBTITLE_PHRASES.map((p, i) => ({
        start: p.start,
        hl: segsList[i].filter((s) => s.hl).map((s) => s.text),
      })),
    );
    return segsList.map((segs, i) =>
      underlined.has(i) ? segs.map((s) => ({ ...s, underline: s.hl })) : segs,
    );
  }, [previewKeywords]);
  return (
    <>
      {SUBTITLE_PHRASES.map((p, i) => {
        const from = secToFrame(p.start);
        const duration = Math.max(1, secToFrame(p.end - p.start));
        const segs = lines[i];
        const size = Math.max(
          minFontSize,
          Math.min(fontSize, Math.floor(usable / Math.max(1, visualLength(p.text)))),
        );
        const mid = (p.start + p.end) / 2;
        const pill = alwaysPill || pillRanges.some((r) => mid >= r.startSec && mid < r.endSec);
        return (
          <Sequence key={`serif-sub-${i}`} from={from} durationInFrames={duration}>
            <SerifLine
              segs={segs}
              fontSize={size}
              pill={pill}
              lineId={`ss${i}`}
              centerX={centerX}
              bottom={bottom}
            />
          </Sequence>
        );
      })}
    </>
  );
};
