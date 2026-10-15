import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type {
  BarItem,
  ContrastSpec,
  Emphasis,
  EventSpec,
  LevelSpec,
  ListItem,
  ListSpec,
  MotionClipSpec,
  NumberSpec,
  QuoteSpec,
  RankSpec,
  SectorSpec,
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

/**
 * 條列項目的字級：文字少、空間大就放大（2026-09-21 使用者要求）。
 *
 * 只看寬度就夠 —— 垂直方向用 space-evenly 分配，項目變高只是吃掉本來就空著的地方
 *（實測 contrast 兩項時下半部空了 600 多 px）。真正會出事的是**橫向折行**。
 *
 * 視覺寬度用「中文 1 格、半形 0.55 格」估。中文字寬約等於字級，這個估法夠準，
 * 不需要真的去量文字 —— Remotion 裡量文字要繞一大圈，而且量了也只是算同一件事。
 *
 * ⚠️ 不設「不小於原本字級」這種下限。一開始寫成只放大不縮小（下限＝原本的 64／66），
 *    結果長文字在加了外框、可用寬變窄之後，硬撐原尺寸**反而折行**
 *    （「三大法人同步站在買方這邊」12 字：66px×12＝792px，可用只有 746px）。
 *    放不下就該縮，這才是自適應的意思。只保留一個看得清楚的底線。
 *
 * @param avail  這一項的文字可以用多寬（已經扣掉圖示、gap、padding、外框）
 * @param texts  同一組項目的所有文字（取最長的那個當基準，各項才會一樣大）
 * @param base   沒有文字可算時的預設字級
 * @param max    上限
 */
const ITEM_FONT_MIN = 44;
function fitFontSize(avail: number, texts: string[], base: number, max: number): number {
  const widest = Math.max(
    1,
    ...texts.map((s) => [...(s ?? '')].reduce((n, c) => n + (/[\x20-\x7e]/.test(c) ? 0.55 : 1), 0))
  );
  // ⚠️ 留 3% 餘裕。實測上限開到 104 時「連2日買力道放大」就折成兩行了 ——
  //    算出來是 785px、可用 782px，差 3px。字寬是估的、字型也不保證每個字剛好一格，
  //    貼著邊界算必然會有折行的那一天，而折行在成品裡很難看。
  if (!texts.some((s) => s)) return base;
  return Math.round(Math.max(ITEM_FONT_MIN, Math.min(max, (avail * 0.97) / widest)));
}

/**
 * 條列項目放大的上限（2026-09-21 使用者從 80／92／104 三版試片挑的）。
 *
 * 這是「最大能長到多大」，不是實際字級 —— 放不下的時候 fitFontSize 會自己收斂。
 * 實測最容易折行的組合（「台積電ADR漲3.5%」97px、「外資買超創今年新高」84px）
 * 都在一行內，右邊還有約 100px 餘裕。
 */
const ITEM_FONT_MAX = 104;

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
  noTailFade?: boolean;
}> = ({ kicker, badge, title, foot, beats, showFoot, idle, children, safeTop, safeBottom,
        noTailFade }) => {
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
  // 內容區是**安全區裡的最大正方形**，水平置中。
  // ⚠️ designW 要固定 1080，不能用 width / scale：那會讓橫式的設計空間變成 1386 寬
  //    （直式是 1080），同一套佈局被放進更寬的框、左對齊就整塊偏左，右側空一大塊
  //    （2026-09-18 使用者指出）。固定 1080 之後兩版真的是同一套排版，只是橫式整塊右移。
  const boxW = Math.min(width, contentH);
  const designW = boxW / scale;          // 恆等於 1080
  const designH = contentH / scale;      // 直式比 1080 高一點，讓內容用滿垂直空間
  const left = (width - boxW) / 2;
  // 頭尾淡出：獨立 mp4 會被貼進主片，切換點要柔一點。
  // ⚠️ 做在結尾那段不淡出尾巴（noTailFade）—— 影片本來就在這裡結束，
  //    淡出只會讓最後閃一下講者畫面（2026-09-21 使用者指出）。
  const fade = noTailFade
    ? interpolate(frame, [0, 0.25 * fps], [0, 1],
      { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
    : interpolate(
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
          left,
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
  // 正項的文字可用寬 = 設計寬 1080 − 左右 pad − 卡片 padding(34×2) − 外框(3×2) − 勾勾(56) − gap(20)
  const posFont = fitFontSize(
    1080 - MC.pad * 2 - 68 - 6 - 56 - 20, spec.positives.slice(0, 2), 64, ITEM_FONT_MAX);
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
              fontSize: posFont,
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
  // 文字可用寬 = 設計寬 1080 − 左右 pad − 卡片 padding(28×2) − 外框(3×2) − 編號徽章(96) − gap(28)
  const itemFont = fitFontSize(
    1080 - MC.pad * 2 - 56 - 6 - 96 - 28, spec.items.slice(0, 5).map((i) => i.text), 66, ITEM_FONT_MAX);
  return (
    // ⚠️ 包一層：整組變成外層 space-evenly 眼中的**單一** flex item，於是它會被置中，
    //    項目之間的距離由這裡的 gap 決定。不包的話每一項都是 flex item，
    //    space-evenly 會把它們拉開到整個主體區，兩項的時候中間空一大塊、下面又空一塊
    //    （2026-09-21 使用者：「上下不要分這麼開」）。
    <div style={{ display: 'flex', flexDirection: 'column', gap: 30 }}>
      {spec.items.slice(0, 5).map((it, i) => {
        // atSec 是產線用旁白時間軸算出來的：唸到這一項時它才滑進來。
        // 沒有就退回 beats 的等距節奏（manual 後端貼參數時通常沒有）。
        const at = typeof it.atSec === 'number' ? it.atSec * fps : beats[2 + i] ?? 0;
        return (
          <Enter key={i} at={at} dy={0}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 28,
                // 給每一項自己的框，不然兩行白字掛在大片背景上很單薄
                //（2026-09-21 使用者：「以為兩點會有各自的外框」）
                background: 'rgba(255,255,255,0.07)',
                border: `3px solid rgba(255,216,77,0.55)`,
                borderRadius: 20,
                padding: '20px 28px',
              }}
            >
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
              <div style={{ fontSize: itemFont, fontWeight: 800, color: MC.white, lineHeight: 1.2 }}>
                {it.text}
              </div>
            </div>
          </Enter>
        );
      })}
    </div>
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

/** 某一項的進場 frame：有 atSec（產線對齊旁白算好的）就用，沒有就退回節奏拍。 */
const itemAt = (it: ListItem, fallback: number, fps: number) =>
  typeof it.atSec === 'number' ? it.atSec * fps : fallback;

// ── ④ 事件預告：日期牌＋事件＋0~2 個看點（2026-10-08）────────────
const EventCard: React.FC<{ spec: EventSpec; beats: number[] }> = ({ spec, beats }) => {
  const { fps } = useVideoConfig();
  const tileAt = beats[2] ?? 0;
  const items = (spec.items ?? []).slice(0, 2);
  // 日期牌 260 寬、跟事件文字之間 44 → 事件文字可用寬 = 1080 − pad×2 − 260 − 44
  const eventFont = fitFontSize(1080 - MC.pad * 2 - 260 - 44, [spec.event], 88, ITEM_FONT_MAX);
  // 日期牌裡的字：牌內可用 260 − 左右 24
  const whenFont = fitFontSize(212, [spec.when], 96, 120);
  const pointFont = fitFontSize(1080 - MC.pad * 2 - 70, items.map((i) => i.text), 58, 72);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 56 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 44 }}>
        <Pop at={tileAt}>
          <div
            style={{
              width: 260,
              height: 260,
              borderRadius: 28,
              border: `4px solid ${MC.yellow}`,
              background: 'rgba(255,216,77,0.10)',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {/* 日曆的「頁首」：純裝飾，兩個環 */}
            <div style={{ height: 58, background: MC.yellow, display: 'flex',
              justifyContent: 'space-around', alignItems: 'center', padding: '0 54px' }}>
              {[0, 1].map((k) => (
                <span key={k} style={{ width: 18, height: 18, borderRadius: '50%', background: '#0e2f6e' }} />
              ))}
            </div>
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: whenFont, fontWeight: 900, color: MC.white, letterSpacing: -2 }}>
              {spec.when}
            </div>
          </div>
        </Pop>
        <Enter at={tileAt + 0.3 * fps} dy={0}>
          <div style={{ fontSize: eventFont, fontWeight: 900, color: MC.white, lineHeight: 1.15 }}>
            {spec.event}
          </div>
        </Enter>
      </div>
      {items.map((it, i) => (
        <Enter key={i} at={itemAt(it, beats[3 + i] ?? tileAt, fps)}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 22, fontSize: pointFont,
            fontWeight: 800, color: MC.white }}>
            <span style={{ color: MC.yellow, fontWeight: 900 }}>▸</span>
            {it.text}
          </div>
        </Enter>
      ))}
    </div>
  );
};

