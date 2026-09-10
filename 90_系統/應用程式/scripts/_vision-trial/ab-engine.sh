#!/usr/bin/env bash
# OCR 引擎 A/B：同一批圖、同一支正式版 analyze-app-images.js，
# 分別用 tesseract（OCR_ENGINE 沒設）與 vision（OCR_ENGINE=vision）跑一次，並排印頁型／股名／代號。
#
# ⚠️ 必須在 macOS Terminal 跑（Vision 是 macOS 框架）。不碰產線：所有東西在暫存資料夾裡做，
#    不寫 src/app-images.generated.json、不動 public/。
#
# 用法：
#   bash scripts/_vision-trial/ab-engine.sh                          # 預設：90_系統/資料/page-samples/_raw/手動新增/ 那 14 張
#   bash scripts/_vision-trial/ab-engine.sh jobs/<id>/input          # 指定一個資料夾的截圖
#   PAGE_RULES=v1 bash scripts/_vision-trial/ab-engine.sh            # 預設 v2；要看舊規則就這樣
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORKSPACE_ROOT="$(cd "$ROOT/../.." && pwd)"
SRC_DIR="$(node -e 'const path = require("path"); const { cliPath } = require(path.join(process.argv[1], "..", "paths.js")); process.stdout.write(cliPath(process.argv[1], process.argv[2]));' "$ROOT" "${1:-$WORKSPACE_ROOT/90_系統/資料/page-samples/_raw/手動新增}")"
export PAGE_RULES="${PAGE_RULES:-v2}"

if [[ "$(uname)" != "Darwin" ]]; then echo "❌ 要在 macOS 上跑（Vision）"; exit 1; fi
[[ -d "$SRC_DIR" ]] || { echo "❌ 找不到資料夾：$SRC_DIR"; exit 1; }

WORK="$(mktemp -d /tmp/ocr-ab.XXXXXX)"
# 鏡像正式目錄，讓相同 paths.js 指向暫存副本，避免讀寫正式產線。
TRIAL_APP="$WORK/90_系統/應用程式"
mkdir -p "$TRIAL_APP/scripts" "$TRIAL_APP/public" "$TRIAL_APP/src"
cp "$ROOT/../paths.js" "$WORK/90_系統/paths.js"
cp "$ROOT/../工作儲存.js" "$WORK/90_系統/工作儲存.js"
cp "$ROOT/scripts/analyze-app-images.js" "$ROOT/scripts/ocr-engine.js" "$ROOT/scripts/ocr-vision.swift" "$TRIAL_APP/scripts/"
ln -s "$ROOT/node_modules" "$TRIAL_APP/node_modules"
# 不複製 .env；PAGE_RULES 沿用上面的 export，OCR_ENGINE 由各輪明確指定。

i=0
for f in "$SRC_DIR"/*.{png,PNG,jpg,JPG,jpeg,JPEG}; do
  [[ -f "$f" ]] || continue
  i=$((i+1)); ext="$(printf '%s' "${f##*.}" | tr 'A-Z' 'a-z')"   # macOS 內建 bash 是 3.2，沒有 ${ext,,}
  name="image$(printf '%02d' "$i").$ext"
  cp "$f" "$TRIAL_APP/public/$name"
  printf '%s\t%s\n' "$name" "$(basename "$f")" >> "$TRIAL_APP/names.tsv"
done
echo "📂 $i 張圖 → $TRIAL_APP/public　規則：PAGE_RULES=$PAGE_RULES"

cd "$TRIAL_APP"
echo "▶ tesseract…"; t0=$(date +%s); (unset OCR_ENGINE; node scripts/analyze-app-images.js > out-tesseract.log 2>&1) || true
cp src/app-images.generated.json out-tesseract.json; echo "   $(( $(date +%s) - t0 ))s"
echo "▶ vision…";    t0=$(date +%s); OCR_ENGINE=vision node scripts/analyze-app-images.js > out-vision.log 2>&1 || true
cp src/app-images.generated.json out-vision.json;    echo "   $(( $(date +%s) - t0 ))s"

node - <<'EOF'
const fs = require('fs');
const T = JSON.parse(fs.readFileSync('out-tesseract.json', 'utf-8')).images || [];
const V = JSON.parse(fs.readFileSync('out-vision.json', 'utf-8')).images || [];
const names = Object.fromEntries(fs.readFileSync('names.tsv', 'utf-8').trim().split('\n').map((l) => l.split('\t')));
const byFile = (arr) => Object.fromEntries(arr.map((x) => [x.file || x.name || x.image, x]));
const t = byFile(T), v = byFile(V);
const pad = (s, n) => { s = String(s ?? '—'); let w = 0; for (const ch of s) w += ch.charCodeAt(0) > 255 ? 2 : 1; return s + ' '.repeat(Math.max(0, n - w)); };
const pick = (x) => x ? [(x.page || x.pageLabel || x.sig && x.sig.page) ?? '—', x.stockName ?? x.name ?? '—', x.stockCode ?? x.code ?? '—', (x.words || []).length] : ['(無)', '—', '—', 0];
console.log('\n' + pad('原檔名', 26) + pad('tesseract 頁型', 22) + pad('vision 頁型', 22) + pad('股名 T/V', 16) + pad('代號 T/V', 12) + '詞框 T/V');
let same = 0, total = 0;
for (const f of Object.keys({ ...t, ...v }).sort()) {
  const a = pick(t[f]), b = pick(v[f]);
  total++; if (a[0] === b[0]) same++;
  console.log(pad(names[f] || f, 26) + pad(a[0], 22) + pad((a[0] === b[0] ? '' : '★ ') + b[0], 22) +
    pad(a[1] + '/' + b[1], 16) + pad(a[2] + '/' + b[2], 12) + a[3] + '/' + b[3]);
}
console.log(`\n頁型判定一致 ${same}/${total}；★ = 兩引擎判得不一樣，請人工看原圖決定誰對。`);
// 除錯：readStockCode() 第一關看的是「頂部 12% 內、剛好 4 位數、信心 >50」的詞。把兩引擎在頂部 12% 含 4 位數的詞都印出來。
console.log('\n頂部 12% 含 4 位數的詞（t@x,y c=信心）：');
for (const f of Object.keys({ ...t, ...v }).sort()) {
  const show = (x) => x ? (x.words || []).filter((w) => /\d{4}/.test(w.t) && w.y < (x.height || 1e9) * 0.12).map((w) => `${w.t}@${w.x},${w.y} c=${w.c}`).join('  ') || '(無)' : '(無)';
  console.log(pad(names[f] || f, 14) + 'T: ' + show(t[f]) + '\n' + pad('', 14) + 'V: ' + show(v[f]));
}
// 除錯 2：股名列（頂部 3%~8%）兩引擎讀到的所有詞 —— 看「景碩 3189」這種標題到底被讀成什麼
console.log('\n股名列（頂部 3%~8%）全部詞：');
for (const f of Object.keys({ ...t, ...v }).sort()) {
  const show = (x) => x ? (x.words || []).filter((w) => w.y > (x.height || 0) * 0.03 && w.y < (x.height || 1e9) * 0.08).map((w) => `${w.t}@${w.x} c=${w.c}`).join('  ') || '(無)' : '(無)';
  console.log(pad(names[f] || f, 14) + 'T: ' + show(t[f]) + '\n' + pad('', 14) + 'V: ' + show(v[f]));
}
console.log(`明細：${process.cwd()}/out-tesseract.json、out-vision.json（log 同名 .log）`);
EOF
