# OCR 與配圖設定

2026-09-10 依現行程式核對。本文記錄已實作行為；引擎評估見研究報告（本機資料），舊路線圖的待辦不構成本次整理需求。

## 開關與預設

以下是程式未收到設定時的預設，**不是本機目前的生效值**；本次未讀取 `.env`。這些腳本啟動時載入根目錄 `.env`，不覆蓋程序原有的環境變數；設定於模組載入時讀取，既有程序不會自動重載。

| 設定 | 未設定時 | 已實作選項與作用 |
| --- | --- | --- |
| `OCR_ENGINE` | `tesseract` | `vision` 使用 Apple Vision；其他值會報錯，`vision+vlm` 尚未實作。 |
| `PAGE_RULES` | `v1` | `v2` 使用第二版頁型規則，並擴充個股／清單頁分類；不是 `v2` 的值走第一版。 |
| `SHOT_MEMORY` | `single` | `multi` 從同頁型的多筆框位挑選相似旁白；找不到或最高分平手，退回最新單筆框位。其他值走單筆模式。 |

OCR 共用入口為 [ocr-engine.js](../應用程式/scripts/ocr-engine.js)，供 APP 截圖、三大法人圖片與定位器使用。Tesseract 需要 CLI 與適用的語言資料；Vision 只支援 macOS，首次使用或 Swift 原始碼更新時嘗試以 `swiftc` 編譯。裁切辨識使用 `ffmpeg`；Vision 的裁切路徑不使用 Tesseract 的單行模式與字元白名單參數。

## 頁型與框位的分工

- [analyze-app-images.js](../應用程式/scripts/analyze-app-images.js) 從 OCR 文字判頁型、股名與代號，寫入 `src/app-images.generated.json`。頁型規則實際寫在程式的 `PAGE_SIGNATURES_V1/V2`；[頁型資料](../資料/README.md) 是整理依據，修改它不會自動更新辨識規則。
- [app-locators.json](../應用程式/scripts/app-locators.json) 的 `regions` 定義局部區域；辨識得出頁型，不代表已有對應框位規則。
- [auto-shot.js](../應用程式/scripts/auto-shot.js) 結合辨識結果、旁白、區域規則與配圖記憶，提供建議與配圖計畫。

`auto-shot.js` 預設只將人工標註寫入正式配圖計畫；`--with-auto` 才納入自動段。`--no-annots` 也會保留自動段，用於對照組，須以 `--out` 指向獨立檔案。人工滑動段的 `titleY` 仍可來自 OCR 的 `topicBox`，不能承諾換引擎完全不影響成品。

## 必須保留的資料

| 資料 | 用途 |
| --- | --- |
| [shot-memory.json](../資料/README.md) | 配圖會讀取的股名補充與框位記憶，包含 `codeNames`、`pages`、`pagesMulti`。 |
| [stock-names.json](../資料/README.md) | 官方股票簡稱表；學習函式不自動覆蓋已收錄的代號。 |
| [corrections.jsonl](../資料/README.md) | 人工修正與當時系統建議的對照紀錄；不是配圖記憶庫。 |
| [messages.jsonl](../資料/README.md) 與 [page-samples/](../資料/README.md) | 留言、頁型標記、樣本與分類資料；頁型標記的截圖存於 `_pinned/`。 |

[shot-memory.js](../應用程式/scripts/shot-memory.js) 的 `learn()` 不受 `SHOT_MEMORY` 開關控制：有可學的人工框位時，同時更新最新單筆 `pages` 與多筆 `pagesMulti`。框位存比例座標；同一框合併，每個記憶鍵最多 40 個框，每框最多 12 句旁白。**這是有容量限制的配圖記憶，不是完整製作歷史。** 完整工作仍須在正式專案資料中保留。

記憶鍵包含頁型與圖片長寬比；未知頁型另依是否有股票代號分組。改頁型規則或 OCR 可能改變鍵與命中結果，現行程式沒有自動重新學習或遷移機制，不應把舊文的「重學」解讀為可直接清空記憶。

服務記錄修正後才學習人工標註；這個順序讓對照建議使用學習前的記憶。學習時讀取該工作的圖片快照與標註，不應改讀可能已被下一支工作覆寫的共用產線資料。

## 驗證範圍

本次只核對程式與文件，未切換開關、執行 OCR 或出片。歷史研究數據不代表目前環境的重測結果。若後續要改辨識行為，應另用隔離樣本比較頁型、建議框與人工滑動結果，保留既有記憶與工作資料。
