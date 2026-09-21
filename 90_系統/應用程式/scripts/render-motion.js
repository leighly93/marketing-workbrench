#!/usr/bin/env node
/**
 * 產生動態小影片（MG）：讀參數 → render 直式＋橫式兩支 mp4 → 寫出 motion.generated.json。
 *
 * 用法：node scripts/render-motion.js [--input=public/motion.json] [--only=p|l]
 *
 * ── 這支在產線的位置 ──────────────────────────────────────────
 *   HeyGen 完成 → 加速 → transcribe → correct-subtitles（此時才有 _scriptCharTimes）
 *   → **本腳本** → prepareShots → render
 *   必須排在字幕之後：每一項要在旁白唸到它的那一刻進場，沒有時間軸就算不出來。
 *
 * ── 參數從哪來（2026-09-18 暫時的介面）────────────────────────
 *   現在讀 `public/motion.json`，人手寫或由 manual 後端貼。
 *   之後前台入口做好，改由 annotations.json／配圖計畫的 edits 產生**同樣格式**的檔，
 *   這支不用改。格式：
 *     [{
 *       "startCharIdx": 280, "endCharIdx": 336,   ← 前台選範圍會給這組（優先）
 *       "at": "所以現在最重要的",                  ← 手寫時可改用文字比對（找不到就報錯）
 *       "spec": { ... }                            ← **可選**，見下
 *     }]
 *
 * ── spec 從哪來 ──────────────────────────────────────────────
 *   一律問 motion-engine（產線唯一入口，AGENTS.md：業務邏輯不得新增供應者 CLI 呼叫）：
 *     MOTION_ENGINE 沒設        → manual：直接用參數檔裡的 spec
 *     MOTION_ENGINE=claude-cli  → 用 claude -p 讀那段原文產生；失敗時退回參數檔的 spec
 *   engine 回 null＝這一段不做動態，跳過它、繼續下一段。
 *
 * ── 檔名為什麼有兩套 ──────────────────────────────────────────
 *   public/ 放 ASCII 檔名（motion-1-p.mp4）給 Remotion 的 staticFile 用，避開中文路徑；
 *   工作資料夾的 素材/ 放看得懂的中文名（動態1_法人賣多少_直式.mp4）給人下載。
 *   兩者內容相同。素材/ 那份也讓「重新出片」整包帶走 input/ 時自動沿用。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const motionEngine = require('./motion-engine');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const SUBS = path.join(ROOT, 'src', 'subtitles.json');
const OUT_JSON = path.join(ROOT, 'src', 'MotionClip', 'motion.generated.json');
// 指紋單獨存 —— 放進 motion.generated.json 會讓渲染端的型別多一個用不到的欄位。
// 檔名跟著 *.generated.json 的慣例：這樣它會被 snapshotTargets 收進快照（重跑才不會白跑一次），
// 也自動被 .gitignore 排除。
const SIG_FILE = path.join(ROOT, 'src', 'MotionClip', 'motion-sig.generated.json');

/**
 * 這份產出是「哪份輸入 ＋ 哪條字幕時間軸」做出來的。
 * 動態在 prepare 階段就 render（review 頁才預覽得到），但人可能在那之後才標／才改，
 * 所以 doRender 之前要再確認一次。有這個指紋就能只在真的變了的時候重跑，
 * 沒變就省下十幾秒。
 */
function inputSignature(entriesRaw, subs) {
  const h = crypto.createHash('sha1');
  h.update(String(entriesRaw || ''));
  h.update('|');
  // 字幕換了（例如重轉過）秒數就不一樣，也要重做
  h.update(String((subs && subs.times && subs.times.length) || 0));
  h.update(String((subs && subs.times && subs.times.length && subs.times[subs.times.length - 1].end) || ''));
  return h.digest('hex').slice(0, 16);
}

const args = process.argv.slice(2);
const argOf = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const INPUT = path.resolve(ROOT, argOf('input', 'public/motion.json'));
const ONLY = argOf('only', '');
/** 哪個版型。決定要出幾支、安全區要往下讓多少（見 TEMPLATE_MOTION）。 */
const TEMPLATE = argOf('template', '');
/** 只算時間、不 render。驗證「每一項落在第幾秒」時用，幾毫秒就跑完。 */
const DRY = args.includes('--dry-run');
/**
 * 輸入沒變就跳過。給 doRender 用：動態在 prepare 階段就 render 過了，
 * 但人可能在配圖計畫頁又改過，所以出片前要再確認一次 —— 沒改就別白跑十幾秒。
 */
const IF_CHANGED = args.includes('--if-changed');

