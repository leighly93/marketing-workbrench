#!/usr/bin/env node
/**
 * 查 HeyGen voice 的能力：support_pause（吃不吃 <break> 標籤）、support_locale、engine。
 *
 * 用法：
 *   npm run check-voices                 # 查 run.js 裡三條固定主播產線的 voice
 *   npm run check-voices -- <voice_id>   # 查任意一支
 *
 * 只讀不寫，不耗生成額度。
 */

const { workspaceRoot } = require('../../paths');
const APP_ROOT = require('path').resolve(__dirname, '..');
try { require('dotenv').config({ path: require('path').join(workspaceRoot(APP_ROOT), '.env'), quiet: true }); } catch (_) {}

const API_KEY = (process.env.HEYGEN_API_KEY || "").trim();

// 跟 run.js 同步（改 run.js 的 voice 時記得也改這裡，或直接帶參數查）
const KNOWN = [
  { label: "大盤小報 dapan", id: "dc529e16819846b2a0ba986a7fc51a85" },
  // 2026-09-11 起盤中焦點有自己的聲音，不再跟大盤小報同一支（原本兩行是同一個 id）。
  { label: "盤中焦點 midday", id: "9cb1516ecebf4c06b668e03f7f6e91f7" },
  // 美股焦點 2026-09-15 新增：這條線預設走 MiniMax，沒有備援的 HeyGen 內建語音，所以還沒有 id 可查。
  { label: "三大法人 institution", id: "e96f2834052f404c9c3725b4fd6ee55a" },
  { label: "焦點股日報 focusstock", id: "65b04effe83f423dbb1f66317318c37f" },
  { label: "投廣單人 女聲／雙人 A", id: "65b04effe83f423dbb1f66317318c37f" },
  { label: "投廣單人 男聲／雙人 B", id: "c223c1b3c779490ca14f4525eb30006e" },
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
