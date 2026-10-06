# 系統與開發入口

先讀[整理狀態](STATUS.md)，只按目前任務查閱需要的文件。

整個 repository 是單一 npm package：`package.json`、`package-lock.json`、`tsconfig.json` 與 `node_modules/` 都在根目錄，所有 `npm run` 命令都從根目錄執行。程式依職責分成三塊，各自帶著自己的測試。

| 位置 | 職責 |
| --- | --- |
| [app](../app/) | 工作台網頁前台（HTML／CSS／JavaScript），由 server 直接提供 |
| [server](../server/) | 工作台 API（`index.js`、`start.js`）；`deploy/` 放 macOS 自動啟動、自動更新與內網名稱設定 |
| [video](../video/) | 出片：`run.js` 主流程、`templates/` 版型設定表與解析／素材／渲染、`subtitles/` 轉錄與字幕校正、`shots/` OCR 與配圖判定、`pipeline/` 其餘產線腳本（動態、素材暫存等）、`remotion/` 的模板（`src/`）與執行素材（`public/`） |
| [shared](../shared/) | 三塊共用的 `paths.js`（路徑解析）與 `job-store.js`（依完整 job ID 找工作資料夾） |
| [tools](../tools/) | init、doctor、verify、release-check；`whisper/` 安裝字幕引擎；`experiments/` 放試聽、A/B 與 OCR 比較等實驗工具 |
| [storage](../storage/) | 資料：`jobs/` 工作、`shared-assets/` 品牌素材（進 Git）、`data/` 詞庫與記憶、`tmp/` 產線暫存、`archive/` 封存 |
| [docs](.) | 維護說明、[模板導覽](templates/README.md)與[第三方授權](licenses/README.md) |

測試用 Vitest：單元測試放在程式旁邊（`foo.js` ↔ `foo.test.js`），跨模組的整合測試放在各區的 `tests/`。前台測試在檔案開頭加 `// @vitest-environment jsdom`。`npm test` 跑全部、`npm run test:coverage` 產生覆蓋率報告（`storage/tmp/coverage/`），`npm run verify` 另外做 typecheck、Remotion 打包與隔離 HTTP 檢查。

版型（composition、輸出檔名、素材、主播與聲音、標題規則）只在 [video/templates/registry.js](../video/templates/registry.js) 設定；新增版型＝加一筆設定＋寫 Remotion composition。手動執行：`npm run template -- <assets|parse|render> --template=<版型>`。

後端 JavaScript 用 JSDoc 標型別：檔案開頭有 `// @ts-check` 的由 `tsconfig.checkjs.json` 檢查（verify 會跑），新拆出的模組一律加上。

Remotion 只在 `package.json` 那一層找 `tsconfig.json`，所以它留在根目錄；設定檔 `video/remotion/remotion.config.ts` 透過 `--config` 指定，並在裡面宣告入口與 `public/` 位置。

工作與影片的對應見[工作與影片位置](job-and-video-locations.md)。環境與驗證按[啟動與驗證](setup-and-verify.md)完成 setup、init、doctor、verify；引擎介面與版本觀測見[環境與 Adapter](environment-and-adapters.md)。
