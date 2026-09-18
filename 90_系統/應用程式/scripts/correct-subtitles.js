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
 *      - scriptExtra：整段沒對到（whisper 漏聽）且空白夠放 → 依字數把空白攤平，補出合成 word（第 5.5 步）；
 *                     補不起來的才附給時間上最近的 whisper word
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
// ─── 5.5 whisper 漏聽一整段 → 依稿件字數把那段空白攤平 ────────
//
// 2026-09-18 使用者定案：「時間可能差個零點幾秒、但片子出得來」。
//
// 為什麼補得起來：這支程式的前提就是「字幕文字 100% 來自 script.txt，whisper 只負責提供時間」。
// whisper 偶爾會在 30 秒 window 邊界整段漏聽（實例：09-18 那支從 25.72 秒起 4.28 秒
// 完全沒轉出東西），但這時我們手上其實兩份資訊都在 —— ①那段空白的起訖時間、
// ②稿件裡缺的是哪幾個字；缺的只是「這幾個字各自落在哪」。中文語速穩定，
// 按字數把空白均分的誤差在零點幾秒，遠比整支片停在出片前划算。
//
// 不補會怎樣（這一步存在的理由）：下面的 scriptExtra 規則會把這 32 個字全掛到
// 時間上最近的那一顆 word 上 → 擠成 0.87 秒 → 被 11.5 的守門擋下 → 停線。
// 資訊其實沒丟，是對齊邏輯沒去用它。
//
// ⚠️ 只補「補得起來」的洞。空白不夠放（每字低於 MIN_SEC_PER_CHAR）就不補，留給下面的
// 鄰居 fallback，讓守門照常擋 —— 那種不是漏聽而是 whisper 的時間軸整體歪掉
// （09-18 第二次失敗就是：結尾 20 個字只剩 1.27 秒可放，攤平也只是讓它閃得比較平均而已）。
// 分流的另一半在 11.5：補洞比例過高、或 whisper 自報 segment 時長對不上字數，一律照擋。
// **我們補的是「沒聽到」，不是「聽錯位置」。**
const MIN_SEC_PER_CHAR = 0.1;  // 攤平後每字至少要有這麼久，否則不算救回來（閃過的字幕沒有意義）
const MAX_FILL_RATIO = 0.25;   // 補洞字數佔全稿的上限；超過表示這份轉錄整體不可信（見 11.5 的 C 判準）
// 幾個字以上才算「漏聽一段」。小洞一律維持原本的鄰居 fallback，不要碰 ——
// 這條門檻是為了**不動到正常影片**：PUNCT_RE 會把「%」濾掉（第 3 步），於是每支稿件裡的
// 「38%」都會產生一個 1 個字的洞；沒有這條門檻，那個 % 就會被補成一顆獨立 word
// （實測 09-18 那支有 3 處），等於在所有正常片子上改變斷句行為，只為了修一個不存在的問題。
// 8 這個數字的來由：守門 A 判準是「連續 15 個字擠在 1 秒內」，洞要接近那個規模才會真的擋片；
// 而 8 個字以上掛到同一顆 word，人眼也已經看得出字幕突然跳掉一段。8 以下兩者都不成立。
const MIN_GAP_CHARS = 8;

// B 判準要看的是「whisper 自己聽到多少字」，所以在補洞之前先記下來 ——
// 補完之後 seg.text 會被第 6 步重寫成含補出來的字，用那個算會把 B 的敏感度洗掉。
for (const seg of subs.segments) {
  seg._whisperChars = (seg.text || '').replace(new RegExp(PUNCT_RE.source, 'g'), '').length;
}

// 結尾漏聽時要知道「可以攤到哪裡」。video-meta.json 由 transcribe.sh 寫，讀不到就退回最後一顆 word。
function readAudioEnd() {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'video-meta.json'), 'utf-8'));
    const sec = Number(meta.heygenDurationSec);
    if (Number.isFinite(sec) && sec > 0) return sec;
  } catch (_) { /* 沒有 meta 就用下面的 fallback */ }
  let last = 0;
  for (const seg of subs.segments) for (const w of seg.words || []) last = Math.max(last, w.end);
  return last;
}

