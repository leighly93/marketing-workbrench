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
- `transcribe(audio, outputDir)`：把 whisper.cpp 的毫秒 `transcription/tokens` 轉成既有秒制 `segments/words`，剔除引擎控制 token。
- 中文的 `words` 實際為引擎 token 粒度，不宣稱等同語言學分詞；字幕校正沿用既有介面。
- 每次轉錄使用獨立暫存目錄。工具失敗、缺少時間或格式錯誤不覆寫上次輸出；驗證後才保存正規化 JSON。
- shell 仍負責抽音、影片時長與正式字幕備份。引擎換成 Base Q5_1 會影響辨識與時間結果，不能視為 small 模型的等價輸出。

[引擎介面測試](../測試/引擎介面.test.js) 驗證 CPU／執行緒參數、時間轉換、控制 token、失敗保護及 Node 版本一致性。一般 verify 不執行模型；本機推論以獨立合成音訊驗證，不重跑正式工作。

## 參考

- [Docker：固定基底 digest 與建置實務](https://docs.docker.com/build/building/best-practices/)
- [Claude Code：匯入共用指令](https://code.claude.com/docs/en/memory)
- [whisper.cpp CLI 原始碼與輸出契約](https://github.com/ggml-org/whisper.cpp/blob/371b5a7561823ab2bb32142d2751e35e7534727b/examples/cli/cli.cpp)
