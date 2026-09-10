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
        {/* 日期牌梯形在 intro-frame.jpg 與 header-overlay.png 上的 y 座標不同（差 371px），
            兩張圖各自傳 top 值，不要共用一組座標（大盤小報 2026-08-07 踩過這個坑） */}
        <DateBadge top={479} />
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

// 日期牌空白區座標：沿用大盤小報實測值（藍色梯形 x:60-379；header-overlay.png y:108-293、
// intro-frame.jpg y:479-664）。素材換成盤中焦點自己的美術之後，如果梯形位置變了要回來重量一次。
const DateBadge: React.FC<{ top: number }> = ({ top }) => {
  const headerDate = (videoMeta as any).headerDate ?? '';
  if (!headerDate) return null;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: 55,
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
//（parse-midday-script.js 從 script.txt 標題段寫入）。第一句白色、其餘黃色。
const TITLE_COLORS = ['#ffffff', '#FFE600'];

const TitleCard: React.FC<{ topOffset?: number }> = ({ topOffset = 0 }) => {
  const title = (videoMeta as any).titleText ?? '';
  if (!title) return null;
  const lines = title.split('\n').filter((l: string) => l.trim());
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: 60,
          right: 60,
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
