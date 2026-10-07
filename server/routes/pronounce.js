// @ts-nocheck
'use strict';

/**
 * 共用發音詞庫（只有管理者能改）。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得（測試可換成假的 fs／子程序）。
 */

module.exports = function createRoutes(ctx) {
  const { isAdmin, send, readJson, nowISO, readPronounce, writePronounce } = ctx;

  return async function handle({ req, res, url, p, seg, admin }) {
    // ── 共用發音詞庫（只有管理者能改）──
    if (p === '/api/pronounce' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 403, { error: '只有管理者看得到詞庫' });
      return send(res, 200, { rules: readPronounce() });
    }

    if (p === '/api/pronounce' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: '只有管理者可以改詞庫' });
      const body = await readJson(req);
      const from = String(body.from || '').trim();
      const to = String(body.to || '').trim();
      if (!from || !to) return send(res, 400, { error: '原文跟唸法都要填' });
      if (from === to) return send(res, 400, { error: '原文跟唸法一樣，這條沒有作用' });
      // ⚠️ 這是字串取代不是「詞」取代 —— 沒有詞邊界判斷。單支腳本填錯當場就聽得出來，
      //    但共用詞庫錯一條會靜默影響之後每一支影片，很難聯想到是它。
      //    單字一律擋死：「玉」會打中「采鈺」「玉山」「金玉」，幾乎不可能是對的。
      //    兩個字只提醒不擋 —— 台股公司名大多是兩個字（采鈺／精材／鴻海），那正是這個功能存在的理由。
      if ([...from].length < 2)
        return send(res, 400, {
          error: `「${from}」只有一個字，不能收進共用詞庫 —— 它會打中所有含這個字的詞。`
            + '請改成完整的詞；真的只能用單字，就在那一支的「唸法」欄位填，只影響那一支。',
        });
      if ([...from].length === 2 && !body.force)
        return send(res, 400, {
          error: `「${from}」只有兩個字。共用詞庫是整篇字串取代，如果有別的詞包含「${from}」，`
            + '那個詞也會被一起改掉。確定沒問題就再按一次「加進詞庫」。',
          short: true,
        });
      const rules = readPronounce();
      // 規則互相打架的檢查。applyVoiceRulesForward 已經改成「換過的地方不再被掃」，
      // 所以不會再靜默串接；但兩條規則互相包含時，實際會生效的是哪一條並不直觀，
      // 與其讓人事後才發現，不如在加的當下就講清楚。
      const clash = rules.filter((r) => r.enabled !== false && r.from !== from
        && (r.to.includes(from) || from.includes(r.from) || r.from.includes(from)));
      if (clash.length && !body.force)
        return send(res, 400, {
          error: `「${from}」跟詞庫裡的「${clash.map((r) => r.from + '→' + r.to).join('」「')}」有重疊，`
            + '兩條規則會搶同一段文字（實際生效的是比較長的那條）。'
            + '確定要加就再按一次「加進詞庫」。',
          clash: clash.map((r) => ({ from: r.from, to: r.to })),
        });
      const i = rules.findIndex((r) => r.from === from);
      const rule = {
        from, to,
        why: String(body.why || '').trim(),
        by: String(body.by || '').trim() || '管理者',
        at: nowISO(),
        enabled: true,
        ...(body.fromMessage ? { fromMessage: String(body.fromMessage) } : {}),
      };
      if (i >= 0) rules[i] = { ...rules[i], ...rule }; else rules.push(rule);
      writePronounce(rules);
      return send(res, 200, { ok: true, rules });
    }

    // 停用／啟用。不刪除 —— 刪掉就不知道當初為什麼加，之後又會有人再加一次。
    if (p === '/api/pronounce' && req.method === 'PATCH') {
      if (!isAdmin(req)) return send(res, 403, { error: '只有管理者可以改詞庫' });
      const body = await readJson(req);
      const rules = readPronounce();
      const r = rules.find((x) => x.from === String(body.from || ''));
      if (!r) return send(res, 404, { error: '詞庫裡沒有這一條' });
      r.enabled = !!body.enabled;
      writePronounce(rules);
      return send(res, 200, { ok: true, rules });
    }
  };
};
