import React from 'react';
import { AbsoluteFill, Sequence } from 'remotion';
import { secToFrame } from './timeline';
import subtitleData from './subtitles.json';
import emphasisData from './emphasis.generated.json';

/**
 * Whisper 輸出的字幕格式
 */
type WhisperWord = {
  word: string;
  start: number;
  end: number;
  /**
   * 「這顆字之後要換幕」—— correct-subtitles.js 第 7 步直接標上來的權威斷點
   * （2026-09-15）。有這個欄位就不必再拿 `_scriptBreaks` 的時間去猜是哪顆字。
   * 舊的 subtitles.json 沒有這個欄位 → 整份都沒有 → 退回時間比對那條路。
   */
  breakAfter?: boolean;
};

type WhisperSegment = {
  start: number; // 秒
  end: number;   // 秒
  text: string;
  words?: WhisperWord[];
};

type WhisperOutput = {
  segments: WhisperSegment[];
  language?: string;
  /** 從 public/script.txt 的逗號/句號推算出的強制換幕時間（秒） */
  _scriptBreaks?: number[];
};

type Phrase = {
  start: number;
  end: number;
  text: string;
  /**
   * `text` 每一個字對應的**腳本字元索引**（插進去的空白／頓號是 -1）。
   *
   * 重點詞（2026-09-17）標的是腳本字元範圍，而字幕是 word 拼出來的短句 —— 中間隔著
   * 標點裁切、空白還原、編號合併三道加工，長度對不上，所以要逐字帶著索引走。
   * ⚠️ 驗證過：所有 word 去空白後拼起來，剛好等於 `_scriptCharTimes` 的字元序列
   *    （同一支 303 = 303），所以游標只在「非空 word」前進就對得上。
   */
  map: number[];
};

const data = subtitleData as WhisperOutput;

/**
 * 重點詞（2026-09-17 使用者定案）：整句維持白字一般大小，只有標到的詞放大變黃。
 * 標記在配圖計畫頁人工拖選，存腳本字元範圍 —— 不存文字，因為同一個詞在句子裡
 * 可能出現兩次，存文字分不出標的是哪一個。
 */
export const SUBTITLE_EMPHASIS = {
  color: '#FFE600',
  /**
   * 放大倍率。⚠️ 用 em **不能**寫死 px —— 橫式（DapanLandscapeComposition）用 textStyle
   * 把字幕基準字級改成 52，寫死 92 的話那邊會變成 1.77 倍，大得離譜。
   * 1.3 倍是實渲比過的：直式 70→91 剛好，82 那一版力道不夠。
   */
  scale: 1.3,
};

type EmphasisMark = { startCharIdx: number; endCharIdx: number };

/** 攤平成「這個腳本字元要不要高亮」。字數只有幾百，用 Set 最直接。 */
const EMPHASIS_CHARS: Set<number> = new Set();
for (const m of ((emphasisData as { marks?: EmphasisMark[] }).marks ?? [])) {
  if (typeof m?.startCharIdx !== 'number' || typeof m?.endCharIdx !== 'number') continue;
  const lo = Math.min(m.startCharIdx, m.endCharIdx);
  const hi = Math.max(m.startCharIdx, m.endCharIdx);
  for (let i = lo; i <= hi; i++) EMPHASIS_CHARS.add(i);
}

/**
 * 把 Whisper 的長 segment 切成多個短句以利顯示。
 *
 * 切點優先順序（2026-05-28 改：嚴格跟 script.txt 標點，不再用字數硬斷）：
 *   1. ⭐ script.txt 的強制換幕點（最優先）：word 自己帶的 breakAfter 標記，
 *      舊檔沒有標記才退回 _scriptBreaks 的時間比對
 *   2. 上一字結尾為 ，。？！ 等標點
 *   3. 與下個字之間停頓 > GAP_THRESHOLD（換氣，safety net）
 *
 * 不再用字數上限切（之前 MAX_CHARS=10 會在 script 沒寫標點的長句中亂斷）。
 * 太長的句子由 SubtitleLine 的 maxWidth 自動換行處理。
 *
 * 不再合併太短的句子（用戶 2026-05-28 要求嚴格跟 script.txt 結構、短句也保留）。
 */
