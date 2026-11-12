'use strict';

/**
 * `claude -p` 的共用呼叫層（2026-11-11），可以附圖片。
 *
 * 跟 motion-engine.js 同一個決定：走**訂閱**、不用 API key（2026-09-16 使用者定案）。
 * 純文字的呼叫目前只有 motion-engine.js 自己那份 callClaude（照舊沒動）；
 * 要附截圖的呼叫走這裡 —— 圖片不能塞進 `-p` 的參數，要用 stream-json 從 stdin 送一則
 * 含 image block 的使用者訊息。
 *
 * 只給「引擎層」用（cell-picker-engine.js…）。AGENTS.md：業務邏輯不得新增供應者 CLI 呼叫。
 *
 * 介面：
 *   runClaude({ prompt, system, images?: [檔案路徑 | { path, width, height }], timeoutMs? })
 *     → { ok: true, text } | { ok: false, error }
 *   一律不丟例外：沒裝 CLI、沒登入、用量上限、逾時都回 ok:false，呼叫端自己降級。
 *
 * 開關：
 *   CLAUDE_BIN    指令路徑，預設 PATH 裡的 `claude`（測試用假的腳本換掉它）
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * 圖片大小上限：長邊 1568、總像素約 115 萬。超過的話 Claude 那邊會**自己再縮一次**，
 * 它看到的座標就跟我們算的對不上（2026-11-12 實測：1206×1221 的大盤截圖被縮，回來的框整個偏掉）。
 * 所以一律由這裡先縮到上限內，呼叫端用 fitSize() 算出同一個尺寸跟它溝通座標。
 */
const MAX_EDGE = 1568;
const MAX_PIXELS = 1150000;

/** 縮到上限內的尺寸（偶數，跟 ffmpeg 一致）與縮放比例 */
function fitSize(width, height) {
  const s = Math.min(1, MAX_EDGE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)));
  if (s >= 1) return { width, height, scale: 1 };
  const w = Math.max(2, Math.floor((width * s) / 2) * 2);
  const h = Math.max(2, Math.floor((height * s) / 2) * 2);
  return { width: w, height: h, scale: w / width };
}

function claudeBin() {
  return process.env.CLAUDE_BIN || 'claude';
}

/**
 * 讀成 base64。`img` 可以是檔案路徑，或 { path, width, height }：給了原圖尺寸就縮到 fitSize() 的大小
 * （產線本來就依賴 ffmpeg），縮失敗或沒給尺寸就送原檔。
 */
function imageBlock(img) {
  const file = typeof img === 'string' ? img : img.path;
  const fit = typeof img === 'object' && img.width && img.height ? fitSize(img.width, img.height) : null;
  if (fit && fit.scale < 1) {
    const tmp = path.join(os.tmpdir(), `claude-img-${process.pid}-${Date.now()}.png`);
    try {
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-vf', `scale=${fit.width}:${fit.height}`, tmp],
        { stdio: 'ignore', timeout: 30000 });
      return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: fs.readFileSync(tmp).toString('base64') } };
    } catch (_) {
      /* 縮失敗就送原檔 */
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }
  const raw = fs.readFileSync(file);
  const jpeg = raw[0] === 0xff && raw[1] === 0xd8;
  return {
    type: 'image',
    source: { type: 'base64', media_type: jpeg ? 'image/jpeg' : 'image/png', data: raw.toString('base64') },
  };
}

/** 從 stream-json 輸出撈最後一筆 result。 */
function parseStream(stdout) {
  let result = null;
  for (const line of String(stdout || '').split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try {
      const ev = JSON.parse(s);
      if (ev && ev.type === 'result') result = ev;
    } catch (_) { /* 不是完整 JSON 的行略過 */ }
  }
  if (!result) return { ok: false, error: '沒有收到 claude 的 result（輸出格式不對或中途結束）' };
  if (result.is_error) return { ok: false, error: `claude 回報錯誤：${String(result.result || '').slice(0, 300)}` };
  return { ok: true, text: String(result.result || '') };
}

function describeFailure(e) {
  if (e && e.code === 'ENOENT') return `找不到 ${claudeBin()} 這個指令（服務的 PATH 裡沒有）`;
  if (e && e.code === 'ETIMEDOUT') return '逾時';
  if (e && e.stdout) {
    const r = parseStream(e.stdout);
    if (!r.ok) return r.error;
  }
  const err = e && e.stderr ? String(e.stderr).trim().slice(0, 300) : '';
  return err || (e && e.message ? String(e.message).slice(0, 300) : '未知錯誤');
}

function runClaude({ prompt, system, images = [], timeoutMs = 120000 }) {
  let content;
  try {
    content = [...images.map(imageBlock), { type: 'text', text: prompt }];
  } catch (e) {
    return { ok: false, error: `讀不到圖片：${e.message}` };
  }
  const input = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--system-prompt', system,
    // 跟 motion-engine.js 同一組：砍掉預設系統提示與工具定義，省 token、也不讓它動檔案
    '--allowed-tools', '',
    '--strict-mcp-config',
    '--exclude-dynamic-system-prompt-sections',
  ];
  let last = null;
  // 失敗重試一次（claude -p 偶爾秒退，見 motion-engine.js）
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const stdout = execFileSync(claudeBin(), args, {
        input,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      });
      const r = parseStream(stdout);
      if (r.ok) return r;
      last = r.error;
    } catch (e) {
      last = describeFailure(e);
      if (e && e.code === 'ENOENT') break; // 沒裝就別重試
    }
  }
  return { ok: false, error: last || '未知錯誤' };
}

module.exports = { runClaude, parseStream, fitSize };
