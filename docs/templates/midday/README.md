# 盤中焦點

前台目前可選。直式 1080×1920（9:16）、30 fps。

以 1 秒開場卡呈現日期與標題，接續主播、字幕及截圖，主段保留品牌圖層。標題可換行，前台提供兩行、每行約 10 字的參考。

## 看成品

南亞科8月營收創高，股價怎麼翻黑？（本機資料）（工作 ID：`20260903-101641-ltbl`）。

## 看素材

[固定素材資料夾](../../../storage/shared-assets/midday)：`intro-frame.jpg` 是開場底圖、`header-overlay.png` 是主段品牌圖層、`bgm.wav` 是背景音樂。日期與稿件標題由程式疊上。

## 看實作

[畫面組合](../../../video/remotion/src/MiddayFocus/MiddayFocusComposition.tsx)、[時間軸](../../../video/remotion/src/MiddayFocus/midday-timeline.ts)、[版型設定與素材對照](../../../video/templates/registry.js)。

目前是整理過渡期，連結指向素材與程式的現有位置，後續搬移時會更新。[返回模板列表](../README.md)
