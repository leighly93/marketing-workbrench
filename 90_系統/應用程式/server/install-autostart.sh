#!/bin/bash
# ─────────────────────────────────────────────────────────────
# 把出片前台裝成 macOS 背景服務。
#
#   為什麼要裝：同事 13:30 要用，你不能每天記得開終端機。
#   裝完之後：伺服器自己起來，關終端機也不會停。
#             服務跑著的時候 Mac 不會進睡眠（caffeinate），
#             不然睡著了同事一樣連不進來。
#
# 兩種裝法，差別很大：
#
#   ① LaunchAgent（預設，舊的做法）
#      住在登入階段（gui/<uid>）。**螢幕一關就不可靠** ——
#      2026-09-11 實測：螢幕 17:19 關掉、服務 17:32 崩潰，launchd 只記了
#      `pending spawn, domain in on-demand-only mode` 就無限期延後，
#      KeepAlive 完全沒作用，停機 35 分鐘直到人工 kickstart。
#      連 RunAtLoad 都不會觸發 → 重開機沒人登入的話根本不會啟動。
#      只適合「你人在電腦前、螢幕亮著」的臨時用途。
#
#   ② LaunchDaemon（--daemon，同事會用到就選這個）
#      住在系統層（system），不綁登入階段、不管螢幕開關、不管有沒有人登入。
#      要 sudo。以 UserName 用你的帳號跑，工作資料的擁有者不會變成 root。
#
#   安裝為系統服務（建議）：sudo bash 90_系統/應用程式/server/install-autostart.sh --daemon
#   安裝為登入階段服務    ：bash 90_系統/應用程式/server/install-autostart.sh
#   移除（兩種都清）      ：sudo bash 90_系統/應用程式/server/install-autostart.sh --uninstall
#   看狀態：launchctl list | grep marketing-video
#   看記錄：tail -f ~/Library/Logs/marketing-video-studio.log
#
# ⚠️ 這台 FileVault 是開的：重開機後磁碟要有人在開機畫面輸入密碼才會解鎖，
#    在那之前**任何**服務（含 LaunchDaemon）都起不來。--daemon 解決的是
#    「解鎖之後沒人登入／螢幕關著」，不是「完全無人值守的冷開機」。
# ─────────────────────────────────────────────────────────────
set -e

LABEL="com.cmoney.marketing-video-studio"
AGENT_PLIST_NAME="$LABEL.plist"
DAEMON_PLIST="/Library/LaunchDaemons/$LABEL.plist"
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
# workspace 根（repo 根）＝ 程式根的上兩層；.env 在那裡。
WORKSPACE="$(cd "$PROJECT/../.." && pwd)"

# 這個腳本可能被 sudo 起來，「使用者」要指 SUDO_USER 而不是 root。
TARGET_USER="${SUDO_USER:-$(id -un)}"
TARGET_HOME="$(dscl . -read "/Users/$TARGET_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
[ -n "$TARGET_HOME" ] || TARGET_HOME="$HOME"
TARGET_UID="$(id -u "$TARGET_USER")"
AGENT_PLIST="$TARGET_HOME/Library/LaunchAgents/$AGENT_PLIST_NAME"
LOG="$TARGET_HOME/Library/Logs/marketing-video-studio.log"

# 顯示用的 port。真正生效的是 .env（見下面 EnvironmentVariables 的註解）。
PORT_SHOWN="$(sed -n 's/^[[:space:]]*PORT=\([0-9][0-9]*\).*/\1/p' "$WORKSPACE/.env" 2>/dev/null | tail -1)"
[ -n "$PORT_SHOWN" ] || PORT_SHOWN="${PORT:-4000}"

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "❌ $1 需要系統權限。請改成："
    echo ""
    echo "   sudo bash \"$PROJECT/server/install-autostart.sh\" $2"
    echo ""
    exit 1
  fi
  if [ "$TARGET_USER" = "root" ]; then
    echo "❌ 抓不到原本的使用者（SUDO_USER 是空的）。"
    echo "   請用一般帳號執行 sudo，不要先 su 成 root。"
    exit 1
  fi
}

