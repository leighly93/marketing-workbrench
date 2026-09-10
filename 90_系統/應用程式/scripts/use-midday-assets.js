#!/usr/bin/env node

// ─────────────────────────────────────────
//  盤中焦點套版素材複製工具
//  把 共用素材/盤中焦點/ 底下的固定檔案複製到 public/，用「midday-」前綴命名，
//  避免跟大盤小報（dapan-）／三大法人（institution-）／焦點股（focusstock-）
//  以及品牌切換系統（use-brand.js 複製進 public/frame.png 等泛用檔名）撞名。
//
//  跟 use-dapan-assets.js 是平行的兩支腳本（天條 #4 精神延伸，不抽共用層）：
//  盤中焦點日後美術要獨立演進，共用一支腳本反而會互相綁死。
//
//  ⚠️ 盤中焦點只出直式，所以**沒有** intro-frame_Horizontal.png 這一項
//     （大盤小報那支是橫式 composition 專用）。
//
//  用法：node scripts/use-midday-assets.js
//
//  註：複製一律走 fs.copyFileSync。不要改用 fs.cpSync —— 它覆蓋掛載碟上
//  既有檔案時會先 truncate、再因 EACCES 失敗，留下 0 byte 壞檔（見 99_封存/2026-09-10_第一批整理/舊說明與Agent紀錄/docs/tasks.md 第 5 節雷區；歷史依據）。
// ─────────────────────────────────────────

const fs = require("fs");
const path = require("path");

const { workspaceRoot } = require('../../paths');
const ROOT = path.resolve(__dirname, "..");
const WORKSPACE_ROOT = workspaceRoot(ROOT);
const SRC_DIR = path.join(WORKSPACE_ROOT, "共用素材", "盤中焦點");
const PUBLIC_DIR = path.join(ROOT, "public");

// 來源檔名 → public/ 目標檔名（固定對應，不是泛用契約）
const FILE_MAP = {
  "intro-frame.jpg": "midday-intro-frame.jpg",
  "header-overlay.png": "midday-header-overlay.png",
  "bgm.wav": "midday-bgm.wav",
};

if (!fs.existsSync(SRC_DIR)) {
  console.error(`❌ 找不到資料夾 共用素材/盤中焦點/`);
  process.exit(1);
}

let count = 0;
const missing = [];
for (const [srcName, destName] of Object.entries(FILE_MAP)) {
  const srcPath = path.join(SRC_DIR, srcName);
  const destPath = path.join(PUBLIC_DIR, destName);
  if (!fs.existsSync(srcPath)) {
    missing.push(srcName);
    continue;
  }
  const size = fs.statSync(srcPath).size;
  if (size === 0) {
    console.warn(`⚠️  共用素材/盤中焦點/${srcName} 是 0 byte（可能上傳/同步沒完成），仍會複製但目標檔也會是壞檔`);
  }
  fs.copyFileSync(srcPath, destPath);
  console.log(`  ✓ 共用素材/盤中焦點/${srcName}  →  public/${destName}（${size} bytes）`);
  count++;
}

if (missing.length) {
  console.error(`❌ 共用素材/盤中焦點/ 缺少檔案：${missing.join(", ")}`);
  process.exit(1);
}

console.log(`✅ 盤中焦點套版素材已複製（共 ${count} 項）`);