const GAP_THRESHOLD = 0.5;
const BREAK_TOLERANCE = 0.05; // 比對 _scriptBreaks 時的時間容差（秒）
// 2026-08-10 只認「全形」標點當斷句點；半形 , . ! ? : ; 不斷（數字裡的 44,396 / 1.95% 不被切）
const PUNCT_RE = /[，。、！？：；]/;

// 2026-09-03：斷點只認「離它最近的那個字」。0903 南亞科：新(–3.30)高(3.30–3.347)，斷點在高的結尾 3.347，
// 但 3.30 也落在 0.05 容差內 → 在「新」後面提早切一刀、「高」又自己再切一刀，變成 0.047 秒的獨立字幕閃一下
// （使用者：「『再創歷史新高』變成『再創歷史新』『高』」）。下一個字的結尾離斷點更近，這個字就先不切。
//
// 2026-09-11：平手（兩個字的結尾跟斷點距離一樣）時要切**後面**那個，原本的 >= 會切前面 →
// 同一個症頭又出現一次。0911 鎧俠那支：「利基型 DRAM！」的 M 是 correct-subtitles 的強制對齊
// 從 whisper 時間戳 token 還原出來的，start === end === 14.52，剛好就是 ！ 的斷點時間。
// 於是 A（結尾 14.52）與 M（結尾 14.52）距離都是 0，>= 成立 → 在 M 前面切一刀，
// 字幕變成「但晶豪科主攻利基型DRA」＋只有 1 frame 的「M」（使用者回報：DRAM 變成 DRA／M）。
// 改成 > 之後：A 不切（0 > 0 不成立）、M 切（下一個字「8」結尾 14.84，距離 0.32 > 0）。
// 0903 那個案子不受影響（0.047 vs 0，> 與 >= 同樣不切）。
//
// 2026-09-15：**一個斷點只能切一刀**（used）。上面那個「離它最近」只往後看一個字，看不到
// 「這個斷點剛剛已經切過了」。0915 大盤：「第二、靜待週四」的、斷點在 37.12，第二(–37.12)
// 距離 0 → 切（正確）；下一個字 靜(37.12–37.13) 距離 0.01 也還在容差內，而再下一個字
// 待(–37.34) 距離 0.22 更遠 → 前向比較成立，同一個斷點又切了第二刀，「靜」變成 0.01 秒的
// 獨立字幕（使用者：「『靜待』字幕被切斷了，應該要連在一起」）。同一支片還有「千／萬別亂接刀」
// 「與／外本比排行榜」兩處。斷點用掉就劃掉，後面的字再近也不能重複使用。
// 回傳用掉的斷點索引（−1 ＝ 沒有），真的切下去才標記 —— midNumber 擋掉的那次不算用掉。
function findScriptBreak(
  endTime: number,
  breaks: number[],
  used: boolean[],
  nextEnd?: number
): number {
  return breaks.findIndex(
    (t, i) =>
      !used[i] &&
      Math.abs(endTime - t) < BREAK_TOLERANCE &&
      (nextEnd == null || Math.abs(nextEnd - t) > Math.abs(endTime - t))
  );
}

/**
 * 收尾一段字幕：去掉尾端標點與前後空白，**`map` 要跟著裁**，
 * 不裁的話後面每一個字的索引都會偏掉、重點詞就標到隔壁字上。
 * `extra` 是額外要當成尾端標點的字元（收整份的最後一段時多吃一個半形逗號，沿用原行為）。
 */
function closePhrase(p: Phrase, extra = ''): Phrase {
  const tail = new RegExp(`[，。、${extra}\\s]`);
  let end = p.text.length;
  while (end > 0 && tail.test(p.text[end - 1])) end--;
  let start = 0;
  while (start < end && /\s/.test(p.text[start])) start++;
  return { ...p, text: p.text.slice(start, end), map: p.map.slice(start, end) };
}

/**
 * 整份字幕能不能對回腳本字元。只要有一段是「沒有 words 的舊格式 segment」就設成 false ——
 * 那種段落算不出字元索引，硬標會標到錯的字上，寧可整份不標（2026-09-17）。
 */
let phrasesAlignable = true;

