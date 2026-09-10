# 環境重建與 Adapter 契約

目標是讓新 Agent 拿到程式後能建立一致的開發環境、驗證修改，並知道原生出片還差哪些條件。開發容器與原生出片分開驗收；容器不代表私人資料備份，也不保證跨硬體輸出逐位元一致。

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

## 原生出片的觀測基準

[native-observed.json](../環境/native-observed.json) 記錄整理電腦的 OS、架構、Node、FFmpeg／ffprobe、Tesseract、Swift、Whisper 所用 Python／套件及 small 模型 SHA-256。沒有使用者路徑、主機名稱或憑證。

```bash
python3 90_系統/環境/native-environment.py --check
npm run doctor -- --production
```

第一個命令比對觀測值，有差異回傳非零；不會為了吻合舊機器而自動降版或安裝。第二個命令檢查目前選用工具是否可用。兩者都不驗證真實推論品質。

[Whisper 套件清單](../環境/whisper-macos-observed.txt) 固定此電腦已安裝的套件版本，是 **macOS 觀測清單，非跨平台解析或含雜湊的完整 lockfile**。需要嘗試原生重建時，使用相同 Python 版本的獨立 venv，再以 `python -m pip install -r 90_系統/環境/whisper-macos-observed.txt` 安裝，不能修改全機 Python。這條乾淨機安裝路徑尚未驗收；PyTorch／Numba 的 wheel 受 Python、OS、CPU 架構影響，不應直接拿到 Linux 安裝。

| 出片依賴 | 目前紀錄／契約 | 尚未固定或驗收的部分 |
| --- | --- | --- |
| Node／npm 套件 | `.node-version`、package-lock、容器基底 digest | 基底與套件的離線鏡像保存 |
| FFmpeg／ffprobe | 原生 CLI 版本觀測值 | 系統動態函式庫與乾淨機安裝配方 |
| Whisper | Python 與套件版本、small 模型指紋、zh、逐字時間 | wheel 雜湊鎖定、離線模型保存、實際轉錄回歸 |
| Tesseract | CLI 版本；doctor 檢查 chi_tra 存在 | 語言資料檔指紋及不同平台 OCR 結果比較 |
| Apple Vision | macOS／Swift 觀測值與版本化 Swift 原始碼 | 綁定 OS 框架，不能包入 Linux Docker；需原生驗收 |
| Remotion／字型 | npm lockfile 與 Git 內字型 | 瀏覽器下載與真實渲染驗收 |
| 外部 API | 設定範本與呼叫程式 | 服務版本／帳號能力不受 Docker 控制 |

Whisper small 模型不隨 Git 提供。觀測程式只檢查預設 `~/.cache/whisper/small.pt`，不下載模型；自訂快取需另外記錄。正式還原應先比对指紋，再以獨立測試資料執行轉錄。私人工作與詞庫仍須按 [工作與影片位置](工作與影片位置.md) 另行還原。

## OCR Adapter

入口：[ocr-engine.js](../應用程式/scripts/ocr-engine.js)。`OCR_ENGINE=tesseract|vision`，預設維持 Tesseract。未知引擎直接報錯。

- `ensure()`：檢查工具；Vision 可能編譯 Swift，不能當作完全無副作用的環境檢查。
- `ocrPage(image, options)`：回傳 `words`／`lines`；座標為左上角原點的像素，信心為 0–100。
- `ocrCrop(image, box, scale, extraArgs)`：回傳裁切辨識文字；舊 `extraArgs` 仍帶 Tesseract 語意，是既有介面限制。
- `ocrDigits(image)`：供三大法人編號定位，回傳至少含 `t/y/h` 的字框；Tesseract 保留 psm 10 與 1234 白名單，Vision 走整頁辨識。

呼叫端不直接啟動 OCR CLI。兩引擎雖有相同資料格式，能力與失敗策略尚不完全一致：部分 Vision 路徑失敗回傳空結果，Tesseract 可能拋錯；本輪保留原行為。更換引擎需比較頁型、框位、數字、人工滑動及記憶命中，不能宣稱同格式就能無損替換。

## 字幕 Adapter

入口：[transcription-engine.js](../應用程式/scripts/transcription-engine.js)。`TRANSCRIPTION_ENGINE=whisper`；目前只有這個供應者，沒有假裝實作其他服務。shell 負責抽音、影片時長及保存，Adapter 負責工具呼叫與輸出契約。

- `ensure()`：檢查 CLI 可用，不下載模型。
- `transcribe(audio, outputDir)`：回傳含 `segments` 的 JSON；段落有 `text/start/end/words`，逐字有 `word/start/end`，時間以秒表示。
- 保留原本 small、zh、word_timestamps 與裝置預設，保存原始 JSON；缺少逐字資料、非法時間或工具失敗即報錯，不更新正式字幕備份。
- 未知供應者直接失敗，不靜默回退。新增供應者須在 Adapter 正規化為相同契約，字幕校正與模板不接觸服務專用回應。

[引擎介面測試](../測試/引擎介面.test.js) 使用合成輸出驗證參數、資料契約與失敗傳遞，不呼叫實際 OCR 或 Whisper。若改模型／裝置／文字規則，須另做有代表性的獨立樣本回歸。

## 參考

- [Docker：固定基底 digest 與建置實務](https://docs.docker.com/build/building/best-practices/)
- [Claude Code：匯入共用指令](https://code.claude.com/docs/en/memory)
