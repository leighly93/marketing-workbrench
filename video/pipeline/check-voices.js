#!/usr/bin/env node
/**
 * 查 HeyGen voice 的能力：support_pause（吃不吃 <break> 標籤）、support_locale、engine。
 *
 * 用法：
 *   npm run check-voices                 # 查各版型（registry）與雙人 path 的 voice
 *   npm run check-voices -- <voice_id>   # 查任意一支
 *
 * 只讀不寫，不耗生成額度。
 */

const { workspaceRoot } = require('../../shared/paths');
const APP_ROOT = require('path').resolve(__dirname, '..', 'remotion');
try { require('dotenv').config({ path: require('path').join(workspaceRoot(APP_ROOT), '.env'), quiet: true }); } catch (_) {}

const API_KEY = (process.env.HEYGEN_API_KEY || "").trim();

// 固定主播的 HeyGen 聲音直接讀 registry；美股焦點只有 MiniMax 聲音，沒有可查的 HeyGen id。
const { TEMPLATES } = require('../templates/registry');
const KNOWN = [
  ...Object.entries(TEMPLATES).filter(([, t]) => t.anchor.heygenVoiceId)
    .map(([id, t]) => ({ label: `${t.label} ${id}`, id: t.anchor.heygenVoiceId })),
  // run.js 雙人 path（HEYGEN_DUAL_VOICES）用的兩支
  { label: "雙人 A（女聲）", id: "65b04effe83f423dbb1f66317318c37f" },
  { label: "雙人 B（男聲）", id: "c223c1b3c779490ca14f4525eb30006e" },
];

async function fetchVoice(voiceId) {
  const res = await fetch(`https://api.heygen.com/v3/voices/${voiceId}`, {
    headers: { "X-Api-Key": API_KEY },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, status: res.status, body };
  return { ok: true, voice: body?.data?.voice || body?.data || body };
}

function fmt(v) {
  const yes = (b) => (b === true ? "✅ 是" : b === false ? "❌ 否" : "（未回報）");
  return [
    `    name          : ${v.name ?? "(無)"}`,
    `    language      : ${v.language ?? "(無)"}`,
    `    gender        : ${v.gender ?? "(無)"}`,
    `    engine        : ${v.engine ?? "(無)"}`,
    `    support_pause : ${yes(v.support_pause)}   ← 吃不吃 <break time="0.3s"/>`,
    `    support_locale: ${yes(v.support_locale)}   ← 吃不吃 voice_settings.locale（例 zh-TW）`,
    v.preview_audio_url ? `    preview       : ${v.preview_audio_url}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

async function main() {
  if (!API_KEY) {
    console.error("❌ 缺少 HEYGEN_API_KEY（請填到 .env）");
    process.exit(1);
  }

  const argIds = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const targets = argIds.length
    ? argIds.map((id) => ({ label: "（指定）", id }))
    : KNOWN;

  for (const t of targets) {
    console.log(`\n▶ ${t.label}  ${t.id}`);
    const r = await fetchVoice(t.id);
    if (!r.ok) {
      console.log(`    ⚠️ 查不到（HTTP ${r.status}）`);
      if (r.body) console.log("    " + JSON.stringify(r.body));
      continue;
    }
    console.log(fmt(r.voice));
  }

  console.log(`
判讀：
  support_pause  = 是 → 可以在 script.txt 裡插 <break time="0.3s"/> 強制停頓
                        ⚠️ 但目前 cleanBodyWithIndex 沒遮罩這個標籤，直接寫會漏進字幕，
                           要先同步檢查 run.js、字幕校正與稿件解析（見 AGENTS.md 的稿件契約）
  support_locale = 是 → run.js 的 HEYGEN_VOICE_LOCALE 可以填 "zh-TW"（台灣國語腔）
`);
}

main().catch((e) => {
  console.error("❌", e.stack || e.message);
  process.exit(1);
});