// ── ⑤ 關卡線：一條價位線＋每次碰線的示意走勢（2026-10-08）───────────
// ⚠️ 走勢是示意，不是行情：形狀只表達「碰到、沒過」或「守住」，數字全部來自稿件。
const CHART_W = 1080 - MC.pad * 2;
const CHART_H = 430;
/** 走勢只畫到這裡，右邊留給價位標籤接在線的末端 —— 放在線的上下方都會壓到某一段走勢。 */
const PATH_W = CHART_W - 260;

/** 第 i 次碰線那一段走勢的折線點（壓力：由下往上碰線再回落）。support 由呼叫端上下翻轉。 */
function trySegment(i: number, n: number): [number, number][] {
  const lineY = 70;
  const peakX = (PATH_W * (i + 1)) / (n + 1);
  const prevX = i === 0 ? 0 : (PATH_W * (i + 0.5)) / (n + 1);
  const nextX = i === n - 1 ? PATH_W : (PATH_W * (i + 1.5)) / (n + 1);
  // 起點：第一段從底部出發，之後接在上一段的回落點
  const startY = i === 0 ? CHART_H - 30 : 230;
  const span = peakX - prevX;
  return [
    [prevX, startY],
    [prevX + span * 0.35, startY - (startY - lineY) * 0.45],
    [prevX + span * 0.55, startY - (startY - lineY) * 0.3],
    [peakX, lineY + 12],              // 碰線但沒過：停在線下 12px
    [peakX + (nextX - peakX) * 0.5, 190],
    [nextX, 230],
  ];
}

