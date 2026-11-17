'use strict';

/**
 * 結尾「明天要看幾件事」（2026-11-16 使用者定案）—— 純邏輯，不碰檔案、不呼叫服務。
 * 測試在 90_系統/測試/明日觀察.test.js。
 *
 * 使用者：「大盤小報結尾段落很常講到說明天要看幾件事，不論是幾件事都做個小動畫」。
 *   - 位置**由程式找**（固定觸發），不再讓 Claude 在最後 25% 的句子裡挑（使用者：「不太準」）。
 *   - 件數**以實際講到的為準**：稿子說「三件事」卻只講了兩件，就做兩件。
 *     旁白有「第一、第二…」「首先、再來、最後」這類序號時，序號的數量就是件數，也是每一項進場的時間點。
 *   - 排法**由程式決定**（outlookLayout）：每一項旁白都短 → 一二三同一個畫面；
 *     有一項講得長 → 一點一個畫面（重點＋一行說明），講到下一點才換頁。
 *
 * units 一律是 auto-shot.js --sentences 的子句：[{ i, sid, text, startCharIdx, endCharIdx }]。
 */

// ── 觸發句 ───────────────────────────────────────────────
const WHEN = '(?:明天|明日|下週|下周|下禮拜|下星期|接下來|下個交易日|週一|周一|節後|連假後|開紅盤)';
const WATCH = '(?:要看|看|觀察|注意|留意|關注|關心|追蹤|焦點|重點|看點|催化|事件)';
const NUM = '(?:[一二兩三四五六七八九十]|\\d+)';
// 「三件事」「兩個重點」「三大觀察」「四項」——「三大法人」「兩點半」這種不是件數，所以名詞要指名
const COUNTED = `${NUM}\\s*(?:件事?|個(?:重點|焦點|看點|觀察點?|事件|變數|關鍵|地方|方向)|大(?:重點|焦點|看點|觀察|事件|變數|關鍵)|項|點(?:要|值得|可以|觀察|注意|關注))`;
/** 有件數的說法：「明天有三件事要注意」「接下來觀察兩個重點」 */
const STRONG = new RegExp(`${WHEN}[^。！？!?]{0,16}?${COUNTED}`);
/** 沒講件數：「明天觀察誰在撐」「明天最大的催化事件是…」 */
const WEAK = new RegExp(`${WHEN}[^。！？!?，,]{0,10}?${WATCH}`);
/** 結尾的招呼不算進動畫：講者回來說再見，比卡片一路蓋到片尾自然 */
const SIGNOFF = /(明天見|下次見|下週見|下周見|我們下|掰掰|拜拜|謝謝(收看|大家|觀看|各位)|記得(追蹤|訂閱|按讚|分享)|追蹤|訂閱|按讚|以上(就是)?今天|今天(的)?(分享|大盤小報|內容)(就)?(到這|先到)|祝(大家|各位))/;

/** 觸發句只在後 40% 找；沒講件數的觸發句還要離結尾 14 個子句以內，免得把中段的「明天觀察」當成結尾 */
const TAIL_FROM = 0.6;
const WEAK_MAX_UNITS = 14;
/** 動畫最多涵蓋幾個子句：太長通常是後面還接了別的內容，切在那句講完的地方 */
const MAX_UNITS = 16;

// ── 序號 ─────────────────────────────────────────────────
// 只認子句開頭的序號：「第一季」「第一金」這種詞到處都是，所以「第一」後面要接個／點／是／逗號這類字
const ORDINAL_AFTER = '(?=個|點|件|項|是|就|要|呢|，|、|：|:|,)';
const FAMILIES = [
  { name: '第N', first: /^第一/, re: new RegExp(`第[一二三四五六](?:個|點|件|項)?${ORDINAL_AFTER}`, 'g') },
  { name: 'N是', first: /^一/, re: /[一二三四五](?:個)?是/g },
  { name: '首先', first: /^首先/, re: /首先|其次|再來|再者|接著|然後|另外|最後/g },
  { name: '一個另一個', first: /^一個/, re: /一個是|另一個是|另外一個是|另外一個/g },
];
const CLAUSE_START = /[，。、；：！？,.;:!?\s]/;

/** 把 units 串成一條字串，子句之間補標點（同一句補「，」、換句補「。」），記住每個子句的起點 */
function joinUnits(units) {
  let all = '';
  const at = [];
  units.forEach((u, k) => {
    if (k > 0) all += units[k - 1].sid === u.sid ? '，' : '。';
    at.push(all.length);
    all += u.text;
  });
  return { all, at };
}

/** 字串位置 → 第幾個子句（units 的陣列位置） */
function unitAtOffset(at, off) {
  let k = 0;
  while (k + 1 < at.length && at[k + 1] <= off) k++;
  return k;
}

/**
 * 找結尾「明天要看的事」。回傳 { from, to, markers, count, strong } | null。
 *   from／to   units 的陣列位置（含）
 *   markers    旁白裡的序號原文（例 ['第一','第二','第三']），兩個以上才給；它就是件數
 */
