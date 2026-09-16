#!/usr/bin/env node
/**
 * 用 public/script.txt 為真相之源，重組 src/subtitles.json 的字幕文字。
 * 採 forced alignment：Whisper 只供 word-level 時間戳，字幕文字 100% 來自 script.txt
 * （套發音替換後）。
 *
 * 用法：npm run correct-subtitles
 *
 * 流程：
 *   1. script.txt 取內文段 + 套發音替換 + 逐字清洗 → scriptChars（含 origIdx）
 *   2. Whisper 的所有 word.word 串成 whisperText（去標點）
 *   3. Needleman-Wunsch 全域對齊兩條字串
 *   4. 對齊結果 → 建立 scriptChar → whisperWord 映射表
 *      - match / sub：scriptChar 屬於對到的 whisper word
 *      - scriptExtra：附給時間上最近的 whisper word
 *      - whisperExtra：丟棄（Whisper 多打 / 幻覺）
 *   5. 對每個 whisper word，重組 .word = 對到它的所有 scriptChars 串接（缺空字串）
 *   6. 套用 subtitles-replacements.json（fallback，跨 word 安全）
 *   7. 反向發音替換（把「四點三九」還原回「4.39」；跨 word 安全）
 *   8. 額外輸出 _scriptBreaks（強制換幕點）與 _scriptCharTimes（每個 cleaned script char 的時間戳，給 anchor 用）
 *   9. 第一次跑會備份原始字幕到 subtitles.original.json
 */

const fs = require('fs');
const path = require('path');
const {
  parseVoiceRules,
  getBodyAfterVoice,
  cleanBodyWithIndex,
} = require('./script-utils');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'public', 'script.txt');
const SUBS_PATH = path.join(ROOT, 'src', 'subtitles.json');
const BACKUP_PATH = path.join(ROOT, 'src', 'subtitles.original.json');
const REPLACEMENTS_PATH = path.join(__dirname, 'subtitles-replacements.json');

// ─── 1. 讀檔 ───────────────────────────────────────────
if (!fs.existsSync(SCRIPT_PATH)) {
  console.error(`❌ 找不到 ${SCRIPT_PATH}`);
  process.exit(1);
}
if (!fs.existsSync(SUBS_PATH)) {
  console.error(`❌ 找不到 ${SUBS_PATH}（請先跑 npm run transcribe）`);
  process.exit(1);
}

const scriptRaw = fs.readFileSync(SCRIPT_PATH, 'utf-8');
const subs = JSON.parse(fs.readFileSync(SUBS_PATH, 'utf-8'));

// ─── 2. 清洗腳本 ───────────────────────────────────────
const bodyAfterVoice = getBodyAfterVoice(scriptRaw);
const scriptChars = cleanBodyWithIndex(bodyAfterVoice);
const cleanScriptText = scriptChars.map((c) => c.char).join('');

// ─── 3. 取出 Whisper char 序列（去標點以求對齊乾淨）
const PUNCT_RE = /[，。、！？「」『』"'""''【】〔〕（）()\[\]：；,.!?:;%／/]/;

const whisperChars = [];
for (const seg of subs.segments) {
  if (!seg.words) continue;
  for (const w of seg.words) {
    const wordText = w.word.replace(/\s/g, '');
    for (const ch of wordText) {
      if (PUNCT_RE.test(ch)) continue;
      whisperChars.push({ char: ch, wordRef: w });
    }
  }
}
const whisperText = whisperChars.map((c) => c.char).join('');

// ─── 4. Needleman-Wunsch 全域對齊 ─────────────────────
function align(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1];
      else dp[i][j] = Math.min(dp[i - 1][j - 1], dp[i][j - 1], dp[i - 1][j]) + 1;
    }
  }
  const pairs = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      pairs.push({ ai: i - 1, bi: j - 1, type: 'match' });
      i--;
      j--;
    } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      pairs.push({ ai: i - 1, bi: j - 1, type: 'sub' });
      i--;
      j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      pairs.push({ ai: i - 1, bi: -1, type: 'whisperExtra' });
      i--;
    } else {
      pairs.push({ ai: -1, bi: j - 1, type: 'scriptExtra' });
      j--;
    }
  }
  pairs.reverse();
  return pairs;
}

