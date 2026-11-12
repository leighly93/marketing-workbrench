import React from 'react';
import {
  AbsoluteFill,
  Easing,
  Img,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
} from 'remotion';
import { VIDEO_FPS, secToFrame } from '../timeline';
import type { ShotBox } from '../ShotFocus';
import type { DapanShot } from './dapan-timeline';

/**
 * 大盤小報（橫式）APP 截圖段：浮動 UI 卡片（2026-11-12 使用者定案「像 skill 那樣呈現」）。
 *
 * 規格照 cmoney-ad-subtitles skill 的 references/app-card-segments.md，換算到橫式左側講者區（1178×1080）：
 *   - 背景：講者畫面本身模糊、壓暗、偏暖，中間偏上一團暖橘光暈，十幾顆很淡很小的金色四芒星慢慢閃
 *   - 卡片：只放裁出來的那一塊 UI（region），圓角 26、細白邊、大片柔和陰影；不要標頭條（使用者選的）
 *   - 小標題：卡片上方，白色極粗黑體 60px，只加柔和陰影、不要底
 *   - 重點：金色發光圓角框（cell），框外不壓暗，0.22 秒淡入
 *   - 進場：第一張從 0.9 倍彈到 1 倍並淡入，接一道斜向反光掃過；同一段換下一張用左右輪播（0.32 秒）
 *   - 不晃、不推近；字幕照常（SerifSubtitles 已經每句墊黑底）
 * 卡片要裁哪裡、框哪裡、小標題寫什麼都是 Claude 排的（scripts/claude-shot-plan.js）。
 */

const ZONE_W = 1178;
const ZONE_H = 1080;
/** 小標題中心高度、卡片可用的上下界（字幕黑底框頂約在 y900） */
const TITLE_Y = 112;
const CARD_TOP = 190;
const CARD_BOTTOM = 870;
const CARD_MAX_W = 1000;
const CARD_RADIUS = 26;
/** 兩段之間只隔這麼久就算同一段（不讓講者露出來），中間用輪播換卡 */
const JOIN_GAP_SEC = 0.4;
const T_SWAP = Math.round(0.32 * VIDEO_FPS);
const T_FADE = Math.round(0.25 * VIDEO_FPS);
const GOLD = 'rgb(255, 206, 80)';

type Card = {
  src: string;
  startSec: number;
  endSec: number;
  crop: ShotBox | null;
  cell?: ShotBox;
  title?: string;
  imgW?: number | null;
  imgH?: number | null;
};

type Block = { startSec: number; endSec: number; cards: Card[] };

/** 截圖段 → 連續的卡片區塊（相隔不到 JOIN_GAP_SEC 的併成同一塊，中間不露講者） */
export function buildCardBlocks(shots: DapanShot[]): Block[] {
  const cards: Card[] = [...shots]
    .sort((a, b) => a.startSec - b.startSec)
    .map((s) => ({
      src: s.src,
      startSec: s.startSec,
      endSec: s.endSec,
      crop: s.region ?? null,
      cell: s.cell,
      title: s.title,
      imgW: s.imageWidth,
      imgH: s.imageHeight,
    }));
  const blocks: Block[] = [];
  for (const c of cards) {
    const last = blocks[blocks.length - 1];
    if (last && c.startSec - last.endSec <= JOIN_GAP_SEC) {
      const prev = last.cards[last.cards.length - 1];
      if (c.startSec > prev.endSec) prev.endSec = c.startSec;
      last.cards.push(c);
      last.endSec = Math.max(last.endSec, c.endSec);
    } else {
      blocks.push({ startSec: c.startSec, endSec: c.endSec, cards: [c] });
    }
  }
  return blocks;
}

/** 卡片要顯示的範圍（原圖像素）與縮放後的大小 */
function layoutCard(card: Card) {
  const W = card.imgW || 0;
  const H = card.imgH || 0;
  const crop = card.crop && W && H ? card.crop : W && H ? { x: 0, y: 0, w: W, h: H } : null;
  const maxH = CARD_BOTTOM - CARD_TOP;
  if (!crop) return { crop: null, s: 1, w: CARD_MAX_W, h: maxH };
  const s = Math.min(CARD_MAX_W / crop.w, maxH / crop.h, 2.2);
  return { crop, s, w: Math.round(crop.w * s), h: Math.round(crop.h * s) };
}

