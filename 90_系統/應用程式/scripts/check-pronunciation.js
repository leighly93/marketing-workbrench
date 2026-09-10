#!/usr/bin/env node
/**
 * 找出「這支影片哪幾個字被唸錯了」。
 *
 * 由來（2026-08-21 使用者問：「抓到這些股票名稱，是不是可以學習他的發音唸法，
 * 變成專有名詞？」）：股票名稱清單本身沒有發音資訊 —— 知道「長榮」是一檔股票，
 * 不代表知道 HeyGen 會把它唸成「掌榮」。要知道唸錯，得有東西真的「聽過」。
 *
 * 而系統裡早就有那個東西了：
 *   src/subtitles.original.json  Whisper 的原始聽寫 ＝ HeyGen 實際唸出來的聲音
 *   src/subtitles.json           correct-subtitles.js 對齊回腳本之後的版本
 * 這兩個檔的 words 陣列是**索引對齊**的（校正只改 .word 的文字，不動時間），
 * 所以逐一比對就好，不用再做一次對齊，而且免費拿到可以試聽的時間點。
 *
 * ⚠️ 不能直接比字。Whisper 輸出簡體、而且大量用同音字：
 *   「台指期」→「台纸旗」、「長債殖利率」→「常債值利率」、「期貨」→「其貨」
 * 這些**發音全都是對的**。實測某支影片字面不同的有 127 個字，比拼音之後只剩 3 個。
 *
 * 用法：
 *   npm run check:pronounce                    # 看現在工作區那支
 *   node scripts/check-pronunciation.js --json # 給程式讀（server 用這個）
 */
const fs = require('fs');
const path = require('path');
const { workspaceRoot, applicationPath, dataPath } = require('../../paths');

const ROOT = workspaceRoot(path.resolve(__dirname, '..'));

// ⚠️ 套件要延後載入、而且不能讓載入失敗往外炸。
//    server/index.js 是在檔案頂層 require 這支的 —— 這裡直接 require('pinyin-pro')
//    的話，只要有人忘記 npm i，**整台伺服器就開不起來**（不是功能壞掉，是連前台都打不開）。
//    缺套件時回傳 needInstall，呼叫端照常運作，只是沒有唸法檢查。
let pinyin = null, t2s = null, loadErr = null;
function loadDeps() {
  if (pinyin || loadErr) return !loadErr;
  try {
    pinyin = require('pinyin-pro').pinyin;
    // 先轉簡體再算拼音。pinyin-pro 的詞典是簡體的，繁體斷不出詞 ——
    // 「跟著反彈」會算成 gen zhu fan dan（正確是 gen zhe fan tan）、
    // 「還不能說」的還會算成 huan（正確 hai），破音字全部變成假警報。
    // Whisper 本來就輸出簡體，兩邊都轉簡體也剛好讓比較基準一致。
    t2s = require('opencc-js').Converter({ from: 'tw', to: 'cn' });
    return true;
  } catch (e) { loadErr = e; return false; }
}

const CJK = /[一-鿿]/;
// 這幾組是 Whisper 自己最常聽混的（不是 TTS 唸錯）：捲舌／前後鼻音。
// 歸到「低信心」而不是直接丟掉 —— 真的唸錯成這樣的話還是看得到。
const FUZZY = [[/ng$/, 'n'], [/^zh/, 'z'], [/^ch/, 'c'], [/^sh/, 's']];
const fuzzy = (p) => p.split(' ')
  .map((w) => FUZZY.reduce((v, [r, t]) => v.replace(r, t), w)).join(' ');

/** 一整句一起算拼音再切回每個 word —— 破音字一定要有上下文才對 */
function pinyinPerWord(words) {
  const text = t2s(words.map((w) => (w.word || '').trim()).join(''));
  const arr = pinyin(text, { toneType: 'none', type: 'array', nonZh: 'consecutive' });
  const out = [];
  let k = 0;
  for (const w of words) {
    const n = [...t2s((w.word || '').trim())].length;
    out.push(arr.slice(k, k + n).join(' '));
    k += n;
  }
  return out;
}

/**
 * @returns {{high:Array,low:Array,checked:number}} 高信心／低信心候選
 * 每筆：{ t 秒數, char 腳本的字, heard 聽起來像, scriptPy, heardPy, ctx 上下文, ctxAt 在上下文的位置,
 *        stock 落在哪個股票名裡（沒有就 null）, ruled 已經有詞庫規則卻還是不對 }
 */