const LevelCard: React.FC<{ spec: LevelSpec; beats: number[] }> = ({ spec, beats }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const tries = spec.items.slice(0, 3);
  const n = Math.max(1, tries.length);
  const flip = spec.kind === 'support';
  const y = (v: number) => (flip ? CHART_H - v : v);
  const lineAt = beats[2] ?? 0;
  const lineP = interpolate(frame, [lineAt, lineAt + 0.5 * fps], [0, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const ats = tries.map((it, i) => itemAt(it, beats[3 + i] ?? lineAt + (i + 1) * 0.7 * fps, fps));
  // 大字與結論接在最後一次碰線之後；片子太短就往前收，至少留 0.8 秒站住
  const lastAt = Math.max(lineAt, ...ats);
  const cap = durationInFrames - 0.8 * fps;
  const gapAt = Math.min(lastAt + 0.6 * fps, cap);
  const verdictAt = Math.min(gapAt + 0.6 * fps, cap);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 30 }}>
      {/* 支撐的碰線標籤在線下方、會超出圖框，下面多留一點，不然會貼到結論 */}
      <svg width={CHART_W} height={CHART_H} viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        style={{ overflow: 'visible', marginBottom: flip ? (n === 3 ? 90 : 40) : 0 }}>
        <line x1={0} x2={(PATH_W + 24) * lineP} y1={y(70)} y2={y(70)}
          stroke={MC.yellow} strokeWidth={5} strokeDasharray="18 12" />
        {/* 價位標籤接在線的末端；每次碰線的標籤放在線的另一側 —— 那一側沒有走勢，
            字不會壓到線（2026-10-08 試片：放在線上下方都會壓到最後一段走勢）。 */}
        <text x={CHART_W} y={y(70) + 15} textAnchor="end"
          fill={MC.yellow} fontSize={40} fontWeight={900} opacity={lineP}>
          {spec.level}
        </text>
        {tries.map((it, i) => {
          const pts = trySegment(i, n).map(([px, py]) => [px, y(py)] as [number, number]);
          const len = pts.reduce((sum, p, k) => (k ? sum + Math.hypot(p[0] - pts[k - 1][0], p[1] - pts[k - 1][1]) : 0), 0);
          const p = interpolate(frame, [ats[i], ats[i] + 0.6 * fps], [0, 1],
            { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
          const peak = pts[3];
          const labelP = interpolate(frame, [ats[i] + 0.4 * fps, ats[i] + 0.7 * fps], [0, 1],
            { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
          return (
            <g key={i}>
              <polyline points={pts.map((q) => q.join(',')).join(' ')} fill="none"
                stroke={i === tries.length - 1 ? MC.white : MC.muted} strokeWidth={i === tries.length - 1 ? 7 : 5}
                strokeLinejoin="round" strokeLinecap="round"
                strokeDasharray={len} strokeDashoffset={len * (1 - p)} />
              <circle cx={peak[0]} cy={peak[1]} r={11} fill={MC.white} opacity={labelP} />
              {/* 三次碰線時峰距只剩 168px，標籤會連成一串 —— 中間那個錯開一排 */}
              <text x={peak[0]}
                y={(flip ? y(70) + 58 : y(70) - 24) + (n === 3 && i === 1 ? (flip ? 48 : -48) : 0)}
                textAnchor="middle"
                fill={MC.white} fontSize={40} fontWeight={800} opacity={labelP}>
                {it.text}
              </text>
            </g>
          );
        })}
      </svg>
      {spec.gap ? (
        <Pop at={gapAt}>
          <div style={{ fontSize: 84, fontWeight: 900, color: MC.yellow, lineHeight: 1.1 }}>{spec.gap}</div>
        </Pop>
      ) : null}
      {spec.verdict ? (
        <Enter at={verdictAt}>
          <div style={{ fontSize: 64, fontWeight: 900, color: colorOf(spec.verdictC), lineHeight: 1.2 }}>
            {spec.verdict}
          </div>
        </Enter>
      ) : null}
    </div>
  );
};

// ── ⑥ 大數字：一個數字從 0 跳到原文的值（2026-10-15）──────────────────
/**
 * 跳到一半時要顯示的字。小數位數與千分位照原文的寫法（「404.6」跳的時候一直是一位小數）。
 * 不是純數字（例「4萬6」）就不跳，直接顯示。
 */
function countText(value: string, p: number): string {
  const n = Number(value.replace(/,/g, ''));
  if (!Number.isFinite(n)) return value;
  const dec = (value.split('.')[1] ?? '').length;
  const v = n * p;
  return value.includes(',')
    ? v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })
    : v.toFixed(dec);
}

const NumberCard: React.FC<{ spec: NumberSpec; beats: number[] }> = ({ spec, beats }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const numAt = typeof spec.atSec === 'number' ? spec.atSec * fps : beats[2] ?? 0;
  // 前快後慢（ease-out cubic），0.9 秒跳完 —— 再久人就等不及了
  const k = interpolate(frame, [numAt, numAt + 0.9 * fps], [0, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const p = 1 - Math.pow(1 - k, 3);
  const items = (spec.items ?? []).slice(0, 2);
  // 單位用半大的字，拿整串估寬會略估大一點，剛好當餘裕
  const numFont = fitFontSize(1080 - MC.pad * 2,
    [`${spec.prefix ?? ''}${spec.value}${spec.unit ?? ''}`], 200, 240);
  const pointFont = fitFontSize(1080 - MC.pad * 2 - 70, items.map((i) => i.text), 58, 72);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 40 }}>
      <div>
        {spec.label ? (
          <Enter at={numAt}>
            <div style={{ fontSize: 52, fontWeight: 800, color: MC.muted }}>{spec.label}</div>
          </Enter>
        ) : null}
        <Pop at={numAt}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, color: colorOf(spec.valueC),
            fontWeight: 900, lineHeight: 1.05, fontVariantNumeric: 'tabular-nums', letterSpacing: -4 }}>
            <span style={{ fontSize: numFont }}>{(spec.prefix ?? '') + countText(spec.value, p)}</span>
            {spec.unit ? <span style={{ fontSize: Math.round(numFont * 0.45), letterSpacing: 0 }}>{spec.unit}</span> : null}
          </div>
        </Pop>
      </div>
      {items.map((it, i) => (
        <Enter key={i} at={itemAt(it, beats[3 + i] ?? numAt, fps)}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 22, fontSize: pointFont,
            fontWeight: 800, color: MC.white }}>
            <span style={{ color: MC.yellow, fontWeight: 900 }}>▸</span>
            {it.text}
          </div>
        </Enter>
      ))}
    </div>
  );
};

