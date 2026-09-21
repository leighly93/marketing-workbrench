# 環境重建與 Adapter 契約

目標是讓新 Agent 拿到程式後能建立一致的開發環境、驗證修改，並知道原生出片還差哪些條件。服務與出片只面向 macOS；Linux 容器只作 CI 程式驗證。開發容器與原生出片分開驗收；容器不代表私人資料備份，也不保證跨硬體輸出逐位元一致。

## Agent 入口

根目錄 [AGENTS.md](../../AGENTS.md) 是共用規則；[CLAUDE.md](../../CLAUDE.md) 使用 `@AGENTS.md` 匯入。技術細節只按任務讀取，不把歷史、封存或全部工作載入 context。完成修改時更新有效決策，不累積對話日誌。

## 可重建的開發環境

[Dockerfile](../環境/Dockerfile) 固定 Node 24.15.0、Debian bookworm 基底的內容 digest，npm 依應用程式 lockfile 安裝。容器以非 root 使用者執行，初始化空工作資料；不包含 FFmpeg、Whisper、Tesseract、Apple Vision 或模型。

在 repository 根目錄執行（需自行具備 Docker）：

```bash
git archive HEAD | docker build -f 90_系統/環境/Dockerfile -t workbench-verify -
docker run --rm --network none workbench-verify
```

建置使用 **HEAD 已提交版本**，未提交修改不會進入映像。這個入口不傳送本機 `.env`、工作目錄、舊 Git 歷史或模型；不掛載主機資料、不暴露服務 port。建置需要網路取得基底與 npm 套件，驗證容器不需要外網。日常未提交修改先用本機 `npm run verify` 驗證，再由 CI 建置提交版本。

這固定的是開發環境配方與套件版本；上游映像／套件仍須可取得。需要離線長期保存時，另保存完成映像及其 digest。基底安全更新須透過獨立提交更新 digest 並重跑驗證，不能把固定版本當作永不更新。

## macOS 本機環境

`.nvmrc` 與 `.node-version` 都是 24.15.0，與容器相同；本機先 `nvm install`、`nvm use`。doctor 檢查精確版本，測試防止三處漂移。nvm 本身需預先安裝。

字幕工具用 [whisper-cpp.json](../環境/whisper-cpp.json) 固定原始碼提交、原始碼 SHA-256、模型下載 revision 與 SHA-256；模型為 `ggml-base-q5_1.bin`。安裝只寫入本專案 `.cache/whisper-cpp/`：

```bash
npm run setup:whisper
npm run doctor -- --production
```

需要 Python 3.12+ 與 Xcode Command Line Tools。安裝腳本建立獨立 venv 安裝固定 CMake 版本，驗證下載雜湊後編譯 CPU 引擎（關閉 Metal／Core ML／CUDA），不修改全機 Python，不安裝 Python Whisper 或 PyTorch。安裝需要網路，辨識不需要。CMake 的平台套件未鎖 wheel 雜湊，Xcode／SDK 仍依本機條件；這不是所有原生函式庫逐位元固定的環境映像。

預設使用專案內的 whisper-cli 與模型。可用 `WHISPER_CPP_BIN`、`WHISPER_CPP_MODEL` 指定其他位置，但需自行核對版本；模型相對路徑以 repository 根解析。`TRANSCRIPTION_ENGINE` 預設 `whisper-cpp`，舊 `.env` 若明確設為 `whisper`，必須改為 `whisper-cpp`，不會靜默沿用舊引擎。

[native-observed.json](../環境/native-observed.json) 記錄這台 macOS、架構、Node、FFmpeg／ffprobe、Tesseract、Swift、whisper-cli 與模型指紋；不記錄憑證或使用者路徑。比對工具只讀取專案預設安裝位置：

```bash
python3 90_系統/環境/native-environment.py --check
```

差異回傳非零，不自動降版。FFmpeg、OCR 語言資料、Swift／SDK、Remotion 瀏覽器與外部 API 仍需各自驗收；Node 一致不代表所有作業系統行為一致。原生完整乾淨機還原與正式成品回歸尚未驗收。私人資料另按 [工作與影片位置](工作與影片位置.md) 還原。

## OCR Adapter

入口：[ocr-engine.js](../應用程式/scripts/ocr-engine.js)。`OCR_ENGINE=tesseract|vision`，預設維持 Tesseract。未知引擎直接報錯。