const pairs = align(whisperText, cleanScriptText);

// ─── 5. 建 scriptChar(bi) → whisperWord 映射 ─────────────
// match/sub：直接用對到的 whisperChars[ai].wordRef
// scriptExtra：暫缺，下面用相鄰 scriptChar 的 wordRef 補
const scriptCharToWord = new Array(scriptChars.length).fill(null);
for (const p of pairs) {
  if (p.bi < 0) continue;
  if (p.ai >= 0) scriptCharToWord[p.bi] = whisperChars[p.ai].wordRef;
}
// scriptExtra 用最近的鄰居（向前優先，否則向後）
for (let i = 0; i < scriptChars.length; i++) {
  if (scriptCharToWord[i]) continue;
  for (let j = i - 1; j >= 0; j--) {
    if (scriptCharToWord[j]) { scriptCharToWord[i] = scriptCharToWord[j]; break; }
  }
  if (!scriptCharToWord[i]) {
    for (let j = i + 1; j < scriptChars.length; j++) {
      if (scriptCharToWord[j]) { scriptCharToWord[i] = scriptCharToWord[j]; break; }
    }
  }
}

// ─── 6. 為每個 whisper word 收集對到它的 script chars，重組 .word
const wordToScriptIdx = new Map();
for (let i = 0; i < scriptChars.length; i++) {
  const w = scriptCharToWord[i];
  if (!w) continue;
  if (!wordToScriptIdx.has(w)) wordToScriptIdx.set(w, []);
  wordToScriptIdx.get(w).push(i);
}
const wordToScriptChars = new Map();
for (const [w, idxs] of wordToScriptIdx) {
  wordToScriptChars.set(w, idxs.map((i) => scriptChars[i].char));
}

// ─── 6.2 leading space 也要以 script.txt 為權威 ────────────────
// 為什麼：本檔檔頭宣示「字幕文字 100% 來自 script.txt」，但 `leading`（word 開頭的半形空白）
// 原本是**原封不動從 Whisper 抄過來**的，是唯一一個沒照這個原則走的欄位。
// Whisper 只要在某個字前面聽到一點停頓，就會把那個字當新 token、加上 leading space
// （例：「世」講完停 0.4 秒 →「 芯」，probability 只有 0.26），
// Subtitles.tsx 再把它還原成真空白 → 螢幕上出現「世 芯-KY」（2026-09-01 使用者回報）。
// 實測 53.8 秒那支共 18 處，連「照進度交 貨」都被空白拆開。
// 改成：只有 script.txt 原文在那個位置真的打了空白，才給 leading。
// 用 scriptChars 的 origIdx 反查 bodyAfterVoice（script.txt 的空白在 cleanBodyWithIndex
// 就被丟掉了，所以一定要回頭查原文，不能查 cleanScriptText）。
function scriptHasSpaceBefore(w) {
  const idxs = wordToScriptIdx.get(w) || [];
  if (idxs.length === 0) return false;
  const o = scriptChars[idxs[0]].origIdx;
  return o > 0 && /[ \t]/.test(bodyAfterVoice[o - 1]);
}

const reports = [];
for (const seg of subs.segments) {
  if (!seg.words) continue;
  for (const w of seg.words) {
    const leading = scriptHasSpaceBefore(w) ? ' ' : '';
    const original = w.word.replace(/\s/g, '');
    const corrected = (wordToScriptChars.get(w) || []).join('');
    if (corrected !== original) {
      reports.push({ time: w.start.toFixed(2) + 's', from: original, to: corrected });
    }
    w.word = leading + corrected;
  }
  seg.text = seg.words.map((w) => w.word.replace(/^\s+/, '')).join('');
}

