#!/usr/bin/env node
/**
 * gen-video.js —— 「話劇式情境影片」全自動 orchestrator（fal.ai Seedance 2.0）
 * 與 run.js（HeyGen 講者影片）分開的另一條產線；共用「後製」那一段。
 *
 * 在你 Mac 上跑：  node gen-video.js
 *   讀 gen-video/input.txt（話劇腳本）
 *   → 每段：shot.js 截圖(xcrun，背景、不搶游標) + fal Seedance 生成 + 下載
 *   → ffmpeg 接片 → 放成 public/heygen.mp4
 *   → use-brand 套品牌素材 + 寫 public/script.txt(三段式)
 *   → 既有後製：加速125% → transcribe → correct-subtitles → parse-script → render
 *   → 成品 out/output.mp4（跟單人影片完全同一套後製）
 *
 * 前置：npm i @fal-ai/client；.env 要有 FAL_KEY；模擬器開著 App(截圖用)；fal 有 credits。
 */

const { workspaceRoot, cliPath } = require("../paths");
const WORKSPACE_ROOT = workspaceRoot(__dirname);
require("dotenv").config({ path: require("path").join(WORKSPACE_ROOT, ".env"), quiet: true });
const { execSync, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const INPUT = path.join(WORKSPACE_ROOT, "gen-video", "input.txt");
const PUBLIC = path.join(ROOT, "public");
const SHOTS = path.join(WORKSPACE_ROOT, "共用素材", "lumina", "shots");
const CLIPS = path.join(WORKSPACE_ROOT, "共用素材", "lumina", "clips");

// ── 可調設定 ──────────────────────────────
const CHAR = {
  A: "共用素材/lumina/EV-VaBLHEESOz3xJzH0t9.jpeg", // 图像1：女主角
  B: "共用素材/lumina/B.jpg",                       // 图像2：男分析師
};
const FAL = {
  endpoint: "bytedance/seedance-2.0/fast/reference-to-video", // 要 1080p 改成不含 /fast 的端點
  resolution: "720p",
  aspect_ratio: "9:16",
};
const MAX_SEG_CHARS = 70; // 一段對話字數上限（≈12 秒，留 fal 15 秒上限的安全邊際）
const SPEEDUP_125 = true; // 跟單人一樣加速 125%；不要就設 false
const COMMON_PROMPT =
  "直式 9:16，真實電影感、戲劇化燈光、淺景深。明亮現代辦公室，兩人對坐辦公桌前。图像1 的台灣女性上班族（約25-30歲、神情緊張）與 图像2 的台灣男性財經分析師（約25-30歲、從容自信）。鏡頭推軌+變焦、運鏡有張力。畫外音旁白（台灣中文、語氣篤定節奏明快，人物不露臉不對嘴）。不要生成任何文字、字幕、標題、浮水印或 LOGO。";
// ──────────────────────────────────────────

const log = (...a) => console.log("›", ...a);
const die = (m) => { console.error("❌ " + m); process.exit(1); };
const run = (cmd) => { log("$ " + cmd); execSync(cmd, { cwd: ROOT, stdio: "inherit" }); };

// 解析 gen-video/input.txt → { brand, title, lines:[{role, screenshot, text}] }
function parseInput() {
  if (!fs.existsSync(INPUT)) die(`找不到輸入腳本：${INPUT}`);
  const raw = fs.readFileSync(INPUT, "utf8");
  const meta = {};
  for (const m of raw.matchAll(/^#\s*([^:：]+)[:：]\s*(.+)$/gm)) {
    meta[m[1].trim()] = m[2].trim();
  }
  const brand = meta["品牌"] || "起漲K線";
  const title = meta["標題"] || "";
  // 內文 = 第一個 === 之後（本檔只有一個 ===，標題放在 # 標頭，內文在 === 之後）
  const bodyPart = raw.includes("===") ? raw.split("===").slice(-1)[0] : raw;
  const lines = [];
  for (const rawLine of bodyPart.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // [A|截圖=個股-多空:3231] 文字   或  [A] 文字
    const m = line.match(/^\[([AB])(?:\s*\|\s*截圖\s*=\s*([^\]]+))?\]\s*(.+)$/);
    if (!m) { log(`(略過無法解析的行) ${line}`); continue; }
    lines.push({ role: m[1], screenshot: (m[2] || "").trim() || null, text: m[3].trim() });
  }
  if (lines.length === 0) die("內文沒有可解析的 [A]/[B] 對話行");
  return { brand, title, lines };
}

// 把對話行切成 ≤MAX_SEG_CHARS 的段（連續行累加，超過就切）
function segment(lines) {
  const segs = [];
  let cur = null;
  for (const ln of lines) {
    const curLen = cur ? cur.lines.reduce((s, l) => s + l.text.length, 0) : 0;
    if (cur && curLen + ln.text.length > MAX_SEG_CHARS) { segs.push(cur); cur = null; }
    if (!cur) cur = { lines: [], screenshot: ln.screenshot };
    cur.lines.push(ln);
    if (!cur.screenshot && ln.screenshot) cur.screenshot = ln.screenshot; // 段內第一個有標的截圖
  }
  if (cur) segs.push(cur);
  return segs;
}

// 自動判斷這段要截哪個個股頁+哪檔股（沒手動標 截圖= 時用）。靠 OpenAI 讀對話內容判斷。
// 回傳 "個股-多空:3231" 之類的 link，判斷不出來回 null。
async function judgeScreenshot(text, brand) {
  if (!process.env.OPENAI_API_KEY) { log("(無 OPENAI_API_KEY，跳過自動判斷截圖)"); return null; }
  const dlPath = path.join(WORKSPACE_ROOT, "共用素材", brand, "deeplinks.json");
  if (!fs.existsSync(dlPath)) { log(`(${brand} 無 deeplinks，跳過自動截圖)`); return null; }
  const pages = Object.keys(JSON.parse(fs.readFileSync(dlPath, "utf8")).stockTemplates || {});
  if (pages.length === 0) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "你是台股 App 助手。根據對話內容，判斷這段最該搭配哪個個股頁面、哪一檔台股。只能從給定頁面清單選。只輸出 JSON。" },
          { role: "user", content: `對話：「${text}」\n可選頁面(只能從這裡選)：${pages.join("、")}\n輸出 JSON：{"need":true或false,"page":"頁面名","stockName":"股名","stockId":"台股代號4位數字"}。若對話沒明確指向某一檔個股的某個頁面，need 設 false。stockId 請給正確的台股代號。` },
        ],
      }),
    });
    const data = await res.json();
    if (!res.ok) { console.error(JSON.stringify(data, null, 2)); log("⚠️ OpenAI 判斷截圖失敗，這段跳過截圖"); return null; }
    const j = JSON.parse(data.choices[0].message.content);
    if (!j.need || !j.page || !pages.includes(j.page) || !/^\d{4,6}$/.test(String(j.stockId || ""))) { log("LLM 判定這段不需截圖"); return null; }
    const link = `${j.page}:${j.stockId}`;
    log(`LLM 判斷截圖 → ${link}（${j.stockName || ""}）  ⚠️請留意股號是否正確`);
    return link;
  } catch (e) { log("⚠️ 判斷截圖出錯：" + e.message + "，這段跳過截圖"); return null; }
}

