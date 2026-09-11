#!/usr/bin/env node

// ─────────────────────────────────────────────────────────────
//  HeyGen 對照測試工具（同一段文字、同一 avatar、同一 voice，只換一個變因）
//
//  可比的變因（--only 用逗號串起來，會「依序」跑，扣點才分得清是誰花的）：
//    v2   POST /v2/videos                        （舊端點，不帶 engine）
//    iv   POST /v3/videos + engine avatar_iv     ← 目前 run.js 的正式設定
//    iii  POST /v3/videos + engine avatar_iii    （photo avatar 只比 IV 便宜 13%，不是 2/3）
//    v    POST /v3/videos + engine avatar_v      （官方說只吃 digital_twin，但這支 photo avatar 的
//                                                 supported_api_engines 有列它，值得一試）
//
//  用法：
//    0) 先免費探測這支 avatar 支援哪些引擎（不生成、不扣點）：
//       node scripts/ab-endpoints.js --template=institution --probe
//    1) 先把測試短句寫進 ab-test.txt（專案根目錄，一行就好；15~25 字 ≒ 4~6 秒）
//    2) 空跑看要花多少、payload 長怎樣（不生成、不扣點）：
//       node scripts/ab-endpoints.js --template=institution --only=iii,iv --dry-run
//    3) 真的跑：
//       node scripts/ab-endpoints.js --template=institution --only=iii,iv --go
//
//  其他旗標：
//    --file=<path>    測試文字檔（預設 ab-test.txt）
//    --text="..."     直接給文字，優先於 --file
//    --motion         帶 motion_prompt（2026-08-19 實測：API tier 不會因此加倍計費）
//    --aspect=16:9    出片比例（預設 9:16）。2026-08-25：大盤主播素材是橫式，
//                     v3 在 9:16 下會上下補白邊，用這個旗標驗證 16:9 是否回原生滿版。
//    --fit=cover      只有 v3 吃。cover=填滿可能裁邊、contain=完整塞進去會露背景；不送＝HeyGen 自己挑
//    --v3-speed=1.25  v3 系列帶 voice_settings.speed
//                     （2026-08-19 實測對 institution 的 voice 無效，只短 2%）
//
//  ⚠️ 加了 --go 才會真的生成、真的扣點。輸出在 out/ab-<變因>.mp4，
//     不會動到 public/heygen.mp4，也不碰後製鏈。
//
//  計費常識（2026-08-19 實測，別再重推一次）：
//    remaining_quota 回的是「quota 單位」，60 單位 = 1 點 = US$1。對秒數取整（floor）。
//    **photo avatar** 的費率：Avatar III $0.0433/秒＝2.6 單位、Avatar IV $0.05/秒＝3.0、Avatar V $0.0667/秒＝4.0。
//    $0.0167/秒（＝1 單位/秒）那一檔只有 Studio Avatar／Digital Twin 吃得到，照片主播拿不到。
//    實證：floor(69.26)×3 = 207（IV）、5.24 秒 → III 扣 14／IV 扣 15。
// ─────────────────────────────────────────────────────────────

const { workspaceRoot, cliPath } = require('../../paths');
const APP_ROOT = require('path').resolve(__dirname, '..');
require('dotenv').config({ path: require('path').join(workspaceRoot(APP_ROOT), '.env'), quiet: true });

const { execSync } = require("child_process");
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require("fs");
const { resolve } = require("path");