// ─── 6.5 斷句點落在 whisper word 中間 → 依斷點把該 word 切開 ──
// 為什麼：Whisper 常把兩個相鄰的字黏成一顆 word（例：「…帶上來」＋「世」→ "來世"），
// 而 script.txt 的斷句標點就落在那顆 word 的中間（「…帶上來，」）。
// _scriptBreaks 只能取 word.end，斷幕就會晚一個字才發生 →
// 字幕變成「…一起帶上來世 / 芯-KY」，把股票名「世芯-KY」攔腰切開
// （2026-09-01 使用者回報）。
// 這裡把這種 word 依斷點切成多顆（時間依「對到的字數」線性內插），
// 讓每個斷句點永遠落在 word 邊界上，Subtitles.tsx 才切得準。
// 只切「斷點不在最後一個字」的 word；其餘 word 原封不動（含 probability 等欄位）。
let midWordCuts = 0;
for (const seg of subs.segments) {
  if (!seg.words) continue;
  const rebuilt = [];
  for (const w of seg.words) {
    const idxs = wordToScriptIdx.get(w) || [];
    const cutAfter = [];
    for (let k = 0; k < idxs.length - 1; k++) {
      if (scriptChars[idxs[k]].breakAfter) cutAfter.push(k);
    }
    if (cutAfter.length === 0) {
      rebuilt.push(w);
      continue;
    }
    midWordCuts += cutAfter.length;
    const leading = (w.word.match(/^\s+/) || [''])[0];
    const dur = w.end - w.start;
    const total = idxs.length;
    const bounds = [-1, ...cutAfter, total - 1];
    for (let b = 0; b < bounds.length - 1; b++) {
      const from = bounds[b] + 1;
      const to = bounds[b + 1];
      const piece = {
        ...w,
        word:
          (b === 0 ? leading : '') +
          idxs.slice(from, to + 1).map((i) => scriptChars[i].char).join(''),
        start: Number((w.start + (dur * from) / total).toFixed(3)),
        end: Number((w.start + (dur * (to + 1)) / total).toFixed(3)),
      };
      for (let k = from; k <= to; k++) scriptCharToWord[idxs[k]] = piece;
      rebuilt.push(piece);
    }
  }
  seg.words = rebuilt;
  seg.text = seg.words.map((w) => w.word.replace(/^\s+/, '')).join('');
}
if (midWordCuts > 0) {
  console.log(`✂️  ${midWordCuts} 個斷句點原本落在 whisper word 中間，已把該 word 切開`);
}

// ─── 7. 強制換幕點：直接標在 word 上（breakAfter），另存 _scriptBreaks 當相容欄位 ──
//
// ⚠️ 2026-09-15：這裡本來只輸出時間（`_scriptBreaks`），Subtitles.tsx 再拿時間去「猜」是哪顆 word
//    （0.05 秒容差）。這一步是資訊遺失 —— 這裡明明知道斷點屬於 `scriptCharToWord[i]` 那顆 word，
//    存成 float 之後就分不出來了。三次同樣的 bug（0903 再創歷史新／高、0911 DRA／M、
//    0915 靜／待週四）全都是那個容差在相鄰兩顆 word 之間誤判，每次只能再補一條判斷規則。
//    現在直接把「這顆 word 之後要換幕」標在 word 上，渲染端不必再比時間，這一類就不會再出現。
//    `_scriptBreaks` 保留：舊的 subtitles.json 沒有 breakAfter，渲染端要靠它走舊路。
const breakSet = new Set();
for (let i = 0; i < scriptChars.length; i++) {
  if (!scriptChars[i].breakAfter) continue;
  const w = scriptCharToWord[i];
  if (!w) continue;
  w.breakAfter = true;
  breakSet.add(Number(w.end.toFixed(3)));
}
subs._scriptBreaks = [...breakSet].sort((a, b) => a - b);

