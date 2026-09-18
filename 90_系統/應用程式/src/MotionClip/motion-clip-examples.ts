import type { ContrastSpec, ListSpec, QuoteSpec } from './motion-clip-types';

/**
 * Studio 預覽用的範例參數（2026-09-16 使用者提供的真實稿件片段）。
 * ⚠️ 只是給 Remotion Studio 當 defaultProps 看長相用，產線不讀這支。
 * 三支刻意給不同時長，用來檢查「時長適配」：6 秒會砍註腳、12 秒會補 idle 掃光。
 */

export const EXAMPLE_CONTRAST: ContrastSpec = {
  template: 'contrast',
  kicker: '美國太空軍',
  title: '首度證實|部署太空武器',
  negative: '傳統火藥',
  positives: ['高頻微波', '電子戰設備'],
};

export const EXAMPLE_LIST: ListSpec = {
  template: 'list',
  kicker: '法說會',
  title: '四大|關鍵問題',
  items: [
    { text: '電容問題影響多大？', at: '電容問題影響多大' },
    { text: '電源 IC 缺料 Q3 能解？', at: '電源IC缺料第三季' },
    { text: 'Q4 指引能否破基期？', at: '第四季指引' },
    { text: '700 億擴廠何時貢獻？', at: '700億資本支出' },
  ],
};

export const EXAMPLE_QUOTE: QuoteSpec = {
  template: 'quote',
  kicker: '今日盤勢',
  lines: [
    [{ t: '大盤' }, { t: '摜破 4 萬 6', c: 'down' }],
    [{ t: '資安股' }, { t: '掀漲停潮', c: 'up' }],
    [{ t: '黃仁勳一句話', c: 'hl' }, { t: '引爆行情' }],
  ],
};