// 把一段的對話行 → fal 旁白 prompt（女聲/男聲、引號）
function voiceoverText(segLines) {
  const parts = segLines.map((l) => {
    const who = l.role === "A" ? "女聲" : "男聲";
    return `${who}說「${l.text}」`;
  });
  return "畫外音旁白：" + parts.join("，接著");
}

async function falGenerate(fal, imagePaths, prompt, outPath, durationSec) {
  const urls = [];
  for (const rel of imagePaths) {
    const p = cliPath(ROOT, rel);
    if (!fs.existsSync(p)) die(`找不到圖：${rel}`);
    const ext = path.extname(p).toLowerCase();
    const type = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    const url = await fal.storage.upload(new Blob([fs.readFileSync(p)], { type }));
    urls.push(url);
  }
  const result = await fal.subscribe(FAL.endpoint, {
    input: {
      prompt,
      image_urls: urls,
      resolution: FAL.resolution,
      duration: String(durationSec),
      aspect_ratio: FAL.aspect_ratio,
      generate_audio: true,
    },
    logs: true,
    onQueueUpdate: (u) => { if (u.status === "IN_PROGRESS") (u.logs || []).forEach((l) => process.stdout.write("  " + l.message + "\n")); },
  });
  const videoUrl = result?.data?.video?.url || result?.video?.url;
  if (!videoUrl) { console.error(JSON.stringify(result?.data ?? result, null, 2)); die("fal 沒回 video url"); }
  const res = await fetch(videoUrl);
  if (!res.ok) die(`下載失敗 HTTP ${res.status}`);
  fs.writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
}