// ─── 8. _scriptCharTimes（每個 cleaned script char 的時間戳，給 anchor 用）
subs._scriptCharTimes = scriptChars.map((_, i) => {
  const w = scriptCharToWord[i];
  return w ? { start: w.start, end: w.end } : { start: 0, end: 0 };
});
// 8b. _scriptText：同一份 cleaned script 的原文（跟 _scriptCharTimes 一一對應、同長度）。
//     渲染端要看「兩段配圖之間夾的是字還是標點」才能決定要不要接續（2026-09-07 使用者定案，
//     見 src/DapanXiaobao/dapan-timeline.ts joinPunctuationAdjacent）；沒有這欄的舊 state 就退回純時間規則。
subs._scriptText = cleanScriptText;

// ─── 9. 跨 word 替換工具（subtitles-replacements 與反向發音替換共用）
// 跨多個 word 命中時，會：
//   ① 保留 firstWord 中匹配前的字（before-match）
//   ② 保留 lastWord 中匹配後的字（after-match）
//   ③ 把替換字串依字數平均分配到涉及的多個 word（保留 timing — 避免整段字幕擠到第一個 word 的小時段）
function applyCrossWordReplace(words, from, to) {
  if (!from) return;
  let combined = '';
  const charMap = [];
  for (let wi = 0; wi < words.length; wi++) {
    const t = words[wi].word.replace(/^\s+/, '');
    for (let ci = 0; ci < t.length; ci++) {
      combined += t[ci];
      charMap.push({ wordIdx: wi, charIdx: ci });
    }
  }
  let searchFrom = 0;
  while (true) {
    const idx = combined.indexOf(from, searchFrom);
    if (idx < 0) break;
    const end = idx + from.length;
    const firstWordIdx = charMap[idx].wordIdx;
    const lastWordIdx = charMap[end - 1].wordIdx;
    if (firstWordIdx === lastWordIdx) {
      words[firstWordIdx].word = words[firstWordIdx].word.split(from).join(to);
    } else {
      const firstWordCharIdx = charMap[idx].charIdx;
      const lastWordCharIdx = charMap[end - 1].charIdx;
      const firstWordOriginal = words[firstWordIdx].word.replace(/^\s+/, '');
      const lastWordOriginal = words[lastWordIdx].word.replace(/^\s+/, '');
      const firstWordLeading = (words[firstWordIdx].word.match(/^\s+/) || [''])[0];
      const lastWordLeading = (words[lastWordIdx].word.match(/^\s+/) || [''])[0];
      const beforeMatch = firstWordOriginal.slice(0, firstWordCharIdx);
      const afterMatch = lastWordOriginal.slice(lastWordCharIdx + 1);

      // 如果 beforeMatch 不是空（firstWord 開頭有非匹配字），讓 beforeMatch 獨佔 firstWord：
      // 這樣斷句點落在 firstWord 之後的話，beforeMatch 跟替換字串就會被分到不同 phrase。
      // 反之亦然：afterMatch 不空 → lastWord 結尾的 afterMatch 留著、replacement 不擠進去。
      // 替換字串只分配到「真正承載 match 的 word」(recipientStart..recipientEnd)。
      const recipientStart = beforeMatch ? firstWordIdx + 1 : firstWordIdx;
      const recipientEnd = afterMatch ? lastWordIdx - 1 : lastWordIdx;

      if (beforeMatch) words[firstWordIdx].word = firstWordLeading + beforeMatch;
      if (afterMatch) words[lastWordIdx].word = lastWordLeading + afterMatch;

      const recipientCount = recipientEnd - recipientStart + 1;
      if (recipientCount >= 1) {
        const toLen = to.length;
        for (let i = 0; i < recipientCount; i++) {
          const wi = recipientStart + i;
          const sliceStart = Math.floor((i * toLen) / recipientCount);
          const sliceEnd = Math.floor(((i + 1) * toLen) / recipientCount);
          const piece = to.slice(sliceStart, sliceEnd);
          // recipient 範圍內如果剛好是 firstWord 或 lastWord，要保留它原本要保留的部分
          let pre = '';
          let post = '';
          let leading;
          if (wi === firstWordIdx) {
            leading = firstWordLeading;
            pre = beforeMatch;
          } else if (wi === lastWordIdx) {
            leading = lastWordLeading;
            post = afterMatch;
          } else {
            leading = (words[wi].word.match(/^\s+/) || [''])[0];
          }
          words[wi].word = leading + pre + piece + post;
        }
      } else {
        // recipient 範圍空（before 跟 after 把所有 word 都佔了）— 沒地方放 replacement
        // 為了不丟字，把整段 replacement 塞回 lastWord 開頭（壓在 afterMatch 之前）
        words[lastWordIdx].word = lastWordLeading + to + afterMatch;
      }
    }
    combined = combined.slice(0, idx) + to + combined.slice(end);
    const newChars = to.split('').map(() => ({ wordIdx: firstWordIdx, charIdx: 0 }));
    charMap.splice(idx, from.length, ...newChars);
    searchFrom = idx + to.length;
  }
}