const audioEnd = readAudioEnd();
const insertAfter = new Map();  // prevWord（null＝整份最前面）→ 要接在它後面的合成 word
const filledGaps = [];
const skippedGaps = [];

for (let i = 0; i < scriptChars.length;) {
  if (scriptCharToWord[i]) { i++; continue; }
  let j = i;
  while (j < scriptChars.length && !scriptCharToWord[j]) j++;
  // [i, j) 這段稿件字，whisper 一個都沒對到
  const prevWord = i > 0 ? scriptCharToWord[i - 1] : null;
  const nextWord = j < scriptChars.length ? scriptCharToWord[j] : null;
  const from = prevWord ? prevWord.end : 0;
  const to = nextWord ? nextWord.start : audioEnd;
  const n = j - i;
  const span = to - from;
  const perChar = span / n;
  if (n < MIN_GAP_CHARS) {
    // 小洞不碰（多半是被 PUNCT_RE 濾掉的「%」這種），走下面的鄰居 fallback ——
    // 維持 2026-09-18 之前就在跑的行為，不列入 skippedGaps（它不是「補不起來的漏聽」）。
  } else if (span > 0 && perChar >= MIN_SEC_PER_CHAR) {
    const made = [];
    for (let k = 0; k < n; k++) {
      const w = {
        word: scriptChars[i + k].char,   // 第 6 步會照 wordToScriptChars 再寫一次，這裡先放著
        start: Number((from + perChar * k).toFixed(3)),
        end: Number((from + perChar * (k + 1)).toFixed(3)),
        probability: 0,   // 0 ＝ 這顆不是 whisper 聽出來的，是我們按字數補的
        filled: true,
      };
      made.push(w);
      scriptCharToWord[i + k] = w;
    }
    insertAfter.set(prevWord, (insertAfter.get(prevWord) || []).concat(made));
    filledGaps.push({ from: Number(from.toFixed(2)), to: Number(to.toFixed(2)), chars: n, secPerChar: Number(perChar.toFixed(3)),
      text: cleanScriptText.slice(i, j) });
  } else {
    // 補不起來：留給鄰居 fallback，交給 11.5 的守門判
    skippedGaps.push({ from: Number(from.toFixed(2)), to: Number(to.toFixed(2)), chars: n, secPerChar: Number(perChar.toFixed(3)) });
  }
  i = j;
}

// 把合成 word 插回 segment。只動 words，不碰 seg.start／seg.end ——
// 渲染端（Subtitles.tsx）是把所有 segment 的 words 攤平成一條 list 在用，不看 segment 邊界；
// 而 11.5 的 B 判準要的正是 whisper 自報的那個原始區間，動了就等於把證據擦掉。
if (insertAfter.size) {
  for (const seg of subs.segments) {
    if (!seg.words) continue;
    const rebuilt = [];
    for (const w of seg.words) {
      rebuilt.push(w);
      const add = insertAfter.get(w);
      if (add) rebuilt.push(...add);
    }
    seg.words = rebuilt;
  }
  const head = insertAfter.get(null);
  if (head) {
    const first = subs.segments.find((s) => Array.isArray(s.words));
    if (first) first.words.unshift(...head);
  }
  for (const g of filledGaps) {
    console.log(`🩹 whisper 漏聽 ${g.from}～${g.to} 秒（${g.chars} 個字「${g.text.slice(0, 12)}${g.text.length > 12 ? '…' : ''}」）`
      + ` → 已用稿件字數把時間攤平（每字 ${g.secPerChar} 秒）`);
  }
}
subs._filledGaps = filledGaps;

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