async function main() {
  if (!process.env.FAL_KEY) die("缺 FAL_KEY（.env）");
  const { brand, title, lines } = parseInput();
  log(`品牌=${brand}  標題=${title.replace(/\n/g, " ")}`);
  const segs = segment(lines);
  log(`切成 ${segs.length} 段`);

  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(CLIPS, { recursive: true });

  const { fal } = await import("@fal-ai/client");
  fal.config({ credentials: process.env.FAL_KEY });

  const segVideos = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    log(`\n━━ 第 ${i + 1}/${segs.length} 段 ━━`);

    // 1) 截圖（背景 xcrun）— 手動標 截圖= 優先；沒標就 LLM 自動判斷
    const images = [CHAR.A, CHAR.B];
    let screenLine = "";
    let link = seg.screenshot;
    if (!link) link = await judgeScreenshot(seg.lines.map((l) => l.text).join(" "), brand);
    if (link) {
      const name = `gv_seg${i + 1}`;
      log(`截圖：${link}`);
      execFileSync("node", [path.join(WORKSPACE_ROOT, "gen-video/shot.js"), name, "--link", link, "--brand", brand], { cwd: ROOT, stdio: "inherit" });
      const shotPath = path.join(SHOTS, name + ".png");
      if (!fs.existsSync(shotPath)) die(`截圖沒生出來：${shotPath}`);
      images.push(path.relative(WORKSPACE_ROOT, shotPath));
      screenLine = "桌上手機顯示 图像3（對應頁面、有訊號），中段自然入鏡、訊號區輕微推近。";
    }

    // 2) prompt + 估時長
    const chars = seg.lines.reduce((s, l) => s + l.text.length, 0);
    const dur = Math.min(15, Math.max(5, Math.round(chars / 5) + 2)); // ~5字/秒 + 緩衝
    const prompt = `${COMMON_PROMPT}${screenLine}${voiceoverText(seg.lines)}`;
    log(`時長≈${dur}s，prompt：${prompt.slice(0, 60)}…`);

    // 3) fal 生成 + 下載
    const out = path.join(CLIPS, `gv_seg${i + 1}.mp4`);
    await falGenerate(fal, images, prompt, out, dur);
    log(`✓ 段 ${i + 1} → ${path.relative(ROOT, out)}`);
    segVideos.push(out);
  }

  // 4) 接片 → public/heygen.mp4
  log("\n接片 → public/heygen.mp4");
  const listFile = path.join(CLIPS, "_gv_concat.txt");
  fs.writeFileSync(listFile, segVideos.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
  const heygen = path.join(PUBLIC, "heygen.mp4");
  if (segVideos.length === 1) {
    fs.copyFileSync(segVideos[0], heygen);
  } else {
    // 重新編碼接片（各段參數一致）
    execSync(`ffmpeg -y -loglevel error -f concat -safe 0 -i "${listFile}" -c:v libx264 -pix_fmt yuv420p -r 24 -c:a aac -b:a 192k "${heygen}"`, { cwd: ROOT, stdio: "inherit" });
  }

  // 5) 套品牌素材 + 寫 script.txt（三段式：空發音替換 + 標題 + 純對話 body，無 (imageN) PIP 標記）
  run(`node scripts/use-brand.js ${brand}`);
  const bodyPlain = lines.map((l) => l.text).join("\n");
  // 標題用逗號斷成多行（白框是多行設計、單行太長會 nowrap 爆框）
  const titleLines = title.split(/[，,]/).map((s) => s.trim()).filter(Boolean).join("\n");
  const scriptTxt = `===\n${titleLines}\n===\n${bodyPlain}\n`;
  fs.writeFileSync(path.join(PUBLIC, "script.txt"), scriptTxt);
  log("已寫 public/script.txt");

  // 6) 加速 125%（跟單人一致）
  if (SPEEDUP_125) {
    log("加速 125%");
    const fast = path.join(PUBLIC, "heygen_fast.mp4");
    execSync(`ffmpeg -y -loglevel error -i "${heygen}" -filter_complex "[0:v]setpts=PTS/1.25[v];[0:a]atempo=1.25[a]" -map "[v]" -map "[a]" "${fast}"`, { cwd: ROOT, stdio: "inherit" });
    fs.renameSync(fast, heygen);
  }

  // 7) 既有後製鏈
  log("\n── 後製（跟單人同一套）──");
  run("npm run transcribe");
  run("npm run correct-subtitles");
  run("npm run parse-script");
  run("npm run render");

  log("\n✅ 完成！成品在 out/output.mp4");
}

main().catch((e) => die(e.stack || e.message));
