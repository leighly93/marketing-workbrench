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
import { MotionOverlay } from '../MotionClip/MotionOverlay';
import { MOTION_RUNS } from '../MotionClip/motion-timeline';
import videoMeta from '../video-meta.json';
import { PunchIn } from '../PunchIn';
import { emphasisPunchSpans } from '../Subtitles';

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
        {/* 2026-08-07 修正：intro-frame.jpg 的日期牌槽跟 header-overlay.png 不同 y 座標，
            之前誤用同一組座標疊在兩張圖上、intro 那張因此歪掉。兩張圖分開傳 top 值。
            2026-09-16 使用者換素材後重量：intro 的槽是 y489–660（舊素材是 y479–664）。 */}
        <DateBadge top={489} />
        <TitleCard topOffset={70} />
      </Sequence>

      {/* === 主段：主講者影片期 === */}
      <Sequence from={introFrames} durationInFrames={heygenFrames}>
        {/* 主軌：講者影片，無 PIP、無模糊
            2026-08-07 修正：大盤小報的來源影片是「橫式（16:9）」，不是 HeyGen 直式輸出，
            所以用 objectFit:'cover'（等比放大＋裁切左右）把畫面填滿直式畫布，裁掉的是
            左右兩側背景，跟現有 MarketingVideo.tsx 那套「contain + scale(1.03)」
            （給直式來源用）是不同情境，這裡不能沿用 */}
        {/* 標了字幕重點詞的那幾句，講者推近一級（2026-09-17 使用者定案，見 PunchIn.tsx）。
            沒標任何重點詞時 spans 是空陣列 → 完全不套 transform，畫面一格都不變。 */}
        <PunchIn spans={emphasisPunchSpans()}>
          <OffthreadVideo
            src={staticFile('heygen.mp4')}
            volume={1.5}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              // 2026-09-11 使用者：「人不夠置中，應該要往畫面左邊移動一點」。
              // 舊值是 'center center'，前提是上面那句「人物本來就在正中央」—— 量過之後
              // **那個前提是錯的**：當時的 avatar（DAPAN_AVATAR 5bad6432…）在 1920px
              // 的來源畫面裡，頭肩中點落在 x≈995（0.518），比正中央偏右 35px。
              // cover 進 1080×1920 之後放大 1.778 倍 → 成品裡人物偏右 62.5px（實測 09-11
              // 出的直式.mp4，頭肩中點 602.5、畫布中心 540），所以看起來就是沒對準。
              // ⚠️ objectPosition 的百分比**不是位移量**，是「來源的 x% 對齊框的 x%」：
              //    數字調大 → 畫面內容往左跑。可裁掉的寬度是 3413−1080＝2333px，
              //    要往左推 62.5px 就是 62.5/2333 ≈ 2.7% → 50% + 2.7% = 52.7%。
              // ⚠️ 這個值**綁 avatar look**，run.js 換 DAPAN_AVATAR 之後要重量一次
              //    （拿一張來源幀量頭肩中點比例，再套上面那條算式），不能無條件沿用。
              //    2026-09-16 使用者換回 5bad6432… ＝ 這個數字當初就是照它量的，前提回到原點。
              //    中間用過的兩支：77012ed5…（0914）臉部中點 x≈998＝0.520，跟這支的 995 差 3px，
              //    所以當時沿用沒出事；484b6346…（0915）只用了一支片就換掉，理由是垂直構圖偏高
              //    （見 run.js 的 DAPAN_AVATAR 註解），水平沒來得及重量。
              //    （橫式 DapanLandscapeComposition.tsx 的 56.3% 同一組前提，要換要一起重算。）
              objectPosition: '52.7% center',
            }}
          />
        </PunchIn>

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

        {/* 動態小影片：獨立畫面，會蓋掉講者與截圖，但字幕與招牌 bar 留在它上面。
            mp4 本身就是 1080×1920 全畫面（背景與掃光在影片裡已鋪滿），內容只畫在 y310–1440，
            所以這裡滿版貼上即可，不必補底色或算位置。沒標動態時 MOTION_RUNS 是空陣列＝完全沒有這一層。
            ⚠️ 這一段在 `<Sequence from={introFrames}>` 內，時間自動對齊主段（開場卡那 1 秒不算）。 */}
        <MotionOverlay
          runs={MOTION_RUNS}
          region={{ x: 0, y: 0, w: VIDEO_WIDTH, h: VIDEO_HEIGHT }}
        />

        {/* 字幕層：跟講者段同一套樣式（直接 reuse，未修改），截圖段也照樣顯示在最上層 */}
        <Subtitles />

        {/* 常駐 header bar：全片主段都在最上層，蓋在截圖/字幕之上 */}
        <AbsoluteFill style={{ pointerEvents: 'none' }}>
          <Img
            src={staticFile('dapan-header-overlay.png')}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </AbsoluteFill>
        <DateBadge top={129} />
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


// 日期牌空白區座標（分別實測 intro-frame.jpg 與 header-overlay.png 兩張圖的實際像素）：
// 兩張圖的招牌是同一套美術、只差 y（intro 整體比 header 低 360px），
// 呼叫端要各自傳對的 top 值，不能共用一組座標（2026-08-06 版本的 bug 就是共用同一組）。
//
// 2026-09-16 使用者換掉素材後重量（舊素材是「無外框的青色平行四邊形 x60–379 /
// header y108–293 / intro y479–664」，那組數字已失效）：
//   新素材是「銀色外框膠囊」，量法＝掃銀白外框（R,G,B>160 且低彩度）取內緣：
//   外框 header y124–306、intro y484–666（兩張都是 h183）→ 內緣藍色槽高 172
//     header-overlay.png：y129–300     intro-frame.jpg：y489–660
//   左緣：外框 x73–78 → 內緣 x79（兩張一致）
//   右緣：是斜切分隔線、上寬下窄，y 每降 20px 約左移 7px；取槽垂直中央約 x357
//   → 可用槽 x79–357（寬 279）、中心 x218.5
// ⚠️ 這兩張圖再換一次就要照上面的量法重量一遍，不能沿用。
const DateBadge: React.FC<{ top: number }> = ({ top }) => {
  const headerDate = (videoMeta as any).headerDate ?? '';
  if (!headerDate) return null;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          // 這個框＝槽本身（left/width 是槽的左內緣與寬，top 由呼叫端傳、height 是槽高），
          // 視覺置中靠下面那層的 transform 修，座標本身不再手動偏移
          left: 79,
          top,
          width: 279,
          height: 172,
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
            // 光學置中修正：flex 置中對齊的是「字的前進寬度＋em 框」，不是實際墨跡。
            // 斜體讓墨跡整體偏右、數字基線讓墨跡偏下，2026-09-16 實測（fontSize 106）
            // 墨跡中心比框中心右 12px、下 7px → 用 em 表示才會跟著字級縮放。
            transform: 'translate(-0.113em, -0.066em)',
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
