// @ts-nocheck
'use strict';

/**
 * 同事留言／唸法回報的 append-only 收件匣。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得（測試可換成假的 fs／子程序）。
 */

module.exports = function create(ctx) {
  const { fs, path, config: { WORKSPACE_ROOT, MESSAGES_LOG }, ensureDir, resolveDataReference } = ctx;

  let msgSeq = 0;
  /** 留言 ID：時間＋同一程序內的流水號（同一毫秒兩筆也不撞）。 */
  const nextMessageId = () => `${Date.now()}-${msgSeq++}`;

  function appendMessage(obj) {
    ensureDir(path.dirname(MESSAGES_LOG));
    fs.appendFileSync(MESSAGES_LOG, JSON.stringify(obj) + '\n');
  }

  /** 讀回所有留言，並把後面追加的 { op:'status' } 摺疊上去 */
  function readMessages() {
    if (!fs.existsSync(MESSAGES_LOG)) return [];
    const byId = new Map();
    for (const line of fs.readFileSync(MESSAGES_LOG, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch (_) { continue; }
      if (o.op === 'status') {
        const m = byId.get(o.id);
        if (m) m.status = o.status;
        continue;
      }
      if (o.id) byId.set(o.id, { status: 'new', ...o });
    }
    return [...byId.values()].map((message) => message.pinned
      ? { ...message, pinned: path.relative(WORKSPACE_ROOT, resolveDataReference(WORKSPACE_ROOT, message.pinned)) }
      : message);
  }

  return { appendMessage, readMessages, nextMessageId };
};
