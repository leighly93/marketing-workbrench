#!/usr/bin/env bash
# 從 HeyGen 影片自動產生字幕 JSON
#
# 用法：./scripts/transcribe.sh [--pad=秒數]
#   --pad=0.5 → 抽出來的音檔前面墊 0.5 秒靜音再轉，時間戳由 Adapter 自動減回去。
#     只有「字幕時間軸被判定壞掉、要重轉」時才用（見 run.js transcribeWithRetry）。
#     為什麼有效：whisper 是分 30 秒 window 解碼的，墊靜音會讓 window 邊界落在不同位置，
#     避開它在某些切點上的解碼失敗。同一個音檔原樣重跑是確定性的（跑三次結果完全相同），
#     不墊就等於再壞一次。
#     ⚠️ 沒有「一定有效」的 pad 值：2026-09-18 實測 6 支音檔 × 8 個 pad，壞掉的值逐支不同
#     （有的只有 pad 0 壞、有的是 0.5 與 1.2 壞）。所以 run.js 會依序試幾個間距拉開的值，
#     這裡只負責照指定秒數墊。
# 前置需求（Mac）：
#   brew install ffmpeg
#   版本與環境規格見 90_系統/維護說明/環境與Adapter.md

set -euo pipefail

PAD_SEC=0
for arg in "$@"; do
  case "$arg" in
    --pad=*) PAD_SEC="${arg#--pad=}" ;;
    *) echo "❌ 不認得的參數：$arg（只吃 --pad=秒數）"; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE_ROOT="$(cd "$ROOT/../.." && pwd)"
INPUT="$ROOT/public/heygen.mp4"
OUTRO="$ROOT/public/outro.mp4"
TMP_DIR="$WORKSPACE_ROOT/.cache"
TMP_AUDIO="$TMP_DIR/heygen.wav"
OUTPUT_DIR="$ROOT/src"
OUTPUT_JSON="$OUTPUT_DIR/subtitles.json"
BACKUP_JSON="$OUTPUT_DIR/subtitles.original.json"
META_JSON="$OUTPUT_DIR/video-meta.json"

if [ ! -f "$INPUT" ]; then
  echo "❌ 找不到 $INPUT — 請先把 HeyGen 影片放到 public/heygen.mp4"
  exit 1
fi

# 檢查必要的指令
missing=()
command -v ffmpeg  >/dev/null 2>&1 || missing+=("ffmpeg (brew install ffmpeg)")
command -v ffprobe >/dev/null 2>&1 || missing+=("ffprobe (brew install ffmpeg)")
node "$ROOT/scripts/transcription-engine.js" --check || missing+=("字幕 Adapter（見環境與Adapter.md）")

if [ ${#missing[@]} -gt 0 ]; then
  echo "❌ 缺少以下工具，請先安裝："
  for m in "${missing[@]}"; do echo "   - $m"; done
  echo ""
  echo "裝完後請『關掉終端機重開』讓 PATH 生效，再執行此腳本"
  exit 1
fi

mkdir -p "$TMP_DIR"

echo "▶ 1/4 用 ffprobe 偵測影片時長..."
HEYGEN_DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$INPUT")
HEYGEN_ROUNDED=$(printf "%.2f" "$HEYGEN_DURATION")

# 結尾影片是選配；若存在就偵測秒數，沒放就當 0
if [ -f "$OUTRO" ]; then
  OUTRO_DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUTRO")
  OUTRO_ROUNDED=$(printf "%.2f" "$OUTRO_DURATION")
  echo "   → 偵測到 heygen.mp4 $HEYGEN_ROUNDED 秒、outro.mp4 $OUTRO_ROUNDED 秒"
else
  OUTRO_ROUNDED="0"
  echo "   → 偵測到 heygen.mp4 $HEYGEN_ROUNDED 秒（無 outro.mp4，跳過）"
fi

cat > "$META_JSON" <<EOF
{
  "heygenDurationSec": $HEYGEN_ROUNDED,
  "outroDurationSec": $OUTRO_ROUNDED,
  "_note": "此檔由 npm run transcribe 自動寫入；手動編輯會在下次 transcribe 時被覆蓋"
}
EOF
echo "   → 已寫入 src/video-meta.json"

if [ "$PAD_SEC" = "0" ]; then
  echo "▶ 2/4 用 ffmpeg 從影片抽出音檔..."
  ffmpeg -y -i "$INPUT" -ar 16000 -ac 1 -c:a pcm_s16le "$TMP_AUDIO" -loglevel error
else
  # 用 awk 不用 python3：這一行是「字幕壞掉要重轉」時才跑的，
  # 不該因為少一個直譯器就連救都救不了（awk 在 macOS 一定有）。
  PAD_MS=$(awk "BEGIN { printf \"%d\", $PAD_SEC * 1000 + 0.5 }")
  echo "▶ 2/4 用 ffmpeg 從影片抽出音檔（前面墊 ${PAD_SEC} 秒靜音，換一個 whisper window 邊界）..."
  ffmpeg -y -i "$INPUT" -af "adelay=${PAD_MS}|${PAD_MS}" -ar 16000 -ac 1 -c:a pcm_s16le "$TMP_AUDIO" -loglevel error
fi

echo "▶ 3/4 跑 whisper.cpp 轉字幕（中文，Base Q5_1，CPU／4 執行緒）..."
node "$ROOT/scripts/transcription-engine.js" "$TMP_AUDIO" "$TMP_DIR" "--pad=$PAD_SEC"

echo "▶ 4/4 整理輸出到 src/subtitles.json..."
# Adapter 正規化的輸出檔名跟輸入相同：heygen.json
cp "$TMP_DIR/heygen.json" "$OUTPUT_JSON"
# 同步覆寫 raw 備份，讓 correct-subtitles 出包時可還原到本次新的 Whisper 輸出
# （否則舊版備份會卡住，重 transcribe 也救不回來）
cp "$TMP_DIR/heygen.json" "$BACKUP_JSON"

echo ""
echo "✅ 完成！"
TOTAL=$(python3 -c "print(f'{$HEYGEN_ROUNDED + $OUTRO_ROUNDED:.2f}')" 2>/dev/null || echo "$HEYGEN_ROUNDED+$OUTRO_ROUNDED")
echo "   時長  → $META_JSON (heygen $HEYGEN_ROUNDED + outro $OUTRO_ROUNDED = $TOTAL 秒)"
echo "   字幕  → $OUTPUT_JSON"
echo "   現在打開 Remotion Studio 就能看到字幕 + 正確時長"