function splitIntoPhrases(
  segments: WhisperSegment[],
  breaks: number[] = []
): Phrase[] {
  const raw: Phrase[] = [];
  /** 消化到腳本的第幾個字（只有非空 word 會前進，見 Phrase.map 的說明） */
  let cursor = 0;
  phrasesAlignable = true;

  // 把所有 segment 的 word 攤平成一條 list — 不再每個 segment 重置 current。
  // 原因：Whisper 的 segment 邊界是它自己分析出來的（常常切在奇怪的地方），
  // 真正該斷句的時機是腳本標點（_scriptBreaks）跟換氣停頓（gap）。
  // 用 segment 重置 phrase 會在 segment 邊界硬切，讓「籤 / 3090」這種應該分開的字綁在一起、
  // 或「大戶買散戶賣頁 / 籤30」這種應該連起來的字反而被切散。
  const allWords: WhisperWord[] = [];
  for (const seg of segments) {
    if (!seg.words || seg.words.length === 0) {
      const t = seg.text.trim();
      raw.push({ start: seg.start, end: seg.end, text: t, map: new Array(t.length).fill(-1) });
      phrasesAlignable = false;   // 這段對不回腳本 → 整份停用重點詞
      continue;
    }
    for (const w of seg.words) allWords.push(w);
  }

  // 斷點來源二選一（2026-09-15）：
  //   ① word 自己帶 breakAfter（correct-subtitles.js 標的）→ 直接切，不比時間、不會誤判。
  //   ② 舊的 subtitles.json 沒有標記 → 退回 `_scriptBreaks` 時間比對（容差＋用過就劃掉）。
  // 整份有沒有標記是一次判定，不逐字混用 —— 混用的話「沒被標到的字」會再走一次時間比對，
  // 等於把剛拿掉的誤判又放回來。
  const hasBreakMarks = allWords.some((w) => w.breakAfter);
  // 每個斷點只能用一次（見 findScriptBreak）。只有走時間比對那條路才需要。
  const usedBreaks: boolean[] = breaks.map(() => false);
  // current 結尾是哪一顆 word —— 判斷「這顆之後要不要換幕」用。
  let lastWord: WhisperWord | null = null;
  let current: Phrase | null = null;
  for (let wi = 0; wi < allWords.length; wi++) {
    const w = allWords[wi];
    // Whisper 的英文 word 會帶 leading space（例 " goodbye"），是 word 邊界提示；
    // trim 拿來判斷有沒有內容，但串接時要把該空白還原成分隔符（不然「Say goodbye」會變「Saygoodbye」）
    //
    // ⚠️ 2026-09-01：這個還原**不能無條件做**。Whisper 只要在某個中文字前面聽到停頓，
    //    就會把它當新 token 加上 leading space（例：「世」講完停 0.4 秒 →「 芯」），
    //    無條件還原就會在字幕上看到「世 芯-KY」。實測 53.8 秒那支有 18 處，
    //    連「照進度交 貨」都被拆開。使用者定案：「就算念起來停頓了一下，
    //    字幕照上、不要出現空白鍵在字幕裡」，中英之間也一律不留（「台積電CPO」）。
    //    → 只有「空白兩側都是英數」才還原，這種才是真的詞邊界（Say goodbye）。
    //    生成端 correct-subtitles.js 第 6.2 步也做了同一件事（leading 以 script.txt 為權威），
    //    這裡是保險：用 --skip-transcribe 沿用舊 subtitles.json 時也要對。
    const hasLeadingSpace = /^\s/.test(w.word);
    const wordText = w.word.trim();
    if (!wordText) continue;
    // 這顆 word 佔腳本的哪幾個字
    const idx: number[] = [];
    for (let k = 0; k < wordText.length; k++) idx.push(cursor + k);
    cursor += wordText.length;
    if (current === null) {
      current = { start: w.start, end: w.end, text: wordText, map: idx };
      lastWord = w;
      continue;
    }
    const gap = w.start - current.end;
    const lastChar = current.text.slice(-1);
    // 只有全形標點才算斷句點（PUNCT_RE 已不含半形），所以半形 . , 結尾（1.95 / 44,396）自然不斷，
    // 不再需要「小數點兩側是數字」的特例。
    const prevEndsWithPunct = PUNCT_RE.test(lastChar);
    const breakIdx = hasBreakMarks
      ? -1
      : findScriptBreak(current.end, breaks, usedBreaks, w.end);
    const atScriptBreak = hasBreakMarks ? !!(lastWord && lastWord.breakAfter) : breakIdx >= 0;
    // 嚴格跟 script.txt 標點切：script break / Whisper word-end 標點 / 換氣停頓。不再用字數硬斷。
    // 數字中間絕不斷開：Whisper 唸「零點八八」時常在 0. 與 88 之間留停頓，
    // 只看 gap 就會把 0.88% 拆成「0.」「88%」兩行（2026-08-12 使用者回報）。
    // 前一段結尾是數字或小數點／千分位逗號，且下一個字以數字開頭 → 視為同一個數字，不斷。
    const midNumber = /[\d.,]$/.test(current.text) && /^[\d.,%]/.test(wordText);
    // ⚠️ 2026-09-11 試過再加一條「英文字母中間不准斷」（DRAM 被切成 DRA／M 時想到的），
    //    結果 0904 那支的「PCB、ABF」變成「PCBABF」—— 中間那個、本來就該斷，
    //    而 whisper 給 ABF 的 token 沒有 leading space，分不出「同一個字」還是「兩個字」。
    //    真正的斷點資訊在 _scriptBreaks（、有、DRAM 中間沒有），所以那一刀本來就該由
    //    斷點判斷那邊判掉，不要在這裡加英文特例。DRAM 那個 bug 修在斷點的平手處理。
    const shouldSplit =
      !midNumber && (atScriptBreak || prevEndsWithPunct || gap > GAP_THRESHOLD);

    if (shouldSplit) {
      // 真的切下去才把斷點劃掉：被 midNumber 擋掉的那次不算用過。
      if (breakIdx >= 0) usedBreaks[breakIdx] = true;
      raw.push(closePhrase(current));
      current = { start: w.start, end: w.end, text: wordText, map: idx };
      lastWord = w;
    } else {
      current.end = w.end;
      lastWord = w;
      const isAlnumEdge =
        /[0-9A-Za-z]$/.test(current.text) && /^[0-9A-Za-z]/.test(wordText);
      const sep = hasLeadingSpace && isAlnumEdge ? ' ' : '';
      current.text += sep + wordText;
      if (sep) current.map.push(-1);   // 還原出來的空白不屬於腳本任何一個字
      current.map.push(...idx);
    }
  }
  if (current) raw.push(closePhrase(current, ','));

  // 2026-05-28 起：不再合併太短句、嚴格跟 script.txt 結構（用戶要求）
  // 2026-09-15 唯一的例外：**編號**（第一、第二、第三…）跟後面那句接起來。
  // 「第一、資金動向由買轉賣」的頓號是真的斷點，但唸「第一」只花 0.08 秒 ——
  //  字幕等於閃一下就沒了（使用者定案「只合併編號那三個」，其餘短句照舊各自一段）。
  // 只有「整段就是一個編號」才合併；「第一季營收」這種不符合，不受影響。
  // 頓號補回去是為了讀得順（「第一資金動向…」會黏在一起）；其餘字幕仍然沒有標點。
  const ORDINAL_RE = /^第[一二三四五六七八九十百零兩\d]+$/;
  const merged: Phrase[] = [];
  for (const p of raw) {
    const prev = merged[merged.length - 1];
    if (prev && ORDINAL_RE.test(prev.text)) {
      prev.text += '、' + p.text;
      prev.map = prev.map.concat(-1, p.map);   // 補回去的頓號不屬於腳本
      prev.end = p.end;
      continue;
    }
    merged.push({ ...p, map: [...p.map] });
  }
  return merged.filter((p) => p.text.length > 0);
}

