import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type {
  ContrastSpec,
  Emphasis,
  ListSpec,
  MotionClipSpec,
  QuoteSpec,
} from './motion-clip-types';

/**
 * 動態小影片（MG）：1080×1080 方形，獨立 render 成 mp4，再貼回大盤小報直式／橫式。
 *
 * 2026-09-16 使用者定案的規格：
 *   - 尺寸 1080×1080。直式原尺寸放在 y310–1390（header 下緣到字幕上緣）；
 *     橫式縮到 840×840 置中（都不碰字幕）。所以**內容要以「縮到 78% 仍看得清」設計**。
 *   - 自帶背景色、蓋掉講者，不疊在截圖上。
 *   - 配色：主色深藍、強調黃，漲紅跌綠（台股慣例）。
 *   - 零圖示素材 —— 純文字排版。需要圖示的內容另外走 manual 後端補 SVG。
 *
 * ⚠️ 時長是**由旁白決定的變數**，不是常數：所有動畫一律用「相對於 durationInFrames
 *    的節奏」計算，不准寫死秒數。時長不夠會自動壓縮節奏、再不夠就砍步驟
 *    （見 buildBeats／showFoot）。這是整支能不能沿用的關鍵，改動前先讀這段。
 */

// ── 品牌常數（跟大盤小報 2026-09-16 的新素材取色）──────────────
export const MC = {
  yellow: '#ffd84d',
  blue: '#7fc4ff',
  white: '#ffffff',
  muted: '#9fc0ee',
  up: '#ff4d5e',    // 漲／買超（台股紅）
  down: '#22d67b',  // 跌／賣超（台股綠）
  bg: 'radial-gradient(120% 90% at 20% 0%, #1a4fa8 0%, #0e2f6e 45%, #081f4d 100%)',
  font:
    '"Noto Sans TC", system-ui, -apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif',
  pad: 74,
} as const;

const colorOf = (c?: Emphasis) =>
  c === 'up' ? MC.up : c === 'down' ? MC.down : c === 'hl' ? MC.yellow : MC.white;

/**
 * 算每個元素的進場時間（frame）。
 *
 * 標準節奏：第一拍 0.15 秒，之後每 0.7 秒一拍，尾端保留 0.8 秒讓最後一項站住。
 * 塞不下就整體等比壓縮（最低壓到 25%，再短就是砍步驟的事了）。
 */
function buildBeats(steps: number, totalFrames: number, fps: number): number[] {
  const first = 0.15 * fps;
  const gap = 0.7 * fps;
  const tail = 0.8 * fps;
  const beats = Array.from({ length: steps }, (_, i) => first + i * gap);
  const last = beats[steps - 1] ?? 0;
  if (last + tail > totalFrames && last > 0) {
    const scale = Math.max(0.25, (totalFrames - tail) / last);
    return beats.map((b) => b * scale);
  }
  return beats;
}

/** 淡入＋上移。at 之前完全不畫，避免短片一開頭就閃一下。 */
const Enter: React.FC<{
  at: number;
  dy?: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ at, dy = 18, children, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const dur = 0.32 * fps;
  const p = interpolate(frame, [at, at + dur], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <div style={{ ...style, opacity: p, transform: `translateY(${(1 - p) * dy}px)` }}>
      {children}
    </div>
  );
};