# 找 node。sudo 之後 root 的 PATH 跟你不一樣，所以要退回去用你的登入環境找。
find_node() {
  local n
  n="$(command -v node || true)"
  if [ -z "$n" ] && [ "$(id -u)" -eq 0 ]; then
    n="$(sudo -u "$TARGET_USER" -H bash -lc 'command -v node' 2>/dev/null || true)"
  fi
  # 舊的 agent plist 裡就有一份驗證過的路徑，拿來當最後退路。
  if [ -z "$n" ] && [ -f "$AGENT_PLIST" ]; then
    n="$(sed -n 's|.*<string>\(/[^<]*/node\)</string>.*|\1|p' "$AGENT_PLIST" | head -1)"
  fi
  echo "$n"
}

remove_agent() {
  launchctl bootout "gui/$TARGET_UID/$LABEL" 2>/dev/null || true
  if [ -f "$AGENT_PLIST" ]; then
    mv "$AGENT_PLIST" "$AGENT_PLIST.disabled"
    echo "   ↳ 舊的 LaunchAgent 已停用並改名為 $AGENT_PLIST_NAME.disabled"
    echo "     （兩份同時跑會搶同一個 port，一定要拆掉其中一份；要還原把 .disabled 拿掉即可）"
  fi
}

# ── 移除 ──────────────────────────────────────────────
if [ "$1" = "--uninstall" ]; then
  launchctl bootout "gui/$TARGET_UID/$LABEL" 2>/dev/null || true
  rm -f "$AGENT_PLIST" "$AGENT_PLIST.disabled"
  if [ -f "$DAEMON_PLIST" ]; then
    need_root "移除系統服務" "--uninstall"
    launchctl bootout "system/$LABEL" 2>/dev/null || true
    rm -f "$DAEMON_PLIST"
  fi
  echo "✅ 已移除自動啟動（登入階段與系統服務都清掉了）"
  exit 0
fi

NODE="$(find_node)"
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "❌ 找不到 node。請先確認終端機打 node -v 有反應。"
  exit 1
fi

CAFFEINATE="/usr/bin/caffeinate"

