import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  Sequence,
  staticFile,
} from 'remotion';
import {
  MIDDAY_BGM,
  MIDDAY_INTRO_SEC,
  MIDDAY_SHOT_RUNS,
  VIDEO_HEIGHT,
  VIDEO_WIDTH,
  MIDDAY_TOTAL_DURATION_SEC,
  HEYGEN_DURATION_SEC,
  VIDEO_FPS,
  secToFrame,
} from './midday-timeline';
import { frameSpan } from '../timeline';
import { Subtitles } from '../Subtitles';
import { ShotFocusImage } from '../ShotFocus';
import videoMeta from '../video-meta.json';

/**
 * 盤中焦點 composition（2026-08-31 新增，使用者：「他跟現有的大盤小報很像，但他取名叫『盤中焦點』，
 * 然後只出直式」）。
 *
 * 版面規格照大盤小報直式複製一份：
 *   - 開場卡（midday-intro-frame.jpg，1 秒）+ 主段（heygen 影片 + 常駐 header bar + 字幕 + 全螢幕截圖切換）
 *   - 日期牌動態渲染（video-meta.json.headerDate，MMDD），標題文字讀 video-meta.json.titleText
 *   - 無 PIP、無主畫面模糊、無 outro CTA
 *
 * ⚠️ 跟大盤小報的兩個差異（別對著 DapanComposition 抄錯）：
 *   ① **只有直式**，沒有橫式姊妹 composition（大盤小報有 DapanXiaobaoLandscape）。
 *   ② 來源影片是 **9:16 直式**（run.js 的 HEYGEN_ASPECT_RATIO 對非 dapan 版型送 9:16，
 *      2026-08-31 使用者確認這支 photo 原圖是直式）。objectFit:'cover' 在來源已經是
 *      1080×1920 時等於沒作用，留著只是保險 —— 日後誰換成橫式素材的 photo 也不會爆版。
 *
 * 跟 ../DapanXiaobao/DapanComposition.tsx 是完全獨立的兩支檔（天條 #4 #8 精神延伸），
 * 只共用 ../Subtitles.tsx 與 ../ShotFocus.tsx（原樣重用、未修改）。
 */

export const MiddayFocusComposition: React.FC = () => {
  const introFrames = secToFrame(MIDDAY_INTRO_SEC);
  const heygenFrames = secToFrame(HEYGEN_DURATION_SEC);
  const totalFrames = secToFrame(MIDDAY_TOTAL_DURATION_SEC);

  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {/* === 開場卡：midday-intro-frame.jpg 顯示 1 秒 === */}
      <Sequence from={0} durationInFrames={introFrames}>
        <AbsoluteFill>
          <Img
            src={staticFile('midday-intro-frame.jpg')}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </AbsoluteFill>
        {/* 日期牌梯形在 intro-frame.jpg 與 header-overlay.png 上的 y 座標不同（差 381px），
            兩張圖各自傳 top 值，不要共用一組座標（大盤小報 2026-08-07 踩過這個坑）。
            2026-09-15 換圖後重量：header 的招牌位置沒變（金框內緣 y115-285，維持 top 108），
            intro 的招牌下移了（金框內緣 y496-666），所以這裡從 479 調成 488 才回到置中。 */}
        <DateBadge top={488} />
        <TitleCard topOffset={70} />
      </Sequence>

      {/* === 主段：主講者影片期 === */}
      <Sequence from={introFrames} durationInFrames={heygenFrames}>
        <AbsoluteFill>
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

        {/* 截圖段：全螢幕切換（黃框由 auto-shot／人工標注決定） */}
        {MIDDAY_SHOT_RUNS.map((run, idx) => {
          const { from, durationInFrames } = frameSpan(run.startSec, run.endSec);
          return (
            <Sequence
              key={`run-${idx}`}
              from={from}
              durationInFrames={durationInFrames}
            >
              {/* safeTop/safeBottom：黃框的安全區。header-overlay.png 不透明到 y301、
                  字幕條從 y1440 起（Subtitles.tsx 的 paddingTop），所以留 310~1430。 */}
              <ShotFocusImage
                run={run}
                width={VIDEO_WIDTH}
                height={VIDEO_HEIGHT}
                fps={VIDEO_FPS}
                safeTop={310}
                safeBottom={1430}
              />
            </Sequence>
          );
        })}

        {/* 字幕層：跟講者段同一套樣式（直接 reuse，未修改） */}
        <Subtitles />

        {/* 常駐 header bar：全片主段都在最上層，蓋在截圖/字幕之上 */}
        <AbsoluteFill style={{ pointerEvents: 'none' }}>
          <Img
            src={staticFile('midday-header-overlay.png')}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </AbsoluteFill>
        <DateBadge top={108} />
      </Sequence>

      {/* === BGM：跨整支影片墊底，頭尾淡入淡出 === */}
      {/* loop：BGM 比影片短時自動從頭接著播，鋪滿整支。
          loopVolumeCurveBehavior="extend"＝volume 收到的 f 是整支影片的 frame，
          不是每圈重新從 0 算 —— 否則下面的淡入會在每一圈開頭重新觸發一次。 */}
      <Audio
        loop
        loopVolumeCurveBehavior="extend"
        src={staticFile(MIDDAY_BGM.src)}
        volume={(f) => {
          const fadeIn = secToFrame(MIDDAY_BGM.fadeInSec);
          const fadeOut = secToFrame(MIDDAY_BGM.fadeOutSec);
          if (f < fadeIn) return MIDDAY_BGM.volume * (f / fadeIn);
          if (f > totalFrames - fadeOut)
            return MIDDAY_BGM.volume * Math.max(0, (totalFrames - f) / fadeOut);
          return MIDDAY_BGM.volume;
        }}
      />
    </AbsoluteFill>
  );
};

