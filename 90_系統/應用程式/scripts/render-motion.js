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
 *       "spec": { "template": "list", "kicker": "...", "title": "三個|觀察重點",
 *                 "items": [{ "text": "法人到底賣多少", "at": "法人到底賣多少" }] }
 *     }]
 *
 * ── 檔名為什麼有兩套 ──────────────────────────────────────────
 *   public/ 放 ASCII 檔名（motion-1-p.mp4）給 Remotion 的 staticFile 用，避開中文路徑；
 *   工作資料夾的 素材/ 放看得懂的中文名（動態1_法人賣多少_直式.mp4）給人下載。
 *   兩者內容相同。素材/ 那份也讓「重新出片」整包帶走 input/ 時自動沿用。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const SUBS = path.join(ROOT, 'src', 'subtitles.json');
const OUT_JSON = path.join(ROOT, 'src', 'MotionClip', 'motion.generated.json');

const args = process.argv.slice(2);
const argOf = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const INPUT = path.resolve(ROOT, argOf('input', 'public/motion.json'));
const ONLY = argOf('only', '');
/** 只算時間、不 render。驗證「每一項落在第幾秒」時用，幾毫秒就跑完。 */
const DRY = args.includes('--dry-run');

/** 兩個版型的畫布與安全區。要接盤中焦點／美股焦點時在這裡加一筆即可。 */
const ORIENTATIONS = {
  p: { key: 'p', label: '直式', width: 1080, height: 1920, safeTop: 310, safeBottom: 1440,
       composition: 'MotionClipListPortrait' },
  l: { key: 'l', label: '橫式', width: 1178, height: 1080, safeTop: 0, safeBottom: 918,
       composition: 'MotionClipListLandscape' },
};

const log = (m) => console.log(m);
/** 丟例外而不是直接 exit —— 這樣純計算函式可以被測試 require 進來驗證。 */
const die = (m) => { throw new Error(m); };

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

function renderOne(o, spec, durationSec, outPath) {
  const propsPath = path.join(PUBLIC, `.motion-props-${o.key}.json`);
  fs.writeFileSync(propsPath, JSON.stringify({ spec, safeTop: o.safeTop, safeBottom: o.safeBottom, durationSec }));
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
  if (!fs.existsSync(INPUT)) {
    log(`ℹ️ 沒有 ${path.relative(ROOT, INPUT)}，這支影片不做動態`);
    fs.writeFileSync(OUT_JSON, '[]\n');
    return;
  }
  const entries = JSON.parse(fs.readFileSync(INPUT, 'utf-8'));
  if (!Array.isArray(entries) || entries.length === 0) {
    log('ℹ️ 參數檔是空的，這支影片不做動態');
    fs.writeFileSync(OUT_JSON, '[]\n');
    return;
  }
  const subs = loadSubtitles();
  const generated = [];

  entries.forEach((entry, idx) => {
    const n = idx + 1;
    const range = resolveRange(entry, subs, idx);
    const durationSec = Number((range.endSec - range.startSec).toFixed(3));
    const phrase = subs.text.slice(range.startCharIdx, range.endCharIdx + 1);
    const spec = resolveItemTimes(entry.spec || {}, range, subs);
    const kw = keywordOf(entry.keyword || phrase);

    log(`\n🎬 動態 ${n}：charIdx ${range.startCharIdx}–${range.endCharIdx}`
      + `　${range.startSec.toFixed(2)}s–${range.endSec.toFixed(2)}s（${durationSec} 秒）`);
    log(`   原文：${phrase.slice(0, 40)}${phrase.length > 40 ? '…' : ''}`);
    (spec.items || []).forEach((it, i) =>
      log(`   ${i + 1}. ${it.text}　→ 第 ${it.atSec} 秒進場${it._fallback ? '（等距，比對不到）' : ''}`));

    const rec = { startCharIdx: range.startCharIdx, endCharIdx: range.endCharIdx, _phrase: phrase };
    for (const o of Object.values(ORIENTATIONS)) {
      if (ONLY && ONLY !== o.key) continue;
      const file = `motion-${n}-${o.key}.mp4`;
      if (DRY) {
        log(`   ▷ [dry-run] ${o.label} ${o.width}×${o.height} → public/${file}（未 render）`);
      } else {
        log(`   ▶ render ${o.label} ${o.width}×${o.height} → public/${file}`);
        renderOne(o, spec, durationSec, path.join(PUBLIC, file));
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
  fs.writeFileSync(OUT_JSON, JSON.stringify(generated, null, 2) + '\n');
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
module.exports = { resolveRange, resolveItemTimes, keywordOf, ORIENTATIONS };
