import React from 'react';
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame } from 'remotion';
import { VIDEO_FPS, resolveByCharIdx } from './dapan-timeline';

/**
 * 補充數字字卡（2026-11-13 使用者選定；規格來自 cmoney-ad-subtitles skill 的「補充數字字卡」）。
 *
 * 旁白講到「主詞＋數字」、但這幾句沒配截圖也沒動態時，在講者畫面、字幕正上方跳出一張小卡，
 * 例「外資賣超 816億｜投信買超 88.7億」。位置與內容由 Claude 排（scripts/shot-planner.js 的 parseFacts，
 * 數字一定要逐字出現在旁白裡），parse-dapan-script.js 寫進 video-meta.json.factCards。
 *
 * 樣式：深色圓角卡＋金色細外框；字用粗黑體（跟字幕一致，2026-11-12 使用者把字幕改黑體）；
 * 數字用漸層色（上漲／買超紅、下跌／賣超綠、其他金）。主詞 44px、數字 62px。
 * 時間：那句一開始講就跳出，**至少停 1.5 秒**（skill：她嫌過「出現太短」），
 * 但不壓進下一張截圖、動態或字卡（提早 0.05 秒收）。進場 0.22 秒從 0.9 倍彈出並淡入，0.2 秒淡出。
 */

export type FactItem = { label: string; value: string; tone: 'up' | 'down' | 'gold' };
export type FactCard = { startCharIdx: number; endCharIdx: number; items: FactItem[] };

const MIN_SEC = 1.5;
const GAP_SEC = 0.05;
const CARD_BOTTOM = 880; // 字幕黑底框頂約 y900
const TONE_GRADIENT: Record<FactItem['tone'], string> = {
  gold: 'linear-gradient(180deg, #FFF0AA 0%, #F7CD55 50%, #D69628 100%)',
  up: 'linear-gradient(180deg, #FFB3A8 0%, #FF4B3A 50%, #C81E1E 100%)',
  down: 'linear-gradient(180deg, #C8F7D2 0%, #3DCB6A 50%, #138A3E 100%)',
};

type Timed = FactCard & { startSec: number; endSec: number };

/** 字元位置 → 時間；結尾至少 1.5 秒，但不跨進 blockers（下一段截圖／動態）或下一張字卡 */
export function timeFactCards(cards: FactCard[], blockers: { startSec: number }[],
  resolve = resolveByCharIdx): Timed[] {
  const timed = cards
    .flatMap((c) => {
      const t = resolve(c.startCharIdx, c.endCharIdx);
      return t && c.items && c.items.length ? [{ ...c, startSec: t.start, endSec: t.end }] : [];
    })
    .sort((a, b) => a.startSec - b.startSec);
  return timed.map((c, k) => {
    const nexts = blockers.map((b) => b.startSec).concat(timed.slice(k + 1).map((x) => x.startSec))
      .filter((s) => s > c.startSec);
    const limit = nexts.length ? Math.min(...nexts) - GAP_SEC : Infinity;
    const endSec = Math.min(Math.max(c.endSec, c.startSec + MIN_SEC), limit);
    return { ...c, endSec: Math.max(endSec, c.startSec + 0.3) };
  });
}

const backOut = (x: number) => {
  const c1 = 1.6;
  const c3 = c1 + 1;
  const t = Math.min(1, Math.max(0, x));
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};

const Card: React.FC<{ card: Timed; centerX: number }> = ({ card, centerX }) => {
  const f = useCurrentFrame();
  const dur = Math.round((card.endSec - card.startSec) * VIDEO_FPS);
  const enter = Math.min(1, f / Math.round(0.22 * VIDEO_FPS));
  const out = interpolate(f, [dur - Math.round(0.2 * VIDEO_FPS), dur], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: centerX,
          bottom: 1080 - CARD_BOTTOM,
          transform: `translateX(-50%) scale(${0.9 + 0.1 * backOut(enter)})`,
          transformOrigin: 'center bottom',
          opacity: Math.min(enter * 1.6, 1) * out,
          display: 'flex',
          alignItems: 'center',
          gap: 30,
          whiteSpace: 'nowrap',
          padding: '12px 38px 14px',
          borderRadius: 22,
          background: 'rgba(18, 13, 8, 0.86)',
          border: '2px solid rgba(255, 206, 80, 0.85)',
          boxShadow: '0 14px 40px rgba(0,0,0,0.55), 0 0 18px rgba(255,206,80,0.18)',
          fontFamily: '"Noto Sans TC", sans-serif',
          fontWeight: 900,
        }}
      >
        {card.items.map((it, i) => (
          <React.Fragment key={i}>
            {i > 0 ? <div style={{ width: 2, height: 56, background: 'rgba(255,206,80,0.55)' }} /> : null}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
              <span style={{ fontSize: 44, color: '#ffffff' }}>{it.label}</span>
              <span
                style={{
                  fontSize: 62,
                  backgroundImage: TONE_GRADIENT[it.tone] || TONE_GRADIENT.gold,
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  color: 'transparent',
                  filter: 'drop-shadow(0 3px 6px rgba(0,0,0,0.5))',
                }}
              >
                {it.value}
              </span>
            </div>
          </React.Fragment>
        ))}
      </div>
    </AbsoluteFill>
  );
};

export const FactCards: React.FC<{ cards: FactCard[]; blockers: { startSec: number }[]; centerX: number }> = ({
  cards, blockers, centerX,
}) => (
  <>
    {timeFactCards(cards, blockers).map((c, i) => {
      const from = Math.round(c.startSec * VIDEO_FPS);
      const dur = Math.max(1, Math.round((c.endSec - c.startSec) * VIDEO_FPS));
      return (
        <Sequence key={`fact-${i}`} from={from} durationInFrames={dur}>
          <Card card={c} centerX={centerX} />
        </Sequence>
      );
    })}
  </>
);
