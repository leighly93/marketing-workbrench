import { Config } from '@remotion/cli/config';

// 渲染影像格式（jpeg 較快、png 較佳品質）
Config.setVideoImageFormat('jpeg');

// 每次 render 覆寫舊輸出
Config.setOverwriteOutput(true);

// 所有版型共用的交付參數（原本重複寫在每一條 render:* 指令）。
// 同時處理 3 格：M1 上比 2 格快約 15–20%。
Config.setConcurrency(3);
Config.setDelayRenderTimeoutInMilliseconds(300000);
Config.setCrf(23);
Config.setAudioBitrate('128k');

// Remotion 專案放在 video/remotion，但 npm 命令從 repository 根執行（package.json 在根目錄）。
// 路徑相對於 repository 根。
Config.setEntryPoint('video/remotion/src/index.ts');
Config.setPublicDir('video/remotion/public');