// 日期牌空白區座標：2026-09-15 換圖後對著 共用素材/盤中焦點/ 重量過
//（header-overlay.png 金框內緣 y115-285、intro-frame.jpg 金框內緣 y496-666，兩張的招牌差 381px；
//  藍色梯形左緣 x≈59 起，右緣因為斜切由上而下從 x363 收到 x329）。
// left 2026-09-15 定案 35（使用者在 55 / 45 / 25 / 35 四版對照後選「左右等距」這版）。
// 四位數字在字級 106／italic／letterSpacing -2 下實測寬 246px（用瀏覽器量 getBoundingClientRect，
// 不要用「字級 × 字數」估，那會多算 30px）。容器 319 寬、文字置中，所以文字左緣 = left + 36.5。
// left 35 → 文字 x71..317，兩張圖都離金線有餘裕：
//   開場 intro-frame（文字帶 y531-631）：梯形 x59-61 起、斜切線由 x363 收到 x329
//                                        → 左留 10-12px、右留 12-46px
//   主段 header-overlay（文字帶 y150-250）：梯形 x59-63 起、斜切線由 x367 收到 x332
//                                          → 左留 8-12px、右留 14-48px
// ⚠️ 兩側都不能再挪超過 ±10px：往左到 25 左緣只剩 0-2px，往右到 45 右緣會壓上斜切線。
// 開場與主段共用同一個 left —— 兩張圖的梯形水平幾何一致（實測差 2px 內），所以一個值同時顧到。
// 再換美術要回來重量一次（量法：ffmpeg 轉 rawvideo 掃金色外框與第一個白色字素的座標）。
const DateBadge: React.FC<{ top: number }> = ({ top }) => {
  const headerDate = (videoMeta as any).headerDate ?? '';
  if (!headerDate) return null;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: 35,
          top,
          width: 319,
          height: 185,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            fontFamily:
              '"Noto Sans TC", system-ui, -apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif',
            fontSize: 106,
            fontWeight: 800,
            fontStyle: 'italic',
            color: '#ffffff',
            letterSpacing: -2,
            lineHeight: 1,
            textShadow: '3px 3px 6px rgba(0,0,0,0.45)',
          }}
        >
          {headerDate}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// 標題卡：只在開場卡顯示，讀 video-meta.json.titleText
//（parse-midday-script.js 從 script.txt 標題段寫入）。第一句深灰、其餘深藍。
// 2026-09-15 使用者換了開場底圖（改成淺藍天空背景）並指定這兩個色，取代原本的白＋黃
//（白＋黃是深色底圖時代的配色，在新的淺底上會看不見）。
// 同一次定案：描邊由黑改白、標題陰影整個拿掉 —— 深色字配黑描邊會把 #023c91 壓成近黑，
// 白描邊則在淺底上給深色字一圈光暈。使用者看過三版對照（黑描邊／無描邊／白描邊）後選了白描邊。
// ⚠️ 只有盤中焦點改 —— 大盤小報／三大法人／焦點股／美股焦點各自有自己的 TITLE_COLORS，維持不動。
const TITLE_COLORS = ['#282828', '#023c91'];

const TitleCard: React.FC<{ topOffset?: number }> = ({ topOffset = 0 }) => {
  const title = (videoMeta as any).titleText ?? '';
  if (!title) return null;
  const lines = title.split('\n').filter((l: string) => l.trim());
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          // 2026-09-14 使用者定案「縮左右邊距、字級不動」（60 → 20）：直式標題要真的塞得下 10 字。
          //   可用寬 1080 − 20 − 20 = 1040px ÷ 字級 103 ≈ 10.09 字，10 字 = 1030px 剛好進得去，
          //   只剩 10px 餘裕 —— 使用者看過成品後說「很靠邊沒關係」。字級 103 維持不動（縮字級的方案被否決）。
          //   前台 TEMPLATES.title.per 的 10（server/index.js）到這裡才算數：per 只是提示，換行是這裡的寬度決定的。
          left: 20,
          right: 20,
          top: 700 + topOffset,
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
              fontSize: 103,
              fontWeight: 800,
              fontStyle: 'italic',
              color: i === 0 ? TITLE_COLORS[0] : TITLE_COLORS[1],
              lineHeight: 1.4,
              textAlign: 'center',
              WebkitTextStroke: '3px #ffffff',
              paintOrder: 'stroke fill',
              // 2026-09-15 使用者要求在白描邊之外再加一層白色模糊陰影：
              // 描邊是硬邊、只有 3px，光暈負責把深色字從淺藍底圖上「浮」起來。
              textShadow: '0 0 18px rgba(255,255,255,0.9)',
            }}
          >
            {line}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};
