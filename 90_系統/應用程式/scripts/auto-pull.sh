#!/bin/bash
# ─────────────────────────────────────────────────────────────
#  公用電腦專用：每 10 分鐘從 GitHub 抓最新版。
#
#  這台機器是「唯讀端」—— 程式單向從主機流過來，不往回推。
#  安裝：  bash scripts/install-autopull.sh
#  移除：  bash scripts/install-autopull.sh --uninstall
#  看記錄：tail -f ~/Library/Logs/marketing-video-autopull.log
#
#  ⚠️ 兩道保險，缺一不可（都會「跳過這一輪」而不是硬幹）：
#    ① 正在出片（.run.lock 存在）→ 跳過。
#       render 到一半被抽換檔案，出來的東西會半新半舊、而且極難查。
#       跳過不會漏更新 —— 10 分鐘後的下一輪自然會補上。
#    ② 有未提交的本機修改 → 跳過並在記錄裡喊一聲。
#       這台照設計不該有本機修改；真的出現了，代表有人在這裡改了東西，
#       那是需要人來看的事，不是該被 git 默默蓋掉的事。
# ─────────────────────────────────────────────────────────────
set -u

APP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$(cd "$APP_ROOT/../.." && pwd)"
LOG="$HOME/Library/Logs/marketing-video-autopull.log"
mkdir -p "$(dirname "$LOG")"

say() { echo "$(date '+%F %T')  $*" >> "$LOG"; }

cd "$PROJECT" || { say "找不到專案資料夾 $PROJECT"; exit 1; }

# ── ① 正在出片就別動它 ──
if [ -e "$PROJECT/.run.lock" ]; then
  say "略過：.run.lock 存在（正在出片），下一輪再說"
  exit 0
fi

# ── ② 有本機修改就別蓋掉，喊一聲讓人來看 ──
dirty="$(git status --porcelain --untracked-files=no)"
if [ -n "$dirty" ]; then
  say "略過：有未提交的本機修改，需要人工處理 ↓"
  echo "$dirty" | sed 's/^/                       /' >> "$LOG"
  exit 0
fi

before="$(git rev-parse HEAD 2>/dev/null)"

# --ff-only：只接受快轉。萬一歷史對不上，寧可失敗也不要自動 merge 出一個
# 沒人看過的合併節點（那會讓「主機是唯一真相」這件事失效）。
if ! out="$(git pull --ff-only 2>&1)"; then
  say "拉取失敗 ↓"
  echo "$out" | sed 's/^/                       /' >> "$LOG"
  exit 1
fi

after="$(git rev-parse HEAD 2>/dev/null)"

if [ "$before" != "$after" ]; then
  say "已更新：${before:0:8} → ${after:0:8}"
  git log --oneline "$before..$after" 2>/dev/null | sed 's/^/                       /' >> "$LOG"
  # 素材是從 共用素材/ 複製到 public/ 的，共用素材/ 有變動就補跑一次，
  # 不然新的 BGM／套版圖不會生效（public/ 不進版控，pull 不會動到它）。
  if git -c core.quotepath=false diff --name-only "$before" "$after" | grep -q '^共用素材/'; then
    say "共用素材/ 有變動 → 補跑 use-*-assets"
    for t in dapan institution focusstock; do
      node "$APP_ROOT/scripts/use-$t-assets.js" >> "$LOG" 2>&1 || say "  ⚠️ use-$t-assets 失敗"
    done
  fi
fi

exit 0
