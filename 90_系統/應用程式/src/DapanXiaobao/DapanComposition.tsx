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
  DAPAN_BGM,
  DAPAN_INTRO_SEC,
  DAPAN_SHOT_RUNS,
  VIDEO_HEIGHT,
  VIDEO_WIDTH,
  DAPAN_TOTAL_DURATION_SEC,
  HEYGEN_DURATION_SEC,
  VIDEO_FPS,
  secToFrame,
} from './dapan-timeline';
import { frameSpan } from '../timeline';
import { Subtitles } from '../Subtitles';
import { ShotFocusImage } from '../ShotFocus';
import videoMeta from '../video-meta.json';

/**
 * 大盤小報 composition。
 *
 * v1 範圍（2026-08-06，「先不考慮全自動化」拍板）：
 *   - 開場卡（intro-frame.jpg，1 秒）+ 主段（heygen 影片 + 常駐 header bar + 字幕 + 全螢幕截圖切換）
 *   - 日期牌動態渲染（video-meta.json.headerDate，MMDD），標題文字是固定畫在 intro-frame.jpg /
 *     header-overlay.png 上的美術、不動態產生
 *   - 截圖段 v1：只做「全螢幕切換」，不含 OCR 黃框標註 / 鏡頭推進放大（留待下一輪）
 *   - 無 PIP、無主畫面模糊、無 outro CTA（大盤小報單純講內容、不催下載）
 *
 * 跟 ../MarketingVideo.tsx 是完全獨立的兩條 composition（天條 #4 #8 精神延伸，
 * 不共用容易互相拖累的渲染邏輯檔），只共用 ../Subtitles.tsx（原樣重用、未修改）。
 */

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

