#!/usr/bin/env node

// ─────────────────────────────────────────
//  行銷影片自動化 orchestrator
//  使用方式：node run.js
// ─────────────────────────────────────────

const { workspaceRoot } = require("../paths");
const WORKSPACE_ROOT = workspaceRoot(__dirname);
require("dotenv").config({ path: require("path").join(WORKSPACE_ROOT, ".env"), quiet: true });

const { execSync } = require("child_process");
const { readFileSync, writeFileSync, existsSync } = require("fs");
const { resolve } = require("path");
const OpenCC = require("opencc-js");
const { cleanStaleStaging, backupJob } = require("./scripts/public-utils");

const PROJECT_DIR = __dirname;
// 繁中 → 簡中：MiniMax 對簡體念法比較準（純字形轉換、不動詞彙；避免「公車→公交」這種詞義替換）
const tradToSimpConverter = OpenCC.Converter({ from: "t", to: "s" });

// ── 版型選擇（2026-08-06 新增）──────────────
// 用法：node run.js --template=dapan（不帶參數 = 預設既有 MarketingVideo 流程，行為完全不變）
// 大盤小報是獨立 composition，不走 use-brand.js 品牌切換、不走隨機 avatar 池、
// 最後跑的 parse-script / render 也是專用版本（parse-script:dapan / render:dapan）。
const TEMPLATE_ARG = process.argv.find((a) => a.startsWith("--template="));
const TEMPLATE = TEMPLATE_ARG ? TEMPLATE_ARG.split("=")[1] : "default";
if (!["default", "dapan", "institution", "focusstock", "midday"].includes(TEMPLATE)) {
  console.error(`❌ 不認得的 --template=${TEMPLATE}（目前支援：default / dapan / institution / focusstock / midday）`);
  process.exit(1);
}
// 大盤小報／三大法人／焦點股日報／盤中焦點是「同一個模子」的四條固定主播產線：固定 avatar、125% 加速。
// 配音 2026-08-24 起走 MiniMax + HeyGen 音訊驅動對嘴（原本是 HeyGen 文字驅動，--heygen-voice 可退回）。
// 大盤小報／盤中焦點在 2026-09-11 當天曾短暫改回 HeyGen 內建語音，同日又改回 MiniMax（換了新 clone 聲音），
// 所以現在**四條線一致走 MiniMax**（見 HEYGEN_VOICE_ONLY_TEMPLATES，那個集合現在是空的）。
// 用這個集合統一判斷，避免每處都寫 (dapan || institution || focusstock || midday)。
// ⚠️ 這個集合是「加速只跑一次」的守門依據：generateHeygenVideo() 末尾的加速用 !FIXED_ANCHOR_TEMPLATE
//    擋掉，固定主播三條線一律只走 main() 內那一次。新增固定主播版型時只要加進這個集合即可，
//    不要再另外寫 TEMPLATE !== "xxx" 的個別判斷（2026-08-17 的雙重加速 bug 就是這樣來的）。
const FIXED_ANCHOR_TEMPLATE =
  TEMPLATE === "dapan" ||
  TEMPLATE === "institution" ||
  TEMPLATE === "focusstock" ||
  TEMPLATE === "midday";

// ── 跳過生成（2026-08-07 新增）──────────────
// 用法：node run.js --template=dapan --skip-generate
// 給「影片已經手動放好在 public/heygen.mp4」的情境用（例如大盤小報這次不經 HeyGen、
// 使用者自己準備好的橫式講者影片）。加這個旗標會：
//   ① 完全不呼叫 HeyGen／MiniMax（不需要 API key、不會生新影片、不會覆蓋你手動放的檔）
//   ② 不做既有投廣模板的 125% 加速（那個只在真的呼叫 HeyGen 生成時做）
//      —— 但固定主播三條線的 125% 加速不受這個旗標影響，無論有沒有 --skip-generate 都會套用
//         （2026-08-07 使用者定案：手動放的影片也要一起加速，見 main() 內統一加速那段）
//   ③ 直接跳到 transcribe → correct-subtitles → parse-script(:dapan) → render(:dapan)
//   ④ 2026-08-21：前台的「用現成的講者影片」已開放給所有同事（不再是 admin only），
//      所以「拿一支已經加速過的影片重跑會變 1.56 倍」不能再靠人記得加 --no-speed ——
//      改由 alreadySpedUp() 讀檔案裡的記號自動擋掉。詳見 SPED_TAG 那段註解。
// 之前「一直被蓋回舊的直式影片」就是因為沒加這個旗標——每次跑 --template=dapan
// 都會真的重新呼叫 HeyGen 生一支新的 9:16 直式影片蓋掉 public/heygen.mp4。
const SKIP_GENERATE = process.argv.includes("--skip-generate");

// ── 額外開關（2026-08-12 使用者要求）──
//   --no-speed ：跳過 125% 加速（想保留原始講話速度時用）。四個版型都吃這個旗標。
//   --no-ad    ：焦點股只出客製版，不出投廣套框版
//   --minimax  ：投廣模板／雙人 path 退回 MiniMax 配音（2026-08-17 起預設用 HeyGen 內建語音）
//   --heygen-voice：三大法人／焦點股日報退回 HeyGen 內建語音（2026-08-24 起預設走 MiniMax 配音 + 音訊驅動）
//                   大盤小報／盤中焦點 2026-09-11 起本來就是 HeyGen 內建語音，這個旗標對它們沒差
//   --simp     ：送 MiniMax 前先做繁→簡轉換（2026-08-24 起**預設不轉**，繁體直送）
//                （`--no-simp` 仍然收，但已經是預設行為、等於沒作用，留著只是為了舊指令不報錯）
//   --heygen-v2：整批退回舊端點 —— 文字驅動與音訊驅動都走 /v2/videos、音檔上傳走 upload.heygen.com/v1/asset
//                （2026-08-24 起預設全部 v3：/v3/videos ＋ /v3/assets。HeyGen 公告 v1/v2 在
//                 2026-10-31 之後退役，所以這個旗標只是過渡期退路，十月底之後就沒用了）
//   --avatar-iii：引擎改用 Avatar III（便宜 7~13%，但 2026-08-20 使用者實際出片後回報表情沒對上，
//                 所以預設維持 Avatar IV。要再評估請用正式長度的稿子比，別用 5 秒短片）
const NO_SPEED = process.argv.includes("--no-speed");

// 焦點股日報：2026-08-13 使用者定案「之後只要出客製版，不用多出投廣套框版」。
// 所以預設不出投廣版；真的要的時候加 --with-ad。
// （--no-ad 保留但已是預設值，舊指令照打不會出事。）
const WITH_AD = process.argv.includes("--with-ad");
const NO_AD = !WITH_AD;

// 投廣模板（default）的品牌：起漲K線 / 籌碼K線。
// 這兩個差在 frame.png / logo.png / outro.mp4 / bgm.wav / deeplinks.json，
// 都放在 共用素材/<品牌>/。以前要自己先跑 node scripts/use-brand.js <品牌>，
// 忘了跑就會沿用上一支的外框（2026-08-13 接前台時補上）。
const BRAND_ARG = process.argv.find((a) => a.startsWith("--brand="));
const BRAND = BRAND_ARG ? BRAND_ARG.split("=").slice(1).join("=") : null;

// ── 兩段式出片（2026-08-13 前台網頁需要）──
//   --stop-before-render：跑到「算出配圖計畫」就停，不 render。
//        給前台在 render 前插入「人看一眼、要改就改」的關卡用。
//   --render-only       ：跳過前面全部，直接用現有的 public/ 與 *.generated.json 出片。
//        前台把使用者改過的配圖計畫寫回去之後，用這個旗標接著跑。
//   兩個旗標都不加時行為跟以前完全一樣（一路跑到底），既有終端機指令不受影響。
const STOP_BEFORE_RENDER = process.argv.includes("--stop-before-render");
const RENDER_ONLY = process.argv.includes("--render-only");

// ── 設定 ──────────────────────────────────
const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const MINIMAX_GROUP_ID = process.env.MINIMAX_GROUP_ID;
// MiniMax 語音設定（非 secret，hardcode 在這裡）
const MINIMAX_VOICE_ID = "moss_audio_3a75102e-54db-11f1-981b-8a143315d498";
// 2026-09-01：speech-02-hd → speech-2.8-hd（使用者定案）。
// ⚠️ 換世代**不是為了發音**：實測 2.8 對台灣讀音沒有比較好 —— 專門塞滿舊字典 16 條的驗證稿
//    裡，使用者聽出 10 條讀成大陸音（收斂／企業／衝擊／意識／曝險／液晶／南亞科・亞洲／
//    成熟／攜手／血本）。換模型救不了讀音，把大陸模型拉回台灣讀音的**只有下面那份字典**。
//    2.8 換的是音質與斷句（使用者實測後選定）。要退回舊世代改這一行即可，字典兩邊通用。
//    對照素材留在 out/tts-ab/，重跑用 scripts/tts-ab.js。
const MINIMAX_MODEL = "speech-2.8-hd"; // HD 品質。要省可改 speech-2.8-turbo
// language_boost 明示語言（2026-08-24）。
// ⚠️ 不送這個欄位時 MiniMax 的預設是 null → 它會「看字猜語言」，而粵語書面就是用繁體寫的，
//    所以一段繁體中文有機率被判成粵語（使用者早期踩過：繁體出粵語、簡體才出普通話）。
//    釘住 "Chinese" 之後語言就固定是普通話，不再靠偵測。合法值裡沒有台灣腔／zh-TW ——
//    腔調完全來自 voice_id 本身（clone 的樣本），這個參數只決定「哪一種中文」。
const MINIMAX_LANGUAGE_BOOST = "Chinese";
// emotion（2026-09-01 上線）。**不送這個欄位＝MiniMax 依文字自動挑**，實測結果偏平：
// 使用者聽完 institution 那支說「聲音可以，但有可能在有一點點情緒嗎？」，
// 接著 A/B 聽 happy 與 fluent →「fluent 斷句可以就是有點平」「happy 這情緒還行，比較下會偏好這個」。
// ⚠️ 合法值只有九個（happy/sad/angry/fearful/disgusted/surprised/calm/fluent/whisper），
//    **沒有 neutral／auto**，送了會回 error 2013。要退回「自動挑」把這行設成 null 或空字串即可。
// ⚠️ 這是**全域**設定：四條固定主播線＋投廣模板／雙人 path 都會套到。
//    2026-09-11 使用者在大盤小報／盤中焦點的兩支新聲音上也 A/B 聽過 happy 與「不送 emotion」，
//    定案「有特別改 happy 的不錯，保留」—— 所以現在三支主播聲音都是聽過才套的。
//    （順帶一提：不送 emotion 時 b47d71d2 那支同一段字會慢 4 秒，平又拖，不要退回「自動挑」。）
//    焦點股日報那支還沒單獨聽過，第一支成品留意一下情緒會不會太 over；
//    要縮成只有某個版型套用，改 minimaxTTS() 那行判斷即可。
// ⚠️ emotion **沒有強度參數**，九個值是離散的。voice_modify.intensity（−100~100）是另一組東西
//    （變聲器），跟 timbre_weights 同一類風險 —— 混音已實測「聽起來很假」，要用要單獨測。
const MINIMAX_EMOTION = "happy";

