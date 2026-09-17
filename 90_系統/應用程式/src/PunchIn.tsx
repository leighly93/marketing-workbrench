import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';

/**
 * 重點句推鏡（2026-09-17 使用者定案）：標了字幕重點詞的那幾句，講者畫面推近一級。
 *
 * 規則刻意做得很簡單 —— 使用者：「有出現黃字就放大 HeyGen，如果前方有壓圖沒差」。
 * 所以**不看有沒有配圖**：截圖段是全螢幕蓋住講者的，那時推鏡在底下一格都看不到，
 * 等於沒作用，但也不會出錯，換來的是一條不用交叉判斷的規則。
 *
 * ⚠️ 畫質是明知的代價：HeyGen 來源就是成品尺寸，放大就是純上取樣，髮絲與皮膚紋理會軟掉，
 *    而且 avatar 的表情不會因為放大而改變（使用者：「放大一點模糊一點也還好反正都手機看」）。
 * ⚠️ 硬切不做過場動畫 —— 切點跟字幕換同一格，見 Subtitles.tsx 的 emphasisPunchSpans()。
 */
export const PUNCH = {
  /** 推近幅度。1.25 是實際拿 avatar 渲過比較的：構圖還在、臉明顯變大。 */
  scale: 1.25,
  /**
   * 縮放錨點。
   * 水平用畫面中心就好 —— 各 composition 的 `objectPosition` 已經把人物擺到中間，
   * 這裡再偏一次會把那個校正抵消掉。
   * 垂直 25% 偏上，推近時臉留在畫面上半、被裁掉的是下襬，跟人工剪的特寫同一個取景。
   * ⚠️ 換 avatar look 時要順便看一眼 —— 人物在來源畫面的高低不一樣，這個值可能要重量
   *   （跟 DapanComposition 的 objectPosition 同一組前提）。
   */
  origin: '50% 25%',
};

export const PunchIn: React.FC<{
  /** 要推近的時間區間（秒，相對這個 Sequence 的開頭） */
  spans: { start: number; end: number }[];
  children: React.ReactNode;
}> = ({ spans, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const on = spans.some((s) => t >= s.start && t < s.end);
  return (
    // ⚠️ 外層一定要 overflow:hidden —— 放大後的影片會溢出畫布，蓋到上面的 header bar。
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      <AbsoluteFill
        style={on ? { transform: `scale(${PUNCH.scale})`, transformOrigin: PUNCH.origin } : undefined}
      >
        {children}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