function findOutlook(units) {
  const n = units.length;
  if (n < 2) return null;
  const { all, at } = joinUnits(units);
  const tailStart = Math.floor(n * TAIL_FROM);
  const scan = (re) => {
    const g = new RegExp(re.source, 'g');
    const hits = [];
    let m;
    while ((m = g.exec(all))) {
      const k = unitAtOffset(at, m.index);
      // 後 40%，或離結尾 MAX_UNITS 個子句以內（短稿的結尾段本身就可能佔掉一半）
      if (k >= tailStart || n - k <= MAX_UNITS) hits.push(k);
      g.lastIndex = m.index + 1;
    }
    return hits;
  };
  const strong = scan(STRONG);
  let from = null;
  if (strong.length) from = strong[0];
  else {
    const weak = scan(WEAK);
    from = weak.find((k) => n - k <= WEAK_MAX_UNITS);
    if (from == null) return null;
  }
  // 觸發句跟前面的話在同一個子句裡的時候，從觸發字所在的子句開始就好（不往前拉整句）
  let to = n - 1;
  while (to > from && SIGNOFF.test(units[to].text)) to--;
  if (to - from + 1 > MAX_UNITS) {
    // 切在第 MAX_UNITS 個子句所屬那一句講完的地方，不切在句子中間
    const sid = units[from + MAX_UNITS - 1].sid;
    to = from + MAX_UNITS - 1;
    while (to + 1 < n && units[to + 1].sid === sid) to++;
  }
  const range = units.slice(from, to + 1);
  const { markers, strict } = findMarkers(joinUnits(range).all);
  return {
    from, to,
    startCharIdx: units[from].startCharIdx,
    endCharIdx: units[to].endCharIdx,
    markers: markers.length >= 2 ? markers : [],
    // 「第一、第二」「一是、二是」是明確的件數；「首先…最後」的「最後」常是收尾提醒，只當參考
    count: markers.length >= 2 && strict ? markers.length : null,
    strong: strong.length > 0,
  };
}

/**
 * 範圍內的序號：同一套說法、從「第一／首先／一是」開始、照順序排。
 * 回傳 { markers, strict }；找不到一套完整的 markers 是 []。strict＝明確的序號（第N、N是）。
 */
const STRICT_FAMILIES = ['第N', 'N是'];
function findMarkers(text) {
  let best = [];
  let bestFam = null;
  for (const fam of FAMILIES) {
    const g = new RegExp(fam.re.source, 'g');
    const found = [];
    let m;
    while ((m = g.exec(text))) {
      const prev = m.index === 0 ? '，' : text[m.index - 1];
      if (!CLAUSE_START.test(prev)) continue;
      found.push(m[0]);
    }
    if (!found.length || !fam.first.test(found[0])) continue;
    // 「首先」那一套：然後／另外 只在已經有「首先」之後才算，而且最後一個「最後」之後不再收
    let seq = found;
    if (fam.name === '首先') {
      const end = seq.indexOf('最後');
      if (end >= 0) seq = seq.slice(0, end + 1);
    }
    if (fam.name === '第N') {
      // 第一、第二、第三…要照順序，不連號的（例「第一…第三」中間漏講）照實際出現的算
      const order = '一二三四五六';
      seq = seq.filter((s, k) => k === 0 || order.indexOf(s[1]) > order.indexOf(seq[k - 1][1]));
    }
    if (seq.length > best.length) { best = seq; bestFam = fam.name; }
  }
  return { markers: best.slice(0, 5), strict: STRICT_FAMILIES.includes(bestFam) };
}

// ── 排法 ─────────────────────────────────────────────────
/** 每一項旁白都在這個字數以內（不算標點），才把一二三放在同一個畫面 */
const SHORT_SPAN = 28;
/** 同畫面時每一項重點最多幾格寬（中文 1 格、半形 0.55 格），再長就換頁排 */
const SHORT_TEXT = 10;
const visualWidth = (s) => [...String(s || '')].reduce((w, c) => w + (/[\x20-\x7e]/.test(c) ? 0.55 : 1), 0);
const bare = (s) => String(s || '').replace(/[，。、；：！？「」『』（）()\s,.;:!?]/g, '');

/**
 * 'all'＝一二三同一個畫面，'paged'＝一點一個畫面。
 *   items    卡片的項目（at 是旁白原文片段）
 *   segText  這段動畫的旁白原文
 * 只有一項時一律 paged（重點＋說明撐滿畫面）；五項以上同畫面放不下，也是 paged。
 */
function outlookLayout(items, segText) {
  const n = (items || []).length;
  if (n < 2 || n > 4) return 'paged';
  if (items.some((it) => visualWidth(it.text) > SHORT_TEXT)) return 'paged';
  const text = String(segText || '');
  const pos = [];
  let cursor = 0;
  for (const it of items) {
    const k = it.at ? text.indexOf(it.at, cursor) : -1;
    pos.push(k);
    if (k >= 0) cursor = k + 1;
  }
  let spans;
  if (pos.every((p) => p >= 0)) {
    spans = pos.map((p, k) => bare(text.slice(p, k + 1 < n ? pos[k + 1] : text.length)).length);
  } else {
    // 對不到旁白就用平均：整段很短才可能同畫面
    spans = items.map(() => bare(text).length / n);
  }
  return Math.max(...spans) <= SHORT_SPAN ? 'all' : 'paged';
}

const 中文件數 = ['', '一', '兩', '三', '四', '五'];
/** 卡片的 kicker／title 由程式給，件數跟著實際的項目數，不照旁白開頭說的數字 */
function outlookHeading(when, n) {
  const w = String(when || '明天').trim().slice(0, 4) || '明天';
  const kicker = /週|周|禮拜|星期/.test(w) ? '下週觀察' : '明日觀察';
  const title = n <= 1 ? `${w}|關鍵焦點` : `${w}要看|${中文件數[n] || n}件事`;
  return { kicker, title };
}

module.exports = {
  findOutlook, findMarkers, outlookLayout, outlookHeading, joinUnits, unitAtOffset, visualWidth,
  SHORT_SPAN, SHORT_TEXT, STRONG, WEAK,
};