// ── MiniMax 發音字典（2026-08-24 建立，2026-09-01 在 speech-2.8-hd 上全面重校）──────
// 取代「拿錯字騙 TTS」的字元替換做法。差別很實際：
//   ① 只影響合成的音訊，稿子的字完全不動 → 字幕天生就是原文，不需要 correct-subtitles 反向還原
//   ② 單字可以指定（`跌` 是單音字，全稿一致才是對的），而共用詞庫 90_系統/資料/pronounce.json
//      對單字是硬擋的（server/index.js:1765，理由是單字會誤傷所有含它的詞）
//   ③ 聲調可以直接指定，不必拿同音字去湊
//   ④ 規則之間不會互相取代（8/19 修過的「南亞科技股份 → 南亞ㄎㄜ技股份有限」那類坑不存在）
//
// 語法有兩種，兩種都實測有效：
//   (a) 拼音：`詞/(拼音1)(拼音2)…`，聲調寫數字 1~5
//   (b) **文字替換**：`詞/替換詞` —— 2026-09-01 實測 "穎崴/影威" 有效。
//       這是之前不知道的能力。專有名詞用換字通常比逐音節釘拼音自然，
//       拼音釘不動、或釘出來一頓一頓的時候走這條。
//
// ⚠️ 這份字典**不是「修模型的錯」，是「把大陸模型拉回台灣讀音」**。
//    像「跌」：教育部《國語辭典》是 ㄉㄧㄝˊ（dié 二聲），大陸普通話是 diē（一聲），
//    MiniMax 是大陸訓練的模型所以給一聲。使用者原本的「下跌→下碟」hack 正是在強迫二聲。
//    推論：換更新的模型救不了這件事 —— 2026-09-01 在 speech-2.8-hd 上實測證實了，
//    16 條驗證裡 10 條照樣是大陸音。所以**這份字典是必要組件，不是可選微調**。
//
// ⚠️ 排序規則：**一律長詞在前、單字在後**。
//    2026-09-01 實測：字典裡明明有 "頸/(jing3)"，「瓶頸」仍然唸錯，而該條剛好排在全表最後。
//    兩個可能 ——（i）MiniMax 做最長匹配，單字條目蓋不到詞（ii）字典條數有上限、後面被靜默丟掉。
//    兩個猜測都指向同一個對策：重要的、詞級的往前排。改成詞級 "瓶頸/(ping2)(jing3)" 後修好。
//    條數上限這個可能**還沒排除**，所以加新條目時優先加在前面，並回頭聽最後幾條有沒有失效。
//
// 要加新條目之前：先用 `node scripts/tts-ab.js` 實際聽過，不要憑字典硬塞。
// 那支腳本的 --text=c 是 107 字的精簡驗證稿，把下面每一條都至少命中一次，跑之前會印覆蓋率表。
const MINIMAX_PRONUNCIATION_DICT = [
  // ── 詞級（長→短）─────────────────────────
  // 「期貨淨空」這條的用意是**詞邊界**不是發音：使用者實測回報聽起來像「還有期｜貨淨空」，
  // 停頓落在詞中間（「還有期」很可能被當成「有期」那個詞）。明確宣告「這幾個字是一個單位、
  // 對應這幾個音節」，模型就沒有空間把它拆開。官方文件只講「指定發音」，沒承諾影響韻律邊界 ——
  // 這是推論，靠耳朵驗過有效。若哪天失效，退路是改寫稿子（期貨淨空 → 期貨的淨空單）。
  "期貨淨空/(qi2)(huo4)(jing4)(kong1)", // 期＝台灣讀 ㄑㄧˊ；空＝空單／空方的 kōng 一聲
  "穎崴/影威",           // 公司名。**文字替換**語法，2026-09-01 實測有效
  "瓶頸/(ping2)(jing3)", // 2026-09-01：單字 "頸" 蓋不到這個詞（見上面的排序規則），改詞級
  "收斂/(shou1)(lian4)", // 台 ㄌㄧㄢˋ 四聲／陸「敛」liǎn 三聲
  "意識/(yi4)(shi4)",    // 2026-09-01 使用者：「都是四聲」。陸「意识」讀 yì shí
  "期貨/(qi2)(huo4)",    // 單獨出現的期貨也要修台灣讀音
  "繼續/(ji4)(xu4)",

  // ── 單字級 ───────────────────────────────
  // 挑過了：這些字在台灣讀音裡都只有一種唸法，不會像「和」那樣（以及＝ㄏㄢˋ／和平＝ㄏㄜˊ）
  // 誤傷。「和」因此沒有加。
  // ⚠️ 有幾條的兩岸差異在**聲母韻母**不在聲調，只看數字會抓不到重點，所以每行都標了兩邊完整讀音。
  "載/(zai3)",  // 台灣一律三聲 ㄗㄞˇ：載板→宰板、下載→ㄒㄧㄚˋㄗㄞˇ（2026-09-01 使用者定案）
  "跌/(die2)",  // 台 ㄉㄧㄝˊ／陸 diē。下跌／漲跌／跌幅／跌破／大跌 一條全包
  "矽/(xi4)",   // 台 ㄒㄧˋ。⚠️ 真正的風險不是唸成 xī，是唸成 **ㄍㄨㄟ** —— 大陸用「硅(guī)」，
                //    MiniMax 很可能把「矽」映到「硅」。旺矽／矽晶圓／矽光子。**必留**
  "銦/(yin1)",  // 磷化銦 → 磷化因
  "識/(shi4)",  // 台 ㄕˋ／陸 shí。意識、知識、認識、辨識、常識。
                //    ⚠️ 例外：「標識」台灣讀 ㄓˋ，真的遇到再改寫成詞級
  "檔/(dang3)", // 台 ㄉㄤˇ 三聲／陸「档」dàng 四聲。一檔個股→一挡個股。
                //    單字級是安全的：2026-09-01 使用者確認「高檔／低檔／檔期」也都是三聲
  "企/(qi4)",   // 台 ㄑㄧˋ／陸 qǐ。企業、企圖
  "擊/(ji2)",   // 台 ㄐㄧˊ／陸 jī。衝擊、打擊、擊敗
  "曝/(pu4)",   // 台 ㄆㄨˋ／陸多讀 bào。曝光、曝險
  "液/(yi4)",   // ⚠️ 差在韻母不在聲調：台 ㄧˋ (yì)／陸 yè，兩邊都是四聲
  "亞/(ya3)",   // 台 ㄧㄚˇ／陸 yà。南亞科、亞洲股、東南亞 —— 這批裡最常用到的一個
  "熟/(shou2)", // ⚠️ 差在韻母不在聲調：台 ㄕㄡˊ (shóu)／陸 shú，兩邊都是二聲。成熟、熟悉
  "攜/(xi1)",   // 台 ㄒㄧ 一聲／陸 xié 二聲。攜手、攜帶
  "血/(xie3)",  // ⚠️ 台 ㄒㄧㄝˇ 三聲／陸 xuè 四聲 —— 聲母韻母聲調三樣全不同
  "期/(qi2)",   // 台 ㄑㄧˊ／陸 qī。台指期、長天期 —— 上面的 `期貨` 詞條蓋不到這兩個
  "究/(jiu4)",  // 台 ㄐㄧㄡˋ／陸 jiū。研究
  "危/(wei2)",  // 台 ㄨㄟˊ／陸 wēi。危機、危險
  "頸/(jing3)", // 備援；主力是上面的 "瓶頸" 詞級條目。2026-08-26 使用者在 ㄍㄥˇ／ㄐㄧㄥˇ 選了後者

  // ── 2026-09-01 實測 speech-2.8-hd 唸對而刪除的，不要加回來 ────────────────
  //   "轉/(zhuan3)"       8/26 在 speech-02-hd 上聽到讀成 zhuàn 才加的；2.8 的「轉強」唸對了
  //   "反彈/(fan3)(tan2)" 2.8 的「反彈」唸對了
  //   ⚠️ 這兩條是**跟著模型走的**。哪天 MINIMAX_MODEL 退回 02 系列，要回頭把它們加回來，
  //      不然會靜默地又唸錯 —— 上面 8/24、8/26 那兩輪就是在 02-hd 上聽出來的。
];

// 單人池：每個 avatar 帶 gender，配音時用 SOLO_VOICES[gender] 抽對應聲音
const AVATAR_IDS = [
  { id: "9d4c8154a0aa4122b20ed60eb1028d69", gender: "female" },
  { id: "1375ec16cd124aaf9a3e182530495776", gender: "female" },
  { id: "2abd791fb4cc4c84a228ea47898c9015", gender: "female" },
  { id: "e0ed406031924df7835cf290d289dc77", gender: "female" },
  { id: "7765f68aaa6a4b658b95f4e5357c21d5", gender: "female" },
  { id: "0855d9402c184b4bbcb0f7df94f63996", gender: "female" },
  { id: "423ce3555c4240999d1400060405997e", gender: "female" },
  { id: "62d14dcef42848e48620d102b31de477", gender: "female" },
  { id: "b69172d0150d4b7dbf2c295f2daa884f", gender: "female" },
  { id: "ba346ffd318d4b779dd9d6b872a09789", gender: "female" },
  { id: "5df65f6c51f441d0b9ded595be814bf5", gender: "female" },
  { id: "2d5baec141644babad17be304f3ae30a", gender: "female" },
  { id: "4e9bcc7c3a1f453b9f4b9b594fc00a31", gender: "female" },
  { id: "54399f608b3d4a47afc628110eb636fc", gender: "female" },
  { id: "69453202ed5c44bdb2e1a9abb230c97e", gender: "female" },
  { id: "6b9907657bf74194a68c866e2ee3bb4b", gender: "female" },
  { id: "74465fc8e46148a4a333090c191a3b12", gender: "female" },
  // 2026-06-08 移除雙人配對 A（85e20f2b / ee70c6af / ca62aa65）：改為只走雙人 path，不進單人池
  // 2026-06-04 新增
  { id: "2e37d4c4903649b8996bd3b7aa2d8c0e", gender: "female" },
  { id: "a658d9acf3bd43dbb0e52394368e7cc4", gender: "female" },
  { id: "f74d88d33a184418b68588bfee84064b", gender: "female" },
  // 2026-06-05 新增：男生（配 SOLO_VOICES.male 男聲）
  { id: "0f51e6a9edad4b7bbf19383b7e9910d1", gender: "male" },
  { id: "6cfb6b22ad064130b50c259313ca4564", gender: "male" },
  { id: "9c4a7be4283c4fc9b0a76f2408bc21e3", gender: "male" },
  { id: "28178c70220c49e1b5b6bddb08c466b9", gender: "male" },
  { id: "1103287ef96b4ef0b9a346ae27b4fc64", gender: "male" },
  { id: "ab9724f5685f4f819a135ac3237460f0", gender: "male" },
  { id: "ba0e4bfa8596449d86041ef91677465c", gender: "male" },
  { id: "c9f3346b2bb942c3847f179989d1809d", gender: "male" },
  { id: "e128f42cf398437ca866c9b94d3e9da3", gender: "male" },
];

// 單人 path 的 voice 對應：抽到的 avatar 性別決定配音
// male 與 DUAL_VOICES.B 同一支聲音，但各自引用、互不影響
const SOLO_VOICES = {
  female: MINIMAX_VOICE_ID,
  male: "moss_audio_44ce6b04-5a39-11f1-981b-8a143315d498",
};

// 雙人 path：A/B 配對表（從 共用素材/avatar-pairs.json 載入）
// 隨機抽一對對話用；單人 path 仍從 AVATAR_IDS 抽
const PAIRS = require(resolve(WORKSPACE_ROOT, "共用素材/avatar-pairs.json")).pairs;

// 雙人 path 的 voice 對應（A 用現有 MINIMAX_VOICE_ID，B 是新 voice）
const DUAL_VOICES = {
  A: MINIMAX_VOICE_ID,
  B: "moss_audio_44ce6b04-5a39-11f1-981b-8a143315d498",
};

// ── HeyGen 內建語音（2026-08-17）────────────
// 使用者：「MiniMax 點數沒了，先不加值」→ 投廣模板（default）與雙人 path 一併改走
// HeyGen 自己的 TTS（script + voice_id 文字驅動），跟固定主播三條線同一條路。
// 影響：①不再需要 MINIMAX_API_KEY／MINIMAX_GROUP_ID ②不再做繁→簡轉換（HeyGen 吃繁中）
//       ③不再產 public/minimax.mp3
// 要退回 MiniMax（例如之後加值了）：指令加 --minimax，整條路徑原封不動復原。
// ⚠️ 這段只講「投廣模板（default）與雙人 path」。固定主播三條線在 2026-08-24 已經改回
//    MiniMax 配音（見下方 MINIMAX_FIXED_ANCHOR_VOICES），不受 --minimax 這個旗標控制。
const USE_MINIMAX = process.argv.includes("--minimax");

// 投廣模板單人 path 的 HeyGen voice（2026-08-17 使用者提供）。
// 結構刻意跟 MiniMax 的 SOLO_VOICES 一模一樣 —— 抽到的 avatar 性別決定配音，
// 所以男 avatar 配男聲、女 avatar 配女聲，跟 MiniMax 時代的行為一致。
const HEYGEN_SOLO_VOICES = {
  female: "65b04effe83f423dbb1f66317318c37f", // 與焦點股日報同一支女聲
  male: "c223c1b3c779490ca14f4525eb30006e",
};

// 雙人 path 的 HeyGen voice：A 女、B 男，對應 MiniMax 時代 DUAL_VOICES 的分工。
const HEYGEN_DUAL_VOICES = {
  A: HEYGEN_SOLO_VOICES.female,
  B: HEYGEN_SOLO_VOICES.male,
};

// 大盤小報：固定單一 avatar（「每日固定主播」形式，不像投廣模板從池子隨機抽），
// 2026-08-06 使用者定案。只在 TEMPLATE === "dapan" 時使用。
const DAPAN_AVATAR = { id: "cf57d30031a44a31bc39822af8de4c30", gender: "female" }; // 2026-09-11 使用者更換 avatar look（原 8032bdb6…、更早 c2c2963b…）
// ⚠️ 換 look 要順便確認上面 HEYGEN_ASPECT_RATIO 那條：大盤小報寫死 16:9 是因為舊主播素材是橫式。
//    新 look 若是直式，16:9 會左右補白 —— 出片後看一眼，真的補白就把它改成 9:16。
// 大盤小報：HeyGen 內建語音 voice_id（2026-08-07 使用者要求聲音改用 HeyGen 生、不經 MiniMax）。
// 2026-08-24 ~ 2026-09-10 這段期間改走 MiniMax、這個常數閒置；2026-09-11 使用者要求改回來，現在又是預設路徑。
// 2026-09-11 使用者換聲音：dc529e16…（原 f331fe73…）。
// ⚠️ 清空它會讓 --template=dapan 直接報錯擋下來（見 main() 內檢查）。要換聲音去 HeyGen 後台
//    「Voice Library」或呼叫 GET https://api.heygen.com/v3/voices 挑一支中文女聲。
// ⚠️ 改這裡要順手改 scripts/check-voices.js 與 scripts/ab-endpoints.js 的同一組 id，
//    不然那兩支測的是舊聲音。
const DAPAN_HEYGEN_VOICE_ID = "dc529e16819846b2a0ba986a7fc51a85";

// 三大法人：跟大盤小報同一個模子（固定主播、HeyGen 文字驅動、125% 加速），只在 TEMPLATE === "institution" 用。
// 2026-08-10 使用者提供：avatar 57d5790b…、中文女聲 voice e96f2834…。
const INSTITUTION_AVATAR = { id: "57d5790b64e34472a932d6c7d0b4f64b", gender: "female" };
const INSTITUTION_HEYGEN_VOICE_ID = "e96f2834052f404c9c3725b4fd6ee55a";

// 焦點股日報：同一個模子（固定主播、HeyGen 文字驅動、125% 加速），只在 TEMPLATE === "focusstock" 用。
// 2026-08-11 使用者提供：avatar 7765f68a…、中文女聲 voice 65b04eff…。
// 一次跑會出兩支：客製版（Focusstock，藍色版型有開場卡）＋投廣套框版（FocusstockAd，籌碼K線外框＋片尾、無開場）。
const FOCUSSTOCK_AVATAR = { id: "7765f68aaa6a4b658b95f4e5357c21d5", gender: "female" };
const FOCUSSTOCK_HEYGEN_VOICE_ID = "65b04effe83f423dbb1f66317318c37f";