function check(opts = {}) {
  if (!loadDeps()) return { high: [], low: [], checked: 0, needInstall: true };
  // root 是工作副本位置；指定 job 快照字幕時，subs / orig 仍優先。
  const root = opts.root || ROOT;
  const subs = opts.subs || applicationPath(root, 'src', 'subtitles.json');
  const orig = opts.orig || applicationPath(root, 'src', 'subtitles.original.json');
  if (!fs.existsSync(subs) || !fs.existsSync(orig)) return { high: [], low: [], checked: 0 };

  const A = JSON.parse(fs.readFileSync(subs, 'utf-8'));
  const B = JSON.parse(fs.readFileSync(orig, 'utf-8'));

  // 股票名清單：用來把候選分級。「盤面」唸錯是小瑕疵，「長榮」唸錯是品牌問題。
  let stockNames = [];
  try {
    stockNames = [...new Set(Object.values(
      JSON.parse(fs.readFileSync(dataPath(root, 'stock-names.json'), 'utf-8'))))]
      .filter((n) => n && n.length >= 2).sort((a, b) => b.length - a.length);
  } catch (_) {}
  // 已經有規則的詞：不是跳過，是標出來 ——「規則加了卻還是唸錯」才是最該知道的事
  let ruled = [];
  try {
    ruled = JSON.parse(fs.readFileSync(dataPath(root, 'pronounce.json'), 'utf-8'))
      .filter((r) => r.enabled !== false).map((r) => r.from);
  } catch (_) {}

  const high = [], low = [];
  let checked = 0;
  const segA = A.segments || [], segB = B.segments || [];
  for (let si = 0; si < Math.min(segA.length, segB.length); si++) {
    const wa = segA[si].words || [], wb = segB[si].words || [];
    // 長度對不上代表這兩個檔不是同一次跑出來的，整段跳過比亂比對安全
    if (!wa.length || wa.length !== wb.length) continue;
    const pa = pinyinPerWord(wa), pb = pinyinPerWord(wb);
    const line = wa.map((w) => (w.word || '').trim()).join('');
    const at = [];
    { let k = 0; for (const w of wa) { at.push(k); k += [...(w.word || '').trim()].length; } }

    for (let i = 0; i < wa.length; i++) {
      const s = (wa[i].word || '').trim(), w = (wb[i].word || '').trim();
      checked++;
      if (!s || !w || s === w) continue;
      if (!CJK.test(s) || !CJK.test(w)) continue;
      // 轉成簡體之後是同一個字 → 繁簡寫法差異，根本不是唸錯。
      // 這一條要擋在拼音比較之前：pinyin-pro 對「坏」這種一字多音的字會挑到罕見讀音
      //（「一好一坏」的坏被讀成 pi），只靠拼音會冒出假警報。
      if (t2s(s) === t2s(w)) continue;
      if (pa[i] === pb[i]) continue;                        // 完全同音 → Whisper 選字，忽略

      const k = at[i];
      const ctxFrom = Math.max(0, k - 6);
      const rec = {
        t: +(wa[i].start || 0).toFixed(2),
        char: s, heard: w, scriptPy: pa[i], heardPy: pb[i],
        ctx: line.slice(ctxFrom, k + 7),
        ctxAt: k - ctxFrom,
        stock: stockNames.find((n) => line.slice(Math.max(0, k - 4), k + 5).includes(n)
          && n.includes(s)) || null,
        ruled: ruled.find((r) => r.includes(s)) || null,
      };
      (fuzzy(pa[i]) === fuzzy(pb[i]) ? low : high).push(rec);
    }
  }
  // 同一個字重複唸錯只回報一次（「淨」在同一支裡出現三次），但把次數帶上
  const dedupe = (list) => {
    const seen = new Map();
    for (const r of list) {
      const key = r.char + '|' + r.heard;
      if (seen.has(key)) { seen.get(key).times++; continue; }
      seen.set(key, { ...r, times: 1 });
    }
    return [...seen.values()];
  };
  return { high: dedupe(high), low: dedupe(low), checked };
}

module.exports = { check };

if (require.main === module) {
  const r = check();
  if (r.needInstall) {
    console.log('缺套件，唸法檢查沒有跑。請先在專案目錄執行：npm i');
    console.log('（需要 pinyin-pro 與 opencc-js，兩個都已經寫進 package.json）');
    process.exit(0);
  }
  if (process.argv.includes('--json')) { console.log(JSON.stringify(r)); process.exit(0); }
  if (!r.checked) {
    console.log('找不到 src/subtitles.json 或 src/subtitles.original.json —— 這支還沒轉字幕。');
    process.exit(0);
  }
  const show = (title, list) => {
    console.log(`\n【${title}】${list.length} 筆`);
    for (const x of list) {
      console.log(`  ${String(x.t).padStart(7)}s　「${x.char}」(${x.scriptPy}) 聽起來像「${x.heard}」(${x.heardPy})`
        + (x.times > 1 ? `　×${x.times}` : '')
        + (x.stock ? `　⚠️ 股票名「${x.stock}」` : '')
        + (x.ruled ? `　⚠️ 詞庫已經有「${x.ruled}」卻還是不對` : ''));
      console.log(`            …${x.ctx}…`);
    }
  };
  show('可能唸錯了', r.high);
  show('比較像 Whisper 自己聽混的', r.low);
  console.log(`\n（比對了 ${r.checked} 個字）`);
}