// ─── 10. 反向發音替換（先跑，當權威來源 — 例：「百分之四點三九 → 4.39%」）
// 順序重要：反向發音替換代表 script.txt 作者的意圖，要比 subtitles-replacements（fallback）優先觸發。
// 若 fallback 先跑，會把「四點三九」攔截成「4.39」，讓反向規則的「百分之四點三九 → 4.39%」失效。
// 2026-08-19：反向還原也要「長的先做」。短的先還原會把長規則的產出拆掉，
// 字幕就變成半還原的怪字串（同 applyVoiceRulesForward 那條註解的道理）。
const voiceRules = parseVoiceRules(scriptRaw)
  .sort((a, b) => (b.to || '').length - (a.to || '').length);
for (const seg of subs.segments) {
  if (!seg.words) continue;
  for (const rule of voiceRules) {
    applyCrossWordReplace(seg.words, rule.to, rule.from);
  }
  seg.text = seg.words.map((w) => w.word.replace(/^\s+/, '')).join('');
}

// ─── 11. 套 subtitles-replacements（fallback；反向規則沒處理到的才會用）
if (fs.existsSync(REPLACEMENTS_PATH)) {
  const replacements = JSON.parse(fs.readFileSync(REPLACEMENTS_PATH, 'utf-8'));
  for (const seg of subs.segments) {
    if (!seg.words) continue;
    for (const rule of replacements) {
      applyCrossWordReplace(seg.words, rule.from, rule.to);
    }
    seg.text = seg.words.map((w) => w.word.replace(/^\s+/, '')).join('');
  }
  console.log(`🔄 套用 ${replacements.length} 條自訂替換規則（fallback）`);
}

// ─── 12. 備份 + 寫回 ───────────────────────────────────
if (!fs.existsSync(BACKUP_PATH)) {
  fs.writeFileSync(BACKUP_PATH, fs.readFileSync(SUBS_PATH, 'utf-8'));
  console.log(`📦 備份原始字幕 → ${path.relative(ROOT, BACKUP_PATH)}`);
}
fs.writeFileSync(SUBS_PATH, JSON.stringify(subs, null, 2));

// ─── 13. 報告 ──────────────────────────────────────────
console.log(`\n✅ Forced alignment 完成！共重組 ${reports.length} 個 whisper word：\n`);
for (const r of reports.slice(0, 40)) {
  console.log(`  ${r.time}  ${r.from || '(空)'}  →  ${r.to || '(空)'}`);
}
if (reports.length > 40) console.log(`  ... 還有 ${reports.length - 40} 筆`);
console.log(`\n📌 ${subs._scriptBreaks.length} 個強制換幕點 / ${subs._scriptCharTimes.length} 個 script char 時間戳`);
console.log(`   字幕已寫回 → ${path.relative(ROOT, SUBS_PATH)}\n`);
console.log(`   想還原？刪掉 subtitles.json 改名 subtitles.original.json → subtitles.json\n`);