- `ensure()`：檢查工具；Vision 可能編譯 Swift，不能當作完全無副作用的環境檢查。
- `ocrPage(image, options)`：回傳 `words`／`lines`；座標為左上角原點的像素，信心為 0–100。
- `ocrCrop(image, box, scale, extraArgs)`：回傳裁切辨識文字；舊 `extraArgs` 仍帶 Tesseract 語意，是既有介面限制。
- `ocrDigits(image)`：供三大法人編號定位，回傳至少含 `t/y/h` 的字框；Tesseract 保留 psm 10 與 1234 白名單，Vision 走整頁辨識。

呼叫端不直接啟動 OCR CLI。兩引擎雖有相同資料格式，能力與失敗策略尚不完全一致：部分 Vision 路徑失敗回傳空結果，Tesseract 可能拋錯；本輪保留原行為。更換引擎需比較頁型、框位、數字、人工滑動及記憶命中，不能宣稱同格式就能無損替換。

## 字幕 Adapter

入口：[transcription-engine.js](../應用程式/scripts/transcription-engine.js)，執行 `whisper-cli`。固定 Base Q5_1、`--no-gpu`、`--threads 4`、`--processors 1`、`--language zh`，使用 `--output-json-full` 取得 token 時間。

- `ensure()`：檢查 CLI 與模型存在，不下載。
- `transcribe(audio, outputDir, { padSec })`：把 whisper.cpp 的毫秒 `transcription/tokens` 轉成既有秒制 `segments/words`，剔除引擎控制 token。`padSec` 是「這個音檔前面墊了幾秒靜音」，輸出時間戳整體減回去（負值夾成 0），寫進磁碟的也是減回之後的。
- 中文的 `words` 實際為引擎 token 粒度，不宣稱等同語言學分詞；字幕校正沿用既有介面。
- 每次轉錄使用獨立暫存目錄。工具失敗、缺少時間或格式錯誤不覆寫上次輸出；驗證後才保存正規化 JSON。
- shell 仍負責抽音、影片時長與正式字幕備份。引擎換成 Base Q5_1 會影響辨識與時間結果，不能視為 small 模型的等價輸出。

### 時間軸失效與重轉

whisper 分 30 秒 window 解碼，會在某些切點把一句話的結束時間報過頭；之後整條時間軸往後偏，音檔時間用完時稿件還剩一段沒有時間可放，全部掛到最後一顆 word（成品是字幕上到一半停住、最後一瞬間閃過）。

- **同一個音檔是確定性的**：同輸入連跑三次輸出完全相同，原樣重轉必定再失敗一次。改 `--beam-size`、`--threads`、`--max-len` 都無效。
- 唯一實測有效的是在音檔前墊靜音換 window 邊界：`scripts/transcribe.sh --pad=秒數` 用 ffmpeg `adelay` 墊，並把秒數傳給 Adapter 減回去；影片時長仍量原始 mp4，不受影響。
- [correct-subtitles.js](../應用程式/scripts/correct-subtitles.js) 在寫回前判定時間軸：字擠成一團、或 segment 秒數對不上字數就 `exit 3` 並不寫回。[run.js](../應用程式/run.js) 的 `SUBTITLE_PAD_LADDER` 據此重轉，第一次一律不墊（維持既有結果），之後每次墊不同秒數。目前是 `[0, 0.8, 1.5, 2.5]`＝最多轉四次。

- 秒數不是隨便挑的：間距拉開比多塞近似值有用（0.3 與 0.5 會落在同一個壞點附近）。實測有一支 pad 0.5 只轉出 267 字、pad 0.8 一次就拿到完整的 279 字。
- 跑滿四階約 15 秒（單次轉錄約 3.6 秒），不值得為了省這 15 秒，把一支已經扣過 HeyGen 點數的片停在出片前。
- 四次都壞就停在出片前要求人工介入。**這種情況不要按「重新出片」** —— whisper 是確定性的，同一支配音會再走一次一模一樣的四個 pad、得到一模一樣的四次失敗。要救就得換一支配音（改稿件斷句讓配音節奏不同）。
- 實測無效、不要再試的路：`-mc 0`（取消跨 window 的 context 帶入）反而更糟，只轉出 202 字、結尾提早 8 秒。

[引擎介面測試](../測試/引擎介面.test.js) 驗證 CPU／執行緒參數、時間轉換、控制 token、失敗保護及 Node 版本一致性。[字幕時間軸測試](../測試/字幕時間軸.test.js) 驗證墊靜音的時間戳還原、三種時間軸判定與重轉階梯。一般 verify 不執行模型；本機推論以獨立合成音訊驗證，不重跑正式工作。

## 動態小影片 Adapter

入口：[motion-engine.js](../應用程式/scripts/motion-engine.js)。前台只讓人在腳本上選一段文字，卡片參數由後端產生；[render-motion.js](../應用程式/scripts/render-motion.js) 只呼叫 `plan()`，不自己碰任何供應者。