// 盤中焦點：2026-08-31 新增。使用者定案「跟現有的大盤小報很像…只改 heygen photo id，
// voice id 一樣」—— 所以 avatar 換成使用者提供的這一支，配音（MiniMax 與 HeyGen 內建語音）
// 兩邊都直接沿用大盤小報同一支聲音，只在 TEMPLATE === "midday" 用。
// ⚠️ 只出直式（沒有橫式 composition），而且這支 photo 的原圖是**直式**（2026-08-31 使用者確認），
//    所以 HEYGEN_ASPECT_RATIO 走非 dapan 的預設 9:16。別跟著大盤小報抄 16:9 —— 那是因為
//    大盤主播的素材是橫式，抄過來會上下補白（見 HEYGEN_ASPECT_RATIO 那段註解）。
const MIDDAY_AVATAR = { id: "b1be6a97186e4c49896f3eb503f8065f", gender: "female" }; // 2026-09-11 使用者更換 avatar look（原 0d84f2f5…）
// ⚠️ 2026-09-11 起盤中焦點有自己的 HeyGen 聲音（9cb1516e…），不再等於大盤小報那一支 ——
//    上面那段「voice id 一樣」是 2026-08-31 的舊定案，已被使用者這次的指定取代。
//    這裡寫死字面值（不要再寫成 = DAPAN_HEYGEN_VOICE_ID），兩條線之後各換各的互不影響。
//    MiniMax 那邊同日也拆開了（MINIMAX_FIXED_ANCHOR_VOICES.midday 換成自己的 f85dc873…）。
// ⚠️ 這個常數目前是**退路**，不是預設路徑 —— 現在走的是 MiniMax，只有 --heygen-voice 才會用到它。
const MIDDAY_HEYGEN_VOICE_ID = "9cb1516ecebf4c06b668e03f7f6e91f7";

// ── 固定主播線改用 MiniMax 配音（2026-08-24 使用者要求；大盤小報／盤中焦點已於 2026-09-11 改回）──
// 使用者：「我要改成先把腳本送給 minimax 配音再給 HeyGen 做對嘴」。
// 也就是這三條線從「HeyGen 文字驅動（script + voice_id，HeyGen 自己 TTS）」
// 改回「MiniMax T2A → 上傳音檔 → HeyGen audio_asset_id 音訊驅動對嘴」，
// 跟投廣模板 --minimax 模式走的是同一條既有路徑（heygenUploadAudio → createHeyGenVideo）。
//
// 為什麼要改：HeyGen 的中文 TTS 腔調不對，MiniMax 這三支是使用者自己 clone 的台灣腔聲音。
// 上面那三個 *_HEYGEN_VOICE_ID 常數保留不刪 —— 加 --heygen-voice 就整條路徑原封不動復原。
//
// ⚠️ 計費模式也跟著換了：文字驅動是 HeyGen 連 TTS 一起算，音訊驅動變成
//    MiniMax 按字符收費（3.5 元/萬字符）+ HeyGen 按音檔秒數收費，兩邊都會扣。
// ⚠️ 2026-09-11 大盤小報與盤中焦點換成兩支**新 clone 的聲音，而且彼此不同** ——
//    2026-08-31 那條「盤中焦點 voice id 跟大盤小報一樣」的舊定案到此為止，兩條線之後各換各的。
//    新聲音在改之前用 scripts/tts-ab.js 配真實文案試聽過（emotion=happy，＝下面 MINIMAX_EMOTION 的值），
//    對照素材留在 90_系統/暫存/產線輸出/tts-ab/，檔名帶 newA／newB。
//    重跑：node scripts/tts-ab.js --voice-id=<id> --text-file=<稿子> --dict --emotion=happy --trad-only
const MINIMAX_FIXED_ANCHOR_VOICES = {
  dapan: "moss_audio_b47d71d2-ada4-11f1-8900-9edb4a3ef07d",       // 大盤小報（2026-09-11 換，原 e9e9da93…）
  institution: "moss_audio_ad826960-9f57-11f1-8aea-1268c6bb306c", // 三大法人
  focusstock: "moss_audio_3a75102e-54db-11f1-981b-8a143315d498",  // 焦點股日報（＝既有 MINIMAX_VOICE_ID）
  midday: "moss_audio_f85dc873-ada4-11f1-a626-8a59b47fb1f9",      // 盤中焦點（2026-09-11 換，原本與大盤小報共用 e9e9da93…）
};

// 退路：固定主播四條線回到 HeyGen 內建語音（2026-08-07 ~ 2026-08-23 的行為）。
const USE_HEYGEN_VOICE = process.argv.includes("--heygen-voice");

// ── 某些版型「預設走 HeyGen 內建語音」的名單 ──────────────────────────────
// 進這個集合的版型效果等同自帶 --heygen-voice：走 script + voice_id 文字驅動，
// 不上傳音檔、不扣 MiniMax 點數，用的是各自的 *_HEYGEN_VOICE_ID 常數。
//
// **現在是空的 —— 四條固定主播線一律走 MiniMax。**
// 沿革：2026-09-11 使用者一度要求大盤小報／盤中焦點「voice 都先改用 HeyGen 內建的聲音，不要接 minimax」，
// 同一天又拿到兩支新 clone 的 MiniMax 聲音、試聽後定案改回 MiniMax（見 MINIMAX_FIXED_ANCHOR_VOICES）。
// 機制保留不刪：哪天某條線又要退回 HeyGen 內建語音，把版型名字加回這個集合就好，
// 其餘分支邏輯（FIXED_ANCHOR_USE_MINIMAX 與 main() 裡那四段）完全不必動。
// 臨時只退一次：指令加 --heygen-voice。
const HEYGEN_VOICE_ONLY_TEMPLATES = new Set([]);

// 固定主播四條線這次要不要走 MiniMax（單一判斷點，避免四個分支各寫一次）
const FIXED_ANCHOR_USE_MINIMAX =
  FIXED_ANCHOR_TEMPLATE &&
  !USE_HEYGEN_VOICE &&
  (!HEYGEN_VOICE_ONLY_TEMPLATES.has(TEMPLATE) || USE_MINIMAX);

// ── 繁→簡轉換：2026-08-24 起預設關閉（使用者定案「不要改簡體字了」）────────────
// 這個轉換是 2026-05-21（commit b08ba99「聲音改串接Minmax完成」）加的，當時的理由記在
// 99_封存/2026-09-10_第一批整理/舊說明與Agent紀錄/docs/tasks.md 第 676 行：「MiniMax 對繁中字符念法不準（用 opencc-js 轉簡體解決）」。
// 那個理由現在被兩個更精準的工具取代了：
//   ① `language_boost: "Chinese"` 釘住普通話 —— 原本繁體會被誤判成粵語，才需要靠轉簡體迴避
//   ② `pronunciation_dict` 逐字指定讀音 —— 原本靠簡體字形去影響念法，現在直接指定拼音
// 而且轉簡體本身有反效果：使用者實測繁體整體較好；「奇鋐」轉簡體會變成 `奇𬭎`
// （U+2C34E，CJK 擴充 B 區罕用字，TTS 字表很可能沒有它）；簡體文本也可能讓大陸模型
// 更偏向大陸讀音，跟我們想要台灣腔的方向相反。
// 要退回舊行為就加 --simp（`tradToSimpConverter` 與 opencc-js 依賴都留著沒拔）。
const TO_SIMP = process.argv.includes("--simp");

// ── 工具函式 ──────────────────────────────

function log(msg) {
  console.log(`\n[${new Date().toLocaleTimeString()}] ${msg}`);
}

function run(cmd) {
  log(`執行：${cmd}`);
  execSync(cmd, { cwd: PROJECT_DIR, stdio: "inherit" });
}

/**
 * 背景執行（不擋主流程）。給「不依賴講者影片」的工作用，最典型的就是圖片 OCR 版面偵測：
 * 它只需要 public/ 裡的圖，跟 HeyGen 生成完全無關，所以可以在等 HeyGen 那 3-5 分鐘時一起跑完。
 * 回傳 Promise，之後用 await 收斂。失敗不丟出（由呼叫端決定要不要當致命錯誤）。
 */
function runBackground(cmd, label) {
  const { exec } = require("child_process");
  log(`背景執行：${cmd}`);
  return new Promise((resolve) => {
    exec(cmd, { cwd: PROJECT_DIR, maxBuffer: 1024 * 1024 * 32 }, (err, stdout, stderr) => {
      resolve({ ok: !err, label, cmd, stdout: stdout || "", stderr: stderr || "", err });
    });
  });
}

/**
 * 依版型啟動「圖片分析」（OCR 版面偵測）。在呼叫 HeyGen 之前就啟動，好處有二：
 *   ① 省時間：跟 HeyGen 生成平行跑，等影片的空檔就把 OCR 做完。
 *   ② 及早失敗：圖有問題／沒裝 tesseract 會在一開始就知道，不必等 3-5 分鐘、白花 HeyGen 額度。
 * 回傳 Promise 或 null（該版型沒有要分析的圖）。
 */
function startImageAnalysis() {
  // 三大法人：固定版面資訊圖 → 用①②③④編號推區塊帶（供聚焦/高亮效果）
  if (TEMPLATE === "institution") {
    // 資訊圖檔名不挑：使用者常丟 0812.png 這種日期命名。
    // （2026-08-12 踩到：這裡寫死 image.png → 判定沒有圖而略過偵測，
    //   regions 停在舊圖、composition 又找不到檔案 → render 404。）
    const fsx = require("fs");
    const pubDir = resolve(PROJECT_DIR, "public");
    const ASSET = /^(dapan|focusstock|institution|midday)-|^(frame|logo)\.png$|^NotoSans/i;
    const found = fsx.existsSync(pubDir)
      ? fsx
          .readdirSync(pubDir)
          .filter((f) => /\.(png|jpg|jpeg)$/i.test(f) && !ASSET.test(f))
          .sort()
      : [];
    if (found.length === 0) {
      log("ℹ️ public/ 沒有資訊圖，略過版面偵測");
      return null;
    }
    log(`   資訊圖：${found.includes("image.png") ? "image.png" : found[0]}`);
    log("🔎 開始資訊圖版面偵測（與 HeyGen 生成平行進行）");
    return runBackground("npm run analyze:institution", "版面偵測");
  }
  // 其餘版型（大盤小報／焦點股／投廣）：變動版面的 APP 截圖
  //   → 判斷是哪一頁、哪一檔股票，並存下逐字框座標，供之後框數字／局部放大用。
  const fs2 = require("fs");
  const pub = resolve(PROJECT_DIR, "public");
  // 截圖檔名不限（使用者常直接丟手機相機命名的檔），排除套版素材即可
  const TEMPLATE_ASSET = /^(dapan|focusstock|institution|midday)-|^(frame|logo)\.png$|^NotoSans/i;
  const shots = fs2.existsSync(pub)
    ? fs2.readdirSync(pub).filter(
        (f) => /\.(png|jpg|jpeg)$/i.test(f) && !TEMPLATE_ASSET.test(f)
      )
    : [];
  if (shots.length === 0) {
    log("ℹ️ public/ 沒有 image*.png，略過 APP 截圖分析");
    return null;
  }
  log(`🔎 開始 APP 截圖分析（${shots.length} 張，與 HeyGen 生成平行進行）`);
  return runBackground("npm run analyze:app-images", "APP 截圖分析");
}

function parseVoiceReplacements(raw) {
  // 讀取頂部 # 發音替換 區塊（=== 之前）
  const rules = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('===')) break;
    if (line.startsWith('#')) continue;
    const m = line.match(/^(.+?)→(.+)$/);
    if (m) rules.push({ from: m[1].trim(), to: m[2].trim() });
  }
  return rules;
}

/**
 * 送配音前把減號拿掉（**只動送 TTS 的那份，不動稿子、不動字幕**）。
 *
 * 2026-09-01 使用者定案：「送去配音時還是要依照 ，。！？ 斷句換氣，但是遇到其他標點符號
 * 像是 - 就不要，或許送配音前 - 可以先刪掉？但最後字幕還是要出現。」
 *
 * 為什麼這裡是對的位置：配音跟字幕走的是**兩條不同的清洗函式** ——
 * TTS 走本檔的 cleanScript()／cleanSegmentText()，字幕走 script-utils.js 的 cleanBodyWithIndex()。
 * 在 TTS 這條刪掉減號，字幕那條完全不受影響 → 螢幕上照樣是「世芯-KY」，
 * 而且**不需要**靠共用詞庫的 `-KY→KY` ＋ correct-subtitles 第 10 步反向還原繞一圈
 * （那條路只認 -KY，而且反向還原沒有詞邊界，會把字幕裡單獨的 KY 也塞成 -KY）。
 *
 * ⚠️ 數字區間的減號一定要留：「未來 3-5 天」「2023-2024 年」無腦刪會變成「35 天」「20232024 年」，
 *    唸出來直接是錯的。所以規則是「兩邊都是數字就保留，其餘刪掉」。
 * ⚠️ 只處理半形 `-`。全形破折號（—／－）在中文裡本來就是有意義的停頓，不碰。
 */
function stripSpeechHyphens(text) {
  return String(text).replace(/-/g, (m, off, full) => {
    const prev = full[off - 1] || '';
    const next = full[off + 1] || '';
    return /\d/.test(prev) && /\d/.test(next) ? '-' : '';
  });
}

