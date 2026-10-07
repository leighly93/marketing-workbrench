# 啟動與驗證

本專案只以 macOS 作為服務與出片環境，不提供容器或 CI；交付前在本機執行 `npm run verify`。

版本基準與 OCR／字幕替換契約見 [環境與 Adapter](environment-and-adapters.md)。

## 取得乾淨環境

使用 `.nvmrc`／`.node-version` 指定的 Node.js 24.15.0；已安裝 nvm 時先執行 `nvm install`、`nvm use`。先確認 repository 根目錄，所有以下 npm 命令都從根執行。

```bash
npm run setup
npm run init
npm run build:web
npm run doctor
npm run verify
```

- `setup` 在 `` 執行 `npm ci`，依 lockfile 安裝，不在根目錄另建套件。npm 快取預設使用本副本 `.cache/npm/`，避免依賴全機快取權限；可用 `npm_config_cache` 自訂。
- `init` 只補缺少的設定、空詞庫、生成資料結構與工作目錄。新 `.env` 權限為 600，管理金鑰隨機產生且不印出；既有檔案逐字保留。
- `build:web` 用 Vite 把前台（`app/src`）建成 `app/dist`，伺服器直接供應這個資料夾；沒建的話網頁會回一頁「前台尚未建置」。改前台原始碼要重建（或開發時用 `npm run dev:web`，它會把 `/api` 代理到本機工作台）。正式機的 `server/deploy/auto-pull.sh` 拉到前台或 lockfile 變動會自動 `npm ci` 與重建，不需要重開伺服器。
- `doctor` 回報開發必要條件、出片工具及選用整合是否齊全，不顯示憑證值，也不驗證金鑰有效性。
- `verify` 先建置前台，再執行 TypeScript、隔離測試、Remotion 打包及臨時 HTTP 檢查（從 index.html 讀出帶 hash 的資源路徑逐一抓）。HTTP 使用空白副本、隨機本機 port，結束後清除；不啟動正式網站、不渲染影片、不呼叫外部 API。

## 模擬模式與端對端

`.env` 設 `WORKBENCH_MOCK=1` 後，整個工作台不呼叫付費 API，也不需要 whisper.cpp 或 tesseract：

| 階段 | 模擬方式 |
| --- | --- |
| MiniMax 配音 | ffmpeg 正弦波，長度依字數估（每秒 5 字） |
| HeyGen 講者 | ffmpeg 單色畫面，聲音用配音檔（文字驅動則依字數估長） |
| 字幕轉錄 | 把配音實際念的文字照字數平均攤在音檔長度上，之後照常跑字幕校正 |
| OCR | 讀不到任何字，截圖當成未知頁面 |
| 動態參數 | 有前台參數就用，否則用旁白開頭做一張固定 quote 卡 |

ffmpeg、加速、備份、字幕校正、配圖計畫與 Remotion 渲染都是真的。工作台頁首顯示「🧪 模擬模式」，模擬模式建立的工作帶 `mock: true`，關掉模擬模式後仍認得出來。成品內容是假的，不能發布。

```bash
npm run e2e                     # 隔離工作區 + 模擬工作台：建立 → 上傳 → 生成 → 配圖計畫 → 確認 → 渲染 → 下載
npm run e2e -- --template=dapan --keep
```

`e2e` 在暫存目錄複製程式（`tools/sandbox.js`），不碰正式工作、`video/remotion/public` 或 `.run.lock`。它會真的渲染，約數十秒到數分鐘，所以不在 `verify` 裡；`npm test` 只跑到配圖計畫（`video/tests/mock-pipeline.test.js`，需要 ffmpeg 與 bash）。模擬通過不代表外部 API、whisper 與 OCR 正常，正式驗收仍要在 macOS 上用真的供應者跑。

初始化的空字幕及配圖結構只讓程式可以載入。第一支真實工作會產生實際資料；尚未有講者影片時，不能把 Remotion 預覽當成已完成的影片。`init` 不還原任何私人影片、詞庫或製作歷史。

## 本機設定

`.env.example` 說明可設定項目，真實值只放根 `.env`。環境變數優先於 `.env`。不要把憑證貼進 issue、截圖或提交。

| 設定／工具 | 用途 |
| --- | --- |
| `HOST`、`PORT` | 預設 `127.0.0.1:4000`；需要區網存取時才將 HOST 設為 `0.0.0.0`，並確認防火牆與存取範圍 |
| `ADMIN_KEY` | 遠端管理金鑰；空值只允許本機管理。用 `?k=<金鑰>` 開一次網頁，伺服器改存 HttpOnly cookie 並轉回不含金鑰的網址 |
| `HEYGEN_API_KEY`、`MINIMAX_API_KEY`、`MINIMAX_GROUP_ID` | 新生成講者使用；沿用現成影片可略過此生成步驟 |
| FFmpeg／ffprobe | 音影片處理、時長與輸出規格 |
| whisper.cpp／Base Q5_1 | `npm run setup:whisper` 安裝；CPU、4 執行緒、中文，取代 Python Whisper |
| Python 3.12+、Xcode Command Line Tools | 本機工具建置；不需 PyTorch 或 Python Whisper |
| Tesseract 與 `chi_tra` 語言資料 | 預設截圖 OCR |
| Apple Vision、Swift 編譯器 | `OCR_ENGINE=vision` 時使用，限 macOS |
| Google 憑證、OpenAI／FAL 設定 | 選用截圖、實驗或整合，非基本驗證所需 |

`npm run doctor -- --production` 會將缺少的出片工具視為失敗。金鑰與模型、瀏覽器、帳號權限仍須在實際使用前確認；doctor 不會自動安裝系統套件或下載模型。OCR 行為見 [OCR與配圖設定](ocr-and-shots.md)。

```bash
npm run studio
```

開啟 `http://127.0.0.1:4000/`。啟動會載入該副本工作並更新狀態，不能指向正在整理或備份中的正式資料。既有內網網址、自動啟動腳本及正在使用的原副本，不會因安裝此版本而自動切換。

## 資料與公開交付

Git 收錄程式、lockfile、字型、共用品牌素材、模板預覽與現行說明。工作影片、備份、封存、產線產物、詞庫／記憶／留言及憑證保留本機；新 clone 的工作列表為空。

要移交私人工作，須另外安全複製 `storage/jobs/` 與 `storage/data/`，不能期待 Git 還原它們。先停止相關寫入並備份；完整 ID 與 `outputs[].archive` 相對路徑必須保持一致。詳見 [工作與影片位置](job-and-video-locations.md)。

`npm run check:release` 檢查目前 Git 追蹤的檔案與單檔大小；不取代人工 diff 審閱或完整歷史稽核。這個公開版本以新的根提交開始，不包含原私有專案歷史。原歷史與本機工作留在原電腦。

推送前在本機執行 `npm run verify` 與 `npm run check:release`。外部 API、正式媒體渲染與實際使用者操作仍屬另一次有授權的驗收。
