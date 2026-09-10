# Vision vs Tesseract 對照測試（隔離區，不影響產線）

## 這是什麼

測試把 OCR 引擎從 **Tesseract**（現況）換成 **Apple Vision**（macOS 內建）
值不值得。**只讀不寫，不碰產線任何檔案。**

## 保證不影響產線

- 不修改 `analyze-app-images.js`、`app-locator.js`、`analyze-institution-image.js`、`auto-shot.js`
- **不寫 `src/app-images.generated.json`**（出片流程讀的檔）
- 所有輸出都在 `scripts/_vision-trial/out/`
- 出片流程完全不知道這個資料夾存在

隨時想收手：整個 `scripts/_vision-trial/` 資料夾刪掉就好。

## 怎麼跑

必須在 **macOS 的 Terminal** 執行（Vision 是 macOS 框架，Claude 那邊的 Linux 環境跑不了）：

```bash
cd ~/Developer/marketing-video

# 先小規模試（跑 public/ 那幾張，最快）
node scripts/_vision-trial/compare.js --only public

# 沒問題再跑全部 91 張歷史截圖
node scripts/_vision-trial/compare.js
```

第一次會自動 `swiftc` 編譯 `ocr-vision.swift`，約 10 秒。

## 會看到什麼

終端機會印一張對照表：

```
檔案                    字框(T/V)   股名(T/V)   代號(T/V)   毫秒(T/V)
jobs/.../shot1.jpg      123 / 187   0 / 1       1 / 1       820 / 95
```

- **T** = Tesseract 現況，**V** = Apple Vision
- **股名／代號**：對 `90_系統/資料/stock-names.json` 官方表比對，數字越高越好
- **毫秒**：順便看速度差多少

另外產出兩個檔：

- `out/compare.json` —— 完整明細
- `out/fulltext.txt` —— 兩個引擎讀出來的全文並排，**這個最值得人眼看**
  （例如 Tesseract 讀成「華邦埋」、Vision 讀成「華邦電」，一眼就看得出來）

## 判讀

這一輪只回答「**讀字準不準**」。框得準不準（IoU）是下一階段的事，
因為那要重跑 `findCell()` 的整套邏輯，比較複雜。

如果股名／代號命中數沒有明顯提升，那就不用換，省下後面的功夫。

## 檔案

| 檔案 | 用途 |
|---|---|
| `ocr-vision.swift` | Vision OCR，輸出格式跟 `ocrPage()` 完全一致 |
| `compare.js` | 對照測試主程式 |
| `out/` | 測試結果（可隨時刪） |
