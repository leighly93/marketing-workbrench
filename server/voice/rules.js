// @ts-nocheck
'use strict';

/**
 * 配音：語氣白名單、script.txt 組裝、共用發音詞庫與本支發音替換。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得（測試可換成假的 fs／子程序）。
 */

module.exports = function create(ctx) {
  const { fs, path, config: { PRONOUNCE_PATH }, ensureDir, nowISO, readMessages, appendMessage, nextMessageId } = ctx;

  // ── 配音語氣（2026-09-14 使用者定案）──────────────────────────
  // MiniMax 的 emotion 參數。九個合法值裡前台只開放兩個，**而且白名單一定要在伺服器端**：
  // 前台不顯示只擋得住同事，擋不住直接打 /api/jobs 的人，而 whisper 配 speech-2.8
  // 是「整支出片直接失敗」（API 回 2013），不是音色變掉而已。
  // 收到白名單以外的值一律當預設 —— 不回 400，因為這欄位不是同事填的，是介面送的，
  // 擋下整支工作不如用預設把片出完（使用者定案：「server 收到非 happy/fluent 一律當 fluent」）。
  // 第一個是預設值：舊工作的 job.json 沒有這個欄位，重跑時也會拿到它。
  // ⚠️ 值要跟 app/app.js 的 EMOTIONS 一致，由 server/tests/voice-tone.test.js 綁住。
  const EMOTIONS = ['fluent', 'happy'];
  const normalizeEmotion = (v) => (EMOTIONS.includes(v) ? v : EMOTIONS[0]);

  /**
   * 把表單欄位組成 script.txt。
   *
   * 格式是既有解析器（script-utils.js / parse-*-script.js）認得的四段式：
   *   第 1 段      = 發音替換規則（一行一條 原文→唸法）
   *   第 2 段      = 保留不用（沿用既有腳本的習慣寫法）
   *   倒數第 2 段  = 開場卡標題（兩行）→ parse 會寫進 video-meta.json.titleText
   *   最後 1 段    = 內文
   *
   * 前台只讓同事填「標題」跟「內文」——`===` 只有 Leighly 看得懂，
   * 給同事看只會造成困擾（2026-08-13 使用者要求）。
   */
  function buildScript({ voice, title, body }) {
    return [
      (voice || '').trim(),
      '===',
      '===',
      (title || '').trim(),
      '===',
      (body || '').trim(),
      '',
    ].join('\n');
  }

  // ── 發音替換 ──────────────────────────────
  // 這條路本來就跑得通，這裡只是多接一個「共用詞庫」的來源：
  //   script.txt 第 1 段 → script-utils 的 applyVoiceRulesForward() 在送 TTS 前把字換掉
  //   → correct-subtitles.js 第 10 步做「反向」取代，字幕顯示回原文。
  // 所以規則只要寫進 script.txt 就好，run.js 與 scripts/ 完全不用動，
  // 而且每支工作的 script.txt 都留著「這次實際套了哪些」→ 可稽核、重跑可重現。

  function readPronounce() {
    try {
      const j = JSON.parse(fs.readFileSync(PRONOUNCE_PATH, 'utf-8'));
      return Array.isArray(j) ? j : (j.rules || []);
    } catch (_) { return []; }
  }

  function writePronounce(rules) {
    ensureDir(path.dirname(PRONOUNCE_PATH));
    fs.writeFileSync(PRONOUNCE_PATH, JSON.stringify(rules, null, 2) + '\n');
  }

  function parseVoiceLines(text) {
    const out = [];
    for (const line of String(text || '').split('\n')) {
      // 跟 script-utils.js 的 parseVoiceRules 同一條規則：# 開頭是註解、要有 →
      const m = line.match(/^([^#→\n][^→]*)→(.+)$/);
      if (m && m[1].trim() && m[2].trim()) out.push({ from: m[1].trim(), to: m[2].trim() });
    }
    return out;
  }

  /**
   * 這一支要用的發音替換 = 同事自己填的 ＋ 共用詞庫。
   *
   * ⚠️ 兩件事決定了順序，改之前先看懂：
   *  ① `applyVoiceRulesForward()` 是**照陣列順序做字串取代**，先套的先贏。所以同事填的排前面，
   *     而且同一個「原文」在詞庫那邊會被濾掉 → 等於「本支覆寫共用詞庫」，不用另做覆寫機制。
   *  ② 共用詞庫內部照「原文長度」由長到短排。短詞先套會把長詞拆散 ——
   *     例：先套「玉→ㄩˋ」，後面的「采鈺→彩玉」就再也對不上了。
   */
  function mergeVoiceRules(ownText) {
    const own = parseVoiceLines(ownText);
    const taken = new Set(own.map((r) => r.from));
    const shared = readPronounce()
      .filter((r) => r && r.enabled !== false && r.from && r.to && !taken.has(r.from))
      .sort((a, b) => [...b.from].length - [...a.from].length);
    return { own, shared };
  }

  /**
   * 這支「真的被換掉」的規則有哪幾條。
   *
   * 為什麼要另外算：共用詞庫會長到幾十條，全部列在前台等於沒列。人工聽的時候想知道的是
   * 「我剛剛聽到的那個字，系統到底有沒有動過手」—— 有動過還唸錯 ＝ 規則沒生效（要換寫法），
   * 沒動過 ＝ 這是新的詞（直接回報）。這兩件事的處置完全不同。
   *
   * ⚠️ 掃描方式必須跟 script-utils.js 的 applyVoiceRulesForward() 一模一樣（長的優先、
   *    由左到右、命中就跳過整個 from）—— 用 indexOf 逐條數的話，被長詞吃掉的短詞會被多算。
   */
  function voiceRuleHits(text, rules) {
    const list = (rules || []).filter((r) => r && r.from);
    const s = String(text || '');
    if (!list.length || !s) return [];
    const sorted = [...list].sort((a, b) => b.from.length - a.from.length);
    const times = new Map();
    let i = 0;
    while (i < s.length) {
      const hit = sorted.find((r) => s.startsWith(r.from, i));
      if (hit) { times.set(hit.from, (times.get(hit.from) || 0) + 1); i += hit.from.length; }
      else i += 1;
    }
    return list.filter((r) => times.has(r.from))
      .map((r) => ({ from: r.from, to: r.to, src: r.src || 'shared', times: times.get(r.from) }));
  }

  /**
   * 同事在「唸法」填的詞，出片時順手送一份到收件匣
   * （2026-09-14 使用者定案：「送出後可以當作『跟我說』那邊的『這個詞唸錯了』寄信給我，我統一收錄」）。
   *
   * 只送**沒看過**的，不然同一個詞每天出片就多一筆，收件匣會被自己灌爆：
   *   ① 共用詞庫已經有那個原文就不送 —— 連**停用**的也算看過（停用＝看過而且決定不要，
   *      再送一次等於一直來吵同一件事）。
   *   ② 收件匣裡同一個原文還沒處理（status 不是 done）也不送。
   * 標 auto:true —— 收件匣才分得出「同事特地回報的」跟「出片時順手帶上的」，
   * 前者是他真的被唸錯困擾到，後者只是路過，處理的優先順序不一樣。
   *
   * ⚠️ 整支包在 try 裡：回報只是順手，壞掉也不能擋住出片。
   */
  function reportOwnVoiceRules(job, own) {
    if (!own || !own.length) return;
    try {
      const known = new Set(readPronounce().filter((r) => r && r.from).map((r) => r.from));
      const seen = new Set(readMessages()
        .filter((m) => m.kind === 'pronounce' && m.status !== 'done' && m.word)
        .map((m) => m.word));
      for (const r of own) {
        if (known.has(r.from) || seen.has(r.from)) continue;
        seen.add(r.from);   // 同一次送出裡填了兩條一樣的原文也只送一筆
        appendMessage({
          id: nextMessageId(),
          at: nowISO(), by: job.owner, kind: 'pronounce', job: job.id,
          status: 'new', auto: true, word: r.from, suggest: r.to, why: '',
        });
      }
    } catch (_) {}
  }

  function voiceSection(own, shared) {
    return [
      ...own.map((r) => `${r.from}→${r.to}`),
      ...(shared.length ? ['# ↓ 共用發音詞庫（自動帶入，不用手改）'] : []),
      ...shared.map((r) => `${r.from}→${r.to}`),
    ].join('\n');
  }

  return { EMOTIONS, normalizeEmotion, buildScript, readPronounce, writePronounce, parseVoiceLines, mergeVoiceRules, voiceRuleHits, reportOwnVoiceRules, voiceSection };
};
