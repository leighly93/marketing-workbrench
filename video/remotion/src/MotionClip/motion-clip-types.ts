/**
 * 動態小影片（MG）的參數型別 —— 這份是 motion-engine adapter 的「輸出契約」。
 *
 * 2026-09-16 使用者定案的三種型別（原本規劃四種，「數據型」拿掉：
 * 有數字的段落本來就用真實 APP 截圖呈現，不需要 MG 補）：
 *   contrast  不是 X，而是 Y —— 轉折、破除迷思、新舊替換
 *   list      2~5 個並列的點 —— 逐項對齊旁白唸到它的時間進場
 *   quote     一句有力的話 —— 關鍵詞逐段著色
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

export type MotionClipSpec = ContrastSpec | ListSpec | QuoteSpec;