/**
 * 送配音前把「年份」轉成中文數字（**只動送 TTS 的那份，不動稿子、不動字幕**）。
 *
 * 2026-09-01 上線。起因：實測 MiniMax 的 `text_normalization`（官方數字正規化開關）
 * 結論是 **✗ 不採用** —— 使用者：「不好，數字會唸錯」，年份 2026／2027 被唸成
 * 「兩千零二十六」，台灣唸法要逐字「二零二六」。而指數 45,832、價格 1,205、
 * 百分比 6% 本來就唸得對，沒有非開 TN 不可的理由。
 *
 * 位置與 stripSpeechHyphens() 同一個理由：TTS 走 cleanScript()／cleanSegmentText()，
 * 字幕走 script-utils.js 的 cleanBodyWithIndex() —— 在這裡轉，螢幕上照樣顯示「2026」。
 *
 * ⚠️ **股號那條規則已經拿掉，不要加回來。** 原本還有一條「獨立的 4 位數 → 逐字唸」
 *    是給 2454／3034 這種股票代號用的，2026-09-01 使用者說明：
 *    「講股票代號機會偏小，因為之前一直撞牆於是我決定再也不讓 AI 講股票代號」。
 *    稿子裡本來就不會有股號 → 那條規則變成純風險：它會吃掉**任何**沒接單位字的 4 位數。
 *    （而且它本身有個很細的坑：單位字排除清單放了「台」，「2330 台積電」就漏轉 ——
 *      台股一堆公司名首字是量詞：台積電／日月光／萬海／元大／億豐／天鈺／家登。
 *      要復活的話得連這個一起處理，不是把 regex 貼回來就好。）
 * ⚠️ **要與 scripts/tts-ab.js 的同名函式保持一致**（同 DICT 的規矩）。
 */
const CN_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

function digitsToCn(str) {
  return String(str).split("").map((d) => CN_DIGITS[Number(d)]).join("");
}

function numFix(text) {
  // 19xx／20xx 後面接「年」。順便吃掉中間空白 ——「二零二七 年」會在「年」前頓一下。
  // 前面不吃數字／逗號／小數點／減號：「2023-2024 年」整段不動
  //（stripSpeechHyphens 會保留數字間的減號，不排除的話會變成「2023-二零二四年」）。
  return String(text).replace(/(?<![\d,\-.])((?:19|20)\d{2})\s*(?=年)/g, (m, d) => digitsToCn(d));
}

function cleanScript(raw) {
  // 套用發音替換（送 HeyGen 前）
  const voiceRules = parseVoiceReplacements(raw);
  // 移除標題區（=== 以前）
  const parts = raw.split("===");
  const body = parts.length >= 3 ? parts[parts.length - 1] : (parts[1] ?? raw);
  // 移除圖片標記 (imageN)...(imageN)、(logo)...(logo)、(shot:名稱)...(shot:名稱)
  // 大小寫不分(i flag),(Logo)、(IMAGE1)、(Shot:...) 都能正確移除
  let cleaned = body.replace(/\(text:[^)]*\)[\s\S]*?\(\/text\)/gi, "").replace(/\([a-z0-9]+\)/gi, "").replace(/\(shot:[^)]*\)/gi, "");
  // 移除括號內文字
  cleaned = cleaned.replace(/[\[{【（][^\]}\]）】]*[\]}\]）】]/g, "");
  // 移除多餘空白與換行
  cleaned = cleaned.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  // 減號不進 TTS（字幕那條路不受影響，見 stripSpeechHyphens 的註解）
  cleaned = stripSpeechHyphens(cleaned);
  // 年份轉中文數字（同上，只動 TTS 這份）
  cleaned = numFix(cleaned);
  return cleaned;
}

function randomAvatar() {
  // 回傳 { id, gender }，gender 用來決定 SOLO_VOICES 配音
  return AVATAR_IDS[Math.floor(Math.random() * AVATAR_IDS.length)];
}

function randomPair() {
  return PAIRS[Math.floor(Math.random() * PAIRS.length)];
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 雙人 path：腳本解析 ─────────────────
// detectMode: 偵測腳本是否含 [A]/[B] 行首標記 → 'dual' 或 'solo'
// 沒有 [A]/[B] → 走現有單人 path（100% 向後相容）
function detectMode(rawScript) {
  const parts = rawScript.split("===");
  const body = parts.length >= 3 ? parts[parts.length - 1] : (parts[1] ?? rawScript);
  return /^[ \t]*\[([AaBb])\]/m.test(body) ? "dual" : "solo";
}

// splitByRole: 把 script.txt 內文依 [A]/[B] 行首標記切段、合併連續同角色段
// 沒標的第一段預設 A；沒標的後續行承襲上一段角色
// 回傳 [{ role: 'A'|'B', text: <已清洗的對話文字> }, ...]
function splitByRole(rawScript, voiceRules) {
  const parts = rawScript.split("===");
  const body = parts.length >= 3 ? parts[parts.length - 1] : (parts[1] ?? rawScript);

  // 套發音替換（保持繁中，跟單人 path 同邏輯）
  let bodyAfterVoice = body;
  for (const rule of voiceRules) {
    bodyAfterVoice = bodyAfterVoice.split(rule.from).join(rule.to);
  }

  const lines = bodyAfterVoice.split("\n");
  let currentRole = "A"; // 預設第一段為 A
  let currentText = "";
  const segments = [];

  function flushSegment() {
    const cleaned = cleanSegmentText(currentText);
    if (cleaned) segments.push({ role: currentRole, text: cleaned });
    currentText = "";
  }

  for (const line of lines) {
    const m = line.match(/^[ \t]*\[([AaBb])\][ \t]*(.*)$/);
    if (m) {
      const newRole = m[1].toUpperCase();
      if (newRole !== currentRole && currentText.trim()) flushSegment();
      currentRole = newRole;
      currentText += (currentText ? " " : "") + m[2];
    } else {
      currentText += (currentText ? " " : "") + line;
    }
  }
  flushSegment();
  return segments;
}

// cleanSegmentText: 單段對話的清洗（跟 cleanScript 同精神，但已切段、只處理單段文字）
function cleanSegmentText(text) {
  let out = text
    .replace(/\(text:[^)]*\)[\s\S]*?\(\/text\)/gi, "")
    .replace(/\([a-z0-9]+\)/gi, "")
    .replace(/\(shot:[^)]*\)/gi, "");
  out = out.replace(/[\[{【（][^\]}\]）】]*[\]}\]）】]/g, "");
  out = out.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  // 跟單人 path 一致：減號不進 TTS、年份轉中文
  out = stripSpeechHyphens(out);
  out = numFix(out);
  return out;
}

// ── MiniMax T2A ───────────────────────────

async function minimaxTTS(text, voiceId = MINIMAX_VOICE_ID) {
  log(`呼叫 MiniMax T2A（${text.length} 字符、model: ${MINIMAX_MODEL}、voice: ${voiceId}、情緒: ${MINIMAX_EMOTION || "自動"}）`);
  const url = `https://api.minimax.io/v1/t2a_v2?GroupId=${MINIMAX_GROUP_ID}`;
  const payload = {
    model: MINIMAX_MODEL,
    text,
    // 見 MINIMAX_LANGUAGE_BOOST 的註解：不送這欄位＝讓 MiniMax 猜語言，繁體有機率被判成粵語。
    language_boost: MINIMAX_LANGUAGE_BOOST,
    voice_setting: {
      voice_id: voiceId,
      speed: 1.0,
      vol: 1.0,
      pitch: 0,
      // emotion 見 MINIMAX_EMOTION 的註解（2026-09-01 起送 happy；設成空值就退回「自動挑」）。
      ...(MINIMAX_EMOTION ? { emotion: MINIMAX_EMOTION } : {}),
    },
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: "mp3",
      channel: 1,
    },
    output_format: "hex",
    stream: false,
  };
  // 發音字典：空陣列就不送這個欄位（見 MINIMAX_PRONUNCIATION_DICT 的註解）
  if (MINIMAX_PRONUNCIATION_DICT.length) {
    payload.pronunciation_dict = { tone: MINIMAX_PRONUNCIATION_DICT };
    log(`  發音字典：${MINIMAX_PRONUNCIATION_DICT.join("　")}`);
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MINIMAX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok || !data.data?.audio) {
    console.error("MiniMax 回應：", JSON.stringify(data, null, 2));
    throw new Error("MiniMax T2A 生成失敗");
  }
  // response.data.audio 是 hex-encoded mp3
  return Buffer.from(data.data.audio, "hex");
}

// ── 影片加速 ───────────────────────────────
// 全流程只准加速一次。2026-08-17 之前有兩個加速點（generateHeygenVideo 末尾的 125%
// 與 main() 內的 120%），守門條件對不上，institution／focusstock 被連續加速兩次
// （1.25 × 1.2 ≒ 1.5 倍），講話斷句被壓爛。現在改成共用這個函式 + 模組層旗標把關：
// 就算未來又有人多加一個呼叫點，第二次也會被擋下並印警告，而不是靜默 compounding。
// 2026-08-19 曾經想把加速搬到 HeyGen 生成端（送 voice_settings.speed，好只付成品長度的點數），
// 同一天實測發現那個欄位對我們的 voice 沒有作用（4.461 秒 → 4.368 秒，只短 2%、扣點一樣）而收回。
// 2026-08-21 使用者定案：那條路不可行，整套 speedAtSource／HEYGEN_VOICE_SPEED 機制一併拆掉 ——
// 留著只是個陷阱（常數一旦被設成非 null，這支 ffmpeg 加速就靜默被跳過，成品變接近原速、
// 點數又一毛沒省，那正是 8/19 當天踩到的）。**現在加速只有這一條路：ffmpeg。**
// 哪天 HeyGen 修好想再試，先用 `node scripts/ab-endpoints.js --only=v3 --v3-speed=1.5 --go`
// 確認秒數真的變短，再把欄位加回來 —— 不要憑推測。
const SPEED_FACTOR = 1.25;
let speedApplied = false;

// 加速過的 mp4 會被蓋上這個記號（寫進容器的 comment tag）。
// 為什麼需要它：`speedApplied` 只擋「同一輪」的重複加速，擋不了「跨輪」——
// 加速完的檔案就是覆蓋回 public/heygen.mp4，拿它再跑一次 --skip-generate 就變 1.25²≒1.56 倍
// （斷句會被壓爛，2026-08-17 踩過同樣的複合加速）。以前靠人記得加 --no-speed，
// 2026-08-21 把「用現成的講者影片」開放給所有同事之後，那個假設就不成立了 → 改成自己認得出來。
// ⚠️ backups/ 裡的檔案**沒有**這個記號（backupJob 是在加速之前跑的），所以拿備份重跑會正常加速，
//    這是對的 —— 那些是原速的原始檔。
const SPED_TAG = "marketing-video:sped";

/** 這支影片是不是我們自己加速過的？認不出來就當成沒有（維持原本會加速的行為）。 */
function alreadySpedUp(p) {
  try {
    const out = execSync(
      `ffprobe -v error -show_entries format_tags=comment -of default=nw=1:nk=1 "${p}"`,
      { encoding: "utf-8" }
    );
    return out.includes(SPED_TAG);
  } catch (_) {
    return false;
  }
}

function speedUpHeygen(heygenPath, whoLabel) {
  if (speedApplied) {
    log(`⚠️ heygen.mp4 這一輪已經加速過了，略過「${whoLabel}」的重複加速（避免 compounding）`);
    return;
  }
  if (alreadySpedUp(heygenPath)) {
    log(`⏩ 這支 heygen.mp4 之前就被加速過了（檔案裡有記號），略過「${whoLabel}」的加速 —— 不然會變 ${(SPEED_FACTOR * SPEED_FACTOR).toFixed(2)} 倍`);
    speedApplied = true;
    return;
  }
  log(`加速影片 ${Math.round(SPEED_FACTOR * 100)}%（保持音調）`);
  const heygenFast = resolve(PROJECT_DIR, "public/heygen_fast.mp4");
  execSync(
    `ffmpeg -y -i "${heygenPath}" -filter_complex "[0:v]setpts=PTS/${SPEED_FACTOR}[v];[0:a]atempo=${SPEED_FACTOR}[a]" -map "[v]" -map "[a]" -metadata comment="${SPED_TAG}=${SPEED_FACTOR}" "${heygenFast}"`,
    { cwd: PROJECT_DIR, stdio: "inherit" }
  );
  require("fs").renameSync(heygenFast, heygenPath);
  speedApplied = true;
  log("加速完成，覆蓋 heygen.mp4（已蓋上記號，之後重跑不會再加速一次）");
}

// ── HeyGen API ────────────────────────────

// ── 引擎（2026-08-20 使用者定案：維持 avatar_iv）────────────
// photo avatar 的官方費率：avatar_iii $0.0433/秒、avatar_iv $0.05/秒、avatar_v $0.0667/秒。
// 實測同一段 25 字（都生成 5.24 秒）：III 扣 14 單位、IV 扣 15 —— 差只有 7~13%。
// **走過一輪 III 又改回來，不要再試第三次**：
//   2026-08-19 用 5 秒短測試片比對，使用者看不出差別 → 一度把預設改成 avatar_iii 省 10%。
//   2026-08-20 使用者看實際出片的回饋是「表情有點沒對上、好奇怪」→ 改回 avatar_iv。
//   結論：**III 跟 IV 的差別在 5 秒短片看不出來，要在正式長度的影片上才會露出來**（表情／對嘴），
//   而省下的只有 7~13%（一支約 $0.23~0.47），不值得拿主播的臉去換。
// 真的要再試 III：指令加 --avatar-iii（不必改程式），但請用「正式長度的稿子」比，別再用 5 秒短片。
// ⚠️ 想省 2/3 只能換 avatar 類型（Studio Avatar／Digital Twin 才吃 $0.0167/秒＝1 單位/秒），
//    照片主播在任何引擎上都拿不到那一檔（見 99_封存/2026-09-10_第一批整理/舊說明與Agent紀錄/docs/tasks.md 雷區）。
const HEYGEN_ENGINE = process.argv.includes("--avatar-iii") ? "avatar_iii" : "avatar_iv";

