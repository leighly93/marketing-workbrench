#!/bin/bash
# ─────────────────────────────────────────────────────────────
# 把這台 Mac 設成一個固定的內網網址，讓同事不用再記 IP。
#
#   用法（工作根目錄）：bash 90_系統/應用程式/server/setup-lan-domain.sh mkt-video
#           （不給名字的話預設 mkt-video）
#
#   原理：設定 macOS 內建的 Bonjour 主機名稱，同網段的人就能用
#         http://<名字>.local:4000 連進來，IP 換掉也不會失效。
#
#   詳細說明與備援方案：90_系統/維護說明/內網固定網址設定.md
# ─────────────────────────────────────────────────────────────
set -e

NAME="${1:-mkt-video}"
PORT="${PORT:-4000}"

# 名字只能英數和連字號，不然 Bonjour 會自己亂改
if ! [[ "$NAME" =~ ^[A-Za-z0-9-]+$ ]]; then
  echo "❌ 名字只能用英文、數字、連字號，你給的是：$NAME"
  exit 1
fi

echo ""
echo "→ 準備把主機名稱設成：$NAME"
echo "  （目前是：$(scutil --get LocalHostName 2>/dev/null || echo '未設定')）"
echo ""

sudo scutil --set LocalHostName "$NAME"
echo "✅ 主機名稱已設定"

# 服務有沒有在對外聽？只綁 127.0.0.1 的話同事連不進來
echo ""
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | grep -qE '\*:|0\.0\.0\.0:'; then
  echo "✅ 服務正在對外監聽 port $PORT"
elif lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "⚠️  服務只綁在 localhost，同事會連不進來。檢查根 .env 的 HOST 是否設定為 0.0.0.0，並在確認後重啟該服務。"
else
  echo "⚠️  port $PORT 沒有服務在跑。請依 90_系統/維護說明/啟動與驗證.md 確認啟動方式。"
fi

# 防火牆狀態
FW=$(/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>/dev/null || echo "")
if echo "$FW" | grep -q "enabled"; then
  echo "⚠️  防火牆是開的 —— 請到 系統設定 → 網路 → 防火牆 → 選項，確認 node 允許傳入連線"
else
  echo "✅ 防火牆沒有阻擋"
fi

IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "查不到")

echo ""
echo "─────────────────────────────────────────"
echo "  貼給同事的網址："
echo ""
echo "     http://$NAME.local:$PORT"
echo ""
echo "  連不上時的備援（IP 可能會變）："
echo "     http://$IP:$PORT"
echo "─────────────────────────────────────────"
echo ""
echo "自己先驗一次："
echo "   dns-sd -G v4 $NAME.local"
echo "   curl -I http://$NAME.local:$PORT"
echo ""
echo "⚠️  Windows 同事若連不上 .local，請他們裝 Apple 的"
echo "   Bonjour Print Services for Windows（免費）。"
echo "   仍然不行的話，改走 90_系統/維護說明/內網固定網址設定.md 的方案 B。"
echo ""