// ── ⑦⑧ 排行長條／族群漲幅：同一套長條；排行結尾蓋總結章，族群結尾放提問（2026-10-15）──────
const isLimit = (v: string) => /漲停|跌停/.test(v);
const barNum = (v: string) => {
  const m = v.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : NaN;
};
/** 沒指定顏色就看數值：負號或「跌」是綠，其餘紅（台股慣例）。 */
const barColor = (it: BarItem) =>
  it.c ? colorOf(it.c) : /^[-−－]|跌/.test(it.value) ? MC.down : MC.up;

/** 一枚斜著蓋上去的章（「漲停」「全部雙位數」）。 */
const Stamp: React.FC<{ at: number; text: string; color: string; size: number }> = ({ at, text, color, size }) => (
  <Pop at={at} style={{ display: 'inline-block' }}>
    <div style={{ border: `5px solid ${color}`, color, borderRadius: 12, padding: '4px 20px',
      fontSize: size, fontWeight: 900, transform: 'rotate(-6deg)', whiteSpace: 'nowrap' }}>
      {text}
    </div>
  </Pop>
);

const Bars: React.FC<{ spec: RankSpec | SectorSpec; beats: number[] }> = ({ spec, beats }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const items = spec.items.slice(0, 5);
  const sector = spec.template === 'sector';
  // 長度依數值比例。有漲停／跌停時以 10%（台股漲跌幅上限）當滿格，
  // 不然「南亞 +7.17%」會跟漲停的台塑一樣長。看不出數字的（漲停本身）一律滿格。
  const nums = items.map((it) => (isLimit(it.value) ? NaN : barNum(it.value)));
  const top = Math.max(0, ...nums.filter(Number.isFinite), items.some((it) => isLimit(it.value)) ? 10 : 0);
  const widthOf = (n: number) => (Number.isFinite(n) && top > 0 ? Math.max(0.06, n / top) : 1);
  const ats = items.map((it, i) => itemAt(it, beats[2 + i] ?? 0, fps));
  const lastAt = Math.max(0, ...ats);
  const endAt = Math.min(lastAt + 0.7 * fps, durationInFrames - 0.8 * fps);
  const dense = items.length >= 5;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: dense ? 22 : 36 }}>
      {items.map((it, i) => {
        const grow = interpolate(frame, [ats[i] + 0.15 * fps, ats[i] + 0.95 * fps], [0, 1],
          { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        const ease = 1 - Math.pow(1 - grow, 3);
        const c = barColor(it);
        return (
          <Enter key={i} at={ats[i]} dy={0}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              fontSize: 58, fontWeight: 800, color: MC.white, lineHeight: 1.2 }}>
              <span>{it.text}</span>
              {/* 漲停／跌停本身就是數值，直接用章蓋在數值的位置 —— 名稱旁再蓋一個會重複 */}
              {isLimit(it.value)
                ? <Stamp at={ats[i] + 0.4 * fps} text={it.value} color={c} size={46} />
                : <span style={{ color: c, fontWeight: 900, fontVariantNumeric: 'tabular-nums' }}>{it.value}</span>}
            </div>
            <div style={{ marginTop: 12, height: 26, borderRadius: 8, background: 'rgba(255,255,255,0.10)' }}>
              <div style={{ height: '100%', borderRadius: 8, background: c,
                width: `${widthOf(nums[i]) * ease * 100}%` }} />
            </div>
          </Enter>
        );
      })}
      {!sector && spec.stamp ? (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 10 }}>
          <Stamp at={endAt} text={spec.stamp} color={spec.stampC ? colorOf(spec.stampC) : MC.yellow} size={60} />
        </div>
      ) : null}
      {sector && (spec.tags ?? []).length ? (
        <Enter at={endAt}>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 10 }}>
            {(spec.tags ?? []).slice(0, 2).map((tg, k) => (
              <span key={k} style={{ border: `3px solid ${k ? MC.yellow : MC.muted}`,
                color: k ? MC.yellow : MC.white, borderRadius: 14, padding: '10px 26px',
                fontSize: 50, fontWeight: 800 }}>
                {tg}
              </span>
            ))}
          </div>
        </Enter>
      ) : null}
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
        : spec.template === 'event'
          ? 1 + Math.min(2, (spec.items ?? []).length)
          : spec.template === 'level'
            ? 1 + Math.min(3, spec.items.length)
            : spec.template === 'number'
              ? 1 + Math.min(2, (spec.items ?? []).length)
              : spec.template === 'rank' || spec.template === 'sector'
                ? Math.min(5, spec.items.length) + 1
                : Math.min(4, spec.lines.length);
  return head + body + 1;
}

export const MotionClip: React.FC<{
  spec: MotionClipSpec;
  safeTop?: number;
  safeBottom?: number;
  /** 這段做在腳本結尾：演到影片結束，尾端不淡出。由 render-motion 用 --props 傳進來。 */
  noTailFade?: boolean;
}> = ({ spec, safeTop, safeBottom, noTailFade }) => {
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
      noTailFade={noTailFade}
    >
      {spec.template === 'contrast' ? <Contrast spec={spec} beats={beats} /> : null}
      {spec.template === 'list' ? <Bullets spec={spec} beats={beats} /> : null}
      {spec.template === 'quote' ? <Quote spec={spec} beats={beats} /> : null}
      {spec.template === 'event' ? <EventCard spec={spec} beats={beats} /> : null}
      {spec.template === 'level' ? <LevelCard spec={spec} beats={beats} /> : null}
      {spec.template === 'number' ? <NumberCard spec={spec} beats={beats} /> : null}
      {spec.template === 'rank' || spec.template === 'sector' ? <Bars spec={spec} beats={beats} /> : null}
    </Shell>
  );
};