// Avatar IV 手部/身體動作提示（只有 photo avatar + avatar_iv 吃）。要微調手勢就改這裡。
// 2026-08-19：改成 null＝三個 payload 都不送 motion_prompt。當初以為帶它是 2:1 雙倍計費，
// 後來實測推翻（API tier 不會加倍，帶不帶都是同一費率）—— 但它對「來源照片本身雙手交握」
// 的 look 幾乎無效（見 99_封存/2026-09-10_第一批整理/舊說明與Agent紀錄/docs/tasks.md 第 4 節），所以維持不送。
// 要恢復就把下一行的 null 換成 HEYGEN_MOTION_PROMPT_TEXT（只有 avatar_iv 會帶上）。
const HEYGEN_MOTION_PROMPT_TEXT = "站姿自然，雙手在胸前或身側做出適度自然的手勢，配合語氣比劃，不要十指交握不動";
const HEYGEN_MOTION_PROMPT = null;

// expressiveness：high / medium / low。官方文件說「省略時預設 low」，只有 photo avatar 吃。
// 手不太動時可以試 high（會連帶放大臉部表情幅度）。
// ⚠️ 這是 Avatar IV 專屬欄位，送給別的引擎會被 400 擋掉（實測 avatar_v 回
//    「expressiveness is not supported with engine 'avatar_v'」）→ 只有 avatar_iv 才帶。
const HEYGEN_EXPRESSIVENESS = "medium";

// ── 出片畫面比例（2026-08-25 修）────────────
// ⚠️ 這個值要跟「主播 avatar 的素材方向」綁，不是跟輸出版型綁。
// 8/24 改走 /v3/videos 之後才爆的問題：舊的 /v2/videos **根本不理 aspect_ratio**，
// 一律回 avatar 原生比例；v3 會照做，而大盤主播（8032bdb6…）的素材是橫式 16:9，
// 被塞進 9:16 就上下補白 —— heygen.mp4 變成 1080×1920 但內容只佔 y656~1263，
// 直式的 objectFit:'cover' 因此完全失效（來源已經是 1080×1920，cover 等於沒作用），
// 橫式左側講者區也一起露出白邊。
// 大盤要「同一支檔案出直式＋橫式」，所以跟 8/21 之前一樣要 16:9 原生：
//   橫式 DapanLandscapeComposition 直接吃（它本來就寫著「來源 16:9 人物置中」）
//   直式 DapanComposition 用 objectFit:'cover' 裁掉左右填滿
// 三大法人／焦點股／盤中焦點的 avatar 素材是直式，維持 9:16（實測 8/24 那支滿版無白邊；
// 盤中焦點 2026-08-31 由使用者確認原圖是直式）。
const HEYGEN_ASPECT_RATIO = TEMPLATE === "dapan" ? "16:9" : "9:16";

// fit：cover＝縮放填滿（可能裁邊）、contain＝完整塞進去（會露出背景）。
// 省略時由 HeyGen 自己挑 —— 上面那個白邊就是它挑了 contain。比例本來就吻合時
// 兩者等價，所以一律送 cover 當保險：日後誰換了橫式素材的 avatar 也不會再無聲變白邊。
// ⚠️ 只有 /v3/videos 有這個欄位，v2 的兩支 payload 不要加。
const HEYGEN_FIT = "cover";


// ── v3 vs v2（2026-08-17）────────────────
// 固定主播三條線（文字驅動）走 POST /v3/videos，理由：
//   ① Avatar IV 是 v3 的「預設引擎」，官方文件現在只寫 v3；我們仍明示 engine.type = avatar_iv
//   ② v3 才有 voice_settings（speed / pitch / locale）——調語速不必再靠 ffmpeg 硬壓
//   ③ 官方明講 <break time="0.3s"/> 標籤適用於 POST /v3/videos 的 script 欄位（唯一支援的標籤，
//      不要包 <speak>，會多唸出音節）。這是修「中文分詞斷錯句」的正解。
//      ⚠️ 但 scripts/script-utils.js 的 cleanBodyWithIndex 目前沒遮罩 <break>，
//         現在直接在 script.txt 寫標籤會漏進字幕。要用得先做天條 #5 的三處同步。
//   ④ brand_glossary_id 可以指定專有名詞唸法，且官方保證「只影響合成音訊，字幕仍顯示原文」——
//      比現在的「發音替換」乾淨。要用先 GET /v3/brand-glossaries 拿 id 填進來。
// 出事時加 --heygen-v2 一鍵退回舊的 /v2/videos 路徑。
// ⚠️ 投廣模板與雙人 path 走的是「MiniMax 配音 + audio_asset_id 音訊驅動」，
//    那條路徑完全沒動，仍然是 /v2/videos（天條：既有投廣模板 100% 不變）。
const HEYGEN_V2_FALLBACK = process.argv.includes("--heygen-v2");

// voice_settings（只有 v3 吃）。null = 不送該欄位，用 HeyGen 預設。
//   locale : BCP-47，例如 "zh-TW"。填之前先跑 npm run check-voices 確認該 voice 的
//            support_locale 是 true，否則可能被 400 退回。
//
// ⚠️ **`speed` 這個欄位刻意不做了**（2026-08-21 使用者定案，別再加回來）。
//    動機本來是省點數：Avatar IV 按**生成秒數**計費 3 單位/秒，原速 69 秒的稿子成品只有 55 秒，
//    等於每支多付 25%。所以 8/19 試過讓 HeyGen 直接生 1.25 倍速、只付成品長度。
//    `scripts/ab-endpoints.js` 實測（institution 的 voice e96f2834…、同一段 25 字）：
//        不送 speed  → 4.461 秒／扣 12 單位
//        speed 1.25 → 4.368 秒／扣 12 單位    ← 只短 2%，等於沒生效、也沒省到
//    而它的存在本身就是陷阱：常數一旦非 null，`speedUpHeygen()` 就會靜默跳過 ffmpeg 加速，
//    成品變成接近原速（比平常慢 25%）而且點數一毛沒省 —— 那正是 8/19 當天踩到的。
//    所以整套（HEYGEN_VOICE_SPEED / speedAtSource / payload.voice_settings.speed）都拆了。
//    哪天 HeyGen 修好想再試：先跑 `node scripts/ab-endpoints.js --only=v3 --v3-speed=1.5 --go`
//    確認秒數真的變短，**再**把欄位加回來，並且同步處理「ffmpeg 那邊要跳過」這件事。
const HEYGEN_VOICE_LOCALE = null;

// 專有名詞唸法字典（v3 專屬）。先 GET /v3/brand-glossaries 拿 id，填進來就會套用。
const HEYGEN_BRAND_GLOSSARY_ID = null;

// 音檔上傳。2026-08-24 起預設走 POST https://api.heygen.com/v3/assets（multipart，欄位名 file，
// 上限 32MB），舊的 upload.heygen.com/v1/asset 留在 --heygen-v2 當退路 ——
// HeyGen 官方公告 v1/v2 端點 2026-10-31 之後退役，必須在 2026-11-01 前遷完。
async function heygenUploadAudio(audioBuffer) {
  if (HEYGEN_V2_FALLBACK) {
    log(`上傳音檔到 HeyGen（v1 端點，${audioBuffer.length} bytes）`);
    const res = await fetch("https://upload.heygen.com/v1/asset", {
      method: "POST",
      headers: { "X-Api-Key": HEYGEN_API_KEY, "Content-Type": "audio/mpeg" },
      body: audioBuffer,
    });
    const data = await res.json();
    // v1 回傳 { code: 100, data: { id, name, url } }；asset id 在 data.id
    const assetId = data?.data?.id || data?.data?.asset_id;
    if (!res.ok || !assetId) {
      console.error("HeyGen upload 回應：", JSON.stringify(data, null, 2));
      throw new Error("HeyGen 音檔上傳失敗（v1）");
    }
    log(`音檔已上傳：asset_id = ${assetId}`);
    return assetId;
  }

  log(`上傳音檔到 HeyGen（/v3/assets，${audioBuffer.length} bytes）`);
  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: "audio/mpeg" }), "audio.mp3");
  const res = await fetch("https://api.heygen.com/v3/assets", {
    method: "POST",
    // ⚠️ 不要自己設 Content-Type —— multipart 的 boundary 要讓 fetch 自己帶
    headers: { "X-Api-Key": HEYGEN_API_KEY },
    body: form,
  });
  const data = await res.json().catch(() => null);
  // v3 回傳 { data: { asset_id, url, mime_type, size_bytes } }
  const assetId = data?.data?.asset_id || data?.data?.id;
  if (!res.ok || !assetId) {
    console.error(`HeyGen /v3/assets 回應（HTTP ${res.status}）：`, JSON.stringify(data, null, 2));
    console.error("   → 想先退回舊端點的話，指令加 --heygen-v2");
    throw new Error("HeyGen 音檔上傳失敗（v3）");
  }
  log(`音檔已上傳：asset_id = ${assetId}`);
  return assetId;
}