const PHRASES = splitIntoPhrases(data.segments, data._scriptBreaks ?? []);

if (typeof window !== 'undefined') {
  // eslint-disable-next-line no-console
  console.log(
    `[Subtitles] ${data.segments.length} 段 Whisper segment → ${PHRASES.length} 段短句（含 ${(data._scriptBreaks ?? []).length} 個 script 強制換幕點）`,
    PHRASES
  );
}

/**
 * 字幕層
 * - 把 Whisper 的長 segment 自動切成小段顯示
 * - 想做 TikTok 風格的字字高亮，要改成用 word-by-word
 */
// 2026-08-10 新增 optional 定位 props（向後相容）：
//   containerStyle → 疊在外層 AbsoluteFill 的預設定位之上（後者贏）
//   textStyle      → 疊在字幕文字 div 的預設樣式之上
// 不傳（直式 DapanComposition / 投廣模板 MarketingVideo 的 <Subtitles />）＝行為完全不變。
// 橫式 DapanLandscapeComposition 用這兩個 prop 把字幕改成「置中在左側講者區底部」。
type SubtitlesStyleProps = {
  containerStyle?: React.CSSProperties;
  textStyle?: React.CSSProperties;
};

export const Subtitles: React.FC<SubtitlesStyleProps> = ({
  containerStyle,
  textStyle,
}) => {
  return (
    <>
      {PHRASES.map((p, i) => {
        const from = secToFrame(p.start);
        const duration = Math.max(1, secToFrame(p.end - p.start));
        return (
          <Sequence
            key={`subtitle-${i}`}
            from={from}
            durationInFrames={duration}
          >
            <SubtitleLine
              text={p.text}
              map={p.map}
              containerStyle={containerStyle}
              textStyle={textStyle}
            />
          </Sequence>
        );
      })}
    </>
  );
};