export const DapanComposition: React.FC = () => {
  const introFrames = secToFrame(DAPAN_INTRO_SEC);
  const heygenFrames = secToFrame(HEYGEN_DURATION_SEC);
  const totalFrames = secToFrame(DAPAN_TOTAL_DURATION_SEC);

  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {/* === 開場卡：intro-frame.jpg 顯示 1 秒 === */}
      <Sequence from={0} durationInFrames={introFrames}>
        <AbsoluteFill>
          <Img
            src={staticFile('dapan-intro-frame.jpg')}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </AbsoluteFill>
        {/* 2026-08-07 修正：intro-frame.jpg 的日期牌梯形跟 header-overlay.png 不同 y 座標
            （量到 top≈479，header-overlay.png 是 top≈108），之前誤用同一組座標疊在兩張圖上、
            intro 那張因此歪掉。兩張圖分開傳 top 值 */}
        <DateBadge top={479} />
        <TitleCard topOffset={70} />
      </Sequence>

      {/* === 主段：主講者影片期 === */}
      <Sequence from={introFrames} durationInFrames={heygenFrames}>
        {/* 主軌：講者影片，無 PIP、無模糊
            2026-08-07 修正：大盤小報的來源影片是「橫式（16:9）」，不是 HeyGen 直式輸出，
            所以用 objectFit:'cover'（等比放大＋裁切左右）把畫面填滿直式畫布，裁掉的是
            左右兩側背景，跟現有 MarketingVideo.tsx 那套「contain + scale(1.03)」
            （給直式來源用）是不同情境，這裡不能沿用 */}
        <AbsoluteFill>
          <OffthreadVideo
            src={staticFile('heygen.mp4')}
            volume={1.5}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              // 2026-09-11 使用者：「人不夠置中，應該要往畫面左邊移動一點」。
              // 舊值是 'center center'，前提是上面那句「人物本來就在正中央」—— 量過之後
              // **那個前提是錯的**：現行 avatar（run.js 的 DAPAN_AVATAR 5bad6432…）在 1920px
              // 的來源畫面裡，頭肩中點落在 x≈995（0.518），比正中央偏右 35px。
              // cover 進 1080×1920 之後放大 1.778 倍 → 成品裡人物偏右 62.5px（實測 09-11
              // 出的直式.mp4，頭肩中點 602.5、畫布中心 540），所以看起來就是沒對準。
              // ⚠️ objectPosition 的百分比**不是位移量**，是「來源的 x% 對齊框的 x%」：
              //    數字調大 → 畫面內容往左跑。可裁掉的寬度是 3413−1080＝2333px，
              //    要往左推 62.5px 就是 62.5/2333 ≈ 2.7% → 50% + 2.7% = 52.7%。
              // ⚠️ 這個值**綁現在這個 avatar look**。run.js 換 DAPAN_AVATAR 之後要重量一次
              //    （拿一張來源幀量頭肩中點比例，再套上面那條算式），不能直接沿用 52.7%。
              objectPosition: '52.7% center',
            }}
          />
        </AbsoluteFill>

        {/* 截圖段：全螢幕切換（v1，無 OCR 黃框標註） */}
        {DAPAN_SHOT_RUNS.map((run, idx) => {
          const { from, durationInFrames } = frameSpan(run.startSec, run.endSec);
          return (
            <Sequence
              key={`run-${idx}`}
              from={from}
              durationInFrames={durationInFrames}
            >
              {/* safeTop/safeBottom：黃框的安全區。實測 dapan-header-overlay.png 不透明到 y301、
                  字幕條從 y1440 起（Subtitles.tsx 的 paddingTop），所以留 310~1430。
                  只有黃框真的超出時才會把圖推進來 —— 直式的框本來都在裡面，畫面維持原樣。 */}
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

        {/* 字幕層：跟講者段同一套樣式（直接 reuse，未修改），截圖段也照樣顯示在最上層 */}
        <Subtitles />

        {/* 常駐 header bar：全片主段都在最上層，蓋在截圖/字幕之上 */}
        <AbsoluteFill style={{ pointerEvents: 'none' }}>
          <Img
            src={staticFile('dapan-header-overlay.png')}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </AbsoluteFill>
        <DateBadge top={108} />
      </Sequence>

      {/* === BGM：跨整支影片墊底，頭尾淡入淡出 === */}
      {/* loop：BGM 比影片短時自動從頭接著播，鋪滿整支（2026-08-21 焦點股踩到：
          bgm 52 秒、影片 92 秒，後面 40 秒是無聲）。
          loopVolumeCurveBehavior="extend"＝volume 收到的 f 是整支影片的 frame，
          不是每圈重新從 0 算 —— 否則下面的淡入會在每一圈開頭重新觸發一次。 */}
      <Audio
        loop
        loopVolumeCurveBehavior="extend"
        src={staticFile(DAPAN_BGM.src)}
        volume={(f) => {
          const fadeIn = secToFrame(DAPAN_BGM.fadeInSec);
          const fadeOut = secToFrame(DAPAN_BGM.fadeOutSec);
          if (f < fadeIn) return DAPAN_BGM.volume * (f / fadeIn);
          if (f > totalFrames - fadeOut)
            return DAPAN_BGM.volume * Math.max(0, (totalFrames - f) / fadeOut);
          return DAPAN_BGM.volume;
        }}
      />
    </AbsoluteFill>
  );
};

/**
 * 截圖段全螢幕圖片：淡入淡出，蓋滿整個畫面（不是現有模板的 PIP+局部疊圖）
 */


// 日期牌空白區座標（分別實測 intro-frame.jpg 與 header-overlay.png 兩張圖的實際像素，2026-08-07）：
// 藍色梯形 x:60-379 兩張圖一致，但 y 不同——header-overlay.png 是 y:108-293，
// intro-frame.jpg 是 y:479-664（低了 371px，兩張圖的版面設計不是同一個基準）。
// 呼叫端要各自傳對的 top 值，不能共用一組座標（2026-08-06 版本的 bug 就是共用同一組）。
const DateBadge: React.FC<{ top: number }> = ({ top }) => {
  const headerDate = (videoMeta as any).headerDate ?? '';
  if (!headerDate) return null;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: 55, // 2026-08-07 使用者要求再往左移 5px（原本 60）
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
            fontSize: 106, // 2026-08-10 使用者要求放大一點點（110 → 98 → 再 +8 → 106）
            fontWeight: 800,
            fontStyle: 'italic',
            color: '#ffffff',
            letterSpacing: -2,
            lineHeight: 1,
            textShadow: '3px 3px 6px rgba(0,0,0,0.45)', // 2026-08-10 使用者要求右下方向加一點陰影
          }}
        >
          {headerDate}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// 標題卡：只在開場卡（intro-frame.jpg）顯示，讀 video-meta.json.titleText
// （parse-dapan-script.js 從 script.txt 標題段寫入）。第一句白色、其餘黃色（2026-08-07 使用者要求）。
// 位置目前放在 header bar 下方的空白深色區（y 900~1300 一帶），沒有參考影片可以核對，
// 是第一版預設，等使用者看過實際渲染再調（見 99_封存/2026-09-10_第一批整理/舊說明與Agent紀錄/docs/tasks.md 未決事項）。
const TITLE_COLORS = ['#ffffff', '#FFE600']; // 2026-08-10 使用者要求第二句更飽和更亮（原本 #FFD700）

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
          // 2026-08-10 使用者要求標題小框跟日期整體區塊下移，topOffset 由呼叫端傳入
          top: 700 + topOffset, // 900 → 850 → 700 → +10 → +30 → 再 +30（區塊整體下移）
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center', // 2026-08-07 使用者要求置中（原本靠左）
          textAlign: 'center',
        }}
      >
        {lines.map((line: string, i: number) => (
          <div
            key={i}
            style={{
              fontFamily:
                '"Noto Sans TC", system-ui, -apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif',
              fontSize: 103, // 2026-08-10 使用者要求再放大 5px（72 → 88 → 103 → 113 → 98 → 再 +5 → 103）
              fontWeight: 800,
              fontStyle: 'italic', // 2026-08-10 使用者要求兩句都斜體
              color: i === 0 ? TITLE_COLORS[0] : TITLE_COLORS[1],
              lineHeight: 1.4,
              textAlign: 'center',
              // 2026-08-07 使用者參考圖是「粗黑描邊」海報字風格，用 -webkit-text-stroke
              // 加黑色描邊（Remotion render 走 headless Chrome，支援這個屬性）
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
