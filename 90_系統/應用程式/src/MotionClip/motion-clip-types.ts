/**
 * 動態小影片（MG）的參數型別 —— 這份是 motion-engine adapter 的「輸出契約」。
 *
 * 2026-09-16 使用者定案的三種型別（原本規劃四種，「數據型」拿掉：
 * 有數字的段落本來就用真實 APP 截圖呈現，不需要 MG 補）：
 *   contrast  不是 X，而是 Y —— 轉折、破除迷思、新舊替換
 *   list      2~5 個並列的點 —— 逐項對齊旁白唸到它的時間進場
 *   quote     一句有力的話 —— 關鍵詞逐段著色
 * 2026-10-08 加第一批新型別：event（事件預告）、level（關卡線），見下面各自的說明。
 *
 * ⚠️ 卡片上放的是**濃縮後的關鍵詞**，不是旁白原句。原句由字幕負責，
 *    兩邊放一樣的字會重複又擠（使用者定案）。每項建議 10 字以內。
 */

/** 關鍵詞著色。台股慣例：漲紅跌綠；hl 是品牌黃，用在「非漲跌」的重點。 */
export type Emphasis = 'up' | 'down' | 'hl';

export type QuoteToken = { t: string; c?: Emphasis };

export type ListItem = {
  /** 卡片上顯示的濃縮字（建議 ≤10 字，橫式會縮到 78%） */
  text: string;
  /**
   * 這一項對應的**旁白原文片段**。產線用它比對 charIdx → 算出該在第幾秒進場，
   * 讓「唸到第二點」與「第二點滑入」同一時間（機制與配圖的 startCharIdx 相同）。
   * 省略時退回等距分配。
   */
  at?: string;
  /** 由產線填入：解析 at 之後得到的進場秒數（相對於本段開頭）。元件只讀這個。 */
  atSec?: number;
};

type Base = {
  /** 左上小標，例如「法說會」「今日盤勢」。可省略。 */
  kicker?: string;
  /** 主標。用 | 分隔的後半段會套品牌黃，例如「四大|關鍵問題」。 */
  title?: string;
  /**
   * 右上角徽章，例如「9/16 盤後」「法說會現場」。補充資訊放這裡。
   * 2026-09-16 使用者定案：取代原本的底部註腳 —— 底部就是字幕的位置，
   * 在那裡再放一層小字會跟字幕搶注意力，而且橫式縮到 78% 後只剩 26px 等效、根本看不清。
   */
  badge?: string;
  /**
   * 底部註腳小字。**預設不給** —— 見 badge 的說明。
   * 只在真的需要標註資料來源／期間、且該段沒有字幕時才用。時長不足 5 秒會自動略過。
   */
  foot?: string;
};

export type ContrastSpec = Base & {
  template: 'contrast';
  /** 被否定的那個（紅叉＋刪除線） */
  negative: string;
  /** 肯定的答案，1~2 個（黃框彈入） */
  positives: string[];
};

export type ListSpec = Base & {
  template: 'list';
  items: ListItem[];
};

export type QuoteSpec = Base & {
  template: 'quote';
  /** 每行是一串 token，token 可帶顏色 */
  lines: QuoteToken[][];
};

/**
 * 事件預告（2026-10-08 使用者定案加的第一批）：段落在講「接下來的某個事件」——
 * 法說、財報、央行、連假後開盤。大盤小報幾乎每支都用它收尾。
 * 時間與背景（休市、連假）不是重點，放在 when 這個日期牌上，不另外列一項。
 */
export type EventSpec = Base & {
  template: 'event';
  /** 日期牌上的字，例如「10/15」「明天」「下週」。最多 5 個字。 */
  when: string;
  /** 事件本身，例如「台積電法說」。最多 9 個字。 */
  event: string;
  /** 看點，0~2 項（例如「展望定光學族群方向」）。跟條列一樣用 at 對齊旁白。 */
  items?: ListItem[];
};

/**
 * 關卡線（2026-10-08 使用者定案加的第一批）：某個關鍵價位被測試 ——
 * 整數關口、前高、壓力、支撐。**走勢是示意圖**，不是真實行情；數字全部來自稿件。
 */
export type LevelSpec = Base & {
  template: 'level';
  /** 壓力（上方過不去）或支撐（下方守住／跌破）。決定線畫在上面還是下面。 */
  kind: 'resistance' | 'support';
  /** 線上的標籤，例如「50,000」「5萬點」。 */
  level: string;
  /**
   * 每一次碰到這條線，1~3 次，例如「昨 49,969」「今 49,967」。
   * 用 at 對齊旁白：唸到哪一次，那一段走勢才畫出來。
   */
  items: ListItem[];
  /** 差距的大字，例如「差 33 點」。可省略。 */
  gap?: string;
  /** 結論，例如「連兩天過不去」。可省略。 */
  verdict?: string;
  /** 結論的顏色，跟 quote 同一套：up 紅／down 綠／hl 黃。 */
  verdictC?: Emphasis;
};

export type MotionClipSpec = ContrastSpec | ListSpec | QuoteSpec | EventSpec | LevelSpec;
