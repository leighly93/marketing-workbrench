#!/usr/bin/env node
/**
 * VLM + OCR 分工試驗（隔離區，不碰產線）—— 2026-09-08
 *
 * 要回答的問題只有兩個：「VLM 幫 OCR 補語意，準不準？」「快不快、多少 token？」
 *
 * 分工（見 99_封存/2026-09-10_第一批整理/舊說明與Agent紀錄/docs/tasks.md 的 2026-09-08 討論；歷史依據）：
 *   OCR（Apple Vision）：字在哪、數字是多少 —— 唯一的座標與數字來源
 *   VLM（OpenAI）：這是哪一頁、哪檔股票、主題、最重要的幾個事實 —— 每個事實必須引用 OCR 讀出的原詞
 *   第二步（純文字、不帶圖）：腳本每一句配哪張圖、講到哪個事實
 *
 * 三條鐵律在這支就開始守：VLM 不吐座標；VLM 說的要能在 OCR 裡對到（grounded 欄位）；數字對不對不問 VLM。
 *
 * 用法（要在 macOS，Vision 是 macOS 框架；網路要能到 api.openai.com）：
 *   node scripts/_vision-trial/vlm-trial.js                              # 預設 jobs/20260903-141043-40pw/input
 *   node scripts/_vision-trial/vlm-trial.js --dir jobs/<id>/input
 *   node scripts/_vision-trial/vlm-trial.js --model gpt-4.1              # 換模型（預設 gpt-4o；或 .env VLM_MODEL）
 *   node scripts/_vision-trial/vlm-trial.js --no-match                   # 只做每張圖的分析，不做腳本配對
 *   node scripts/_vision-trial/vlm-trial.js --concurrency 2
 *
 * 輸出：終端機表格 ＋ scripts/_vision-trial/out/vlm-<jobId>.json（完整回覆、token、耗時）
 * 花費：每張圖約 1~2k input token；一支 9 張圖的 job 大約幾塊台幣。
 */
'use strict';
process.env.OCR_ENGINE = 'vision'; // 這支只驗 Vision + VLM 的組合

const fs = require('fs');
const path = require('path');
const { workspaceRoot, cliPath, dataPath } = require('../../../paths');

const ROOT = path.resolve(__dirname, '..', '..');
const WORKSPACE_ROOT = workspaceRoot(ROOT);
const HERE = __dirname;
const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });
try { require('dotenv').config({ path: path.join(WORKSPACE_ROOT, '.env'), quiet: true }); } catch (_) {}

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const DIR = cliPath(ROOT, arg('--dir', 'jobs/20260903-141043-40pw/input'));
const MODEL = arg('--model', process.env.VLM_MODEL || 'gpt-4o');
const CONC = parseInt(arg('--concurrency', '4'), 10);
const DO_MATCH = !argv.includes('--no-match');
const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) { console.error('❌ .env 沒有 OPENAI_API_KEY'); process.exit(1); }
if (process.platform !== 'darwin') { console.error('❌ 要在 macOS 上跑（Vision）'); process.exit(1); }

const OCR = require(path.join(ROOT, 'scripts', 'ocr-engine.js'));
const { getBodyAfterVoice, cleanBodyWithIndex } = require(path.join(ROOT, 'scripts', 'script-utils.js'));

// ── 頁型清單（給 VLM 選，不讓它自己發明）──
const PT = JSON.parse(fs.readFileSync(dataPath(WORKSPACE_ROOT, 'page-samples', 'page-types.json'), 'utf-8'));
const PAGE_TYPES = Object.entries(PT.types || {}).map(([k, t]) => ({ key: t.legacyKey || k, zh: t.zh, hint: (t.signatures && t.signatures.all || []).join('、') }));
const PAGE_KEYS = PAGE_TYPES.map((p) => p.key).concat(['unknown']);

// ── 圖片 ──
const files = fs.readdirSync(DIR).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
if (!files.length) { console.error('❌ 資料夾沒有截圖：' + DIR); process.exit(1); }
const jobId = path.basename(path.dirname(DIR)) === 'input' ? path.basename(DIR) : path.basename(path.dirname(DIR));
console.log(`📂 ${files.length} 張圖　模型：${MODEL}　並行：${CONC}`);