- `MOTION_ENGINE` 切換後端：`claude-cli`（預設，跑 `claude -p`，用訂閱不需要 API key）／`manual`（只吃前台貼好的 spec，不呼叫任何服務）／`api`（保留，未實作）。
- 驗證**只拒絕不修正**：template 不在三種之內、list 少於兩項、contrast 沒有否定項，一律回 `null`。回 `null` 等於「這段不做動態」，呼叫端必須能接受 —— 與其送半對的參數進 render，不如不做。
- 失敗一律降級成「這支沒有動態」，不擋出片。失敗兩次才放棄（`ENOENT` 不重試）。

### 哪些版型有動態

`render-motion.js` 的 `TEMPLATE_MOTION` 決定「這個版型出幾支、安全區在哪」，`run.js` 與 `doRender` 都會把 `--template=` 傳進去。

| 版型 | 出幾支 | 安全區 |
| --- | --- | --- |
| 大盤小報 `dapan` | 直式＋橫式 | 直 y310–1440／橫 y0–918 |
| 盤中焦點 `midday` | 只有直式 | y310–1440 |
| 美股焦點 `usstock` | 只有直式 | y325–1440（招牌膠囊比較高） |
| 其他 | 只有直式（並留一行提示） | 預設 y310–1440 |

- **只有大盤小報有橫式輸出**，其餘版型硬產一支橫式是白花十秒、白佔 1.3MB。不認得的版型一律只出直式：少一支橫式只是沒有，多一支是每次出片都白等，代價不對稱。
- `safeTop` 直接沿用各 composition 自己那個量過的值（招牌實心到 y 幾：焦點股 267／三大法人 278／盤中焦點 291／大盤小報 303／美股焦點 307），動態要避開的東西跟截圖黃框完全一樣，沒有理由另立一套。`safeBottom` 全部相同 —— 直式版型共用 `Subtitles.tsx`，字幕一律從 y1440 起。
- 要接新版型：`TEMPLATE_MOTION` 加一筆、該 composition 掛一個 `<MotionOverlay>`、測試的版型檔案表補一行。測試會檢查兩邊的 `safeTop` 一致，也會擋「登記了卻沒貼上去」（那會每次 render 出 mp4 然後沒人用，完全沒有錯誤訊息）。
- 三大法人尚未接（使用者定案那類內容用真實 App 畫面呈現），焦點股與其投廣版也還沒接。

### 背景服務要有 CLAUDE_CODE_OAUTH_TOKEN

`claude` 的憑證放在 macOS login keychain，**出片服務讀不到**，只會得到 `Not logged in · Please run /login`，於是每支影片都靜默沒有動態。

- 解法是 `.env` 的 `CLAUDE_CODE_OAUTH_TOKEN`，由 `claude setup-token` 產生（吃訂閱，不是 API key，效期一年）。`server/start.js` 用 dotenv 載進 `process.env`，`execFileSync` 與 spawn 出去的 `run.js` 都繼承，因此與 keychain、security session、服務啟動方式都無關。
- **在終端互動使用時不需要它**，所以「自己跑得動」不能當成「服務跑得動」的證據。要驗證就清掉環境裡的 `CLAUDE*`／`ANTHROPIC*` 再跑：`env -i HOME=… PATH=… CLAUDE_CODE_OAUTH_TOKEN=… claude -p …` 應回 `is_error=false`。
- `setup-token` 印出的 token 在終端會折行，滑鼠拖選容易只抓到半截；完整長度是 108 字元、`sk-ant-oat01-` 開頭，長度不對就會是 401。

### 失敗要看得到原因

`--output-format json` 的 claude 失敗（用量上限、登入過期）是把原因寫在 **stdout** 的 JSON 裡，stderr 留空、1 秒內非零退出。只看 stderr 的話，只會拿到 Node 的 `Command failed: claude -p …` 整條命令列，看起來像旗標有問題，其實無關。`describeFailure()` 按 stdout JSON → stdout 純文字 → stderr → signal → 結束碼的順序取訊息，服務端呼叫的輸出也一律寫進工作 log —— 這條路沒有人在看終端。

[動態小影片測試](../測試/動態小影片.test.js) 驗證參數契約、時間定位與失敗降級；不呼叫 `claude`。

## 參考

- [Docker：固定基底 digest 與建置實務](https://docs.docker.com/build/building/best-practices/)
- [Claude Code：匯入共用指令](https://code.claude.com/docs/en/memory)
- [whisper.cpp CLI 原始碼與輸出契約](https://github.com/ggml-org/whisper.cpp/blob/371b5a7561823ab2bb32142d2751e35e7534727b/examples/cli/cli.cpp)
