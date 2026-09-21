import React from 'react';
import {
  AbsoluteFill,
  OffthreadVideo,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { frameSpan } from '../timeline';
import type { MotionRun } from './motion-timeline';

/**
 * 把動態小影片貼進版型 —— 三個版型共用這一支（大盤小報直式／橫式、盤中焦點、美股焦點）。
 *
 * 用法（各版型只要一行，差別只有貼在哪一塊）：
 *   直式：<MotionOverlay runs={MOTION_RUNS} region={{ x: 0, y: 0, w: 1080, h: 1920 }} />
 *   橫式：<MotionOverlay runs={MOTION_RUNS} landscape region={{ x: 0, y: 0, w: 1178, h: 1080 }} />
 *
 * ⚠️ 動態 mp4 **本身就是該版型整個可見畫面的尺寸**（背景與掃光在影片裡已經鋪滿），
 *    所以這裡只負責「貼在哪、什麼時候出現」，不需要補底色、不需要置中計算。
 *    橫式的 region 寬度是 PANEL_LEFT_X（1178），右側品牌面板不覆蓋。
 *
 * 擺放位置：**放在截圖層之後、字幕與 header 之前**。動態是獨立畫面（會蓋掉講者與截圖），
 * 但字幕與招牌 bar 要留在它上面 —— 動態影片的內容本來就只畫在安全區內，不會被蓋到。
 */

/** 進出場淡化。時長由 Sequence 決定，這裡只看相對 frame。 */
const Clip: React.FC<{
  src: string;
  region: { x: number; y: number; w: number; h: number };
  /** 這段演到影片結束 → 尾端不淡出（淡出就變成「閃一下講者然後結束」，很突兀） */
  noTailFade?: boolean;
}> = ({ src, region, noTailFade }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const fade = Math.round(0.3 * fps);
  const opacity = noTailFade
    ? interpolate(frame, [0, fade], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
    : interpolate(
      frame,
      [0, fade, Math.max(fade, durationInFrames - fade), durationInFrames],
      [0, 1, 1, 0],
      { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
    );
  return (
    <AbsoluteFill style={{ opacity }}>
      <div
        style={{
          position: 'absolute',
          left: region.x,
          top: region.y,
          width: region.w,
          height: region.h,
        }}
      >
        {/* muted：動態沒有音軌（旁白來自講者影片），寫明白免得哪天模板加了音效偷偷混進成品 */}
        <OffthreadVideo
          src={staticFile(src)}
          muted
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </div>
    </AbsoluteFill>
  );
};

export const MotionOverlay: React.FC<{
  runs: MotionRun[];
  region: { x: number; y: number; w: number; h: number };
  /** 用 `srcLandscape` 那支。只出直式的版型不必給。 */
  landscape?: boolean;
}> = ({ runs, region, landscape }) => (
  <>
    {runs.map((run, idx) => {
      const src = landscape ? run.srcLandscape : run.src;
      // 該版型沒有對應的檔（例如只生了直式）就跳過，不要 render 出 404
      if (!src) return null;
      const { from, durationInFrames } = frameSpan(run.startSec, run.endSec);
      return (
        <Sequence key={`motion-${idx}`} from={from} durationInFrames={durationInFrames}>
          <Clip src={src} region={region} noTailFade={run.toEnd} />
        </Sequence>
      );
    })}
  </>
);