// ─── 11.5 出片前健全性檢查：字幕時間軸有沒有整條壞掉 ──────────
//
// 為什麼要有這一關（2026-09-16 實際出片事故）：
//   whisper 是分 30 秒 window 解碼的，偶爾會在 window 邊界把某句話的結束時間報得離譜
//   （實例：24.72 秒那句只有 22 個字，卻被報成撐到 36.56 秒），之後整條時間軸往後偏 8 秒，
//   音檔時間用完時稿件還剩一大段沒有時間可放。
//   上面第 5 步的 scriptExtra 規則「附給時間上最近的 whisper word」是為了不丟字，
//   但遇到這種情況就變成：結尾 49 個字全部掛到同一顆 word（0.19 秒）。
//   成品是「字幕上到一半就不動了，最後一瞬間整段閃過」—— 而整條 pipeline 一聲不吭照樣出片，
//   只能靠人盯著看才發現。所以這裡寧可停下來，也不要讓壞掉的片流出去。
//
// 2026-09-18 之後這一關的角色變成「分流的後半段」：
//   ・whisper **沒聽到**一段（時間軸其餘是準的）→ 第 5.5 步已經按稿件字數把空白攤平，
//     那些字有了合理時間，A 判準自然就不會觸發 → 放行，片子出得來。
//   ・whisper **聽錯位置**（時間軸整體歪掉）→ 5.5 補不動（空白根本不夠放），
//     或雖然補了但補太多（C 判準）→ 照樣擋在這裡。
//   換句話說：能用稿件算回來的就算回來，只有真的算不回來才停線。
//
// ⚠️ 判準只抓「一定是壞的」，寧可漏抓也不要誤擋：正常影片離這幾條線都很遠
//    （實測正常那支：最多 7 個字共用一顆 word、最長 segment 0.19 秒/字）。
const PUNCT_ALL_RE = new RegExp(PUNCT_RE.source, 'g');

