'use strict';

/**
 * 動態卡片參數的產生層（2026-09-18）—— 產線唯一的入口。
 *
 * 為什麼要有這一層：AGENTS.md 明寫「業務邏輯不得新增供應者 CLI 呼叫」。
 * 所以 `claude -p` 只出現在這個檔案裡，run.js／render-motion.js 只呼叫 plan()，
 * 換後端不必動它們。這跟 ocr-engine.js／transcription-engine.js 是同一個模式。
 *
 * ── 開關（.env）────────────────────────────────────────────────
 *   MOTION_ENGINE 沒設      → claude-cli（前台只選範圍，參數本來就要自己產）
 *   MOTION_ENGINE=manual    → 只讀前台貼進來的 spec，不呼叫任何服務
 *   MOTION_ENGINE=claude-cli → claude -p（用**訂閱**，不需要 API key）
 *   MOTION_ENGINE=api        → 保留，尚未實作（真要做時約 US$1.5／月 200 支）
 *
 * ── 介面（三個後端一致）────────────────────────────────────────
 *   plan({ text, manualSpec }) → spec | null
 *     text        那一段旁白的原文（cleaned script，跟 charIdx 同一套座標）
 *     manualSpec  前台貼的 spec；manual 後端只回傳它，其餘後端在生成失敗時拿它當退路
 *   回傳 null＝這一段不做動態。**呼叫端一律要能接受 null**（見 run.js 的降級）。
 *
 * ── 為什麼 claude-cli 不用 API key ─────────────────────────────
 *   使用者定案（2026-09-16）：跟公司申請費用要走流程很麻煩，而出片時段與他自己
 *   使用 Claude 的時段不重疊，共用訂閱額度的衝突風險低。
 *   ⚠️ 代價是每次呼叫約 16～25K input tokens —— 自己的 prompt 只有幾百，其餘全是
 *      Claude Code 的系統提示。`--system-prompt` 換掉預設那包可以降到 16K，
 *      再往下只剩 `--bare`，但它強制走 ANTHROPIC_API_KEY，與本決定衝突。
 */

const { execFileSync } = require('node:child_process');

const MODELS = { 'claude-cli': 'claude -p（訂閱）' };

/** 卡片上放濃縮後的關鍵詞，不是旁白原句 —— 原句由字幕負責，兩邊放一樣的字會重複又擠。 */
const SYSTEM_PROMPT =
  '你是財經短影音的動態卡片參數產生器。只輸出 JSON，不要說明文字，不要 markdown 圍欄。';

function buildPrompt(text) {
  return [
    '把這段財經旁白做成一張動態卡片的參數。',
    '',
    `旁白原文：「${text}」`,
    '',
    '規則：',
    '1. template 三選一：',
    '   list     —— 2~5 個並列的點（例：四大關鍵問題、三個觀察重點）',
    '   contrast —— 「不是 X，而是 Y」的轉折（例：不是傳統火藥，而是高頻微波）',
    '   quote    —— 一句有力的話，關鍵詞著色（例：大盤摜破4萬6，資安股掀漲停潮）',
    '2. 卡片上放**濃縮後的關鍵詞**，不是旁白原句 —— 原句下方就是字幕，重複會很擠。',
    '3. **每一項最多 9 個字**（不含前面的編號）。這條最重要 —— 超過的話卡片上的字會被',
    '   自動縮小才塞得下，一長就變小、畫面很難看。寧可再濃縮：',
    '   「外資買超創今年新高紀錄」→「外資買超創新高」、「營收落地或由虧轉盈」剛好 9 個字。',
    '   這條對 list 的 items、contrast 的 negative 與 positives 都適用。',
    '4. list 的每一項都要附 at：那一項對應的**旁白原文片段**（用來算進場時間）。',
    '   at 必須是原文裡真的出現過的連續字串，而且要照原文的先後順序排列。',
    '5. title 可以用 | 分隔，| 之後的部分會套品牌黃色（例：「四大|關鍵問題」）。',
    '6. quote 的 lines 是每行一串 token，token 可帶 c：up（漲，紅）／down（跌，綠）／hl（重點，黃）。',
    '',
    '輸出格式（三選一）：',
    '{"template":"list","kicker":"法說會","title":"四大|關鍵問題","items":[{"text":"電容影響多大","at":"電容問題影響多大"}]}',
    '{"template":"contrast","kicker":"美國太空軍","title":"首度證實|部署太空武器","negative":"傳統火藥","positives":["高頻微波","電子戰設備"]}',
    '{"template":"quote","kicker":"今日盤勢","lines":[[{"t":"大盤"},{"t":"摜破4萬6","c":"down"}]]}',
  ].join('\n');
}