// ── OpenAI ──
async function chat(messages, schema, name) {
  const t0 = Date.now();
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API_KEY },
    body: JSON.stringify({
      model: MODEL, messages, temperature: 0,
      response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
    }),
  });
  const ms = Date.now() - t0;
  const txt = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}：${txt.slice(0, 300)}`);
  const j = JSON.parse(txt);
  const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  let parsed = null;
  try { parsed = JSON.parse(content); } catch (e) { throw new Error('回的不是 JSON：' + String(content).slice(0, 200)); }
  return { parsed, usage: j.usage || {}, ms };
}

// ── 第一步：每張圖一個問題 ──
const IMAGE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['page', 'pageWhy', 'newTypeGuess', 'stockName', 'stockCode', 'topic', 'facts', 'confidence'],
  properties: {
    page: { type: 'string', enum: PAGE_KEYS, description: '從清單選一個；都不像就 unknown' },
    pageWhy: { type: 'string', description: '一句話，為什麼是這一頁' },
    newTypeGuess: { type: ['string', 'null'], description: 'page=unknown 時描述這是什麼頁，否則 null' },
    stockName: { type: ['string', 'null'], description: '圖上明確看到的股票／指數名稱，看不到就 null' },
    stockCode: { type: ['string', 'null'], description: '圖上明確看到的 4 位數代號，看不到就 null，不要猜' },
    topic: { type: ['string', 'null'], description: '排行／清單頁左側被選取的篩選名稱（例：噴發向上），沒有就 null' },
    facts: {
      type: 'array', description: '這張圖最重要的 3~6 個數字事實，旁白最可能講到的',
      items: {
        type: 'object', additionalProperties: false, required: ['text', 'ocrWords'],
        properties: {
          text: { type: 'string', description: '中文短句，例：欣興 下跌 5.14%' },
          ocrWords: { type: 'array', items: { type: 'string' }, description: '依據的 OCR 詞，必須逐字複製自 OCR 清單' },
        },
      },
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
};

function imageMessages(file, ocr) {
  const b64 = fs.readFileSync(path.join(DIR, file)).toString('base64');
  const mime = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg';
  const ocrList = ocr.words.map((w) => w.t).join(' | ');
  const types = PAGE_TYPES.map((p) => `${p.key}：${p.zh}${p.hint ? '（特徵字：' + p.hint + '）' : ''}`).join('\n');
  return [
    { role: 'system', content:
      '你是台股 App（CMoney 籌碼K線）截圖的分析員。使用者會給你一張截圖和 OCR 讀出的詞清單。' +
      '只回答 JSON。規則：①頁型只能從給定清單選，都不像才 unknown。②股名／代號只填圖上明確看到的，看不到就 null，絕對不要用常識猜。' +
      '③facts 的 ocrWords 必須逐字複製自 OCR 清單（OCR 可能有錯字，照抄即可，不要修正）。④不要給任何座標。' },
    { role: 'user', content: [
      { type: 'text', text: `頁型清單：\n${types}\n\nOCR 讀出的詞（左上到右下）：\n${ocrList}\n\n請分析這張截圖。` },
      { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}`, detail: 'high' } },
    ] },
  ];
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