/**
 * 連字號個股名（世芯-KY／矽力-KY…）與斜線日期（9/16、2026/09/16）不准在符號處折行。
 *
 * 2026-09-01 使用者定案：「只要出現 XX-XX 這個 `-` 就要留在畫面上，
 * 不要被當標點符號處理，不要被當斷句處理。」
 * 2026-09-15 使用者定案：「把 / 保留在字幕上，但是不要變成拆行依據，
 * 目標是 9/16 可以完整顯示在字幕上。」→ 斜線套用同一套保護。
 *
 * ⚠️ 減號在「切句」那一層本來就不是標點 —— `script-utils.js` 的 `BREAK_RE`／`OTHER_PUNCT_RE`
 *    與本檔的 `PUNCT_RE` 都沒有 `-`，所以它一直都會顯示、也一直都不是斷句點。
 *    真正會把它當斷點的是**這一層**：字幕框有 `maxWidth` ＋ `wordBreak: 'break-word'`，
 *    而 `-` 在 CSS 裡是標準的「可折行機會」，所以一句字幕只要長到需要換行、
 *    而減號剛好排在行尾附近，瀏覽器就會折在減號後面 → 上行「…世芯-」下行「KY」。
 *    修法是把整個 XX-XX 包成 `white-space: nowrap` 的 span（**保留減號字元本身**，
 *    不換成 U+2011 —— Noto Sans TC 不保證有那個字符，缺字會變成豆腐框）。
 *
 * ⚠️ 斜線是兩層都要動，跟減號不一樣：`/` 本來連**顯示**都沒有（被 `OTHER_PUNCT_RE` 濾掉，
 *    9/16 渲染成 916），2026-09-15 先在 `script-utils.js` 讓它進 cleaned chars，
 *    這一層才輪得到管折行。只改一邊都達不到「9/16 完整顯示」。
 *
 * 長度上限 12：nowrap 的 span 撐不下就會溢出字幕框，所以只保護「看起來像個股名」的短詞，
 * 真的很長的連字號字串還是讓它正常折行。
 */
// 符號兩側各自：一串英數字（KY／ADR／3661／2026）或**最多 4 個**中文字（台股名幾乎都 ≤4 字）。
// 中文沒有詞邊界，所以一定要設上限 —— 不設的話 `[中文]+` 會一路吃到句尾，
// 「矽力-KY與譜瑞-KY盤中也翻紅」會被整句包成 nowrap（實測過），那反而害整句不能折行。
const TOKEN_SIDE = '(?:[0-9A-Za-z]+|[\u4e00-\u9fff]{1,4})';
// 斜線兩側只吃數字（9/16、08/10、2026/09/16）。不沿用上面那組寬鬆的側 ——
// 那樣「9/16FOMC」會被整串黏成一個 nowrap（右側的 [0-9A-Za-z]+ 一路吃到 FOMC），
// 連「16 和 FOMC 之間」這個本來合理的折行點都被關掉。日期是這次要救的情境，收窄剛好。
const SLASH_SIDE = '[0-9]{1,4}';
// `(?:符號 + 側)+` 而不是只吃一個符號：2026/09/16 要整串一起保護，
// 只配一次的話會切成「2026/09」＋沒保護的「/16」，第二個斜線照樣可以折。
const TOKEN_RE = new RegExp(
  TOKEN_SIDE + '(?:-' + TOKEN_SIDE + ')+|' + SLASH_SIDE + '(?:[/／]' + SLASH_SIDE + ')+',
  'g',
);
const TOKEN_MAX = 12;

