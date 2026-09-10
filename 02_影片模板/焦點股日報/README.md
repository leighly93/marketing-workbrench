# 焦點股日報

前台目前可選客製版。直式 1080×1920（9:16）、30 fps。

客製版使用藍色版型，以 1 秒開場卡呈現日期與標題，接續主播、字幕及截圖。標題會自然折行，字級維持不變。

另有保留中的「投廣套框版」實作：共用主播影片與字幕，改套籌碼K線外框並接片尾，沒有開場卡。這個變體目前未顯示在前台選項中；此處只說明既有實作。

## 看成品

目前尚未核對到可連結至正式工作紀錄的成品範例。

## 看素材

[客製版固定素材](../../共用素材/焦點股日報)：`intro-frame.jpg` 是開場底圖、`header-overlay.png` 是主段品牌圖層；目前背景音樂檔為 `BGM.mp3`，此模板的背景音樂是選配。

投廣變體使用[籌碼K線固定素材](../../共用素材/籌碼K線)中的 `frame.png`、`outro.mp4`、`bgm.wav`。

## 看實作

[客製版畫面](../../90_系統/應用程式/src/Focusstock/FocusstockComposition.tsx)、[時間軸](../../90_系統/應用程式/src/Focusstock/focusstock-timeline.ts)、[客製版素材準備](../../90_系統/應用程式/scripts/use-focusstock-assets.js)。

保留中的變體：[投廣套框版畫面](../../90_系統/應用程式/src/Focusstock/FocusstockAdComposition.tsx)、[投廣素材準備](../../90_系統/應用程式/scripts/use-focusstock-ad-assets.js)。

目前是整理過渡期，連結指向素材與程式的現有位置，後續搬移時會更新。[返回模板列表](../README.md)