const backOut = (x: number) => {
  const c1 = 1.6;
  const c3 = c1 + 1;
  const t = Math.min(1, Math.max(0, x));
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};

const SPARKS = Array.from({ length: 14 }, (_, i) => {
  // 固定的偽亂數，每一格都一樣（分散式渲染不會抖）
  const r = (k: number) => (Math.sin(i * 97.13 + k * 13.7) * 43758.5453) % 1;
  const a = Math.abs;
  return {
    x: 60 + a(r(1)) * (ZONE_W - 120),
    y: 150 + a(r(2)) * (ZONE_H - 300),
    size: 10 + a(r(3)) * 9,
    phase: a(r(4)) * Math.PI * 2,
    speed: 1.6 + a(r(5)) * 1.6,
  };
});

const Sparkle: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" style={{ display: 'block' }}>
    <path d="M10 0 L11.4 8.6 L20 10 L11.4 11.4 L10 20 L8.6 11.4 L0 10 L8.6 8.6 Z" fill="rgb(255,236,180)" />
  </svg>
);

const Background: React.FC<{ dur: number }> = ({ dur }) => {
  const f = useCurrentFrame();
  const t = f / VIDEO_FPS;
  const opacity = interpolate(f, [0, T_FADE, dur - T_FADE, dur], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill style={{ width: ZONE_W, opacity }}>
      {/* 講者畫面本身：模糊、壓暗、偏暖 */}
      <AbsoluteFill
        style={{
          backdropFilter: 'blur(26px) brightness(0.3) saturate(0.8) sepia(0.35)',
          WebkitBackdropFilter: 'blur(26px) brightness(0.3) saturate(0.8) sepia(0.35)',
          backgroundColor: 'rgba(24, 14, 6, 0.35)',
        }}
      />
      <AbsoluteFill
        style={{ background: 'radial-gradient(ellipse 55% 45% at 50% 36%, rgba(255,160,60,0.22), rgba(255,160,60,0) 70%)' }}
      />
      {SPARKS.map((p, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: p.x,
            top: p.y,
            opacity: 0.12 + 0.22 * (0.5 + 0.5 * Math.sin(t * p.speed + p.phase)),
            filter: 'drop-shadow(0 0 4px rgba(255,220,150,0.7))',
          }}
        >
          <Sparkle size={p.size} />
        </div>
      ))}
    </AbsoluteFill>
  );
};