/** 兩種畫布與它們的預設安全區。 */
const ORIENTATIONS = {
  p: { key: 'p', label: '直式', width: 1080, height: 1920, safeTop: 310, safeBottom: 1440,
       composition: 'MotionClipListPortrait' },
  l: { key: 'l', label: '橫式', width: 1178, height: 1080, safeTop: 0, safeBottom: 918,
       composition: 'MotionClipListLandscape' },
};

/**
 * 哪個版型出哪幾支、安全區要不要調。
 *
 * 只有大盤小報有橫式輸出，其餘版型都只出直式 —— 硬產一支橫式是白花十秒、白佔 1.3MB。
 *
 * safeTop 直接沿用各 composition 自己那個量過的值（招牌實心到哪），
 * 動態要避開的東西跟截圖黃框完全一樣，沒有理由另立一套數字：
 *   焦點股 y267／三大法人 y278／盤中焦點 y291／大盤小報 y303／美股焦點 y307
 * 只有美股焦點的膠囊比較高，所以它的 safeTop 是 325 而不是 310。
 * safeBottom 全部一樣：直式版型共用 Subtitles.tsx，字幕一律從 y1440 起。
 */
const TEMPLATE_MOTION = {
  dapan: { p: {}, l: {} },
  midday: { p: {} },
  usstock: { p: { safeTop: 325 } },
};

/**
 * 這個版型要出哪幾支。不認得的版型只出直式 —— 橫式是大盤小報獨有的，
 * 猜錯的代價不對稱：少一支橫式只是沒有，多一支是每次出片都白等。
 */
function orientationsFor(template) {
  const conf = TEMPLATE_MOTION[template];
  if (!conf) {
    if (template) log(`ℹ️ 版型 ${template} 還沒登記動態設定，只出直式（要改在 TEMPLATE_MOTION 加一筆）`);
    return [ORIENTATIONS.p];
  }
  return Object.entries(conf).map(([key, over]) => ({ ...ORIENTATIONS[key], ...over }));
}

const log = (m) => console.log(m);
/** 丟例外而不是直接 exit —— 這樣純計算函式可以被測試 require 進來驗證。 */
const die = (m) => { throw new Error(m); };

/**
 * 講者影片有多長。動態的時間軸就是這支影片的時間軸（_scriptCharTimes 是從它的音訊算的），
 * 所以「延續到最後」就是延續到這個秒數。讀不到就回 0＝不做延續（寧可維持原行為）。
 */
function heygenDurationSec() {
  try {
    const f = path.join(ROOT, 'src', 'video-meta.json');
    const v = JSON.parse(fs.readFileSync(f, 'utf-8'));
    return Number(v.heygenDurationSec) || 0;
  } catch (_) {
    return 0;
  }
}

/**
 * 這段動態是不是「做在結尾」—— 拖到腳本最後就算。
 *
 * 2026-09-21 使用者定案：做在結尾的話不要淡出回講者，直接延續到影片結束
 *（本來是閃一下講者然後就沒了，很突兀）。**剩幾秒都延續**，不設上限。
 *
 * 容忍最後幾個字是因為拖選很難剛好停在最後一個字上（標點、尾字常會漏掉）。
 * 反過來說，刻意留一段沒標到的旁白就不會延續 —— 這是使用者可以控制的：
 * 拖到底＝延續到片尾，留一點＝結尾還是回講者。
 */
const TAIL_TOLERANCE_CHARS = 5;
function endsAtScriptTail(range, subs) {
  return range.endCharIdx >= subs.times.length - 1 - TAIL_TOLERANCE_CHARS;
}

function loadSubtitles() {
  if (!fs.existsSync(SUBS)) die(`找不到 ${path.relative(ROOT, SUBS)}（要先跑 transcribe ＋ correct-subtitles）`);
  const d = JSON.parse(fs.readFileSync(SUBS, 'utf-8'));
  const times = d._scriptCharTimes || [];
  const text = d._scriptText || '';
  if (times.length === 0) die('subtitles.json 沒有 _scriptCharTimes —— 請先跑 npm run correct-subtitles');
  return { times, text };
}

/** 整段動態的範圍：優先用 charIdx（前台會給），手寫時可用 at 做文字比對。 */
function resolveRange(entry, { times, text }, idx) {
  let s = entry.startCharIdx;
  let e = entry.endCharIdx;
  if (typeof s !== 'number' || typeof e !== 'number') {
    if (!entry.at) die(`第 ${idx + 1} 段：要嘛給 startCharIdx/endCharIdx，要嘛給 at（原文片段）`);
    if (!text) die(`第 ${idx + 1} 段：用 at 比對需要 subtitles.json 的 _scriptText（舊資料沒有，請改給 charIdx）`);
    const i = text.indexOf(entry.at);
    if (i < 0) die(`第 ${idx + 1} 段：在腳本裡找不到「${entry.at}」`);
    s = i;
    e = i + entry.at.length - 1;
  }
  if (s < 0 || e >= times.length || e < s) die(`第 ${idx + 1} 段：charIdx ${s}–${e} 超出腳本範圍（共 ${times.length} 字）`);
  const startSec = times[s].start;
  const endSec = times[e].end;
  if (!(endSec > startSec)) die(`第 ${idx + 1} 段：解出來的時間不合理（${startSec} → ${endSec}）`);
  return { startCharIdx: s, endCharIdx: e, startSec, endSec };
}