const PROJECT_DIR = workspaceRoot(APP_ROOT);
const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const val = (name, dflt = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const TEMPLATE = val("template", "institution");
const TEXT_FILE = val("file", "ab-test.txt");
const TEXT_INLINE = val("text");
const WITH_MOTION = flag("motion");
const V3_SPEED = val("v3-speed") ? Number(val("v3-speed")) : null;
// 2026-08-25 加：直接比「同一支 avatar 在不同 aspect_ratio / fit 下會不會補白邊」。
// 只有 /v3/videos 吃 fit（cover=縮放填滿可能裁邊、contain=完整塞進去會露背景）。
const ASPECT = val("aspect", "9:16");
const FIT = val("fit");
const PROBE = flag("probe");
const DRY_RUN = flag("dry-run");
const GO = flag("go");

// run.js 的固定主播四條線設定（改 run.js 時這裡要同步，否則測的不是同一組人聲）
// dapan／midday 的 avatar 與 HeyGen 聲音於 2026-09-11 跟著 run.js 換掉（兩條線的聲音也從此各自獨立）。
const PRESETS = {
  dapan: { avatar: "5bad6432678c4157aeaf245021a2326e", voice: "dc529e16819846b2a0ba986a7fc51a85" },
  institution: { avatar: "57d5790b64e34472a932d6c7d0b4f64b", voice: "e96f2834052f404c9c3725b4fd6ee55a" },
  focusstock: { avatar: "7765f68aaa6a4b658b95f4e5357c21d5", voice: "65b04effe83f423dbb1f66317318c37f" },
  midday: { avatar: "b1be6a97186e4c49896f3eb503f8065f", voice: "9cb1516ecebf4c06b668e03f7f6e91f7" },
};

// 變因定義。engine = null 表示不送 engine 欄位（舊端點的行為）。
const VARIANTS = {
  v2: { api: "v2", engine: null, label: "v2（舊端點）" },
  v3: { api: "v3", engine: "avatar_iv", label: "v3 + avatar_iv" }, // 舊名保留當別名
  iv: { api: "v3", engine: "avatar_iv", label: "Avatar IV" },
  iii: { api: "v3", engine: "avatar_iii", label: "Avatar III" },
  v: { api: "v3", engine: "avatar_v", label: "Avatar V" },
};

const MOTION_PROMPT =
  "站姿自然，雙手在胸前或身側做出適度自然的手勢，配合語氣比劃，不要十指交握不動";

const log = (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 餘額 ───────────────────────────────────
async function readQuota() {
  const res = await fetch("https://api.heygen.com/v2/user/remaining_quota", {
    headers: { "X-Api-Key": HEYGEN_API_KEY },
  });
  const data = await res.json().catch(() => null);
  const raw = data?.data?.remaining_quota ?? data?.remaining_quota;
  if (typeof raw !== "number") {
    console.error("查餘額失敗，回應：", JSON.stringify(data, null, 2));
    return null;
  }
  return { raw, credits: raw / 60 };
}

// ── 免費探測：這支 avatar 支援哪些引擎 ──────
// 官方：呼叫前先看 GET /v3/avatars/looks/{look_id} 回的 supported_api_engines。
async function probeEngines(avatarId) {
  const urls = [
    `https://api.heygen.com/v3/avatars/looks/${avatarId}`,
    `https://api.heygen.com/v3/avatars/${avatarId}`,
  ];
  for (const u of urls) {
    const res = await fetch(u, { headers: { "X-Api-Key": HEYGEN_API_KEY } });
    const data = await res.json().catch(() => null);
    log(`GET ${u} → HTTP ${res.status}`);
    if (!res.ok) continue;
    const d = data?.data || data || {};
    const engines = d.supported_api_engines || d.look?.supported_api_engines;
    console.log(JSON.stringify(d, null, 2).slice(0, 1200));
    if (engines) {
      console.log("");
      log(`✅ supported_api_engines = ${JSON.stringify(engines)}`);
      return engines;
    }
  }
  console.log("");
  log("⚠️ 兩個路徑都拿不到 supported_api_engines（可能 talking_photo 不走 looks 那組端點）。");
  log("   那就直接花一支短片試 --only=iii —— 引擎不支援的話 API 會回 400、不會扣點。");
  return null;
}

// ── 建立影片 ───────────────────────────────
function buildPayload(name, text, preset) {
  const v = VARIANTS[name];
  const p = {
    avatar_id: preset.avatar,
    script: text,
    voice_id: preset.voice,
    aspect_ratio: ASPECT,
    resolution: "1080p",
    title: `ab-test-${name}`,
  };
  // expressiveness / motion_prompt 是 photo avatar + Avatar IV 那條的欄位。
  // avatar_v 送了會被 400 擋掉（實測訊息：「expressiveness is not supported with engine 'avatar_v'」）；
  // avatar_iii 也可能被拒或忽略 → 只在 IV／舊端點帶，把變因收乾淨。
  if (v.engine === "avatar_iv" || v.engine === null) p.expressiveness = "medium";
  if (WITH_MOTION) p.motion_prompt = MOTION_PROMPT;
  if (v.api === "v3") {
    p.type = "avatar";
    if (v.engine) p.engine = { type: v.engine };
    if (FIT) p.fit = FIT;
    if (V3_SPEED !== null) p.voice_settings = { speed: V3_SPEED };
  }
  return p;
}

async function createVideo(name, payload) {
  const url = `https://api.heygen.com/${VARIANTS[name].api}/videos`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "X-Api-Key": HEYGEN_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => null);
  const videoId = data?.data?.video_id || data?.data?.id || data?.video_id;
  if (!res.ok || !videoId) {
    console.error(`${name} 建立失敗（HTTP ${res.status}）：`, JSON.stringify(data, null, 2));
    throw new Error(`${name} 建立影片失敗`);
  }
  return videoId;
}

async function pollVideo(name, videoId) {
  const api = VARIANTS[name].api;
  for (let i = 0; i < 90; i++) {
    await sleep(10000);
    const res = await fetch(`https://api.heygen.com/${api}/videos/${videoId}`, {
      headers: { "X-Api-Key": HEYGEN_API_KEY },
    });
    const data = await res.json().catch(() => null);
    const d = data?.data || data || {};
    if (d.failure_code || d.failure_message) {
      console.error(`${name} 回應：`, JSON.stringify(data, null, 2));
      throw new Error(`${name} 生成失敗：${d.failure_code || ""} ${d.failure_message || ""}`.trim());
    }
    const url = d.video_url || d.url || d.output?.video_url;
    const status = d.status || d.state || "processing";
    if (url) {
      console.log("");
      return { url, duration: d.duration || null };
    }
    if (["failed", "error"].includes(String(status))) {
      throw new Error(`${name} 生成失敗：${JSON.stringify(data)}`);
    }
    process.stdout.write(`\r  ${name} 狀態：${status}            `);
  }
  throw new Error(`${name} 等待超時（15 分鐘）`);
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下載失敗：${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

function probeDuration(file) {
  try {
    return Number(
      execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`, {
        encoding: "utf-8",
      }).trim()
    );
  } catch {
    return null;
  }
}

async function runOne(name, text, preset) {
  const payload = buildPayload(name, text, preset);
  log(`── ${VARIANTS[name].label} ──`);
  log(`payload：${JSON.stringify(payload)}`);

  const before = await readQuota();
  if (before) log(`生成前餘額：${before.raw} 單位（÷60 = $${before.credits.toFixed(2)}）`);

  const videoId = await createVideo(name, payload);
  log(`video_id = ${videoId}，等待生成（約 2-5 分鐘）…`);
  const { url, duration } = await pollVideo(name, videoId);

  const outDir = resolve(PROJECT_DIR, "out");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const tag = `${ASPECT.replace(":", "x")}${FIT ? "-" + FIT : ""}`;
  const file = resolve(outDir, `ab-${name}-${tag}.mp4`);
  await download(url, file);
  log(`已下載 → ${file}`);

  log("等 20 秒讓扣點反映後查餘額…");
  await sleep(20000);
  const after = await readQuota();
  if (after) log(`生成後餘額：${after.raw} 單位（÷60 = $${after.credits.toFixed(2)}）`);

  const sec = probeDuration(file) ?? duration;
  const spent = before && after ? before.raw - after.raw : null;
  return { name, videoId, file, sec, spent };
}

async function main() {
  if (!HEYGEN_API_KEY) {
    console.error("❌ .env 裡沒有 HEYGEN_API_KEY");
    process.exit(1);
  }
  const preset = PRESETS[TEMPLATE];
  if (!preset) {
    console.error(`❌ 不認得的 --template=${TEMPLATE}（支援 dapan / institution / focusstock / midday）`);
    process.exit(1);
  }

  if (PROBE) {
    log(`探測 avatar ${preset.avatar}（${TEMPLATE}）支援哪些引擎 —— 只讀，不扣點`);
    await probeEngines(preset.avatar);
    const q = await readQuota();
    if (q) log(`目前餘額：${q.raw} 單位（÷60 = $${q.credits.toFixed(2)}）`);
    return;
  }

  const only = val("only");
  const targets = (only ? only.split(",") : ["v2", "iv"]).map((s) => s.trim()).filter(Boolean);
  for (const t of targets) {
    if (!VARIANTS[t]) {
      console.error(`❌ 不認得的變因「${t}」（可用：${Object.keys(VARIANTS).join(" / ")}）`);
      process.exit(1);
    }
  }

  let text = TEXT_INLINE;
  if (!text) {
    const p = cliPath(APP_ROOT, TEXT_FILE);
    if (!existsSync(p)) {
      console.error(`❌ 找不到測試文字檔 ${p}（或用 --text="..." 直接給）`);
      process.exit(1);
    }
    text = readFileSync(p, "utf-8").trim();
  }
  if (!text) {
    console.error("❌ 測試文字是空的");
    process.exit(1);
  }

  const chars = [...text].length;
  const estSec = Math.round((chars / 4.5) * 10) / 10; // 中文 TTS 粗估 4.5 字/秒
  // photo avatar 的官方費率（單位/秒 = $/秒 × 60）：
  //   Avatar III $0.0433 → 2.6　　Avatar IV $0.05 → 3.0　　Avatar V $0.0667 → 4.0
  // （$0.0167/秒＝1 單位/秒 那一檔是 Studio Avatar／Digital Twin，photo avatar 吃不到）
  const RATE = { avatar_iii: 2.6, avatar_iv: 3, avatar_v: 4, null: 3 };
  const rateOf = (t) => RATE[VARIANTS[t].engine] ?? 3;
  const estUnits = Math.round(targets.reduce((n, t) => n + Math.floor(estSec) * rateOf(t), 0));

  console.log("");
  log(`版型：${TEMPLATE}（avatar ${preset.avatar} / voice ${preset.voice}）`);
  log(`測試文字（${chars} 字）：${text}`);
  log(`要比的變因：${targets.map((t) => VARIANTS[t].label).join("　vs　")}`);
  log(
    `預估每支約 ${estSec} 秒；合計約 ${estUnits} 單位（≒$${(estUnits / 60).toFixed(2)}）` +
      `　※ photo avatar 費率：III 2.6／IV 3.0／V 4.0 單位/秒`
  );
  log(`motion_prompt：${WITH_MOTION ? "帶" : "不帶"}　voice_settings.speed：${V3_SPEED ?? "不送"}`);
  log(`aspect_ratio：${ASPECT}　fit：${FIT ?? "不送（由 HeyGen 自己挑）"}`);

  const quota = await readQuota();
  if (quota) {
    log(`目前餘額：${quota.raw} 單位（÷60 = $${quota.credits.toFixed(2)}）`);
    log(`　＝ Avatar IV 約 ${Math.floor(quota.raw / 3)} 秒；這次約用掉 ${((estUnits / quota.raw) * 100).toFixed(1)}%`);
  }

  if (DRY_RUN || !GO) {
    console.log("");
    log(DRY_RUN ? "✅ 空跑結束，沒有呼叫生成、沒有扣點。" : "⏸ 沒有加 --go，所以只做空跑（不扣點）。");
    log("   確認上面的預估與 payload 沒問題後，加 --go 真的跑。");
    return;
  }

  // 一個變因失敗不該拖垮整輪 —— 記下錯誤、繼續跑下一個，最後照樣印對照表。
  // （2026-08-19 踩到：avatar_v 回 400 讓整個腳本 exit，前兩支已經花掉的數字也跟著看不到。）
  const results = [];
  for (const t of targets) {
    try {
      results.push(await runOne(t, text, preset));
    } catch (e) {
      log(`⚠️ ${VARIANTS[t].label} 失敗，跳過繼續跑下一個：${e.message}`);
      results.push({ name: t, file: "（失敗）", sec: null, spent: null, failed: true });
    }
  }

  console.log("\n════════ 對照結果 ════════");
  console.log("變因              生成秒數   扣單位   ≒USD    單位/秒   檔案");
  for (const r of results) {
    const rate = r.sec && r.spent ? (r.spent / r.sec).toFixed(2) : "?";
    console.log(
      `${VARIANTS[r.name].label.padEnd(17)} ${String(r.sec ?? "?").padEnd(10)} ` +
        `${String(r.spent ?? "?").padEnd(8)} ${String(r.spent != null ? "$" + (r.spent / 60).toFixed(2) : "?").padEnd(7)} ` +
        `${String(rate).padEnd(9)} ${r.file}`
    );
  }
  if (results.length === 2 && results.every((r) => r.spent)) {
    const [a, b] = results;
    log(`💰 ${VARIANTS[b.name].label} 是 ${VARIANTS[a.name].label} 的 ${(b.spent / a.spent).toFixed(2)} 倍`);
  }
  console.log("");
  log("👀 品質比對：把檔案並排看／聽 —— 對嘴準不準、臉會不會僵、動作自然度、畫質");
  log("💰 單價比對：看「單位/秒」那欄。photo avatar 的官方費率是 III 2.6／IV 3.0／V 4.0；");
  log("   1.0 那一檔（$0.0167/秒）只有 Studio Avatar／Digital Twin 吃得到，照片主播拿不到。");
  console.log("");
}

main().catch((err) => {
  console.error("\n❌ 錯誤：", err.message);
  process.exit(1);
});
