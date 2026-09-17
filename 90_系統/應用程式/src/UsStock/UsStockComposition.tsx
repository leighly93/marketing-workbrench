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
  USSTOCK_BGM,
  USSTOCK_INTRO_SEC,
  USSTOCK_SHOT_RUNS,
  VIDEO_HEIGHT,
  VIDEO_WIDTH,
  USSTOCK_TOTAL_DURATION_SEC,
  HEYGEN_DURATION_SEC,
  VIDEO_FPS,
  secToFrame,
} from './usstock-timeline';
import { frameSpan } from '../timeline';
import { PunchIn } from '../PunchIn';
import { emphasisPunchSpans } from '../Subtitles';
import { Subtitles } from '../Subtitles';
import { ShotFocusImage } from '../ShotFocus';
import videoMeta from '../video-meta.json';

/**
 * 美股焦點 composition（2026-09-15 新增，使用者：「基本上跟盤中焦點一樣，只是 HeyGen avatar id
 * 和 MiniMax voice id 不同」）。
 *
 * 版面規格照盤中焦點複製一份：
 *   - 開場卡（usstock-intro-frame.jpg，1 秒）+ 主段（heygen 影片 + 常駐 header bar + 字幕 + 全螢幕截圖切換）
 *   - 日期牌動態渲染（video-meta.json.headerDate，MMDD），標題文字讀 video-meta.json.titleText
 *   - 無 PIP、無主畫面模糊、無 outro CTA、只出直式
 *
 * ⚠️ 座標**不是**照盤中焦點抄的，是對著 共用素材/美股焦點/ 這兩張圖重新量的（見 DateBadge 註解）：
 *    美股焦點的招牌是**圓角膠囊**、盤中焦點是**斜切梯形**，空白區的位置與大小都不一樣。
 *    素材換新美術之後要回來重量一次。
 *
 * 跟 ../MiddayFocus/MiddayFocusComposition.tsx 是完全獨立的兩支檔（天條 #4 #8 精神延伸），
 * 只共用 ../Subtitles.tsx 與 ../ShotFocus.tsx（原樣重用、未修改）。
 */

// 日期字級（開場卡與主段共用，見 DateBadge 上方註解）
const DATE_FONT_SIZE = 125;