# ── 裝成系統服務（--daemon）────────────────────────────
if [ "$1" = "--daemon" ]; then
  need_root "安裝系統服務" "--daemon"

  case "$NODE" in
    "$TARGET_HOME"/*)
      echo "⚠️  node 在你的家目錄底下（$NODE）——"
      echo "   看起來是 nvm 裝的。系統服務會鎖死這個路徑，之後 nvm 換版本或清舊版就會壞。"
      echo "   建議改用系統層的 node（例如 /usr/local/bin/node），再重跑一次這個指令。"
      echo "" ;;
  esac

  echo "→ 先停用登入階段那份，避免兩份搶 port $PORT_SHOWN"
  remove_agent

  cat > "$DAEMON_PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <!-- caffeinate -i：服務活著的時候不讓系統進睡眠。
         注意 -i 只擋 idle system sleep，**不擋螢幕休眠** —— 螢幕關掉照樣沒事，
         因為系統服務不住在登入階段裡（這正是 --daemon 要解決的問題）。 -->
    <string>$CAFFEINATE</string>
    <string>-i</string>
    <string>$NODE</string>
    <string>$PROJECT/server/start.js</string>
  </array>
  <!-- 用你的帳號跑，不是 root：出片會寫進工作紀錄，擁有者變成 root 你就改不動了 -->
  <key>UserName</key><string>$TARGET_USER</string>
  <key>GroupName</key><string>staff</string>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>RunAtLoad</key><true/>
  <!-- 掛掉自動重開，但最短間隔 10 秒，避免壞掉時瘋狂重啟。
       裝在 system domain 才真的有效 —— LaunchAgent 版的 KeepAlive
       在螢幕關掉後會被 launchd 無限期延後（2026-09-11 實測）。 -->
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <!-- LaunchAgent 本來就有 HOME，daemon 沒有。補上讓兩邊行為一致。 -->
    <key>HOME</key><string>$TARGET_HOME</string>
    <!-- ⚠️ 這裡**故意不設 PORT**。dotenv 不覆寫既有環境變數，所以 plist 一旦寫死 PORT
         就會壓過 .env，改了 .env 也不會生效（舊的 agent 就踩過這個坑）。
         port 一律以 $WORKSPACE/.env 的 PORT 為準。 -->
  </dict>
</dict>
</plist>
PLISTEOF

  chown root:wheel "$DAEMON_PLIST"
  chmod 644 "$DAEMON_PLIST"
  # log 檔要是你的，不然 root 建出來之後你自己 tail 不了、輪替也會怪
  touch "$LOG"
  chown "$TARGET_USER" "$LOG"

  launchctl bootout "system/$LABEL" 2>/dev/null || true
  launchctl bootstrap system "$DAEMON_PLIST"
  sleep 2

  IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "查不到")
  echo ""
  if launchctl print "system/$LABEL" 2>/dev/null | grep -q "state = running"; then
    echo "✅ 裝好了，現在是系統服務 —— 螢幕關掉、沒人登入都會繼續跑"
  else
    echo "⚠️  plist 裝好了但服務沒起來。看記錄找原因："
    echo "     tail -30 $LOG"
    echo "     launchctl print system/$LABEL"
  fi
  echo ""
  echo "   你自己：http://localhost:$PORT_SHOWN"
  echo "   同事連：http://$IP:$PORT_SHOWN"
  echo ""
  echo "   重啟：    sudo launchctl kickstart -k system/$LABEL"
  echo "   執行記錄：tail -f $LOG"
  echo "   移除：    sudo bash \"$PROJECT/server/install-autostart.sh\" --uninstall"
  echo ""
  echo "⚠️  你的 zsh alias 要改 —— 舊的 studio 打的是 gui/\$(id -u)，系統服務不吃那個網域："
  echo "     alias studio='sudo launchctl kickstart -k system/$LABEL && echo \"出片工具 → http://localhost:$PORT_SHOWN\"'"
  echo ""
  echo "⚠️  FileVault 是開的：重開機後要先有人在開機畫面輸入密碼解鎖磁碟，服務才會起來。"
  echo ""
  exit 0
fi

# ── 裝成登入階段服務（預設，舊行為）────────────────────
mkdir -p "$TARGET_HOME/Library/LaunchAgents"

cat > "$AGENT_PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <!-- caffeinate -i：服務活著的時候不讓系統進睡眠 -->
    <string>$CAFFEINATE</string>
    <string>-i</string>
    <string>$NODE</string>
    <string>$PROJECT/server/start.js</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>RunAtLoad</key><true/>
  <!-- 掛掉自動重開，但最短間隔 10 秒，避免壞掉時瘋狂重啟。
       ⚠️ 螢幕關掉之後這條會失效（見檔案開頭），要可靠請改用 --daemon。 -->
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>PORT</key><string>${PORT:-4000}</string>
  </dict>
</dict>
</plist>
PLISTEOF

launchctl bootout "gui/$TARGET_UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$TARGET_UID" "$AGENT_PLIST"

IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "查不到")
echo ""
echo "✅ 裝好了，登入之後會自己啟動"
echo ""
echo "   你自己：http://localhost:${PORT:-4000}"
echo "   同事連：http://$IP:${PORT:-4000}"
echo ""
echo "   執行記錄：tail -f $LOG"
echo "   移除：    bash \"$PROJECT/server/install-autostart.sh\" --uninstall"
echo ""
echo "⚠️  這是登入階段服務：螢幕關掉之後 launchd 不會重啟它，重開機沒人登入也不會啟動。"
echo "   同事要靠它出片的話，改用：sudo bash \"$PROJECT/server/install-autostart.sh\" --daemon"
echo ""
echo "⚠️  把上面「同事連」那個網址貼給同事。IP 可能會變 ——"
echo "   若同事說連不上，先在這台跑一次 ipconfig getifaddr en0 看 IP 是不是換了。"
echo "   要一勞永逸的話，請 IT 幫這台 Mac 綁固定 IP。"
echo ""