/**
 * 每一項的進場時間（相對本段開頭）。
 * 比對只在**本段範圍內**進行 —— 範圍小，重複詞與濃縮失真的風險都低得多。
 * 比對不到就退回等距分配：仍跟著聲音大致同步，不會整個壞掉。
 */
function resolveItemTimes(spec, range, { times, text }) {
  const items = spec.items || [];
  if (items.length === 0) return spec;
  const segText = text.slice(range.startCharIdx, range.endCharIdx + 1);
  const dur = range.endSec - range.startSec;
  let cursor = 0;
  let missed = 0;
  const resolved = items.map((it, i) => {
    if (typeof it.atSec === 'number') return it;           // 已經算好就不動
    const key = it.at || it.text;
    const rel = key ? segText.indexOf(key, cursor) : -1;    // 從上一項之後找，避免倒退
    if (rel < 0) {
      missed += 1;
      // 等距：第 i 項落在整段的 (i+1)/(n+1) 處
      return { ...it, atSec: Number(((dur * (i + 1)) / (items.length + 1)).toFixed(3)), _fallback: true };
    }
    cursor = rel + 1;
    const abs = times[range.startCharIdx + rel].start;
    return { ...it, atSec: Number((abs - range.startSec).toFixed(3)) };
  });
  if (missed) log(`   ⚠️ 有 ${missed} 項在腳本裡比對不到，那幾項改用等距分配`);
  return { ...spec, items: resolved };
}

/** 檔名用的關鍵字：取原文前 10 字，剝掉標點與空白。 */
function keywordOf(text) {
  const clean = String(text || '').replace(/[，。、！？「」『』（）()\[\]：；,.!?:;\s]/g, '');
  return clean.slice(0, 10) || '動態';
}

