import type { ContrastSpec, ListSpec, NumberSpec, QuoteSpec, RankSpec, SectorSpec } from './motion-clip-types';

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

// 2026-10-15 數字型三種：用 2026-10-08 大盤稿的真實段落（當天的草稿就是這幾段）
export const EXAMPLE_NUMBER: NumberSpec = {
  template: 'number',
  kicker: '籌碼面',
  title: '三大法人|連兩天賣超',
  label: '合計賣超',
  value: '404.6',
  unit: '億',
  valueC: 'down',
  items: [{ text: '指數守在高檔' }, { text: '有其他資金在接' }],
};

export const EXAMPLE_RANK: RankSpec = {
  template: 'rank',
  kicker: '9月營收 年增率',
  title: '被動元件|全面成長',
  items: [
    { text: '光頡', value: '+67.4%' },
    { text: '禾伸堂', value: '+27.1%' },
    { text: '立隆電', value: '+39.5%' },
  ],
  stamp: '全部雙位數',
};

export const EXAMPLE_SECTOR: SectorSpec = {
  template: 'sector',
  kicker: '新資金方向',
  title: '|塑化',
  items: [
    { text: '南亞', value: '+7.17%' },
    { text: '台塑', value: '漲停' },
    { text: '台塑化', value: '+5.4%' },
  ],
  tags: ['資金輪動？', '新主力題材？'],
};
