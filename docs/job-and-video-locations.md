# 工作與影片位置

每次製作是一筆 job，以完整 ID 定位；人看的資料集中在同一個工作資料夾。

```text
storage/jobs/
└── 日期_影片名稱_完整jobID/
    ├── portrait.mp4
    ├── landscape.mp4
    ├── script.txt
    ├── inputs/
    │   └── motion/        ← 動態小影片（可單獨下載）
    └── _meta/
        ├── job.json
        ├── state/
        └── backups/
```

只保留實際存在的影片與稿件，不替缺件建立空檔。同名再次輸出加 `(2)` 避免覆蓋；這不代表已有正式版本模型。

## 網頁如何找到影片

1. 服務掃描 [jobs](../storage/jobs/) 中各資料夾的 `_meta/job.json`，以內部完整 ID 建立對照。
2. 網頁從 `/api/jobs` 取得列表，再以 `/api/jobs/<ID>` 選取工作。目前列表仍只顯示最新 50 筆，全部 55 筆都保存在資料夾中。
3. 播放器沿用 `/api/jobs/<ID>/file/<輸出名稱>`；伺服器依該 job 的 `outputs[].archive` 取得其資料夾第一層的 MP4。輸出 API 名稱保持相容，例如 `output-dapan.mp4` 可對應 `portrait.mp4`。
4. 缺件只查同工作的製作輸出、縮圖、快照與素材，仍找不到回 404；不使用共用產線暫存的同名影片。

### inputs/motion

動態小影片 render 出來時是躺在**共用**工作區的 `video/remotion/public/motion-N-{p,l}.mp4`，下一支出片就被清掉。所以出片收尾會複製一份進 `inputs/motion/`，檔名換成看得懂的 `motion1_那段話的關鍵字_portrait.mp4`，成品頁列出來給人單獨下載（要自己重剪、或影片其他地方要重做時用得到）。

- 放在 `inputs/` 的**子目錄**是刻意的：重新出片與 `backupJobArtifacts` 那兩段都有 `isFile()` 過濾，子目錄自動被跳過 —— 新工作會自己重產，不需要繼承；備份也不必為可重產的東西佔空間。`stageJobInputs` 是唯一要另外排除的（它用 `copyRecursive`）。
- 每次出片收尾會先清掉整個目錄再寫。這支不再有動態時，上一次的檔不能留著 —— 成品頁會列出一支根本不在影片裡的素材，比沒有更糟。
- 檔名含中文關鍵字，所以前台的下載連結一定要 `encodeURIComponent`；伺服器端靠 `Content-Disposition` 的 RFC 5987 兩段式寫法讓中文檔名正確落地。

`archive` 欄位指正式影片引用，與 `archive/` 不同。`done` 只表示曾完成，不能證明影片仍在。

## 產線與備份

- [shared-assets](../storage/shared-assets/) 供多筆工作使用，製作時複製到程式工作區。
- 新輸出先寫 `storage/tmp/pipeline-output/`（本機資料），確認為當次產出後保存到該工作第一層，再更新 job 引用。
- 工作備份保存在該工作 `_meta/backups/`；獨立 CLI 沒有工作 ID 時寫入系統的 `backups/unassigned/`。
- 工作稿件、素材、成品、備份與快照不再依年代自動刪除；明確的管理者刪除工作操作仍會移除整筆工作。

## 重新出片

跑完或失敗的工作可以用同一份輸入再跑一次（`POST /api/jobs/<ID>/redo`，前台在工作頁的「重新出片」）。它建立一筆**新工作**，原本那支完全不動。

帶過去的東西：`script.txt`（含當時實際套用的發音詞庫段）、`inputs/` 全部（截圖與 `annotations.json` 的顯示範圍／黃框／箭頭）、講者影片（優先取 `inputs/heygen.mp4`，沒有就取 `_meta/state/public/heygen.mp4`），以及版型、語氣、品牌等旗標。

- 一律 `skipGenerate`：不呼叫 HeyGen／MiniMax，不重新扣點數。加速記號（mp4 comment tag）跟著檔案走，不會被重複加速。
- 新工作停在 `draft`，要在標注頁確認過才送出；`draft` 也開放標注編輯就是為了這一步。
- **稿件不給改**：`annotations.json` 以 `startCharIdx`／`endCharIdx` 對到稿件字元位置，改一個字後面的標注就整段錯位且不會報錯。要改稿請另開工作重畫。
- 缺稿件或講者影片會直接回 400 並說明缺什麼（功能上線前的舊工作可能沒有留製作快照）。

工具用途、操作流程與資料夾導覽見根目錄 [README](../README.md)；介紹簡報也位於根目錄。