function renderOne(o, spec, durationSec, outPath, noTailFade) {
  const propsPath = path.join(PUBLIC, `.motion-props-${o.key}.json`);
  fs.writeFileSync(propsPath, JSON.stringify(
    { spec, safeTop: o.safeTop, safeBottom: o.safeBottom, durationSec, noTailFade: !!noTailFade }));
  try {
    // stdio pipe 不是為了安靜 —— 各版型 timeline 的 debug console.log 會被 Remotion 轉發出來，
    // 一支就洗掉幾十行，把這支自己印的「第幾項落在第幾秒」淹掉。失敗時整包吐出來。
    execFileSync('npx', ['remotion', 'render', o.composition, outPath,
      `--props=${propsPath}`, '--concurrency=2', '--crf', '23', '--log=error'],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const out = [e.stdout, e.stderr].filter(Boolean).map((b) => b.toString()).join('\n');
    if (out.trim()) console.error(out.trim().split('\n').slice(-20).join('\n'));
    throw e;
  } finally {
    try { fs.unlinkSync(propsPath); } catch (_) {}
  }
}

function main() {
  // ⚠️ 第一件事：確保 motion.generated.json 存在。
  //    motion-timeline.ts 是**靜態 import** 它的，檔案不在 Remotion 連 bundle 都過不了 ——
  //    而這支程式第一步就是 render。清工作區時若把它刪掉（而不是清空），
  //    每次出片都會在這裡炸掉，而且錯誤訊息是「Can't resolve './motion.generated.json'」，
  //    看起來像專案壞了，其實只是少一個空陣列（2026-09-19 實際出片踩到）。
  if (!fs.existsSync(OUT_JSON)) fs.writeFileSync(OUT_JSON, '[]\n');

  if (!fs.existsSync(INPUT)) {
    log(`ℹ️ 沒有 ${path.relative(ROOT, INPUT)}，這支影片不做動態`);
    fs.writeFileSync(OUT_JSON, '[]\n');
    fs.writeFileSync(SIG_FILE, 'none');
    return;
  }
  const raw = fs.readFileSync(INPUT, 'utf-8');
  const entries = JSON.parse(raw);
  if (!Array.isArray(entries) || entries.length === 0) {
    log('ℹ️ 參數檔是空的，這支影片不做動態');
    fs.writeFileSync(OUT_JSON, '[]\n');
    fs.writeFileSync(SIG_FILE, 'empty');
    return;
  }
  const subs = loadSubtitles();
  const signature = inputSignature(raw, subs);
  if (IF_CHANGED) {
    let prev = null;
    try { prev = fs.readFileSync(SIG_FILE, 'utf-8').trim(); } catch (_) {}
    if (prev === signature && fs.existsSync(OUT_JSON)) {
      log('ℹ️ 動態的參數與字幕都沒變，沿用上次的結果（不重跑）');
      return;
    }
  }
  const generated = [];

  entries.forEach((entry, idx) => {
    const n = idx + 1;
    const range = resolveRange(entry, subs, idx);
    // 做在結尾的話一路演到影片結束，不要中途淡出回講者
    const heygenEnd = heygenDurationSec();
    const toEnd = endsAtScriptTail(range, subs) && heygenEnd > range.endSec;
    const 收尾秒 = toEnd ? heygenEnd : range.endSec;
    const durationSec = Number((收尾秒 - range.startSec).toFixed(3));
    const phrase = subs.text.slice(range.startCharIdx, range.endCharIdx + 1);

    // spec 一律問 engine：manual 後端直接回參數檔裡的 spec，claude-cli 後端讀原文產生。
    // 回 null＝這段不做動態（engine 已經把原因印出來了），跳過、繼續下一段。
    const planned = motionEngine.plan({ text: phrase, manualSpec: entry.spec });
    if (!planned) {
      // engine 名稱一定要印出來 —— 光說「產不出來」的話，
      // 「engine 選錯」跟「claude 這次回得不合格」看起來一模一樣。
      const who = process.env.MOTION_ENGINE || '預設';
      log(`\n⏭  動態 ${n}：參數產不出來（後端＝${who}，原因見上一行），這段跳過`);
      return;
    }
    const spec = resolveItemTimes(planned, range, subs);
    const kw = keywordOf(entry.keyword || phrase);

    log(`\n🎬 動態 ${n}：charIdx ${range.startCharIdx}–${range.endCharIdx}`
      + `　${range.startSec.toFixed(2)}s–${收尾秒.toFixed(2)}s（${durationSec} 秒）`
      + (toEnd ? `　※ 做在結尾 → 延續到影片結束，不淡出回講者` : ''));
    log(`   原文：${phrase.slice(0, 40)}${phrase.length > 40 ? '…' : ''}`);
    (spec.items || []).forEach((it, i) =>
      log(`   ${i + 1}. ${it.text}　→ 第 ${it.atSec} 秒進場${it._fallback ? '（等距，比對不到）' : ''}`));

    // toEnd 要寫進產出檔：渲染端（motion-timeline.ts）是從 charIdx **重新解析**秒數的，
    // 不會讀這裡算好的秒數，所以「這段要演到片尾」一定要用明確旗標告訴它。
    const rec = { startCharIdx: range.startCharIdx, endCharIdx: range.endCharIdx, _phrase: phrase };
    if (toEnd) rec.toEnd = true;
    for (const o of orientationsFor(TEMPLATE)) {
      if (ONLY && ONLY !== o.key) continue;
      const file = `motion-${n}-${o.key}.mp4`;
      if (DRY) {
        log(`   ▷ [dry-run] ${o.label} ${o.width}×${o.height} → public/${file}（未 render）`);
      } else {
        log(`   ▶ render ${o.label} ${o.width}×${o.height} → public/${file}`);
        renderOne(o, spec, durationSec, path.join(PUBLIC, file), toEnd);
      }
      if (o.key === 'p') rec.src = file; else rec.srcLandscape = file;
      rec[o.key === 'p' ? '_niceName' : '_niceNameLandscape'] = `動態${n}_${kw}_${o.label}.mp4`;
    }
    generated.push(rec);
  });

  if (DRY) {
    log(`\n▷ dry-run 結束：算出 ${generated.length} 段，沒有 render、沒有寫 ${path.basename(OUT_JSON)}`);
    return;
  }
  // 指紋放在陣列外面會讓渲染端的型別變複雜，所以塞進每一筆（渲染端忽略底線開頭的欄位）
  fs.writeFileSync(OUT_JSON, JSON.stringify(generated, null, 2) + '\n');
  fs.writeFileSync(SIG_FILE, signature);
  log(`\n✅ 完成：${generated.length} 段動態，已寫入 ${path.relative(ROOT, OUT_JSON)}`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exitCode = 1;
  }
}

// 純計算的部分獨立出來給測試用（不碰檔案系統、不呼叫 remotion）
module.exports = { orientationsFor, TEMPLATE_MOTION, resolveRange, resolveItemTimes, keywordOf, ORIENTATIONS };