(async () => {
  // OCR
  console.log('▶ Vision OCR…');
  let t0 = Date.now();
  OCR.ensure();
  const ocrByFile = {};
  for (const f of files) ocrByFile[f] = OCR.ocrPage(path.join(DIR, f));
  const ocrMs = Date.now() - t0;
  console.log(`   ${ocrMs} ms（${files.length} 張）`);

  // VLM per image
  console.log(`▶ VLM 看圖（${MODEL}）…`);
  t0 = Date.now();
  const results = await mapLimit(files, CONC, async (f) => {
    try {
      const r = await chat(imageMessages(f, ocrByFile[f]), IMAGE_SCHEMA, 'app_screenshot');
      const set = new Set(ocrByFile[f].words.map((w) => w.t));
      const fullText = ocrByFile[f].words.map((w) => w.t).join('');
      const facts = (r.parsed.facts || []).map((x) => ({ ...x, grounded: x.ocrWords.length > 0 && x.ocrWords.every((w) => set.has(w)) }));
      const nameOk = r.parsed.stockName ? fullText.includes(r.parsed.stockName) : null;
      const codeOk = r.parsed.stockCode ? fullText.includes(r.parsed.stockCode) : null;
      return { file: f, ok: true, ...r.parsed, facts, nameGrounded: nameOk, codeGrounded: codeOk, usage: r.usage, ms: r.ms };
    } catch (e) {
      return { file: f, ok: false, error: e.message };
    }
  });
  const vlmMs = Date.now() - t0;

  const pad = (s, n) => { s = String(s ?? '—'); let w = 0; for (const ch of s) w += ch.charCodeAt(0) > 255 ? 2 : 1; return s + ' '.repeat(Math.max(0, n - w)); };
  console.log('\n' + pad('檔名', 12) + pad('頁型', 22) + pad('股名', 10) + pad('代號', 8) + pad('主題', 10) + pad('信心', 8) + pad('事實(對到OCR)', 14) + pad('秒', 6) + 'token in/out');
  let tokIn = 0, tokOut = 0;
  for (const r of results) {
    if (!r.ok) { console.log(pad(r.file, 12) + '❌ ' + r.error); continue; }
    tokIn += r.usage.prompt_tokens || 0; tokOut += r.usage.completion_tokens || 0;
    const g = r.facts.filter((x) => x.grounded).length;
    console.log(pad(r.file, 12) + pad(r.page + (r.page === 'unknown' && r.newTypeGuess ? '?' : ''), 22) +
      pad((r.stockName ?? '—') + (r.nameGrounded === false ? '⚠' : ''), 10) + pad((r.stockCode ?? '—') + (r.codeGrounded === false ? '⚠' : ''), 8) +
      pad(r.topic, 10) + pad(r.confidence, 8) + pad(`${g}/${r.facts.length}`, 14) + pad((r.ms / 1000).toFixed(1), 6) +
      `${r.usage.prompt_tokens}/${r.usage.completion_tokens}`);
  }
  console.log(`\nVision ${ocrMs} ms；VLM 總牆鐘 ${(vlmMs / 1000).toFixed(1)} s（並行 ${CONC}）；token 合計 in ${tokIn} / out ${tokOut}`);
  console.log('⚠ = VLM 說的股名／代號在 OCR 全文裡找不到（鐵律二：不能直接採用）');
  for (const r of results) if (r.ok) {
    console.log(`\n${r.file}　${r.pageWhy}${r.newTypeGuess ? '　新頁型？' + r.newTypeGuess : ''}`);
    for (const x of r.facts) console.log(`   ${x.grounded ? '✓' : '✗'} ${x.text}　← ${x.ocrWords.join(' | ')}`);
  }

  // ── 第二步：腳本 → 圖（純文字）──
  let match = null;
  const scriptPath = path.join(DIR, 'script.txt');
  if (DO_MATCH && fs.existsSync(scriptPath)) {
    const raw = fs.readFileSync(scriptPath, 'utf-8');
    const chars = cleanBodyWithIndex(getBodyAfterVoice(raw));
    // 句子：cleaned chars 依 breakAfter 切
    const sentences = []; let cur = '', start = 0;
    chars.forEach((c, i) => { if (!cur) start = i; cur += c.char; if (c.breakAfter || i === chars.length - 1) { sentences.push({ i: sentences.length, text: cur, start, end: i }); cur = ''; } });
    // 人工標注（標準答案）
    let human = [];
    try {
      const ann = JSON.parse(fs.readFileSync(path.join(DIR, 'annotations.json'), 'utf-8'));
      human = (ann.shots || []).map((s) => ({ src: s.src, start: s.startCharIdx, end: s.endCharIdx }));
    } catch (_) {}
    const humanFor = (s) => [...new Set(human.filter((h) => h.start <= s.end && h.end >= s.start).map((h) => h.src))];

    const imgs = results.filter((r) => r.ok).map((r) => ({
      file: r.file, page: r.page, stockName: r.stockName, stockCode: r.stockCode, topic: r.topic,
      facts: r.facts.map((x, k) => ({ k, text: x.text })),
    }));
    const MATCH_SCHEMA = {
      type: 'object', additionalProperties: false, required: ['items'],
      properties: { items: { type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['i', 'file', 'factK', 'why'],
        properties: {
          i: { type: 'integer' }, file: { type: ['string', 'null'], description: '配哪張圖的檔名；這句不該配圖就 null' },
          factK: { type: ['integer', 'null'], description: '講到那張圖的第幾個事實（k）；沒有特定事實就 null' },
          why: { type: 'string' },
        } } } },
    };
    console.log('\n▶ VLM 配對（純文字）…');
    try {
      const r = await chat([
        { role: 'system', content: '你是短影音的配圖編輯。給你旁白句子與每張截圖的摘要，判斷每一句該配哪張圖、講到哪個事實。只有這句話明確在講那張圖的內容才配；泛泛的句子（開場、總結、轉折）回 null。同一張圖可以配多句。只回 JSON。' },
        { role: 'user', content: `旁白句子：\n${sentences.map((s) => `${s.i}. ${s.text}`).join('\n')}\n\n截圖摘要：\n${JSON.stringify(imgs, null, 1)}` },
      ], MATCH_SCHEMA, 'shot_matching');
      match = { ...r.parsed, usage: r.usage, ms: r.ms };
      const byI = Object.fromEntries((r.parsed.items || []).map((x) => [x.i, x]));
      let agree = 0, scored = 0;
      console.log('\n' + pad('#', 4) + pad('旁白', 44) + pad('VLM 配圖', 12) + pad('人工', 16) + '一致');
      for (const s of sentences) {
        const m = byI[s.i] || {}; const hs = humanFor(s);
        const same = hs.length ? (m.file ? hs.includes(m.file) : false) : (m.file ? false : true);
        if (hs.length || m.file) { scored++; if (same) agree++; }
        console.log(pad(s.i, 4) + pad(s.text.length > 20 ? s.text.slice(0, 20) + '…' : s.text, 44) +
          pad(m.file ? m.file + (m.factK != null ? '#' + m.factK : '') : '—', 12) + pad(hs.length ? hs.join(',') : '—', 16) + (hs.length || m.file ? (same ? '✓' : '✗') : ''));
      }
      console.log(`\n配對與人工一致 ${agree}/${scored}（只算至少一邊有配圖的句子）；${(r.ms / 1000).toFixed(1)} s；token in ${r.usage.prompt_tokens} / out ${r.usage.completion_tokens}` +
        (human.length ? '' : '　（這個 job 沒有 annotations.json，沒有人工答案可比）'));
    } catch (e) {
      console.log('❌ 配對失敗：' + e.message);
    }
  }

  const outPath = path.join(OUT, `vlm-${jobId}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ model: MODEL, dir: DIR, ocrMs, vlmMs, results, match }, null, 2));
  console.log(`\n明細：${outPath}`);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