export const UsStockComposition: React.FC = () => {
  const introFrames = secToFrame(USSTOCK_INTRO_SEC);
  const heygenFrames = secToFrame(HEYGEN_DURATION_SEC);
  const totalFrames = secToFrame(USSTOCK_TOTAL_DURATION_SEC);

  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {/* === 開場卡：usstock-intro-frame.jpg 顯示 1 秒 === */}
      <Sequence from={0} durationInFrames={introFrames}>
        <AbsoluteFill>
          <Img
            src={staticFile('usstock-intro-frame.jpg')}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </AbsoluteFill>
        {/* 招牌在 intro-frame.jpg 與 header-overlay.png 上的座標不同（差 x+10、y+373），
            兩張圖各自傳一組值，不要共用（大盤小報 2026-08-07 踩過這個坑） */}
        <DateBadge left={116} top={488} fontSize={DATE_FONT_SIZE} />
        <TitleCard topOffset={70} />
      </Sequence>

      {/* === 主段：主講者影片期 === */}
      <Sequence from={introFrames} durationInFrames={heygenFrames}>
        {/* 標了字幕重點詞的那幾句，講者推近一級（2026-09-17，見 PunchIn.tsx）。
            沒標就是空陣列 → 完全不套 transform，畫面一格都不變。 */}
        <PunchIn spans={emphasisPunchSpans()}>
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
        </PunchIn>

        {/* 截圖段：全螢幕切換（黃框由 auto-shot／人工標注決定） */}
        {USSTOCK_SHOT_RUNS.map((run, idx) => {
          const { from, durationInFrames } = frameSpan(run.startSec, run.endSec);
          return (
            <Sequence
              key={`run-${idx}`}
              from={from}
              durationInFrames={durationInFrames}
            >
              {/* safeTop/safeBottom：黃框的安全區。usstock-header-overlay.png 的招牌實心到 y307
                  （比盤中焦點的 y291 低，膠囊比較高），字幕條從 y1440 起（Subtitles.tsx 的 paddingTop），
                  所以留 325~1430。 */}
              <ShotFocusImage
                run={run}
                width={VIDEO_WIDTH}
                height={VIDEO_HEIGHT}
                fps={VIDEO_FPS}
                safeTop={325}
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
            src={staticFile('usstock-header-overlay.png')}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </AbsoluteFill>
        <DateBadge left={106} top={115} fontSize={DATE_FONT_SIZE} />
      </Sequence>

      {/* === BGM：跨整支影片墊底，頭尾淡入淡出 === */}
      {/* loop：BGM 比影片短時自動從頭接著播，鋪滿整支。
          loopVolumeCurveBehavior="extend"＝volume 收到的 f 是整支影片的 frame，
          不是每圈重新從 0 算 —— 否則下面的淡入會在每一圈開頭重新觸發一次。 */}
      <Audio
        loop
        loopVolumeCurveBehavior="extend"
        src={staticFile(USSTOCK_BGM.src)}
        volume={(f) => {
          const fadeIn = secToFrame(USSTOCK_BGM.fadeInSec);
          const fadeOut = secToFrame(USSTOCK_BGM.fadeOutSec);
          if (f < fadeIn) return USSTOCK_BGM.volume * (f / fadeIn);
          if (f > totalFrames - fadeOut)
            return USSTOCK_BGM.volume * Math.max(0, (totalFrames - f) / fadeOut);
          return USSTOCK_BGM.volume;
        }}
      />
    </AbsoluteFill>
  );
};

// 日期牌空白區座標：**對著 共用素材/美股焦點/ 的兩張圖量出來的**，不是沿用盤中焦點的值。
//   header-overlay.png：金框內緣 y129-286、膠囊左端到「美」字左緣 x71-460
//   intro-frame.jpg   ：同一塊招牌整體位移 (x+10, y+373)
// top 維持 intro 488 / header 115（＝行框在膠囊空白區正中）。2026-09-15 試過各上移 20px，
// 使用者看過完整畫面後選了不上移這版，所以改回來；上移的那版沒有留在程式裡。
// 底下這個 319×185 的框比空白區高一點，但內容是 flex 置中，字高＝fontSize，不會溢出。
// fontSize 上限 157（＝空白區高度），四位數字的寬度是 fontSize × 2.32，到 167 才會撞到左右；
// 也就是高度先卡住。開場卡用 130（文字 302×130，上下各留 14px），主段沿用預設 106。
// 素材換成別版美術之後，如果膠囊位置變了要回來重量一次
//（量法：ffmpeg 轉 rawvideo 掃金色外框與第一個白色字素的座標）。
//
// 字級 125：2026-09-15 使用者出過第一支片後要求放大（原 106），開場卡與主段**用同一個值** ——
// 兩處的膠囊一樣大（空白區都是 389×157），分開設會讓日期在 t=1s 切換時忽大忽小。
//
// ⚠️ 算餘裕要用**墨跡**，不是 line box。實測（canvas measureText，字級 125／italic／800）：
//      墨跡 300×96，但 line-height:1 的行框是 125 高 —— 數字上方有 23px 空隙、下方 6px。
//      也就是行框置中時，看起來的字會偏下 17px。
//    比例：墨跡寬 = 字級 × 2.40、墨跡高 = 字級 × 0.768。
//    對 389×157 的空白區 → 寬度先卡住，**上限約 162**（高度要到 204 才滿）。
//    先前註解寫「上限 157、高度先卡住」是拿 line box 當墨跡算的，已修正。
// 目前 125 + top 不上移：墨跡離金框上緣 39px、下緣 22px，左右各 49px。
//   （因為上方空隙 23px > 下方 6px，行框置中時看起來的字會偏下 17px。
//     2026-09-15 拿「上移 20px 讓墨跡視覺置中」跟這版並排比過，使用者選了不上移的。
//     所以這裡是刻意不做視覺補償，不是漏算 —— 要改請整組 top 一起動，別只動一處。）
const DateBadge: React.FC<{ left: number; top: number; fontSize?: number }> = ({
  left,
  top,
  fontSize = 106,
}) => {
  const headerDate = (videoMeta as any).headerDate ?? '';
  if (!headerDate) return null;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left,
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
            fontSize,
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
//（parse-usstock-script.js 從 script.txt 標題段寫入）。第一句白色、其餘黃色。
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
          // 跟盤中焦點同一組值（2026-09-14 使用者定案「縮左右邊距、字級不動」）：
          //   可用寬 1080 − 20 − 20 = 1040px ÷ 字級 103 ≈ 10.09 字，10 字 = 1030px 剛好進得去。
          //   前台 TEMPLATES.title.per 的 10（server/index.js）到這裡才算數：per 只是提示，換行是這裡的寬度決定的。
          // top 700+70：美股焦點的招牌底緣在 y669（盤中焦點 y662），兩邊留白差 7px，沿用同一組值。
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