// v3 音訊驅動（2026-08-24 起的預設路徑）。欄位跟 v2 幾乎一樣，差在多一個必填的 type: "avatar"、
// 引擎走 engine.type，輪詢共用文字驅動那支 pollHeyGenStatusV3()。
// engine 參數是給「被拒時自動退回 avatar_iv」用的，正常呼叫不要自己傳。
async function createHeyGenVideoAudioDrivenV3(audioAssetId, avatarId, title, engine = HEYGEN_ENGINE) {
  log(`呼叫 HeyGen /v3/videos ${engine}（avatar: ${avatarId}、audio_asset_id: ${audioAssetId}）`);

  const payload = {
    type: "avatar",
    avatar_id: avatarId,
    audio_asset_id: audioAssetId,
    aspect_ratio: HEYGEN_ASPECT_RATIO,
    fit: HEYGEN_FIT,
    resolution: "1080p",
    engine: { type: engine },
    title,
  };
  // expressiveness／motion_prompt 是 Avatar IV 專屬欄位，送給別的引擎會被 400 擋掉。
  if (engine === "avatar_iv") {
    payload.expressiveness = HEYGEN_EXPRESSIVENESS;
    if (HEYGEN_MOTION_PROMPT) payload.motion_prompt = HEYGEN_MOTION_PROMPT;
  }

  const res = await fetch("https://api.heygen.com/v3/videos", {
    method: "POST",
    headers: { "X-Api-Key": HEYGEN_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => null);
  const videoId = data?.data?.video_id || data?.data?.id;

  if (!res.ok || !videoId) {
    console.error(`HeyGen /v3/videos 回應（HTTP ${res.status}）：`, JSON.stringify(data, null, 2));
    // 跟文字驅動同一套：建立失敗不扣點，所以直接用 avatar_iv 重試一次，別讓整支片死掉。
    if (engine !== "avatar_iv") {
      log(`⚠️ ${engine} 被拒，自動改用 avatar_iv 重試一次（建立失敗不扣點）`);
      return createHeyGenVideoAudioDrivenV3(audioAssetId, avatarId, title, "avatar_iv");
    }
    console.error("   → 想先退回舊路徑出片的話，指令加 --heygen-v2");
    throw new Error("HeyGen 建立影片失敗（音訊驅動 v3）");
  }

  return videoId;
}

// 音訊驅動的統一入口（create）：預設 v3，加 --heygen-v2 退回 /v2/videos。
async function createAudioDrivenVideo(audioAssetId, avatarId, title = "marketing-auto") {
  if (HEYGEN_V2_FALLBACK) {
    log("⚠️ 已指定 --heygen-v2，音訊驅動改走舊的 /v2/videos 路徑");
    return createHeyGenVideoAudioDrivenV2(audioAssetId, avatarId, title);
  }
  return createHeyGenVideoAudioDrivenV3(audioAssetId, avatarId, title);
}

// 音訊驅動的統一入口（poll）：v3 與 v2 的回應 schema 不同，各自有現成的輪詢函式。
async function pollAudioDrivenStatus(videoId) {
  return HEYGEN_V2_FALLBACK ? pollHeyGenStatus(videoId) : pollHeyGenStatusV3(videoId);
}

async function createHeyGenVideoAudioDrivenV2(audioAssetId, avatarId, title = "marketing-auto") {
  log(`呼叫 HeyGen Avatar IV（avatar: ${avatarId}、audio_asset_id: ${audioAssetId}）`);

  // 端點：POST /v2/videos（HeyGen 專用 Avatar IV）。
  // 跟舊的 /v2/video/generate 差別：這裡的 motion_prompt（控制身體/手部動作，僅 photo avatar）
  // 與 expressiveness（注意值要小寫 high）才真正生效 → 手會動。
  // avatar_id 直接吃 talking_photo 的 id；audio_asset_id 走 audio-driven 對嘴（與 script 互斥），沿用 MiniMax 配音。
  const payload = {
    avatar_id: avatarId,
    audio_asset_id: audioAssetId,
    expressiveness: "medium", // 必須小寫：low / medium / high
    aspect_ratio: HEYGEN_ASPECT_RATIO,
    resolution: "1080p",
    title,
  };
  if (HEYGEN_MOTION_PROMPT) payload.motion_prompt = HEYGEN_MOTION_PROMPT;

  const res = await fetch("https://api.heygen.com/v2/videos", {
    method: "POST",
    headers: {
      "X-Api-Key": HEYGEN_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  const videoId = data?.data?.video_id || data?.video_id || data?.data?.id;

  if (!res.ok || !videoId) {
    console.error("HeyGen 回應：", JSON.stringify(data, null, 2));
    throw new Error("HeyGen 建立影片失敗");
  }

  return videoId;
}

// 固定主播三條線專用：不經 MiniMax，直接把腳本文字＋HeyGen 內建語音 voice_id 送給 HeyGen，
// 由 HeyGen 自己 TTS＋對嘴（跟現有 audio_asset_id 音訊驅動路徑互斥，用 script+voice_id 這組欄位）。
// 2026-08-07 使用者要求「大盤小報聲音改用 HeyGen 生，不要用 MiniMax」。
// 2026-08-17 起預設走 v3（見下方 createHeyGenVideoTextDrivenV3）；這支是 --heygen-v2 的退路。
async function createHeyGenVideoTextDrivenV2(scriptText, avatarId, voiceId, title) {
  log(`呼叫 HeyGen /v2/videos（avatar: ${avatarId}，voice_id: ${voiceId}，文字驅動、不經 MiniMax）`);

  const payload = {
    avatar_id: avatarId,
    script: scriptText,
    voice_id: voiceId,
    expressiveness: HEYGEN_EXPRESSIVENESS,
    aspect_ratio: HEYGEN_ASPECT_RATIO,
    resolution: "1080p",
    title,
  };
  if (HEYGEN_MOTION_PROMPT) payload.motion_prompt = HEYGEN_MOTION_PROMPT;

  const res = await fetch("https://api.heygen.com/v2/videos", {
    method: "POST",
    headers: {
      "X-Api-Key": HEYGEN_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  const videoId = data?.data?.video_id || data?.video_id || data?.data?.id;

  if (!res.ok || !videoId) {
    console.error("HeyGen 回應：", JSON.stringify(data, null, 2));
    throw new Error("HeyGen 建立影片失敗（文字驅動 v2）");
  }

  return videoId;
}

// v3 版（預設路徑）。跟 v2 的差別：
//   - 多了必填的 type: "avatar"
//   - engine.type 明示引擎（預設 avatar_iv，見 HEYGEN_ENGINE；--avatar-iii 可換便宜的）
//   - 多了 voice_settings（speed / pitch / locale）與 brand_glossary_id
//   - script 欄位吃 <break time="0.3s"/> 標籤
// engine 參數是給「被拒時自動退回 avatar_iv」用的，正常呼叫不要自己傳。
async function createHeyGenVideoTextDrivenV3(scriptText, avatarId, voiceId, title, engine = HEYGEN_ENGINE) {
  log(`呼叫 HeyGen /v3/videos ${engine}（avatar: ${avatarId}，voice_id: ${voiceId}，文字驅動、不經 MiniMax）`);

  const payload = {
    type: "avatar",
    avatar_id: avatarId,
    script: scriptText,
    voice_id: voiceId,
    aspect_ratio: HEYGEN_ASPECT_RATIO,
    fit: HEYGEN_FIT,
    resolution: "1080p",
    engine: { type: engine },
    title,
  };
  // expressiveness／motion_prompt 是 Avatar IV 專屬欄位，送給別的引擎會被 400 擋掉。
  if (engine === "avatar_iv") {
    payload.expressiveness = HEYGEN_EXPRESSIVENESS;
    if (HEYGEN_MOTION_PROMPT) payload.motion_prompt = HEYGEN_MOTION_PROMPT;
  }

  // ⚠️ 這裡刻意不送 voice_settings.speed —— 加速一律由 ffmpeg 做（見 HEYGEN_VOICE_LOCALE 上方註解）。
  const voiceSettings = {};
  if (HEYGEN_VOICE_LOCALE) voiceSettings.locale = HEYGEN_VOICE_LOCALE;
  if (Object.keys(voiceSettings).length) payload.voice_settings = voiceSettings;
  if (HEYGEN_BRAND_GLOSSARY_ID) payload.brand_glossary_id = HEYGEN_BRAND_GLOSSARY_ID;

  const res = await fetch("https://api.heygen.com/v3/videos", {
    method: "POST",
    headers: {
      "X-Api-Key": HEYGEN_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => null);
  const videoId = data?.data?.video_id || data?.data?.id;

  if (!res.ok || !videoId) {
    console.error(`HeyGen /v3/videos 回應（HTTP ${res.status}）：`, JSON.stringify(data, null, 2));
    // 這支 avatar 可能不支援 avatar_iii（投廣模板的隨機池 AVATAR_IDS 沒有逐一驗過），
    // 或參數跟引擎不合。建立失敗不扣點，所以直接用 avatar_iv 重試一次，不要讓整支片死掉。
    if (engine !== "avatar_iv") {
      log(`⚠️ ${engine} 被拒，自動改用 avatar_iv 重試一次（建立失敗不扣點）`);
      log(`   若這支 avatar 長期不吃 ${engine}，用 node scripts/ab-endpoints.js --template=<版型> --probe 查支援的引擎（不扣點）`);
      return createHeyGenVideoTextDrivenV3(scriptText, avatarId, voiceId, title, "avatar_iv");
    }
    console.error("   → 想先退回舊路徑出片的話，指令加 --heygen-v2");
    throw new Error("HeyGen 建立影片失敗（文字驅動 v3）");
  }

  return videoId;
}

// HeyGen 輪詢上限：每 10 秒一次 × 90 次 = 15 分鐘。
// 2026-09-07 中午曾縮成 8 分鐘（48 次），同日下午 HeyGen 尖峰時段實測 7.5 分鐘擦邊過、另一支超過 8 分鐘被我們自己砍掉
// （點數已扣、片子其實還在做）→ 使用者定案放寬回 15 分鐘。正常一支 1～6 分鐘；超時不代表失敗，錯誤訊息會提示怎麼接手。
const HEYGEN_POLL_MAX = 90;

// 輪詢 GET /v3/videos/{video_id}。回應是 VideoDetail：完成時給 video_url / duration /
// subtitle_url，失敗時給 failure_code / failure_message（沒有保證一定有 status 欄位，
// 所以用「有沒有 video_url」當完成判準，status 只拿來顯示）。
async function pollHeyGenStatusV3(videoId) {
  log(`等待 HeyGen 完成（v3，video_id: ${videoId}）`);

  for (let i = 0; i < HEYGEN_POLL_MAX; i++) {
    await sleep(10000); // 每 10 秒查一次

    // 2026-09-07：以前 res.json() 失敗會被 catch 成 null → 空物件 → 印「processing」，
    // 429／5xx／回 HTML 全被吞成「HeyGen 慢」。現在網路錯誤與非 2xx／非 JSON 都印成獨立一行再繼續等，
    // 不提早放棄（使用者定案：早放棄＝點數白扣；15 分鐘上限語意不變）。
    let res;
    try {
      res = await fetch(`https://api.heygen.com/v3/videos/${videoId}`, {
        headers: { "X-Api-Key": HEYGEN_API_KEY },
      });
    } catch (e) {
      console.log(`\n  第 ${i + 1} 次輪詢網路錯誤：${e.code || e.message}（下一輪再試）`);
      continue;
    }
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch {}
    if (!res.ok || data === null) {
      console.log(`\n  第 ${i + 1} 次輪詢 HTTP ${res.status}：${raw.slice(0, 120).replace(/\s+/g, " ")}（下一輪再試）`);
      continue;
    }
    const d = data.data || data;

    if (d.failure_code || d.failure_message) {
      console.error("HeyGen 回應：", JSON.stringify(data, null, 2));
      throw new Error(`HeyGen 生成失敗：${d.failure_code || ""} ${d.failure_message || ""}`.trim());
    }

    if (d.video_url) {
      console.log("");
      if (d.duration)
        // ⚠️ 對帳看這一行：計費是按「HeyGen 生成的秒數」算的，不是成品秒數 ——
        //    稍後 ffmpeg 壓掉的那 25% 是白付的（目前沒有替代方案，見 HEYGEN_VOICE_LOCALE 上方註解）。
        log(
          `HeyGen 原始輸出時長：${d.duration} 秒（加速前；${Math.floor(d.duration) * 3} 單位就是這一支的扣點）`
        );
      return d.video_url;
    }

    const status = d.status || d.state || "processing";
    process.stdout.write(`\r  狀態：${status}            `);
  }

  throw new Error(`HeyGen 等待超時（${HEYGEN_POLL_MAX / 6} 分鐘）；影片可能仍在 HeyGen 生成中，可到 HeyGen 網站確認並下載後用「現有影片」重跑`);
}

// 文字驅動的統一入口：預設 v3，加 --heygen-v2 退回 v2。
// 三個固定主播分支都呼叫這支，避免各自複製一份 create + poll。
async function generateTextDrivenVideo(scriptText, avatarId, voiceId, title) {
  if (HEYGEN_V2_FALLBACK) {
    log("⚠️ 已指定 --heygen-v2，改走舊的 /v2/videos 路徑");
    const videoId = await createHeyGenVideoTextDrivenV2(scriptText, avatarId, voiceId, title);
    return pollHeyGenStatus(videoId);
  }
  const videoId = await createHeyGenVideoTextDrivenV3(scriptText, avatarId, voiceId, title);
  return pollHeyGenStatusV3(videoId);
}

// 音訊驅動的統一入口（2026-08-24）：MiniMax 配音 → 上傳 HeyGen → audio_asset_id 對嘴。
// 固定主播三條線預設走這支；投廣模板 --minimax 走的是同一組底層函式（只是沒收斂成一支）。
// 回傳 HeyGen 的 video_url，跟 generateTextDrivenVideo() 對稱，呼叫端行為一致。
async function generateAudioDrivenVideo(scriptText, avatarId, minimaxVoiceId, title) {
  // 繁→簡：MiniMax 對簡體念法比較準。釘住 language_boost 後理論上可省，但預設維持既有行為。
  const ttsText = TO_SIMP ? tradToSimpConverter(scriptText) : scriptText;
  if (TO_SIMP) {
    log(`⚠️ 已指定 --simp，轉簡體後送 MiniMax：\n  ${ttsText}`);
  } else {
    log(`繁體直送 MiniMax（language_boost=${MINIMAX_LANGUAGE_BOOST} 釘住普通話；要轉簡體加 --simp）`);
  }

  const audioBuffer = await minimaxTTS(ttsText, minimaxVoiceId);

  // 音檔備份：出問題時可以直接聽這支判斷是配音壞了還是對嘴壞了（public/minimax.mp3 已在 .gitignore）
  const minimaxAudioPath = resolve(PROJECT_DIR, "public/minimax.mp3");
  writeFileSync(minimaxAudioPath, audioBuffer);
  log(`音檔備份 → ${minimaxAudioPath}`);

  const audioAssetId = await heygenUploadAudio(audioBuffer);

  log("⏳ 正在呼叫 HeyGen（音訊驅動對嘴），請勿重複執行此腳本...");
  log("   預計等待 3-5 分鐘，請耐心等候 ☕");
  const videoId = await createAudioDrivenVideo(audioAssetId, avatarId, title);
  return pollAudioDrivenStatus(videoId);
}

// v2 的輪詢（音訊驅動 path 與 --heygen-v2 共用，維持原樣不動）
async function pollHeyGenStatus(videoId) {
  log(`等待 HeyGen 完成（video_id: ${videoId}）`);

  // 輪詢 /v2/videos 專用的狀態端點：GET /v2/videos/{video_id}（不是舊的 v1/video_status.get）。
  // 回應 schema 防禦式解析：status 與 video_url 都試多個可能位置。
  for (let i = 0; i < HEYGEN_POLL_MAX; i++) {
    await sleep(10000); // 每 10 秒查一次

    // 2026-09-07：與 v3 同一套防禦（以前 res.json() 沒 catch，非 JSON 會直接讓整支失敗）。
    let res;
    try {
      res = await fetch(`https://api.heygen.com/v2/videos/${videoId}`, {
        headers: { "X-Api-Key": HEYGEN_API_KEY },
      });
    } catch (e) {
      console.log(`\n  第 ${i + 1} 次輪詢網路錯誤：${e.code || e.message}（下一輪再試）`);
      continue;
    }
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch {}
    if (!res.ok || data === null) {
      console.log(`\n  第 ${i + 1} 次輪詢 HTTP ${res.status}：${raw.slice(0, 120).replace(/\s+/g, " ")}（下一輪再試）`);
      continue;
    }
    const d = data.data || data;
    const status = d?.status || d?.state;
    const url = d?.video_url || d?.url || d?.output?.video_url;

    process.stdout.write(`\r  狀態：${status || "?"}            `);

    if (["completed", "success", "done", "ready"].includes(String(status))) {
      console.log("");
      if (!url) {
        console.error("HeyGen 完成但找不到 video_url：", JSON.stringify(data, null, 2));
        throw new Error("HeyGen 完成但解析不到下載連結");
      }
      return url;
    }

    if (["failed", "error"].includes(String(status))) {
      throw new Error(`HeyGen 生成失敗：${JSON.stringify(data)}`);
    }
  }

  throw new Error(`HeyGen 等待超時（${HEYGEN_POLL_MAX / 6} 分鐘）；影片可能仍在 HeyGen 生成中，可到 HeyGen 網站確認並下載後用「現有影片」重跑`);
}

async function downloadVideo(url, destPath) {
  log(`下載影片到 ${destPath}`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`下載失敗：${res.status}`);

  const buffer = await res.arrayBuffer();
  writeFileSync(destPath, Buffer.from(buffer));
  log("下載完成！");
}

// ── 雙人 path 主流程 ──────────────────────
// 平行跑 N 段 MiniMax + N 段 HeyGen + ffmpeg concat → 輸出 outputMp4Path（即 public/heygen.mp4）
// 加速 125% 由 main() 統一處理、跟單人 path 共用
// 段間銜接策略：頭尾不 trim（驗證過、加速 125% 後段尾停頓感自然消化）
async function runDualPath(segments, pair, outputMp4Path) {
  const fs = require("fs");
  const path = require("path");

  log(`\n=== 雙人 path ===`);
  log(`配對：A=${pair.A} / B=${pair.B}`);
  log(`段數：${segments.length}`);
  for (const [i, s] of segments.entries()) {
    log(`  段 ${i + 1} [${s.role}] ${s.text}`);
  }

  const tmpDir = path.resolve(WORKSPACE_ROOT, ".dual-tmp");
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  // Step 1–3。2026-08-17 起預設走 HeyGen 內建語音（文字驅動）：
  // 每段一次 API 呼叫就出影片，不必先 MiniMax 配音再上傳音檔，少兩個步驟也少一組 key。
  // 加 --minimax 退回原本的三步（MiniMax 配音 → upload → 音訊驅動）。
  let segMp4s;

  if (USE_MINIMAX) {
    // Step 1: MiniMax 配音 + upload HeyGen（平行）
    log("\n--- Step 1: MiniMax 配音 + upload HeyGen（平行） ---");
    const audioAssets = await Promise.all(
      segments.map(async (seg, i) => {
        const simpText = TO_SIMP ? tradToSimpConverter(seg.text) : seg.text;
        const mp3 = await minimaxTTS(simpText, DUAL_VOICES[seg.role]);
        const mp3Path = path.resolve(tmpDir, `seg-${i + 1}-${seg.role}.mp3`);
        fs.writeFileSync(mp3Path, mp3);
        const assetId = await heygenUploadAudio(mp3);
        log(`  段 ${i + 1} [${seg.role}] mp3 + upload OK → ${assetId}`);
        return { ...seg, assetId };
      })
    );

    // Step 2: HeyGen generate（平行）
    log("\n--- Step 2: HeyGen generate 各段（平行） ---");
    const videoIds = await Promise.all(
      audioAssets.map(async (seg, i) => {
        const vid = await createAudioDrivenVideo(
          seg.assetId,
          pair[seg.role],
          `marketing-auto-dual-${i + 1}${seg.role}`
        );
        log(`  段 ${i + 1} [${seg.role}] video_id = ${vid}`);
        return { ...seg, videoId: vid };
      })
    );

    // Step 3: 輪詢 + 下載（平行）
    log("\n--- Step 3: 輪詢 + 下載 各段 mp4（平行） ---");
    segMp4s = await Promise.all(
      videoIds.map(async (seg, i) => {
        const url = await pollAudioDrivenStatus(seg.videoId);
        const mp4Path = path.resolve(tmpDir, `seg-${i + 1}-${seg.role}.mp4`);
        await downloadVideo(url, mp4Path);
        log(`  段 ${i + 1} 下載 OK`);
        return mp4Path;
      })
    );
  } else {
    // Step 1–3 合併：HeyGen 文字驅動，各段平行（繁中直送，不轉簡體）
    log("\n--- Step 1-3: HeyGen 文字驅動生成 + 下載 各段（平行、不經 MiniMax） ---");
    log(`  聲音：A=${HEYGEN_DUAL_VOICES.A} / B=${HEYGEN_DUAL_VOICES.B}`);
    segMp4s = await Promise.all(
      segments.map(async (seg, i) => {
        const url = await generateTextDrivenVideo(
          seg.text,
          pair[seg.role],
          HEYGEN_DUAL_VOICES[seg.role],
          `marketing-auto-dual-${i + 1}${seg.role}`
        );
        const mp4Path = path.resolve(tmpDir, `seg-${i + 1}-${seg.role}.mp4`);
        await downloadVideo(url, mp4Path);
        log(`  段 ${i + 1} [${seg.role}] 生成 + 下載 OK`);
        return mp4Path;
      })
    );
  }

  // Step 4: ffmpeg concat（強制重編碼，避免段邊界吃幀；驗證階段確認過）
  log("\n--- Step 4: ffmpeg concat ---");
  const concatListPath = path.resolve(tmpDir, "concat-list.txt");
  fs.writeFileSync(concatListPath, segMp4s.map((p) => `file '${p}'`).join("\n"));
  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c:v libx264 -c:a aac -pix_fmt yuv420p "${outputMp4Path}"`,
    { cwd: PROJECT_DIR, stdio: "inherit" }
  );
  log(`✅ 雙人 concat 完成 → ${outputMp4Path}`);
}

// ── 主流程 ────────────────────────────────

async function main() {
  // 0. 防止重複執行
  const lockFile = resolve(WORKSPACE_ROOT, ".run.lock");
  if (existsSync(lockFile)) {
    console.error("❌ 偵測到腳本已在執行中！請等待完成再跑。");
    console.error(`   鎖檔位置：${lockFile}（確認沒有產線執行後才移除）`);
    process.exit(1);
  }
  writeFileSync(lockFile, String(Date.now()));
  process.on("exit", () => { try { require("fs").unlinkSync(lockFile); } catch(e) {} });
  // 被終止（關終端機=SIGHUP、Ctrl+C=SIGINT、kill=SIGTERM）時也清 .run.lock。
  // 注意：這不會讓生成繼續——關視窗 run.js 一樣會死、新 heygen.mp4 不會下載；
  // 只是死得乾淨、不留 lock 卡住下一次執行。
  for (const sig of ["SIGHUP", "SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      console.error(`\n⚠️ 收到 ${sig}（終端機被關/手動中斷），本次生成中止，清理 .run.lock`);
      process.exit(1); // 觸發上面的 exit handler → 刪 lock
    });
  }

  // --render-only：前台已經把配圖計畫確認過了，直接出片。
  // 不重跑 HeyGen／加速／轉字幕／OCR —— 那些的產物都還在 public/ 與 src/*.generated.json。
  if (RENDER_ONLY) {
    log("▶️  --render-only：沿用現有 public/ 與配圖計畫，直接 render");
    renderTemplate();
    return;
  }

  // 0. 檢查環境（--skip-generate 不會呼叫 HeyGen/MiniMax，不需要這些 key）
  if (!SKIP_GENERATE) {
    if (!HEYGEN_API_KEY) {
      console.error("❌ 缺少 HEYGEN_API_KEY（請填到 .env）");
      process.exit(1);
    }
    // 需要 MiniMax key 的兩種情況：
    //   ① 投廣模板／雙人 path 加了 --minimax（2026-08-17 起那兩條線預設走 HeyGen 內建語音）
    //   ② 三大法人／焦點股日報（2026-08-24 起預設走 MiniMax 配音，除非加 --heygen-voice）
    //      大盤小報／盤中焦點 2026-09-11 起預設 HeyGen 內建語音，不在此列（除非加 --minimax）
    const needMinimax = USE_MINIMAX || FIXED_ANCHOR_USE_MINIMAX;
    if (needMinimax && (!MINIMAX_API_KEY || !MINIMAX_GROUP_ID)) {
      console.error("❌ 缺少 MINIMAX_API_KEY 或 MINIMAX_GROUP_ID（請填到 .env）");
      console.error(
        FIXED_ANCHOR_USE_MINIMAX
          ? "   三大法人／焦點股日報 2026-08-24 起預設用 MiniMax 配音（大盤小報／盤中焦點 2026-09-11 起已改回 HeyGen 內建語音）。\n   不想加 key 的話，指令加 --heygen-voice 退回 HeyGen 內建語音。"
          : "   指定了 --minimax 就需要這兩個 key。"
      );
      process.exit(1);
    }
  }

  const scriptPath = resolve(PROJECT_DIR, "public/script.txt");
  if (!existsSync(scriptPath)) {
    console.error("❌ 找不到 public/script.txt");
    process.exit(1);
  }

  const templateLabel =
    TEMPLATE === "dapan" ? "📰 大盤小報"
    : TEMPLATE === "institution" ? "🏦 三大法人"
    : TEMPLATE === "focusstock" ? "🔍 焦點股日報"
    : TEMPLATE === "midday" ? "⏱ 盤中焦點"
    : "🎬 預設（起漲K線／籌碼K線投廣模板）";
  log(`版型：${templateLabel}${SKIP_GENERATE ? "（跳過生成，用現有 public/heygen.mp4）" : ""}`);

  // 先清掉 public/ 裡「非當前版型」的殘留素材，維持精簡（源頭都在 共用素材/，可再複製回來）
  cleanStaleStaging(PROJECT_DIR, TEMPLATE);

  // 固定主播版型：先把套版素材（intro-frame.jpg / header-overlay.png / bgm.wav）複製進 public/
  if (TEMPLATE === "default" && BRAND) {
    log(`複製投廣品牌素材：${BRAND}`);
    run(`node scripts/use-brand.js "${BRAND}"`);
  } else if (TEMPLATE === "dapan") {
    log("複製大盤小報套版素材");
    run("npm run use-dapan-assets");
  } else if (TEMPLATE === "midday") {
    log("複製盤中焦點套版素材");
    run("npm run use-midday-assets");
  } else if (TEMPLATE === "institution") {
    log("複製三大法人套版素材");
    run("npm run use-institution-assets");
  } else if (TEMPLATE === "focusstock") {
    log("複製焦點股日報套版素材（客製版）");
    run("npm run use-focusstock-assets");
    if (WITH_AD) {
      log("複製籌碼K線投廣素材（外框／片尾／BGM）");
      run("npm run use-focusstock-ad-assets");
    }
  }

  const heygenPath = resolve(PROJECT_DIR, "public/heygen.mp4");

  // 圖片 OCR 版面偵測：不需要講者影片，先啟動，跟 HeyGen 生成平行跑（省下等待時間、
  // 且圖有問題時馬上就知道，不會等到影片生完才發現）。稍後在需要它的步驟前 await。
  const imageAnalysis = startImageAnalysis();

  if (SKIP_GENERATE) {
    // ── 跳過生成：直接用現有 public/heygen.mp4，不呼叫 HeyGen/MiniMax ──
    if (!existsSync(heygenPath)) {
      console.error("❌ --skip-generate 但找不到 public/heygen.mp4，請先手動放好影片檔");
      process.exit(1);
    }
    log("✅ 找到現有 public/heygen.mp4，跳過 HeyGen/MiniMax 生成");
  } else {
    await generateHeygenVideo(heygenPath);
  }

  // 自動備份：在「加速之前」先存檔，這樣原始速度的影片永遠救得回來。
  // （2026-08-12 踩到：備份排在加速之後，重跑兩次就把 72.5 秒的原檔洗成 50.4 秒且無法還原。）
  try {
    backupJob(PROJECT_DIR, TEMPLATE, WORKSPACE_ROOT);
  } catch (e) {
    log("⚠️ 自動備份失敗（不影響出片）：" + e.message);
  }

  // 固定主播版型（大盤小報／三大法人／焦點股日報／盤中焦點）加速 125%（保持音調）── 使用者定案：無論影片來源
  // （HeyGen 現生 or --skip-generate 手動放）都要套用。
  // 這是固定主播三條線「唯一」的加速點，generateHeygenVideo() 末尾那段已用 !FIXED_ANCHOR_TEMPLATE 擋掉。
  // 2026-08-17：原本這裡是 120%、而 generateHeygenVideo() 只擋 dapan，導致 institution／focusstock
  // 被連續加速兩次（1.25 × 1.2 ≒ 1.5 倍），講話斷句被壓爛。現統一成單次 125%。
  if (FIXED_ANCHOR_TEMPLATE && NO_SPEED) {
    log("⏩ 已指定 --no-speed，跳過 125% 加速（保留原始速度）");
  } else if (FIXED_ANCHOR_TEMPLATE) {
    speedUpHeygen(heygenPath, "固定主播版型");
  }

  // 收斂平行進行的圖片分析（通常在等 HeyGen 時就跑完了，這裡多半是立刻返回）
  if (imageAnalysis) {
    const r = await imageAnalysis;
    if (r.ok) {
      const tail = r.stdout.trim().split("\n").slice(-6).join("\n");
      log("✅ 版面偵測完成（與生成平行）：\n" + tail);
    } else {
      log("⚠️ 版面偵測失敗，沿用既有 regions（影片照樣出）。");
      log("   若要聚焦/高亮對位正確，Mac 請先安裝一次：brew install tesseract tesseract-lang");
    }
  }

  // 6. 跑 Remotion 後製（transcribe / correct-subtitles 兩版型共用；parse-script / 配圖 / render 各自版本）
  log("開始 Remotion 後製");
  run("npm run transcribe");
  run("npm run correct-subtitles");
  prepareShots();

  if (STOP_BEFORE_RENDER) {
    log("⏸  已指定 --stop-before-render：配圖計畫算好了，這裡停下不 render。");
    log("   前台會把計畫拿去給人看，確認後再用 --render-only 接著跑。");
    return;
  }
  renderTemplate();
}

/**
 * 解析腳本 ＋ 算配圖／聚焦計畫（會寫出 *-shots.generated.json 或 focus 設定）。
 * 抽出來是為了讓「算計畫」與「render」可以分兩次執行——前台要在中間插入人工確認關卡。
 * ⚠️ 手寫標記優先的規則不變：(shot:) / (imageN) / (focus:) 標到的段落自動一律不碰。
 */
function prepareShots() {
  if (TEMPLATE === "dapan") {
    run("npm run parse-script:dapan");
    try {
      run("npm run auto-shot:dapan");
    } catch (e) {
      log("⚠️ 自動配圖失敗（不影響出片，只是這支不會插圖）：" + e.message);
    }
  } else if (TEMPLATE === "midday") {
    run("npm run parse-script:midday");
    try {
      run("npm run auto-shot:midday");
    } catch (e) {
      log("⚠️ 自動配圖失敗（不影響出片，只是這支不會插圖）：" + e.message);
    }
  } else if (TEMPLATE === "institution") {
    run("npm run parse-script:institution");
    // 自動聚焦：不用在 script.txt 標注，程式比對「旁白數字 ↔ 圖上數字」自己決定
    // 哪一句要聚焦哪一區、框哪一格。手寫的 (focus:) 標記優先，自動只補其餘句子。
    try {
      run("npm run auto-focus");
    } catch (e) {
      log("⚠️ 自動聚焦失敗（不影響出片，只是這支不會有聚焦效果）：" + e.message);
    }
  } else if (TEMPLATE === "focusstock") {
    run("npm run parse-script:focusstock");
    try {
      run("npm run auto-shot");
    } catch (e) {
      log("⚠️ 自動配圖失敗（不影響出片，只是這支不會插圖）：" + e.message);
    }
  } else {
    run("npm run parse-script");
    try {
      run("npm run auto-shot:default");
    } catch (e) {
      log("⚠️ 自動配圖失敗（不影響出片，只是這支不會插圖）：" + e.message);
    }
  }
}

/** 只做 render。--render-only 會直接跳到這裡，沿用現有的 public/ 與 *.generated.json。 */
function renderTemplate() {
  if (TEMPLATE === "dapan") {
    // 同一份 heygen/字幕/腳本出兩支：直式先出，橫式後出（2026-08-10 使用者拍板）
    run("npm run render:dapan");
    log("✅ 直式完成！90_系統/暫存/產線輸出/output-dapan.mp4");
    run("npm run render:dapan-landscape");
    log("✅ 完成！直式 90_系統/暫存/產線輸出/output-dapan.mp4、橫式 90_系統/暫存/產線輸出/output-dapan-landscape.mp4");
  } else if (TEMPLATE === "midday") {
    // 盤中焦點只出直式（2026-08-31 使用者定案「只出直式」），沒有橫式那一支
    run("npm run render:midday");
    log("✅ 完成！輸出影片在 90_系統/暫存/產線輸出/output-midday.mp4");
  } else if (TEMPLATE === "institution") {
    run("npm run render:institution");
    log("✅ 完成！輸出影片在 90_系統/暫存/產線輸出/output-institution.mp4");
  } else if (TEMPLATE === "focusstock") {
    // 同一份 heygen／字幕／腳本出兩支（2026-08-11 使用者定案）：
    //   客製版 = 藍色版型＋開場卡；投廣版 = 籌碼K線外框＋片尾、無開場卡。
    run("npm run render:focusstock");
    if (WITH_AD) {
      run("npm run render:focusstock-ad");
      log("✅ 完成！客製版 90_系統/暫存/產線輸出/output-focusstock.mp4、投廣版 90_系統/暫存/產線輸出/output-focusstock-ad.mp4");
    } else {
      log("✅ 完成！90_系統/暫存/產線輸出/output-focusstock.mp4（只出客製版；要投廣版請加 --with-ad）");
    }
  } else {
    run("npm run render");
    log("✅ 完成！輸出影片在 90_系統/暫存/產線輸出/output.mp4");
  }
}

/**
 * 呼叫 HeyGen/MiniMax 生成 heygen.mp4（含單人/雙人偵測、125% 加速）。
 * 只在 !SKIP_GENERATE 時呼叫，抽出來讓 main() 的兩條路（生成 / 跳過生成）分岔更清楚。
 */
async function generateHeygenVideo(heygenPath) {
  const scriptPath = resolve(PROJECT_DIR, "public/script.txt");
  // 1. 讀取腳本 + 偵測單人/雙人模式（大盤小報固定單人，不偵測）
  log("讀取 script.txt");
  const rawScript = readFileSync(scriptPath, "utf-8");
  const voiceRules = parseVoiceReplacements(rawScript);
  const mode = FIXED_ANCHOR_TEMPLATE ? "solo" : detectMode(rawScript);
  log(`偵測模式：${mode === "dual" ? "🎭 雙人對話（含 [A]/[B] 標記）" : "🎤 單人講話"}`);

  if (mode === "dual") {
    // ── 雙人 path：切段 + N × MiniMax + N × HeyGen + ffmpeg concat ──
    const segments = splitByRole(rawScript, voiceRules);
    if (segments.length === 0) {
      console.error("❌ 雙人模式但切不出任何段。請檢查 script.txt 的 [A]/[B] 標記");
      process.exit(1);
    }
    const pair = randomPair();
    log("⏳ 雙人模式：N 段平行跑，請勿重複執行此腳本...");
    log("   預計等待 3-5 分鐘，請耐心等候 ☕");
    await runDualPath(segments, pair, heygenPath);
  } else if (TEMPLATE === "dapan") {
    // ── 大盤小報單人 path：預設 MiniMax 配音 + HeyGen 音訊驅動對嘴 ──
    //    加 --heygen-voice 才走 HeyGen 內建語音的文字驅動（script + voice_id）。
    if (!FIXED_ANCHOR_USE_MINIMAX && !DAPAN_HEYGEN_VOICE_ID) {
      console.error("❌ 大盤小報要用 HeyGen 內建語音，但 DAPAN_HEYGEN_VOICE_ID 還是空值。");
      console.error("   去 HeyGen 後台「Voice Library」或呼叫 GET https://api.heygen.com/v3/voices 找一個中文女聲 voice_id，填進 run.js 的 DAPAN_HEYGEN_VOICE_ID 常數。");
      process.exit(1);
    }
    let cleanedScript = cleanScript(rawScript);
    for (const rule of voiceRules) {
      cleanedScript = cleanedScript.split(rule.from).join(rule.to);
    }
    log(`清洗後腳本（繁）：\n  ${cleanedScript}`);

    log(`固定 avatar（大盤小報）：${DAPAN_AVATAR.id}`);

    let videoUrl;
    if (FIXED_ANCHOR_USE_MINIMAX) {
      log(`配音來源：MiniMax voice ${MINIMAX_FIXED_ANCHOR_VOICES.dapan}`);
      videoUrl = await generateAudioDrivenVideo(cleanedScript, DAPAN_AVATAR.id, MINIMAX_FIXED_ANCHOR_VOICES.dapan, "marketing-auto-dapan");
    } else {
      log("⏳ 正在呼叫 HeyGen（文字驅動），請勿重複執行此腳本...");
      log("   預計等待 3-5 分鐘，請耐心等候 ☕");
      videoUrl = await generateTextDrivenVideo(cleanedScript, DAPAN_AVATAR.id, DAPAN_HEYGEN_VOICE_ID, "marketing-auto-dapan");
    }
    await downloadVideo(videoUrl, heygenPath);
  } else if (TEMPLATE === "midday") {
    // ── 盤中焦點單人 path：跟大盤小報同一套（預設 MiniMax 配音 + HeyGen 音訊驅動對嘴）──
    //    avatar 與聲音都是自己的（MiniMax、HeyGen 兩邊的聲音 2026-09-11 起都不再沿用大盤小報那一支）。
    if (!FIXED_ANCHOR_USE_MINIMAX && !MIDDAY_HEYGEN_VOICE_ID) {
      console.error("❌ 盤中焦點要用 HeyGen 內建語音，但 MIDDAY_HEYGEN_VOICE_ID 還是空值。");
      console.error("   去 HeyGen 後台「Voice Library」或呼叫 GET https://api.heygen.com/v3/voices 找一個中文女聲 voice_id，填進 run.js 的 MIDDAY_HEYGEN_VOICE_ID 常數。");
      process.exit(1);
    }
    let cleanedScript = cleanScript(rawScript);
    for (const rule of voiceRules) {
      cleanedScript = cleanedScript.split(rule.from).join(rule.to);
    }
    log(`清洗後腳本（繁）：\n  ${cleanedScript}`);

    log(`固定 avatar（盤中焦點）：${MIDDAY_AVATAR.id}`);

    let videoUrl;
    if (FIXED_ANCHOR_USE_MINIMAX) {
      log(`配音來源：MiniMax voice ${MINIMAX_FIXED_ANCHOR_VOICES.midday}`);
      videoUrl = await generateAudioDrivenVideo(cleanedScript, MIDDAY_AVATAR.id, MINIMAX_FIXED_ANCHOR_VOICES.midday, "marketing-auto-midday");
    } else {
      log("⏳ 正在呼叫 HeyGen（文字驅動），請勿重複執行此腳本...");
      log("   預計等待 3-5 分鐘，請耐心等候 ☕");
      videoUrl = await generateTextDrivenVideo(cleanedScript, MIDDAY_AVATAR.id, MIDDAY_HEYGEN_VOICE_ID, "marketing-auto-midday");
    }
    await downloadVideo(videoUrl, heygenPath);
  } else if (TEMPLATE === "institution") {
    // ── 三大法人單人 path：跟大盤小報同一套（預設 MiniMax 配音 + HeyGen 音訊驅動對嘴）──
    if (!FIXED_ANCHOR_USE_MINIMAX && !INSTITUTION_HEYGEN_VOICE_ID) {
      console.error("❌ 三大法人要用 HeyGen 內建語音，但 INSTITUTION_HEYGEN_VOICE_ID 還是空值。");
      console.error("   去 HeyGen 後台「Voice Library」或呼叫 GET https://api.heygen.com/v3/voices 找一個中文女聲 voice_id，填進 run.js 的 INSTITUTION_HEYGEN_VOICE_ID 常數。");
      process.exit(1);
    }
    let cleanedScript = cleanScript(rawScript);
    for (const rule of voiceRules) {
      cleanedScript = cleanedScript.split(rule.from).join(rule.to);
    }
    log(`清洗後腳本（繁）：\n  ${cleanedScript}`);

    log(`固定 avatar（三大法人）：${INSTITUTION_AVATAR.id}`);

    let videoUrl;
    if (FIXED_ANCHOR_USE_MINIMAX) {
      log(`配音來源：MiniMax voice ${MINIMAX_FIXED_ANCHOR_VOICES.institution}`);
      videoUrl = await generateAudioDrivenVideo(cleanedScript, INSTITUTION_AVATAR.id, MINIMAX_FIXED_ANCHOR_VOICES.institution, "marketing-auto-institution");
    } else {
      log("⏳ 正在呼叫 HeyGen（文字驅動），請勿重複執行此腳本...");
      log("   預計等待 3-5 分鐘，請耐心等候 ☕");
      videoUrl = await generateTextDrivenVideo(cleanedScript, INSTITUTION_AVATAR.id, INSTITUTION_HEYGEN_VOICE_ID, "marketing-auto-institution");
    }
    await downloadVideo(videoUrl, heygenPath);
  } else if (TEMPLATE === "focusstock") {
    // ── 焦點股日報單人 path：同大盤小報／三大法人（預設 MiniMax 配音 + HeyGen 音訊驅動對嘴）──
    if (!FIXED_ANCHOR_USE_MINIMAX && !FOCUSSTOCK_HEYGEN_VOICE_ID) {
      console.error("❌ 焦點股日報要用 HeyGen 內建語音，但 FOCUSSTOCK_HEYGEN_VOICE_ID 還是空值。");
      process.exit(1);
    }
    let cleanedScript = cleanScript(rawScript);
    for (const rule of voiceRules) {
      cleanedScript = cleanedScript.split(rule.from).join(rule.to);
    }
    log(`清洗後腳本（繁）：\n  ${cleanedScript}`);
    log(`固定 avatar（焦點股日報）：${FOCUSSTOCK_AVATAR.id}`);

    let videoUrl;
    if (FIXED_ANCHOR_USE_MINIMAX) {
      log(`配音來源：MiniMax voice ${MINIMAX_FIXED_ANCHOR_VOICES.focusstock}`);
      videoUrl = await generateAudioDrivenVideo(cleanedScript, FOCUSSTOCK_AVATAR.id, MINIMAX_FIXED_ANCHOR_VOICES.focusstock, "marketing-auto-focusstock");
    } else {
      log("⏳ 正在呼叫 HeyGen（文字驅動），請勿重複執行此腳本...");
      log("   預計等待 3-5 分鐘，請耐心等候 ☕");
      videoUrl = await generateTextDrivenVideo(cleanedScript, FOCUSSTOCK_AVATAR.id, FOCUSSTOCK_HEYGEN_VOICE_ID, "marketing-auto-focusstock");
    }
    await downloadVideo(videoUrl, heygenPath);
  } else {
    // ── 單人 path（投廣模板）──
    // 2026-08-17 起預設走 HeyGen 內建語音（文字驅動），跟固定主播三條線同一條路。
    // 加 --minimax 可退回原本的「MiniMax 配音 + HeyGen 音訊驅動」。
    let cleanedScript = cleanScript(rawScript);
    for (const rule of voiceRules) {
      cleanedScript = cleanedScript.split(rule.from).join(rule.to);
    }

    const avatar = randomAvatar();

    if (USE_MINIMAX) {
      log(`清洗後腳本（繁）：\n  ${cleanedScript}`);
      log(`抽到 avatar：${avatar.id}（${avatar.gender === "male" ? "男" : "女"}）`);
      // 2026-08-24：這段原本自己攤開寫（繁→簡 → minimaxTTS → 備份 → upload → 音訊驅動），
      // 現在收斂成 generateAudioDrivenVideo()，跟固定主播三條線共用同一支，行為不變。
      const videoUrl = await generateAudioDrivenVideo(
        cleanedScript,
        avatar.id,
        SOLO_VOICES[avatar.gender],
        "marketing-auto"
      );
      await downloadVideo(videoUrl, heygenPath);
    } else {
      log(`清洗後腳本（繁，直接送 HeyGen，不轉簡體、不經 MiniMax）：\n  ${cleanedScript}`);
      // 跟 MiniMax 時代一樣：抽到的 avatar 性別決定配音，只是 voice 換成 HeyGen 的。
      const heygenVoiceId = HEYGEN_SOLO_VOICES[avatar.gender];
      log(`抽到 avatar：${avatar.id}（${avatar.gender === "male" ? "男" : "女"}）→ HeyGen voice ${heygenVoiceId}`);

      log("⏳ 正在呼叫 HeyGen（文字驅動），請勿重複執行此腳本...");
      log("   預計等待 3-5 分鐘，請耐心等候 ☕");
      const videoUrl = await generateTextDrivenVideo(
        cleanedScript,
        avatar.id,
        heygenVoiceId,
        "marketing-auto"
      );
      await downloadVideo(videoUrl, heygenPath);
    }
  }

  // 加速 heygen.mp4 125%（保持音調）── 既有投廣模板（default）專用
  // 固定主播四條線（dapan／institution／focusstock／midday）在 main() 內統一加速，這裡一律擋掉，
  // 避免同一支影片被加速兩次。2026-08-17 修正：原本只擋 dapan，institution／focusstock 漏網。
  if (!FIXED_ANCHOR_TEMPLATE && NO_SPEED) {
    log("⏩ 已指定 --no-speed，跳過 125% 加速（保留原始速度）");
  } else if (!FIXED_ANCHOR_TEMPLATE) {
    speedUpHeygen(heygenPath, "投廣模板");
  }
}

main().catch((err) => {
  console.error("\n❌ 錯誤：", err.message);
  process.exit(1);
});