/** 彈入（scale）。用在黃框關鍵詞與編號徽章，比純淡入更有「落定」的感覺。 */
const Pop: React.FC<{ at: number; children: React.ReactNode; style?: React.CSSProperties }> = ({
  at,
  children,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({
    frame: frame - at,
    fps,
    config: { damping: 14, mass: 0.6 },
    durationInFrames: Math.round(0.5 * fps),
  });
  const o = interpolate(frame, [at, at + 0.2 * fps], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return <div style={{ ...style, opacity: o, transform: `scale(${0.82 + s * 0.18})` }}>{children}</div>;
};

/** 卡片外殼：背景、光暈、kicker、主標、註腳、長片才有的 idle 掃光、整體頭尾淡出。 */
const Shell: React.FC<{
  kicker?: string;
  badge?: string;
  title?: string;
  foot?: string;
  beats: number[];
  showFoot: boolean;
  idle: boolean;
  children: React.ReactNode;
  safeTop?: number;
  safeBottom?: number;
}> = ({ kicker, badge, title, foot, beats, showFoot, idle, children, safeTop, safeBottom }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  // 2026-09-17 使用者定案：直式與橫式各出一支，共用同一套佈局。
  //
  // ⚠️ 影片尺寸＝**整個可見畫面**（直式 1080×1920、橫式 1178×1080），不是只有內容區。
  //    因為背景有漸層與掃光，只鋪內容區的話光掃到一半就斷掉，接縫很明顯
  //    （2026-09-17 使用者指出）。所以：**背景鋪滿整張，內容只畫在安全區內**。
  //
  // 安全區＝避開招牌 bar 與字幕之後剩下的地方：
  //   直式 y310–1440（bar 不透明到 y309、字幕從 y1440 起）
  //   橫式 y0–918（左側講者區沒有 bar；字幕一行時頂端 y918）
  // 字級由**安全區**的短邊決定（不是畫布短邊），這樣兩版的字看起來才一樣大。
  const top = safeTop ?? 0;
  const bottom = safeBottom ?? height;
  const contentH = Math.max(1, bottom - top);
  const scale = Math.min(width, contentH) / 1080;
  const designW = width / scale;
  const designH = contentH / scale;
  // 頭尾淡出：獨立 mp4 會被貼進主片，切換點要柔一點
  const fade = interpolate(
    frame,
    [0, 0.25 * fps, durationInFrames - 0.3 * fps, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );
  // 主標的 | 之後套品牌黃
  const [t1, t2] = (title ?? '').split('|');
  return (
    <AbsoluteFill style={{ background: MC.bg, fontFamily: MC.font, opacity: fade }}>
      {/* 常駐光暈：鋪滿整張畫布，不是只有內容區 */}
      <AbsoluteFill
        style={{
          background:
            'linear-gradient(115deg, transparent 40%, rgba(110,200,255,0.13) 50%, transparent 60%)',
        }}
      />
      {/* 長片（>10 秒）才加的 idle：一道光緩慢掃過，避免動畫跑完剩下一大段定格 */}
      {idle ? (
        <AbsoluteFill
          style={{
            background:
              'linear-gradient(115deg, transparent 44%, rgba(255,216,77,0.10) 50%, transparent 56%)',
            transform: `translateX(${interpolate(
              (frame % (6 * fps)) / (6 * fps),
              [0, 1],
              [-1200, 1200]
            )}px)`,
          }}
        />
      ) : null}

      {/* 內容只畫在安全區內（背景已經鋪滿整張） */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top,
          width: designW,
          height: designH,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
        }}
      >
      <AbsoluteFill style={{ padding: MC.pad, display: 'flex', flexDirection: 'column' }}>
        {/* 頂列只有 kicker。2026-09-17 使用者定案：底部註腳與右上角徽章**兩個都不要** ——
            卡片就是 kicker ＋ 標題 ＋ 主體。型別裡的 foot／badge 欄位保留但預設不給。 */}
        {kicker ? (
          <Enter at={beats[0]}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <div
                  style={{
                    fontSize: 40,
                    fontWeight: 700,
                    color: MC.blue,
                    letterSpacing: 2,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 16,
                  }}
                >
                  <span style={{ width: 8, height: 40, background: MC.yellow, borderRadius: 4 }} />
                  {kicker}
              </div>
            </div>
          </Enter>
        ) : null}

        {title ? (
          <Enter at={beats[Math.min(1, beats.length - 1)]}>
            <div
              style={{
                fontSize: 68,
                fontWeight: 900,
                color: MC.white,
                marginTop: 22,
                lineHeight: 1.25,
                letterSpacing: -1,
              }}
            >
              {t1}
              {t2 ? <span style={{ color: MC.yellow }}>{t2}</span> : null}
            </div>
          </Enter>
        ) : null}

        {/* 2026-09-17 使用者：卡片內容要撐滿，不要擠在上半部。
            space-evenly ＝ 不管幾項都均分整個主體區，項目少的時候不會縮成一團。 */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-evenly' }}>
          {children}
        </div>

        {showFoot && foot ? (
          <Enter at={beats[beats.length - 1]}>
            <div
              style={{
                fontSize: 34,
                color: MC.muted,
                borderTop: '2px solid rgba(255,255,255,0.16)',
                paddingTop: 24,
              }}
            >
              {foot}
            </div>
          </Enter>
        ) : null}
      </AbsoluteFill>
      </div>
    </AbsoluteFill>
  );
};

// ── ① 對比型：不是 X，而是 Y ────────────────────────────────
const Contrast: React.FC<{ spec: ContrastSpec; beats: number[] }> = ({ spec, beats }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const negAt = beats[2] ?? 0;
  // 刪除線用寬度動畫劃過去，比整條直接出現有「打掉」的動作感
  const strike = interpolate(frame, [negAt + 0.25 * fps, negAt + 0.6 * fps], [0, 100], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <>
      <Enter at={negAt}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 24,
            fontSize: 60,
            fontWeight: 800,
            color: '#7d93b8',
          }}
        >
          <Pop at={negAt}>
            <span
              style={{
                width: 64,
                height: 64,
                borderRadius: '50%',
                background: MC.up,
                color: '#fff',
                fontSize: 40,
                fontWeight: 900,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              ✕
            </span>
          </Pop>
          <span style={{ position: 'relative' }}>
            {spec.negative}
            <span
              style={{
                position: 'absolute',
                left: 0,
                top: '52%',
                height: 6,
                width: `${strike}%`,
                background: MC.up,
                borderRadius: 3,
              }}
            />
          </span>
        </div>
      </Enter>

      <Enter at={negAt + 0.55 * fps} style={{ margin: '26px 0 26px 30px' }}>
        <div style={{ fontSize: 52, color: MC.yellow, fontWeight: 900 }}>↓</div>
      </Enter>

      {spec.positives.slice(0, 2).map((p, i) => (
        <Pop key={i} at={beats[3 + i] ?? negAt + (1 + i) * 0.7 * fps} style={{ marginBottom: 20 }}>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 20,
              background: 'rgba(255,216,77,0.13)',
              border: `3px solid ${MC.yellow}`,
              borderRadius: 20,
              padding: '22px 34px',
              fontSize: 64,
              fontWeight: 900,
              color: MC.yellow,
            }}
          >
            <span
              style={{
                width: 56,
                height: 56,
                borderRadius: '50%',
                background: MC.yellow,
                color: '#0e2f6e',
                fontSize: 34,
                fontWeight: 900,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              ✓
            </span>
            {p}
          </div>
        </Pop>
      ))}
    </>
  );
};

// ── ② 編號條列型：逐項對齊旁白 ──────────────────────────────
const Bullets: React.FC<{ spec: ListSpec; beats: number[] }> = ({ spec, beats }) => {
  const { fps } = useVideoConfig();
  return (
    <>
      {spec.items.slice(0, 5).map((it, i) => {
        // atSec 是產線用旁白時間軸算出來的：唸到這一項時它才滑進來。
        // 沒有就退回 beats 的等距節奏（manual 後端貼參數時通常沒有）。
        const at = typeof it.atSec === 'number' ? it.atSec * fps : beats[2 + i] ?? 0;
        return (
          <Enter key={i} at={at} dy={0}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 30 }}>
              <Pop at={at}>
                <div
                  style={{
                    width: 96,
                    height: 96,
                    borderRadius: 24,
                    background: MC.yellow,
                    color: '#0e2f6e',
                    fontSize: 50,
                    fontWeight: 900,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxShadow: '0 6px 0 rgba(0,0,0,0.18)',
                  }}
                >
                  {i + 1}
                </div>
              </Pop>
              <div style={{ fontSize: 66, fontWeight: 800, color: MC.white, lineHeight: 1.2 }}>
                {it.text}
              </div>
            </div>
          </Enter>
        );
      })}
    </>
  );
};

// ── ③ 重點句型：一句話，關鍵詞逐段著色 ──────────────────────
const Quote: React.FC<{ spec: QuoteSpec; beats: number[] }> = ({ spec, beats }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div style={{ borderLeft: `12px solid ${MC.yellow}`, paddingLeft: 36 }}>
      {spec.lines.slice(0, 4).map((line, li) => {
        const at = beats[1 + li] ?? 0;
        return (
          <Enter key={li} at={at} style={{ marginBottom: 6 }}>
            <div style={{ fontSize: 82, fontWeight: 900, lineHeight: 1.35, letterSpacing: -1 }}>
              {line.map((tk, ti) => {
                // 關鍵詞比句子本身晚半拍才上色，讓視線被帶過去
                const on = interpolate(
                  frame,
                  [at + 0.3 * fps, at + 0.5 * fps],
                  [0, 1],
                  { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
                );
                const target = colorOf(tk.c);
                return (
                  <span
                    key={ti}
                    style={{ color: tk.c ? (on > 0.5 ? target : MC.white) : MC.white }}
                  >
                    {tk.t}
                  </span>
                );
              })}
            </div>
          </Enter>
        );
      })}
    </div>
  );
};

/** 依型別算「要幾拍」：kicker、title 各一拍，主體每項一拍，註腳一拍。 */
function stepsOf(spec: MotionClipSpec): number {
  const head = 2;
  const body =
    spec.template === 'contrast'
      ? 1 + Math.min(2, spec.positives.length)
      : spec.template === 'list'
        ? Math.min(5, spec.items.length)
        : Math.min(4, spec.lines.length);
  return head + body + 1;
}

export const MotionClip: React.FC<{
  spec: MotionClipSpec;
  safeTop?: number;
  safeBottom?: number;
}> = ({ spec, safeTop, safeBottom }) => {
  const { fps, durationInFrames } = useVideoConfig();
  const totalSec = durationInFrames / fps;
  // 時長不足 5 秒就砍註腳（使用者定案的減步驟規則）；超過 10 秒補 idle 掃光
  const showFoot = totalSec >= 5;
  const idle = totalSec > 10;
  const beats = buildBeats(stepsOf(spec), durationInFrames, fps);

  return (
    <Shell
      kicker={spec.kicker}
      badge={spec.badge}
      title={spec.title}
      foot={spec.foot}
      beats={beats}
      showFoot={showFoot}
      idle={idle}
      safeTop={safeTop}
      safeBottom={safeBottom}
    >
      {spec.template === 'contrast' ? <Contrast spec={spec} beats={beats} /> : null}
      {spec.template === 'list' ? <Bullets spec={spec} beats={beats} /> : null}
      {spec.template === 'quote' ? <Quote spec={spec} beats={beats} /> : null}
    </Shell>
  );
};
