// @ts-nocheck
'use strict';

/**
 * 跟我說：留言、唸法回報、📌 頁型記錄與收件匣。
 * 由 server/app.js 組裝；依賴一律從 ctx 取得（測試可換成假的 fs／子程序）。
 */

module.exports = function createRoutes(ctx) {
  const { fs, path, config: { WORKSPACE_ROOT }, dataPath, SHOT_MEMORY, isAdmin, send, readJson, nowISO, ensureDir, jobPath,
    appendMessage, readMessages, nextMessageId } = ctx;

  return async function handle({ req, res, url, p, seg, admin }) {
    // ── 跟我說：留言／唸法回報 ──
    // 送出人人都可以（同事就是要靠這個跟我說話）；看收件匣只有管理者。
    if (p === '/api/messages' && req.method === 'POST') {
      const body = await readJson(req);
      const by = String(body.by || '').trim();
      if (!by) return send(res, 400, { error: '不知道是誰回報的，請先填「你是誰」' });
      const kind = ['pronounce', 'page-pin'].includes(body.kind) ? body.kind : 'note';
      // 2026-09-07 使用者定案：📌 只有管理者可以按（前端也只畫給管理者）。
      if (kind === 'page-pin' && !isAdmin(req)) return send(res, 403, { error: '📌 只有管理者可以記下頁型' });
      const m = {
        id: nextMessageId(),
        at: nowISO(), by, kind,
        job: body.job ? String(body.job) : null,
        status: 'new',
      };
      if (kind === 'pronounce') {
        m.word = String(body.word || '').trim();
        m.suggest = String(body.suggest || '').trim();
        m.why = String(body.why || '').trim();
        if (!m.word || !m.suggest) return send(res, 400, { error: '「唸錯的詞」跟「建議怎麼寫」都要填' });
      } else if (kind === 'page-pin') {
        // 📌 記下這種頁（2026-09-07）：審核頁上系統認不出頁型的截圖旁那顆按鈕。
        // 只存「這是哪支工作的哪張圖」＋指紋（OCR 中文詞、尺寸、memKey）＋截圖副本，**不命名** ——
        // 使用者定案：當場手打會長出三種寫法，累積一批再用 video/shots/page-pins.js 分群、一次命名。
        m.src = String(body.src || '').trim();
        if (!m.src || !m.job) return send(res, 400, { error: '📌 要知道是哪支工作的哪張圖' });
        m.text = String(body.text || '').trim();
        // 指紋與存圖都包在 try：任何一步失敗還是要把 📌 記下來（至少有 job/src 事後可追）
        try {
          const st = jobPath(m.job, 'state');
          let im = null;
          try {
            im = (JSON.parse(fs.readFileSync(path.join(st, 'src', 'app-images.generated.json'), 'utf-8')).images || [])
              .find((x) => x.file === m.src) || null;
          } catch (_) {}
          m.systemPage = im ? (im.page || 'unknown') : null;
          if (im) {
            // 指紋 = 合併字框後、只留中文 ≥2 字的詞（去數字：數字每天不同，版面標籤才是頁型特徵）
            const words = SHOT_MEMORY.mergeRuns(im.words || []).map((r) => r.t)
              .flatMap((t) => String(t).match(/[一-鿿]{2,}/g) || []);
            m.fingerprint = { words: [...new Set(words)].slice(0, 40), width: im.width, height: im.height,
              stockCode: im.stockCode || null, memKey: SHOT_MEMORY.memKeyOf(im) };
          }
          // 截圖存一份到 data/page-samples/_pinned/ —— jobs/ 會被 prune，指紋在、圖沒了就白搭
          const from = [path.join(st, 'public', m.src), jobPath(m.job, 'input', m.src)].find((f) => fs.existsSync(f));
          if (from) {
            const dest = dataPath(WORKSPACE_ROOT, 'page-samples', '_pinned', `${m.job}__${m.src}`);
            ensureDir(path.dirname(dest));
            if (!fs.existsSync(dest)) fs.copyFileSync(from, dest);
            m.pinned = path.relative(WORKSPACE_ROOT, dest);
          }
        } catch (e) { m.pinError = e.message; }
      } else {
        m.text = String(body.text || '').trim();
        if (!m.text) return send(res, 400, { error: '留言是空的' });
      }
      appendMessage(m);
      return send(res, 200, { ok: true, id: m.id });
    }

    if (p === '/api/messages' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 403, { error: '只有管理者看得到收件匣' });
      return send(res, 200, { messages: readMessages() });
    }

    // 已讀／標回未讀。不就地改，追加一行 op:'status'，讀的時候摺疊 —— 檔案維持 append-only。
    if (p === '/api/messages/status' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: '只有管理者可以標記' });
      const body = await readJson(req);
      if (!body.id) return send(res, 400, { error: '缺少 id' });
      appendMessage({ op: 'status', id: String(body.id), status: body.status === 'done' ? 'done' : 'new', at: nowISO() });
      return send(res, 200, { ok: true });
    }
  };
};
