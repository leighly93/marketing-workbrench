#!/bin/bash
# ─────────────────────────────────────────────────────────────
#  把「每 10 分鐘從 GitHub 抓最新版」裝成 macOS 背景服務。
#
#   安裝：  bash scripts/install-autopull.sh
#   移除：  bash scripts/install-autopull.sh --uninstall
#   看狀態：launchctl list | grep marketing-video-autopull
#   看記錄：tail -f ~/Library/Logs/marketing-video-autopull.log
#   手動跑一次（不等排程）：bash scripts/auto-pull.sh && tail -5 ~/Library/Logs/marketing-video-autopull.log
#
#   ⚠️ 只裝在「公用電腦」。主機是編輯端，裝了會把你自己的修改判成
#      「未提交的本機修改」而一直略過 —— 不會壞，但那個記錄檔會很吵。
# ─────────────────────────────────────────────────────────────
set -e

LABEL="com.cmoney.marketing-video-autopull"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
APP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$(cd "$APP_ROOT/../.." && pwd)"
LOG="$HOME/Library/Logs/marketing-video-autopull.log"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✅ 已移除定時更新（記錄檔留著：$LOG）"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$LOG")"

cat > "$PLIST" <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$APP_ROOT/scripts/auto-pull.sh</string>
  </array>
  <!-- 每 600 秒（10 分鐘）跑一次 -->
  <key>StartInterval</key><integer>600</integer>
  <!-- 開機/登入後也立刻跑一次，不用等第一個 10 分鐘 -->
  <key>RunAtLoad</key><true/>
  <!-- ⚠️ launchd 的環境變數極簡，不給 PATH 的話 git／node 都找不到 -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST_END

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "✅ 定時更新已安裝"
echo "   專案：$PROJECT"
echo "   頻率：每 10 分鐘（開機也會跑一次）"
echo "   記錄：$LOG"
echo
echo "馬上驗證一次："
echo "   bash $APP_ROOT/scripts/auto-pull.sh && tail -5 $LOG"
