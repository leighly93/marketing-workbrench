#!/bin/bash
# MiniMax 參數實測批次 —— 第三輪（2026-09-01）。純 TTS，不碰 HeyGen、不扣 HeyGen 點數。
# 三支合計約 300 字符 ≒ 0.11 元。voice 全部用 institution（三大法人）。
#
# 在工作副本根目錄執行（會使用付費 TTS，需另行授權）：
#   bash 90_系統/應用程式/scripts/tts-batch.sh
#
# 前兩輪結論：
#   TN (text_normalization)  → ✗ 年份／股號唸成整數。改用 --numfix（regex 轉中文），第二輪過關。
#   timbre_weights 混音       → ✗「聽起來很假」，淘汰。
#   停頓標記 <#x#>            → ✗ 1.0 倍「非常怪」、0.5 倍「超級怪」。**本輪只補最後一個對照就收掉。**
#   腔調候選字                → 沒意見，暫不進字典。
#   numfix + institution      → ✓「聲音可以」→ 使用者要求「有可能有一點點情緒嗎？」= 本輪主題。
set -e
APP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE_ROOT="$(cd "$APP_ROOT/../.." && pwd)"
cd "$APP_ROOT"
echo "工作目錄：$(pwd)"
echo "voice = institution（三大法人）"
echo ""

echo "──── ① 情緒 happy ────"
echo "   跟你說「聲音可以」的那支 (…textd…numfix…) 只差一個 emotion 欄位，其餘完全相同。"
node scripts/tts-ab.js --voice=institution --text=d --dict --trad-only --numfix --emotion=happy

echo ""
echo "──── ② 情緒 fluent ────"
echo "   另一個可能適合播報的值。happy 太over的話聽這支。"
node scripts/tts-ab.js --voice=institution --text=d --dict --trad-only --numfix --emotion=fluent

echo ""
echo "──── ③ 停頓標記的最後一個對照：同一段稿子，完全不加標記 ────"
echo "   text f 那四句是 Claude 寫的，本來就可能僵。這支若也怪 → 是稿子的問題，不是標記的問題。"
echo "   這支聽完，停頓標記這條路就結案（不管結果如何都不再調秒數）。"
node scripts/tts-ab.js --voice=institution --text=f --dict --trad-only

echo ""
echo "=== TTS BATCH DONE ==="
ls -lat "$WORKSPACE_ROOT"/90_系統/暫存/產線輸出/tts-ab/*.mp3 | head -5