const CardView: React.FC<{ card: Card; enterAt: number; first: boolean; exitAt: number | null }> = ({
  card,
  enterAt,
  first,
  exitAt,
}) => {
  const f = useCurrentFrame();
  const { crop, s, w, h } = layoutCard(card);
  const local = f - enterAt;
  // 進場：第一張彈進來，之後的從右邊滑進來
  const enterP = interpolate(local, [0, T_SWAP], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const enterX = first ? 0 : interpolate(enterP, [0, 1], [ZONE_W * 0.55, 0], { easing: Easing.inOut(Easing.cubic) });
  const scale = first ? 0.9 + 0.1 * backOut(enterP) : 1;
  let opacity = first ? interpolate(enterP, [0, 0.6], [0, 1], { extrapolateRight: 'clamp' }) : enterP;
  // 出場：往左滑出並淡出（下一張同時從右邊進來）
  let exitX = 0;
  if (exitAt != null) {
    const exitP = interpolate(f - exitAt, [0, T_SWAP], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    exitX = interpolate(exitP, [0, 1], [0, -ZONE_W * 0.55], { easing: Easing.inOut(Easing.cubic) });
    opacity *= 1 - exitP;
  }
  // 反光掃過（進場後 0.2 秒開始，0.6 秒）
  const sweep = interpolate(local, [6, 6 + Math.round(0.6 * VIDEO_FPS)], [-0.6, 1.6], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const glow = interpolate(local, [5, 5 + Math.round(0.22 * VIDEO_FPS)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const top = CARD_TOP + Math.round((CARD_BOTTOM - CARD_TOP - h) / 2);
  const left = Math.round((ZONE_W - w) / 2);
  const pad = 8;
  const cell =
    crop && card.cell
      ? {
          left: Math.max(0, (card.cell.x - crop.x) * s - pad),
          top: Math.max(0, (card.cell.y - crop.y) * s - pad),
          width: Math.min(w, card.cell.w * s + pad * 2),
          height: Math.min(h, card.cell.h * s + pad * 2),
        }
      : null;

  return (
    <AbsoluteFill style={{ width: ZONE_W, opacity, transform: `translateX(${enterX + exitX}px)` }}>
      {card.title ? (
        <div
          style={{
            position: 'absolute',
            left: 0,
            width: ZONE_W,
            top: TITLE_Y - 45,
            textAlign: 'center',
            fontFamily: '"Noto Sans TC", sans-serif',
            fontWeight: 900,
            fontSize: 60,
            lineHeight: '90px',
            color: '#ffffff',
            textShadow: '0 5px 18px rgba(8,6,4,0.9), 0 0 4px rgba(8,6,4,0.6)',
            transform: `scale(${first ? 0.85 + 0.15 * backOut(enterP) : 1})`,
          }}
        >
          {card.title}
        </div>
      ) : null}
      <div
        style={{
          position: 'absolute',
          left,
          top,
          width: w,
          height: h,
          borderRadius: CARD_RADIUS,
          overflow: 'hidden',
          backgroundColor: '#161618',
          border: '2px solid rgba(255,255,255,0.18)',
          boxShadow: '0 30px 80px rgba(0,0,0,0.6), 0 8px 24px rgba(0,0,0,0.4)',
          transform: `scale(${scale})`,
        }}
      >
        {crop ? (
          <Img
            src={staticFile(card.src)}
            style={{
              position: 'absolute',
              left: -crop.x * s,
              top: -crop.y * s,
              width: (card.imgW || 0) * s,
              height: (card.imgH || 0) * s,
              maxWidth: 'none',
            }}
          />
        ) : (
          <Img src={staticFile(card.src)} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        )}
        {cell ? (
          <div
            style={{
              position: 'absolute',
              ...cell,
              borderRadius: 12,
              border: `5px solid ${GOLD}`,
              backgroundColor: 'rgba(255,206,80,0.08)',
              boxShadow: '0 0 14px 3px rgba(255,206,80,0.75), inset 0 0 12px rgba(255,206,80,0.3)',
              opacity: glow,
            }}
          />
        ) : null}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: `linear-gradient(115deg, rgba(255,255,255,0) ${(sweep - 0.25) * 100}%, rgba(255,255,255,0.28) ${sweep * 100}%, rgba(255,255,255,0) ${(sweep + 0.25) * 100}%)`,
            pointerEvents: 'none',
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

export const AppCardShots: React.FC<{ shots: DapanShot[] }> = ({ shots }) => {
  const blocks = buildCardBlocks(shots);
  return (
    <>
      {blocks.map((b, bi) => {
        const from = secToFrame(b.startSec);
        const dur = Math.max(1, secToFrame(b.endSec) - from);
        return (
          <Sequence key={`card-block-${bi}`} from={from} durationInFrames={dur}>
            <AbsoluteFill style={{ width: ZONE_W, height: ZONE_H, overflow: 'hidden' }}>
              <Background dur={dur} />
              {b.cards.map((c, ci) => {
                const enterAt = secToFrame(c.startSec) - from;
                const next = b.cards[ci + 1];
                const exitAt = next ? secToFrame(next.startSec) - from : null;
                // 只在自己的時間（加上出場那 0.32 秒）畫，免得疊一堆看不見的卡片
                const until = exitAt != null ? exitAt + T_SWAP : dur;
                return (
                  <Sequence key={`card-${ci}`} from={enterAt} durationInFrames={Math.max(1, until - enterAt)} layout="none">
                    <CardView card={c} enterAt={0} first={ci === 0} exitAt={exitAt != null ? exitAt - enterAt : null} />
                  </Sequence>
                );
              })}
            </AbsoluteFill>
          </Sequence>
        );
      })}
    </>
  );
};