function detectTimelineFailure() {
  const problems = [];
  const times = subs._scriptCharTimes;

  // A. 症狀：一堆字擠在極短的時間內 → 觀眾根本看不到，或最後一瞬間全部閃過。
  //    正常講話 15 個字至少要 2 秒以上；擠在 1 秒內只有「沒有時間可放，全部堆到同一顆 word」一種可能。
  const RUN = 15;
  const SPAN = 1.0;
  for (let i = 0; i + RUN <= times.length; i++) {
    if (times[i + RUN - 1].end - times[i].start >= SPAN) continue;
    let j = i + RUN;
    // 往後把整團吃完。用「平均每字幾秒」延伸（跟上面的門檻同一個：SPAN / RUN），
    // 不要用「距離團塊起點 SPAN 秒」硬切 —— 那會把 64 個字的一團截成 50 個，
    // 訊息還會因此說成「第 240～289 個字」而不是「最後 64 個字」。
    while (j < times.length && (times[j].end - times[i].start) / (j - i + 1) < SPAN / RUN) j++;
    const n = j - i;
    const span = times[j - 1].end - times[i].start;
    // 這一團不一定在結尾（whisper 中間漏聽一整段也會這樣），措辭要跟著位置走，
    // 不能一律說「最後」—— 講錯位置會害人往錯的地方找。
    const where = j >= times.length ? `最後 ${n} 個字` : `第 ${i + 1}～${j} 個字（共 ${n} 個）`;
    const before = cleanScriptText.slice(Math.max(0, i - 12), i);
    problems.push(
      `${where}「${cleanScriptText.slice(i, i + 12)}…」全部擠在 `
      + `${times[i].start.toFixed(2)}～${times[j - 1].end.toFixed(2)} 秒（只有 ${span.toFixed(2)} 秒）內。\n`
      + `     觀眾會看到字幕${before ? `停在「${before}」之後就不動` : '從頭就跟不上語音'}，`
      + `這一段會在一瞬間全部閃過。`
    );
    break; // 報第一團就夠，後面通常是同一個原因
  }

  // B. 根因：whisper 自己報的 segment 時長對不上它的字數。
  //    這是「window 邊界把結束時間報過頭」的直接指紋，比 A 更早、更能指出壞在第幾秒。
  //    ⚠️ 字數一定要用 `_whisperChars`（5.5 在補洞之前記下的 whisper 原始字數），
  //    不能用 seg.text —— 第 6 步已經把補出來的字寫進 seg.text 了，拿它算會讓分母變大、
  //    把這條判準洗掉。B 問的是「whisper 自己聽到的字撐不撐得住它自己報的時長」。
  for (const seg of subs.segments) {
    const n = Number.isFinite(seg._whisperChars)
      ? seg._whisperChars
      : (seg.text || '').replace(PUNCT_ALL_RE, '').length;
    const dur = seg.end - seg.start;
    if (!n || dur <= 6 || dur / n <= 0.4) continue;
    problems.push(
      `whisper 把 ${seg.start.toFixed(2)} 秒那句的結束時間報成 ${seg.end.toFixed(2)} 秒 —— `
      + `那句只有 ${n} 個字卻佔了 ${dur.toFixed(1)} 秒（每字 ${(dur / n).toFixed(2)} 秒，正常約 0.15）。\n`
      + `     從這裡開始整條字幕會落後語音，後面的字被往後擠。`
    );
    break;
  }

  // C. 5.5 補的洞太多 → 這份轉錄整體不可信，不要用「攤平」把它蓋過去。
  //    補洞的前提是「whisper 只是漏聽一小段，其餘時間軸是準的」—— 我們靠兩端那兩顆真 word
  //    把空白夾出來。漏掉的比例一大，那個前提就不成立了（夾出來的區間本身可能就是歪的），
  //    再攤平只是把「看不出來的錯」做得更像對的。寧可停在這裡交回給人。
  const filledChars = (subs._filledGaps || []).reduce((s, g) => s + g.chars, 0);
  if (filledChars > cleanScriptText.length * MAX_FILL_RATIO) {
    const pct = ((filledChars / cleanScriptText.length) * 100).toFixed(0);
    problems.push(
      `whisper 這次漏聽了 ${filledChars} 個字（佔整篇 ${pct}%，共 ${subs._filledGaps.length} 段）—— `
      + `超過可以用稿件補回來的上限（${(MAX_FILL_RATIO * 100).toFixed(0)}%）。\n`
      + `     漏這麼多表示整條時間軸都不可信，補出來的時間會是猜的，不是差零點幾秒的問題。`
    );
  }
  return problems;
}

const timelineProblems = detectTimelineFailure();
if (timelineProblems.length) {
  // 故意不寫回 subtitles.json：留著 whisper 原始輸出，不要讓半成品混進後面的配圖與 render。
  console.error('\n❌ 字幕時間軸壞掉，已停在出片前（沒有寫回 subtitles.json）\n');
  for (const p of timelineProblems) console.error(`  ・${p}\n`);
  console.error('  這是 whisper 在 30 秒 window 邊界的解碼失敗，不是稿件或配音的問題。');
  console.error('  同一個音檔原樣重跑會得到一模一樣的結果（實測跑三次完全相同），');
  console.error('  所以重跑時會在音檔前面墊一段靜音，換一個 window 邊界再轉；\n');
  console.error('  墊多少是逐支音檔碰運氣（壞掉的 pad 值每支不同），所以會依序試幾個間距拉開的值。\n');
  // 5.5 想補但補不起來的洞：這是「時間軸歪掉」而不是「單純漏聽」的直接證據，
  // 印出來才知道停線不是補洞漏做，是那段時間根本塞不下那些字。
  for (const g of skippedGaps) {
    console.error(`  （${g.from}～${g.to} 秒要放 ${g.chars} 個字、每字只有 ${g.secPerChar} 秒 —— `
      + `低於可攤平的下限 ${MIN_SEC_PER_CHAR} 秒，所以第 5.5 步沒有補它。）`);
  }
  if (skippedGaps.length) console.error('');
  process.exit(3); // 3 = 時間軸判定失敗（run.js 靠這個 code 決定要不要墊靜音重跑）
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
