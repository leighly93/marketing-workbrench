# 執行資料

詞庫、配圖記憶、留言、修正紀錄與頁型樣本屬於本機正式資料，不隨公開 Git 傳送，也不是暫存。

`npm run init` 只在缺少時建立空結構：`pronounce.json`、`stock-names.json`、`shot-memory.json`、`messages.jsonl`、`corrections.jsonl` 與 `page-samples/page-types.json`。已有檔案不覆寫。

股票名稱可用現有 `npm run stocks` 更新（需網路）；已有詞庫或記憶應另行安全移交，不以空檔覆蓋。程式透過 `90_系統/paths.js` 定位；路徑與資料格式變更須有隔離測試。
