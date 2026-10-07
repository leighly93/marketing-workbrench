// 唸法（發音替換）：兩格一列的輸入，組成伺服器要的「原文→唸法」文字。

/** 組出來的字串就是送出去的 body.voice。只留兩邊都有填的列。 */
export function voiceText(rows) {
  return rows
    .filter((r) => r.from.trim() && r.to.trim())
    .map((r) => `${r.from.trim()}→${r.to.trim()}`).join('\n');
}

/** 伺服器存的 voiceRules.own 是「原文→唸法」字串，拆回兩格。 */
export function voiceRows(own) {
  const rows = (own || []).map((s) => {
    const [from = '', to = ''] = String(s).split('→');
    return { from, to };
  });
  return rows.length ? rows : [{ from: '', to: '' }];
}

/** 同一個原文填兩次，只有第一條會生效（伺服器照順序做字串取代，先套先贏）—— 回傳重複的列索引。 */
export function voiceDupes(rows) {
  const seen = new Set(), dup = new Set();
  rows.forEach((r, i) => {
    const from = r.from.trim();
    if (from && seen.has(from)) dup.add(i);
    if (from) seen.add(from);
  });
  return dup;
}

/**
 * 送出前檢查。回傳第一個問題（字串）或 null。
 * 擋的都是「填了卻不會生效」的寫法 —— 以前這些全部被靜默丟掉，這正是要消滅的那件事。
 * 整列空白不算問題：預設就有一列，多數工作不填。
 */
export function voiceProblem(rows) {
  const seen = new Map();
  for (let i = 0; i < rows.length; i++) {
    const from = rows[i].from.trim();
    const to = rows[i].to.trim();
    const at = `第 ${i + 1} 條唸法`;
    if (!from && !to) continue;
    if (!from) return `${at}只填了右邊。左邊要填腳本裡原本的那個詞。`;
    if (!to) return `${at}只填了「${from}」。右邊要填怎麼寫它才唸得對（例如「收練」）。`;
    if (/[→\n]/.test(from + to) || (from + to).includes('->'))
      return `${at}裡不用自己打箭頭 —— 左右兩格各填一個詞就好。`;
    if (from.startsWith('#')) return `${at}的「${from}」以 # 開頭，那在腳本裡是註解的意思，整條不會生效。`;
    if (from === to) return `${at}左右兩格一模一樣（${from}），這樣等於沒有改。`;
    if (seen.has(from)) return `${at}的「${from}」跟第 ${seen.get(from)} 條重複了。`
      + '同一個詞只有前面那條會生效，請刪掉一條。';
    seen.set(from, i + 1);
  }
  return null;
}

// 配音語氣：[值, 按鈕文字]。**值要跟 server/voice/rules.js 的 EMOTIONS 白名單一字不差**，
// 由 server/tests/voice-tone.test.js 綁住 —— 這裡多塞一個 whisper 之類的值，
// 不是「多一個選項」，是讓選到的人整支出片直接失敗（speech-2.8 不支援，API 回 2013）。
// 第一個是預設。
export const EMOTIONS = [['fluent', '流暢'], ['happy', '開心']];

export function emotionLabel(v) {
  return (EMOTIONS.find(([k]) => k === v) || [])[1] || v;
}