/** LLM 偶爾會加上 markdown 圍欄或前言，把第一個完整的 JSON 物件挖出來。 */
function extractJson(raw) {
  const s = String(raw || '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1].trim() : s;
  const i = body.indexOf('{');
  const j = body.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try {
    return JSON.parse(body.slice(i, j + 1));
  } catch (_) {
    return null;
  }
}

/**
 * 擋掉 LLM 的常見走樣。**不修正、只拒絕** —— 與其送一份半對的參數進 render，
 * 不如回 null 讓這支沒有動態（呼叫端會降級）。
 */
function validate(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const t = spec.template;
  if (!['list', 'contrast', 'quote'].includes(t)) return null;
  const str = (v) => typeof v === 'string' && v.trim().length > 0;

  if (t === 'list') {
    const items = Array.isArray(spec.items) ? spec.items.filter((x) => x && str(x.text)) : [];
    if (items.length < 2 || items.length > 5) return null;
    return { ...spec, items: items.map((x) => ({ text: x.text.trim(), at: str(x.at) ? x.at.trim() : undefined })) };
  }
  if (t === 'contrast') {
    const pos = Array.isArray(spec.positives) ? spec.positives.filter(str) : [];
    if (!str(spec.negative) || pos.length < 1) return null;
    return { ...spec, positives: pos.slice(0, 2) };
  }
  // quote
  const lines = Array.isArray(spec.lines)
    ? spec.lines.map((l) => (Array.isArray(l) ? l.filter((tk) => tk && str(tk.t)) : [])).filter((l) => l.length)
    : [];
  if (lines.length === 0) return null;
  return { ...spec, lines: lines.slice(0, 4) };
}

/**
 * 把 execFileSync 丟出來的錯誤講成人話。順序有意義：
 * stdout 的 JSON（claude 自己的錯誤）→ stderr → 結束碼／signal → 最後才是命令列。
 */
function describeFailure(e) {
  const out = (e && e.stdout || '').toString().trim();
  if (out) {
    try {
      const j = JSON.parse(out);
      const msg = j.result || j.error || j.message;
      if (msg) return `${String(msg).slice(0, 300)}（claude 回報，結束碼 ${e.status}）`;
    } catch (_) { /* 不是 JSON 就當純文字用 */ }
    return `${out.split('\n').slice(-3).join(' ').slice(0, 300)}（結束碼 ${e.status}）`;
  }
  const err = (e && e.stderr || '').toString().trim();
  if (err) return `${err.split('\n').slice(-3).join(' ').slice(0, 300)}（結束碼 ${e.status}）`;
  if (e && e.signal) return `被 ${e.signal} 中止（逾時上限 120 秒）`;
  if (e && e.code === 'ENOENT') return '找不到 claude 這個指令（服務的 PATH 裡沒有）';
  return `結束碼 ${e && e.status}，沒有任何輸出`;
}

const ENGINES = {
  manual: {
    label: '手動（前台貼的參數）',
    plan({ manualSpec }) {
      const spec = validate(manualSpec);
      // ⚠️ 一定要講原因。manual 不呼叫任何服務，「前台只選了範圍、沒貼參數」
      //    在這裡回 null 是正常行為，但對人來說看到的是「影片裡沒有動態」，
      //    不講的話跟當機分不出來（2026-09-18 實際踩過：查了半小時才發現是 engine 選錯）。
      if (!spec) {
        console.error(manualSpec
          ? '⚠️ manual 後端：前台貼的參數不合格，這段不做動態'
          : '⚠️ manual 後端只吃前台貼好的參數，而這段只有選取範圍沒有參數。'
            + '要讓它自己產生，請設 MOTION_ENGINE=claude-cli');
      }
      return spec;
    },
  },

  'claude-cli': {
    label: 'claude -p（訂閱，不需要 API key）',
    plan({ text, manualSpec }) {
      if (!text || !text.trim()) return validate(manualSpec);
      let out;
      // 失敗重試一次。claude -p 偶爾會秒退（2026-09-19 出片時遇過一次，
      // 同一份輸入在別的環境重跑都正常），這種暫時性失敗重試就過，
      // 成本是多等幾秒；真的壞掉的話第二次也會失敗，訊息照樣留在 log 裡。
      for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        out = execFileSync('claude', [
          '-p', buildPrompt(text),
          '--system-prompt', SYSTEM_PROMPT,
          // 這三個旗標把 Claude Code 的預設系統提示與工具定義砍掉，
          // 每次呼叫從 ~25K input tokens 降到 ~16K（實測 2026-09-16）。
          '--allowed-tools', '',
          '--strict-mcp-config',
          '--exclude-dynamic-system-prompt-sections',
          '--output-format', 'json',
        ], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
          // < /dev/null 的等價：不給 stdin 就不會卡在「等 3 秒看有沒有管線輸入」
          input: '',
          timeout: 120000,
          maxBuffer: 8 * 1024 * 1024,
        });
      } catch (e) {
        // 登入過期／用量上限／沒裝 CLI 都走這裡。回 null 讓呼叫端降級，
        // 但訊息要留下來 —— 背景服務跑的時候沒人看得到終端機。
        //
        // ⚠️ stdout 一定要看。--output-format json 的失敗（用量上限、登入過期）
        //    是把原因寫在 **stdout** 的 JSON 裡，stderr 留空、1 秒內非零退出。
        //    只看 stderr 的話，e.message 就只剩「Command failed: claude -p …」整條命令列，
        //    看起來像參數有問題，實際上跟參數無關（2026-09-19 查了一輪才發現）。
        console.error(`⚠️ claude -p 失敗（第 ${attempt} 次）：${describeFailure(e)}`);
        // 找不到指令重試也沒用，直接放棄
        if (attempt === 2 || (e && e.code === 'ENOENT')) return validate(manualSpec);
        try { execFileSync('sleep', ['3']); } catch (_) { /* 等不到就直接重試 */ }
        continue;
      }
      break;
      }
      let result;
      try {
        result = JSON.parse(out).result;
      } catch (_) {
        result = out;
      }
      const spec = validate(extractJson(result));
      if (!spec) {
        console.error('⚠️ claude -p 回傳的內容不符合參數格式，改用手動參數（若有）');
        return validate(manualSpec);
      }
      return spec;
    },
  },

  api: {
    label: 'Anthropic API（尚未實作）',
    plan() {
      throw new Error('MOTION_ENGINE=api 尚未實作；目前可用 manual 或 claude-cli');
    },
  },
};

function createEngine(name) {
  // 預設是 claude-cli：前台只讓人「選一段文字」，參數本來就該自己產生 ——
  // 預設 manual 的話，沒設環境變數就會靜默變成「每支都沒有動態」（2026-09-18 踩過）。
  // manual 仍留著，給「參數自己貼、不想呼叫任何服務」的情況用。
  const key = name || 'claude-cli';
  const engine = ENGINES[key];
  if (!engine) throw new Error(`不認得的 MOTION_ENGINE：${key}（可用：${Object.keys(ENGINES).join('／')}）`);
  return engine;
}

/** 產線唯一入口。回傳 null＝這段不做動態，呼叫端必須能接受。 */
function plan(input, env = process.env) {
  return createEngine(env.MOTION_ENGINE).plan(input || {});
}

module.exports = { plan, createEngine, validate, extractJson, buildPrompt, describeFailure, ENGINES, MODELS };
