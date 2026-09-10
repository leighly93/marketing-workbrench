#!/usr/bin/env node
/**
 * 抓官方的「股票代號 ↔ 簡稱」對照表，寫成 90_系統/資料/stock-names.json。
 *
 * 為什麼需要這張表（2026-08-21 使用者要求「下次看到一樣的截圖要認得」）：
 * APP 個股頁的 OCR 幾乎一定讀得到 4 位數代號（實測 2408 信心 91、2454 信心 93），
 * 但股名常常讀壞或被切碎（「南亞」+「科」兩個框、「華邦」+「電」兩個框）。
 * 而旁白只會講股名、不會講代號 —— 兩邊對不起來，那張圖就整張配不到句子。
 * 有了這張表，analyze-app-images.js 就能用代號把股名補回來。
 *
 * 為什麼要你自己跑一次，不是我幫你抓：
 * 我的環境抓長網頁會被截斷（實測跟證交所要清單只拿得到代號 1101~1432 就斷了），
 * 硬湊等於我憑印象填，填錯一筆影片就會框錯股票。你的機器有網路，抓的是官方原始檔。
 *
 * 用法：
 *   npm run stocks          # 抓上市＋上櫃，寫入 90_系統/資料/stock-names.json
 *   npm run stocks -- --dry # 只印筆數，不寫檔
 *
 * 什麼時候要再跑：有新股上市、或發現某檔股票一直配不到圖的時候。
 */
const fs = require('fs');
const path = require('path');
const { workspaceRoot, dataPath } = require('../../paths');

const ROOT = workspaceRoot(path.resolve(__dirname, '..'));
const OUT = dataPath(ROOT, 'stock-names.json');
const DRY = process.argv.includes('--dry');

// 證交所的 ISIN 清單頁。strMode=2 上市、4 上櫃。
// 這兩頁是 Big5 編碼的 HTML 表格，欄位是「代號　簡稱」中間夾全形空白。
const SOURCES = [
  { market: '上市', url: 'https://isin.twse.com.tw/isin/C_public.jsp?strMode=2' },
  { market: '上櫃', url: 'https://isin.twse.com.tw/isin/C_public.jsp?strMode=4' },
];

/** Big5 → UTF-8。Node 內建的 TextDecoder 在有 full-icu 時吃得下 big5。 */
function decodeBig5(buf) {
  for (const enc of ['big5', 'cp950', 'big5-hkscs']) {
    try {
      const s = new TextDecoder(enc).decode(buf);
      if (s.includes('股票') || s.includes('上市') || s.includes('上櫃')) return s;
    } catch (_) { /* 這個 Node 沒有這個編碼，換下一個 */ }
  }
  throw new Error(
    'Node 解不開 Big5（缺 full-icu）。請改用：\n'
    + '  npm i -D iconv-lite   然後再跑一次\n'
    + '或手動存檔後告訴我檔案路徑。'
  );
}

async function fetchTable(src) {
  const res = await fetch(src.url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'zh-TW' },
  });
  if (!res.ok) throw new Error(`${src.market} HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  let html;
  try { html = decodeBig5(buf); }
  catch (e) {
    // 有裝 iconv-lite 就用它，沒有就把原始錯誤往上丟
    try { html = require('iconv-lite').decode(buf, 'big5'); }
    catch (_) { throw e; }
  }

  const out = {};
  // 每一列長這樣：<td bgcolor=#FAFAD2>2330　台積電</td>
  // 代號與簡稱之間是**全形空白 U+3000**（不是半形），這是最容易踩的一點。
  for (const m of html.matchAll(/<td[^>]*>\s*(\d{4,6}[A-Z]?)　([^<]+?)\s*<\/td>/g)) {
    const code = m[1].trim();
    const name = m[2].trim();
    // 只要 4 位數的股票；ETF／權證／存託憑證代號是 5~6 位，留著只會讓比對變吵
    if (!/^\d{4}$/.test(code)) continue;
    if (!name || name.length > 8) continue;
    out[code] = name;
  }
  return out;
}

(async () => {
  const all = {};
  const stat = [];
  for (const src of SOURCES) {
    try {
      const t = await fetchTable(src);
      Object.assign(all, t);
      stat.push(`${src.market} ${Object.keys(t).length} 檔`);
      console.log(`✅ ${src.market}：${Object.keys(t).length} 檔`);
    } catch (e) {
      console.error(`❌ ${src.market} 抓失敗：${e.message}`);
    }
  }

  const n = Object.keys(all).length;
  if (n < 500) {
    console.error('');
    console.error(`⚠️ 只抓到 ${n} 檔，明顯不對（上市＋上櫃應該有一千五百檔以上）。`);
    console.error('   不寫檔，避免用一份殘缺的表去配圖。請檢查網路或稍後再試。');
    process.exit(1);
  }

  // 抽驗幾檔大家都認得的，確認欄位沒有對錯位
  const 抽驗 = ['2330', '2454', '2408', '2344', '2317'];
  console.log('');
  console.log('抽驗：' + 抽驗.map((c) => `${c}=${all[c] || '(缺)'}`).join('　'));

  if (DRY) { console.log(`\n（--dry，沒寫檔）共 ${n} 檔`); return; }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  // 依代號排序再寫，diff 才看得懂哪幾檔是新增的
  const sorted = {};
  for (const k of Object.keys(all).sort()) sorted[k] = all[k];
  fs.writeFileSync(OUT, JSON.stringify(sorted, null, 0).replace(/","/g, '",\n  "')
    .replace(/^\{/, '{\n  ').replace(/\}$/, '\n}') + '\n');
  console.log(`\n✅ 共 ${n} 檔 → 90_系統/資料/stock-names.json（${stat.join('、')}）`);
  console.log('   這份進版控，之後 analyze-app-images.js 會用它把讀不到的股名補回來。');
})();