function keepTokensTogether(text: string): React.ReactNode {
  if (!/[-/／]/.test(text)) return text;
  const out: React.ReactNode[] = [];
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m[0].length > TOKEN_MAX) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <span key={`nb-${m.index}`} style={{ whiteSpace: 'nowrap' }}>
        {m[0]}
      </span>
    );
    last = m.index + m[0].length;
  }
  if (out.length === 0) return text;
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * 依重點詞把一句字幕切成「要放大變黃」與「照常」兩種片段。
 * 沒有任何重點詞、或整份對不回腳本時回傳 null，呼叫端就走原本那條路（行為完全不變）。
 */
function splitByEmphasis(text: string, map: number[]): { text: string; hl: boolean }[] | null {
  if (!phrasesAlignable || EMPHASIS_CHARS.size === 0) return null;
  if (map.length !== text.length) return null;   // 對位不上就不要亂標
  const parts: { text: string; hl: boolean }[] = [];
  let any = false;
  for (let i = 0; i < text.length; i++) {
    const hl = map[i] >= 0 && EMPHASIS_CHARS.has(map[i]);
    if (hl) any = true;
    const last = parts[parts.length - 1];
    if (last && last.hl === hl) last.text += text[i];
    else parts.push({ text: text[i], hl });
  }
  return any ? parts : null;
}

const SubtitleLine: React.FC<{ text: string; map?: number[] } & SubtitlesStyleProps> = ({
  text,
  map,
  containerStyle,
  textStyle,
}) => {
  const parts = map ? splitByEmphasis(text, map) : null;
  return (
    <AbsoluteFill
      style={{
        // 字幕位置：以「上邊」為錨點 → 多行字幕會向下延伸（而不是往上推第一行）
        justifyContent: 'flex-start',
        alignItems: 'center',
        paddingTop: 1440,
        paddingLeft: 65,
        paddingRight: 65,
        ...containerStyle,
      }}
    >
      <div
        style={{
          // 字體：'Noto Sans TC' 在 src/fonts.ts 預載；找不到時 fallback 到系統繁中字
          fontFamily:
            '"Noto Sans TC", system-ui, -apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif',
          fontSize: 70,
          fontWeight: 700, // 700 = Bold，由 fonts.ts 註冊的 Noto Sans TC 可變字型提供
          color: '#ffffff',
          textAlign: 'center',
          lineHeight: 1.3,
          // 半透明黑底字幕條（圓角膠囊感）
          backgroundColor: 'rgba(0, 0, 0, 0.43)',
          padding: '12px 28px',
          borderRadius: 24,
          // 太長自動換行：限制最大寬度（扣 padding 後實際內容 ≈ 894px ≈ 12-13 個中文字 / 行）
          // 2026-05-28 新增：配合 splitIntoPhrases 嚴格跟標點切的改動、讓單句超寬時自動 wrap
          maxWidth: 950,
          wordBreak: 'break-word',
          overflowWrap: 'break-word',
          ...textStyle,
        }}
      >
        {/* 重點詞：整句維持白字一般大小，只有標到的詞放大變黃（2026-09-17 使用者定案）。
            沒標的段落照舊整句丟給 keepTokensTogether，一個字都不會變。 */}
        {parts
          ? parts.map((seg, i) => (seg.hl
            ? (
              <span key={i} style={{ color: SUBTITLE_EMPHASIS.color, fontSize: `${SUBTITLE_EMPHASIS.scale}em` }}>
                {seg.text}
              </span>
            )
            : <React.Fragment key={i}>{keepTokensTogether(seg.text)}</React.Fragment>))
          : keepTokensTogether(text)}
      </div>
    </AbsoluteFill>
  );
};
