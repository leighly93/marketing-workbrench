// MiniMax 配音 A/B 測試 —— 獨立腳本，完全不碰 run.js、不覆蓋任何 public/ 或 src/ 產物。
// 用法：node scripts/tts-ab.js [--voice=focusstock] [--model=speech-2.8-hd] [--dict]
//   --voice= focusstock | dapan | midday | institution | male   （預設 focusstock）
//   --voice-id= 直接給 moss_audio_… 原始 id（測還沒進 VOICES 表的新聲音；覆蓋 --voice）
//   --voice-tag= 檔名標籤，只在用 --voice-id 時有意義（預設取 id 尾碼 8 碼）
//   --text-file= 用外部檔案當稿子（覆蓋 --text；真實文案用這個，不要塞命令列）
//   --model= 任一 MiniMax T2A 模型                              （預設 speech-2.8-hd）
//            2026-09-11 拿本帳號的 key 逐一打 t2a_v2 實測，可用的只有這 8 個：
//              speech-01-hd / speech-01-turbo / speech-02-hd / speech-02-turbo
//              speech-2.6-hd / speech-2.6-turbo / speech-2.8-hd / speech-2.8-turbo
//            ✗ speech-2.5-hd-preview / speech-2.5-turbo-preview → 2061「token plan not support」（方案沒開）
//            ✗ speech-2.7-hd / speech-2.7-turbo → 2013「t2a-v2 not have model」（**根本沒這個世代**；
//              帶 emotion 時它會先回「不支援 emotion」，那訊息會誤導人以為模型存在，別被騙）
//            hd＝音質優先、turbo＝便宜快。聲音本身來自 voice_id（clone），換世代換的是音質與斷句。
//   --text=  c（精簡驗證稿，字典 25 條全命中）| a（原始測試稿）| b（第一版驗證稿）
//            | d（數字驗證稿，測 --tn）| e（腔調候選稿，測還沒進字典的兩岸差異字）  預設 c
//   --dict   加上才會送發音字典；預設「不送」
//   --trad-only  只出繁體版，不出簡體版
//   --tn     送 voice_setting.text_normalization=true（數字正規化，預設 false）
//   --mix=   timbre_weights 混音，語法 `voice:權重,voice:權重`（最多 4 個、權重 1~100）
//            例：--mix=focusstock:70,institution:30
//   --pause  保留稿子裡的 `<#秒數#>` 停頓標記；**不加就整批剝掉**（＝同一份稿的對照組）
//   --numfix 送 TTS 前把「年份」與「股號」轉成中文數字（只動送 TTS 的那份，字幕不受影響）
//   --pause-scale=0.5  把稿子裡所有停頓秒數乘上這個倍率（配 --pause 用，調長短不必改稿）
//   --emotion= happy|sad|angry|fearful|disgusted|surprised|calm|fluent|whisper
//              不送＝MiniMax 依文字自動挑（＝目前產線行為，實測偏平）
// 每跑一次出兩支：繁體直送 vs opencc 轉簡體後送，其餘參數完全一致。
// 輸出：out/tts-ab/<model>_<voice>_<dict|nodict>_<trad|simp>.mp3

const { workspaceRoot } = require('../../paths');
const path = require('path');
const APP_ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(workspaceRoot(APP_ROOT), '.env'), quiet: true });
const fs = require("fs");
const OpenCC = require("opencc-js");

const API_KEY = process.env.MINIMAX_API_KEY;
const GROUP_ID = process.env.MINIMAX_GROUP_ID;
if (!API_KEY || !GROUP_ID) {
  console.error("❌ 讀不到 MINIMAX_API_KEY / MINIMAX_GROUP_ID（.env 或 shell export）");
  process.exit(1);
}

// 與 run.js 的 MINIMAX_FIXED_ANCHOR_VOICES 對齊（同 DICT 的規矩：一邊換了另一邊要跟上，
// 不然這支測的是舊聲音，聽出來的結論套不回產線）。male 是雙人 path 的 B，產線表裡沒有。
const VOICES = {
  focusstock:  "moss_audio_3a75102e-54db-11f1-981b-8a143315d498",
  dapan:       "moss_audio_b47d71d2-ada4-11f1-8900-9edb4a3ef07d", // 2026-09-11 換，原 e9e9da93…
  midday:      "moss_audio_f85dc873-ada4-11f1-a626-8a59b47fb1f9", // 2026-09-11 換，原本與 dapan 共用 e9e9da93…
  institution: "moss_audio_ad826960-9f57-11f1-8aea-1268c6bb306c",
  male:        "moss_audio_44ce6b04-5a39-11f1-981b-8a143315d498",
};

// 發音字典 —— 與 run.js 的 MINIMAX_PRONUNCIATION_DICT 保持一字不差（含順序）。
// 改這裡就要同步改 run.js，反之亦然；不同步的話這支腳本就失去比對意義。
// （2026-09-01 使用者在 speech-2.8-hd 上逐條聽過的結果）
// 結論：2.8 對台灣讀音沒有比較好 —— 驗證稿 16 條裡 10 條讀成大陸音。字典是必要組件。
//
// ⚠️ 排序規則（2026-09-01 改）：**一律長詞在前、單字在後**。
//    原因：09-01 實測「瓶頸」在字典裡有 "頸/(jing3)" 的情況下**仍然唸錯**，而該條剛好排在
//    全表最後一條。兩個可能：①MiniMax 做最長匹配，單字條目蓋不到詞 ②字典條數有上限、
//    後面的被靜默丟掉。兩個猜測都指向同一個對策：重要的、詞級的往前排。
//    所以「瓶頸」改成詞級 "瓶頸/(ping2)(jing3)" 並往前移，單字 "頸/(jing3)" 留著當備援。
//
// 標記：✅＝2.8 實測唸錯、非修不可　📌＝2.8 唸對，使用者要求釘住（刪了不會修好任何東西）
const DICT = [
  // ── 詞級（長→短）──
  "期貨淨空/(qi2)(huo4)(jing4)(kong1)", // 📌
  "穎崴/影威",           // ✅ 公司名直接換字。若語法被靜默忽略，改成 "穎崴/(ying3)(wei1)"
  "瓶頸/(ping2)(jing3)", // ✅ 09-01 實測：單字條目蓋不到，改詞級並前移
  "收斂/(shou1)(lian4)", // ✅ 台 ㄌㄧㄢˋ 四聲／陸「敛」liǎn 三聲
  "意識/(yi4)(shi4)",    // ✅ 使用者：「都是四聲」。陸「意识」讀 yì shí
  "期貨/(qi2)(huo4)",    // 📌
  "繼續/(ji4)(xu4)",     // 📌

  // ── 單字級 ──
  "載/(zai3)",  // ✅ 載板→宰板、下載→ㄒㄧㄚˋㄗㄞˇ。台灣一律三聲
  "跌/(die2)",  // ✅ 下跌→下碟
  "矽/(xi4)",   // ✅ 旺矽→旺細、矽晶圓→細晶圓。⚠️ 真風險是唸成ㄍㄨㄟ（陸用「硅gui1」），必留
  "銦/(yin1)",  // ✅ 磷化銦→磷化因
  "識/(shi4)",  // ✅ 知識、認識、辨識、常識。⚠️ 例外：標識 台灣讀ㄓˋ
  "檔/(dang3)", // ✅ 一檔個股→一挡個股。台灣三聲ㄉㄤˇ／陸「档」dàng 四聲。
                //    單字級是安全的：使用者 09-01 確認「高檔／低檔／檔期」也都是三聲
  "企/(qi4)",   // ✅ 企業
  "擊/(ji2)",   // ✅ 衝擊
  "曝/(pu4)",   // ✅ 曝險
  "液/(yi4)",   // ✅ 液晶
  "亞/(ya3)",   // ✅ 南亞科、亞洲
  "熟/(shou2)", // ✅ 成熟
  "攜/(xi1)",   // ✅ 攜手
  "血/(xie3)",  // ✅ 血本
  "期/(qi2)",   // 📌 台指期、長天期
  "究/(jiu4)",  // 📌 研究
  "危/(wei2)",  // 📌 危機
  "頸/(jing3)", // 📌 備援；主力是上面的 "瓶頸" 詞級條目

  // ── 已刪除，不要加回來 ──
  //    "轉/(zhuan3)"      2.8 唸對（text a 的「轉強」）
  //    "反彈/(fan3)(tan2)" 2.8 唸對（text a 的「反彈」）
];

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith("--" + n + "="));
  return a ? a.split("=")[1] : d;
};
const VOICE_KEY = arg("voice", "focusstock");
const MODEL = arg("model", "speech-2.8-hd");
const USE_DICT = process.argv.includes("--dict");
const TRAD_ONLY = process.argv.includes("--trad-only");
const USE_TN = process.argv.includes("--tn");
const USE_PAUSE = process.argv.includes("--pause");
const USE_NUMFIX = process.argv.includes("--numfix");
// --dry：只印「實際會送出去的文字」就結束，不呼叫 API、不扣字符。
// 加這個是因為 numfix 是 regex，改規則時要能離線確認有沒有誤傷。
const DRY_RUN = process.argv.includes("--dry");
// --pause-scale：2026-09-01 使用者實測 textf「停頓點非常怪」。
// 量出來的原因：我只放 5 個標記，但成品有 11 段靜音、最長 1.14 秒 ——
// **模型自己的停頓會疊在標記上面**，不是取代。所以第二輪不是改稿，是整體縮短，
// 用倍率調才能一次改全部、也才能看出「怪」是長度問題還是這條路本身不通。
// emotion：2026-09-01 使用者聽完 institution + numfix 那支後說「聲音可以，但有可能在有一點點情緒嗎？」
// 現況是**不送這個欄位**＝MiniMax 依文字內容自動挑，實測出來偏平。要有情緒得明確指定。
// ⚠️ 合法值只有下面九個，**沒有 neutral／auto**，送了會回 error 2013（run.js:548 已記）。
// ⚠️ emotion 沒有「強度」參數。voice_modify.intensity（-100~100）是另一組東西 ——
//    那是變聲器，跟 timbre_weights 一樣有把 clone 語調弄壞的風險（混音已實測「很假」），
//    要用的話單獨開一輪測，不要跟 emotion 混在一起。
const EMOTIONS = ["happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm", "fluent", "whisper"];
const EMOTION = arg("emotion", "");
if (EMOTION && !EMOTIONS.includes(EMOTION)) {
  console.error("❌ 不認得的 --emotion=" + EMOTION + "（合法值：" + EMOTIONS.join(" / ") + "；沒有 neutral／auto，送了會回 2013）");
  process.exit(1);
}

const PAUSE_SCALE = Number(arg("pause-scale", "1"));
if (!Number.isFinite(PAUSE_SCALE) || PAUSE_SCALE <= 0) {
  console.error("❌ --pause-scale 要是大於 0 的數字，收到：" + arg("pause-scale", ""));
  process.exit(1);
}

// --mix=focusstock:70,institution:30 → [{voice_id, weight}, ...]
// 官方文件：最多 4 個 voice、每個權重 1~100。權重是「相似度」不是百分比，不必加總 100。
const MIX_RAW = arg("mix", "");
const MIX = MIX_RAW
  ? MIX_RAW.split(",").map((pair) => {
      const [k, w] = pair.split(":");
      const id = VOICES[k.trim()];
      if (!id) {
        console.error("❌ --mix 裡不認得的 voice：" + k + "（可用：" + Object.keys(VOICES).join(" / ") + "）");
        process.exit(1);
      }
      const weight = Number(w);
      if (!Number.isFinite(weight) || weight < 1 || weight > 100) {
        console.error("❌ --mix 的權重要是 1~100 的整數，收到：" + w);
        process.exit(1);
      }
      return { voice_id: id, weight, _key: k.trim() };
    })
  : null;
if (MIX && MIX.length > 4) {
  console.error("❌ --mix 最多 4 個 voice，收到 " + MIX.length + " 個");
  process.exit(1);
}
// --voice-id=moss_audio_…：直接指定還沒進 VOICES 表的聲音（2026-09-11 新增）。
// 為什麼不先寫進 VOICES：新 clone 的聲音要先聽過才決定用不用，沒過關的留在表裡只會誤導人；
// 定案要進產線時再寫進 run.js 的 MINIMAX_FIXED_ANCHOR_VOICES，順手補進這張表。
// 檔名標籤預設取 id 尾碼 8 碼（--voice-tag= 可自訂），不然一次測兩支新聲音會分不出誰是誰。
const RAW_VOICE_ID = arg("voice-id", "");
const VOICE_ID = RAW_VOICE_ID || VOICES[VOICE_KEY];
const VOICE_LABEL = RAW_VOICE_ID ? (arg("voice-tag", "") || "id-" + RAW_VOICE_ID.slice(-8)) : VOICE_KEY;
if (!VOICE_ID) {
  console.error("❌ 不認得的 --voice=" + VOICE_KEY + "（可用：" + Object.keys(VOICES).join(" / ") + "；或用 --voice-id= 直接指定）");
  process.exit(1);
}

const TEXTS = {
  // c = 精簡驗證稿（2026-09-01 使用者要求「改寫短一點」）。
  //     約 105 字，但把字典 25 條**全部**至少各命中一次 —— 一支聽完就能驗完整份字典。
  //     改這段之前先跑一次看 coverage 表，不要讓任何一條掉出去（就是踩過的那個坑：
  //     舊測試稿有 16 條字根本沒出現，卻差點被當成「2.8 唸對了」刪掉）。
  c: [
    "一檔個股世芯-KY下跌，旺矽、穎崴的矽晶圓和磷化銦載板在高檔收斂。",
    "法人期貨淨空單繼續增加，研究機構認為企業有危機意識，曝險部位攜手下降。",
    "液晶面板、南亞科這些亞洲供應鏈已經成熟，衝擊產能瓶頸，投資人不必血本無歸。",
  ].join("\n"),
  // a = 使用者 09-01 提供的原始測試稿（保留，用來跟舊檔對照）
  a: [
    "連帶把ASIC、IC設計和封測一起帶上來，一檔個股世芯-KY、京元電子也同步轉強。",
    "所以這波資金不只看光通訊，也開始往設備、測試和封裝找機會。像萬潤布局光引擎相關設備，旺矽、穎崴切入CPO測試，力成、日月光也在準備相關封裝技術。",
    "接下來最重要的，就是看第四季設備能不能照進度交貨，以及現在還在驗證的產品，能不能真的變成正式訂單",
    "萬海反彈然後下跌，奇鋐長約反應調整載版。",
  ].join("\n"),
  // b = 第一版驗證稿（保留，用來跟舊檔對照）
  b: [
    "三大法人在台指期的期貨淨空單繼續增加，價差收斂，長天期資金也在觀望。",
    "研究機構認為，企業獲利受到關稅衝擊，短線有危機意識，法人曝險部位跟著下降。",
    "液晶面板、南亞科這些亞洲供應鏈已經相對成熟，兩家大廠攜手突破產能瓶頸，投資人不必擔心血本無歸。",
  ].join("\n"),
  // d = 數字驗證稿（2026-09-01 新增，專門測 --tn / text_normalization）。
  //     刻意把五種數字樣態各塞一次，而且是**同一句裡混著出現**，因為 TN 是靠上下文判斷
  //     「這串數字要當數量唸還是當代號唸」的，分開測驗不出它會不會搞混。
  //     樣態取自 jobs/*/input/script.txt 的實際分佈：
  //       ①百分比 6% 1.6%    ②小數 1.6      ③指數含千分位 45,832
  //       ④股價 663 305      ⑤⚠️股號 6915 2400（台灣唸法是逐字「六九一五」，TN 可能唸成整數）
  //       ⑥⚠️年份 2026 2027（該唸「二零二六」，TN 可能唸成「兩千零二十六」）
  //     聽的時候重點只有 ⑤⑥ 兩項 —— ①~④ 開 TN 幾乎一定變好，不用細聽。
  d: [
    "二〇二六年台股加權指數站上 45,832 點，較去年上漲 6%。",
    "2454 聯發科開在 1,205 元，3034 聯詠收 663 元，單日漲幅 1.6%。",
    "法人預估 2027 年獲利年增 8%，目標價上看 970 元。",
  ].join("\n"),
  // e = 腔調候選稿（2026-09-01 新增）。目標：**找出還沒進字典、但兩岸讀音不同的字**。
  //     這支不是驗證現有字典（那是 text c 的工作），是拿來「聽有沒有漏網之魚」的。
  //     兩類候選，都還沒進字典、都需要使用者親耳確認才可以加：
  //     ①單字聲調／韻母差異：
  //        息 台ㄒㄧˊ(xi2)／陸 xī　— 股息、消息、利息、休息（財經高頻，這條可能是最有價值的）
  //        微 台ㄨㄟˊ(wei2)／陸 wēi — 微幅、微軟
  //        括 台ㄍㄨㄚ(gua1)／陸 kuò — 包括
  //        質 台ㄓˊ(zhi2)／陸 zhì  — 品質、體質　⚠️例外：人質台灣讀ㄓˋ，真遇到再改詞級
  //     ②輕聲差異（大陸讀輕聲、台灣讀本調）—— 這一類是「腔調」聽起來像不像的關鍵之一，
  //        比單字聲調更難用耳朵指認，但一整段聽下來的違和感常常來自這裡：
  //        消息 陸 xiāoxi／台 ㄒㄧㄠ ㄒㄧˊ　時候 陸 shíhou／台 ㄕˊ ㄏㄡˋ
  //        朋友 陸 péngyou／台 ㄆㄥˊ ㄧㄡˇ　生意 陸 shēngyi／台 ㄕㄥ ㄧˋ
  //        便宜 陸 piányi／台 ㄆㄧㄢˊ ㄧˊ　　東西 陸 dōngxi／台 ㄉㄨㄥ ㄒㄧ
  e: [
    "這檔的股息殖利率不錯，消息面上利息負擔也在下降，體質和品質都算穩。",
    "包括法人在內，微幅加碼的時候不多，現在進場的東西其實不便宜。",
    "做生意的朋友都知道，休息一下比追高好。",
  ].join("\n"),
  // f = 停頓標記驗證稿（2026-09-01 新增，測 `<#x#>`）。
  //     **稿子只有這一份**：加 --pause 就保留標記，不加就被 stripPauseMarks() 剝乾淨 ——
  //     所以 A/B 兩支的「字」保證一模一樣，差異只有標記，不會像 09-01 減號那次
  //     因為兩邊輸入不一致而比錯（見 tasks.md 實測結論④）。
  //
  //     ⚠️ 標記位置的鐵則：**絕對不可以插進 pronunciation_dict 條目的中間**。
  //        字典是做字串比對的，"期貨淨空/(qi2)(huo4)(jing4)(kong1)" 這條碰到
  //        「期<#0.2#>貨淨空」就整條失效 —— 而且是**靜默失效**，聽起來只是「唸錯了」，
  //        很難聯想到是標記造成的。所以第 1 句的標記刻意放在「期貨淨空」**之前**。
  //        下面 checkPauseSafety() 會在送出前掃一次，撞到就直接擋下來。
  //
  //     四句各測一件事：
  //       ①詞邊界（0.20 秒短停）—— 這正是 "期貨淨空" 那條字典條目在側面處理的問題。
  //         使用者原本回報聽起來像「還有期｜貨淨空」，停頓落在詞中間。
  //         如果 0.20 秒的標記就能把邊界釘住，那條字典條目的**發音**部分可以留、
  //         但它兼差當詞邊界工具的角色就可以退休（拼音釘死會犧牲自然度）。
  //       ②關鍵數字前的語意停頓（0.60 秒）—— 播報體常用，現在完全做不到。
  //       ③列舉節奏（0.25 秒 ×2）—— 比對「頓號自己的停頓」夠不夠。
  //       ④句間長停（0.80 秒）—— 段落感。現在是靠句號自帶的停頓，長度不可控。
  f: [
    "三大法人還有<#0.20#>期貨淨空單繼續增加。",
    "今天最重要的數字是<#0.60#>四萬五千八百三十二點。",
    "權值股裡面<#0.25#>台積電<#0.25#>聯發科都收在最高。",
    "電子權值股整個翻紅。<#0.80#>接下來看到傳產這邊。",
  ].join("\n"),
};
// --text-file=路徑：改用外部檔案的稿子（2026-09-11 新增，用來測新聲音在**真實文案**上的表現）。
// 走檔案不走 --text=「一整段字」是因為真實文案有全形標點、驚嘆號與百分比，
// 塞進命令列很容易被 shell 咬掉一半，出來的音檔跟你以為送出去的東西不一樣。
const TEXT_FILE = arg("text-file", "");
const TEXT_ARG = arg("text", "c");
const TEXT_KEY = TEXT_FILE ? "file" : TEXT_ARG;
const TEXT = TEXT_FILE ? fs.readFileSync(TEXT_FILE, "utf8").trim() : TEXTS[TEXT_ARG];
if (!TEXT) {
  console.error("❌ 不認得的 --text=" + TEXT_ARG + "（可用：" + Object.keys(TEXTS).join(" / ") + "；或用 --text-file= 指定稿子）");
  process.exit(1);
}


// ── 減號處理：直接沿用 run.js 的 stripSpeechHyphens()（commit 5d81808, 2026-09-01）──
// ⚠️ 這不是新發明。正式產線的 cleanScript() 早就會刪減號了，是**這支測試腳本**
//    一開始沒做同樣的清洗，才會出現「世芯-KY 被唸成兩截」—— 是測試環境跟產線不一致，
//    不是 MiniMax 的問題。要比對就要比對同樣的輸入。
// 規則：兩邊都是數字就保留（「3-5 天」「2023-2024 年」），其餘刪掉；全形破折號不碰。
// 要聽「沒清洗」的原始行為加 --keep-hyphen。
const KEEP_HYPHEN = process.argv.includes("--keep-hyphen");
function stripStockHyphen(text) {
  if (KEEP_HYPHEN) return text;
  return String(text).replace(/-/g, (m, off, full) => {
    const prev = full[off - 1] || "";
    const next = full[off + 1] || "";
    return /\d/.test(prev) && /\d/.test(next) ? "-" : "";
  });
}

// ── 年份／股號轉中文數字（2026-09-01）────────────────────
// 起因：使用者實測 `--tn`（text_normalization）的結論是「不好，數字會唸錯」，
// 具體是**年份 2026／2027 與股號 2454／3034 都被唸成整數**（「兩千零二十七」「兩千四百五十四」），
// 台灣唸法應該是逐字「二零二七」「二四五四」。指數 45,832、價格 1,205、百分比 6% 沒被點名。
//
// 為什麼不用 pronunciation_dict 解：字典要一檔一條，台股上千檔寫不完，
// 而且「字典條數有上限」這個可能**還沒排除**（見上面 DICT 的註解）。regex 是通用規則，一條蓋全部。
//
// ⚠️ 這個轉換**只能動送 TTS 的那一份**，字幕必須照樣顯示「2454」。
//    產線上對應的位置是 run.js 的 cleanScript()／cleanSegmentText()，
//    字幕走的是 script-utils.js 的 cleanBodyWithIndex()，兩條路本來就分開 ——
//    stripSpeechHyphens()（run.js:417）就是同樣的模式，照抄即可。
// ⚠️ 以下與 run.js 的同名版本**必須一字不差**（同 DICT 的規矩）。
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

// ── 停頓標記 `<#x#>` ────────────────────────────────────
// MiniMax 官方語法：`文字<#0.60#>文字`，秒數 0.01~99.99、最多兩位小數。
// 規則（官方）：要放在**可發音的文字之間**、不可連放兩個、不要拿它當換行用。
// 這裡把「保留 / 剝掉」做成同一份稿的開關，就是為了讓 A/B 的字完全一致。
const PAUSE_RE = /<#\s*([0-9]+(?:\.[0-9]+)?)\s*#>/g;

function stripPauseMarks(text) {
  return String(text).replace(PAUSE_RE, "");
}

// 送出前的靜態檢查。目的不是替 MiniMax 做參數驗證，是擋掉**會靜默壞掉**的兩件事：
//   ① 秒數超出範圍／小數超過兩位 → API 可能整包退，也可能默默當成普通文字唸出來
//   ② 標記插進 pronunciation_dict 條目中間 → 那條字典**靜默失效**，聽起來只是唸錯
// ②才是真正的坑：它不會報錯，只會讓你以為「停頓標記讓發音變差了」而誤判。
function checkPauseSafety(text) {
  const problems = [];

  // ① 語法與位置
  const lines = text.split("\n");
  for (const line of lines) {
    let m;
    const re = new RegExp(PAUSE_RE.source, "g");
    const hits = [];
    while ((m = re.exec(line))) hits.push({ raw: m[0], sec: m[1], start: m.index, end: m.index + m[0].length });
    for (const h of hits) {
      const sec = Number(h.sec);
      if (!(sec >= 0.01 && sec <= 99.99)) problems.push(h.raw + "：秒數要在 0.01~99.99 之間");
      const dec = (h.sec.split(".")[1] || "").length;
      if (dec > 2) problems.push(h.raw + "：小數最多兩位");
      if (h.start === 0) problems.push(h.raw + "：不能放在句首（官方：要放在可發音的文字之間）");
      if (h.end === line.length) problems.push(h.raw + "：不能放在句尾");
    }
    for (let i = 1; i < hits.length; i++) {
      if (hits[i].start === hits[i - 1].end) problems.push(hits[i - 1].raw + hits[i].raw + "：不可以連放兩個標記");
    }
  }

  // ② 標記有沒有切斷字典條目（只在有送字典時才需要檢查）
  if (USE_DICT) {
    const clean = stripPauseMarks(text);
    // 對每個字典條目，比對「剝掉標記後有出現」但「原文（含標記）沒有出現」→ 就是被切斷了
    for (const entry of DICT) {
      const term = entry.split("/")[0];
      if (clean.includes(term) && !text.includes(term)) {
        problems.push("停頓標記插進了字典條目「" + term + "」的中間 —— 那條字典會靜默失效，把標記移到這個詞的前面或後面");
      }
    }
  }
  return problems;
}

function maybeNumFix(text) {
  if (!USE_NUMFIX) return text;
  const after = numFix(text);
  if (after !== text) console.log("年份／股號轉中文：有改（--dry 可看轉完的全文）");
  return after;
}

function scalePauseMarks(text) {
  if (PAUSE_SCALE === 1) return text;
  return String(text).replace(PAUSE_RE, (m, sec) => {
    // 兩位小數是官方上限；低於 0.01 就沒有意義，直接把標記拿掉而不是送一個非法值
    const v = Math.round(Number(sec) * PAUSE_SCALE * 100) / 100;
    return v < 0.01 ? "" : "<#" + v.toFixed(2) + "#>";
  });
}

function preparePause(text) {
  if (!USE_PAUSE) return stripPauseMarks(text);
  text = scalePauseMarks(text);
  const problems = checkPauseSafety(text);
  if (problems.length) {
    console.error("❌ 停頓標記有問題，先修好再跑（沒有送出任何請求、沒有扣任何字符）：");
    for (const p of problems) console.error("   ・" + p);
    process.exit(1);
  }
  const n = (text.match(PAUSE_RE) || []).length;
  const secs = (text.match(PAUSE_RE) || []).map((m) => m.replace(/[^\d.]/g, "")).join(" / ");
  console.log("停頓標記：保留 " + n + " 個" + (PAUSE_SCALE !== 1 ? "（倍率 " + PAUSE_SCALE + "）" : "") + " → " + secs + " 秒");
  return text;
}

const toSimp = OpenCC.Converter({ from: "t", to: "s" });
const OUT_DIR = path.join(workspaceRoot(APP_ROOT), "90_系統", "暫存", "產線輸出", "tts-ab");
fs.mkdirSync(OUT_DIR, { recursive: true });


// 送出前先印覆蓋率：這份稿子有沒有把字典每一條都念到？
// 沒命中的條目 = 這次聽不到，不能拿這次的結果判它生死。
function printCoverage(text) {
  const miss = [];
  console.log("字典覆蓋率：");
  for (const e of DICT) {
    const key = e.split("/")[0];
    const n = text.split(key).length - 1;
    if (!n) miss.push(key);
  }
  console.log("  " + (DICT.length - miss.length) + "/" + DICT.length + " 條命中" +
    (miss.length ? "　❌ 沒命中：" + miss.join("、") : "　✅ 全部命中"));
}

function buildPayload(text, opts) {
  const payload = {
    model: MODEL,
    text,
    language_boost: "Chinese",
    voice_setting: { voice_id: VOICE_ID, speed: 1.0, vol: 1.0, pitch: 0 },
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
    output_format: "hex",
    stream: false,
  };
  if (USE_DICT) payload.pronunciation_dict = { tone: DICT };
  // text_normalization：官方說「優化數字唸法，代價是略高的延遲」。離線批次跑，延遲不痛。
  if (USE_TN) payload.voice_setting.text_normalization = true;
  if (EMOTION) payload.voice_setting.emotion = EMOTION;
  if (MIX) {
    // ⚠️ 兩件事文件沒講清楚，所以這裡做退避（見下方 tts() 的重試迴圈）：
    //   ① 欄位拼字：官方英文文件寫 timbre_weights，但 MiniMax 早期 API 用過 timber_weights。
    //   ② voice_setting.voice_id 是否要同時送 —— 文件標 voice_id「Required」，
    //      又說 timbre_weights 自己帶 voice_id，兩者是否互斥沒有明講。
    payload[opts.field] = MIX.map((m) => ({ voice_id: m.voice_id, weight: m.weight }));
    if (opts.dropVoiceId) delete payload.voice_setting.voice_id;
  }
  return payload;
}

async function callApi(payload) {
  // 連線層的錯（DNS / 逾時 / 被防火牆擋）要跟 API 回的業務錯誤分開報，
  // 不然使用者會以為是參數寫錯。⚠️ Cowork 掛進來的 Linux VM 與雲端沙盒都連不到
  // api.minimax.io（2026-09-01 實測 curl 回 000），這支腳本只能在使用者自己的 Mac 上跑。
  let res;
  try {
    res = await fetch("https://api.minimax.io/v1/t2a_v2?GroupId=" + GROUP_ID, {
      method: "POST",
      headers: { Authorization: "Bearer " + API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { ok: false, data: { base_resp: { network_error: String(e && e.message || e) } }, fatal: true };
  }
  const data = await res.json().catch(() => ({}));
  const ok = res.ok && data.data && data.data.audio;
  return { ok, data };
}

async function tts(text, tag) {
  // 沒混音就一種組合；混音時把「拼字 × 要不要送 voice_id」四種組合依序試，
  // 第一個成功的就採用並印出來 —— 這支腳本得由使用者在 Mac 上手動跑，
  // 每次往返成本很高，不要為了一個文件沒寫清楚的欄位名浪費一輪。
  const attempts = MIX
    ? [
        { field: "timbre_weights", dropVoiceId: false },
        { field: "timbre_weights", dropVoiceId: true },
        { field: "timber_weights", dropVoiceId: false },
        { field: "timber_weights", dropVoiceId: true },
      ]
    : [{ field: null, dropVoiceId: false }];

  let data = null;
  let used = null;
  for (const opt of attempts) {
    const r = await callApi(buildPayload(text, opt));
    if (r.ok) { data = r.data; used = opt; break; }
    if (r.fatal) {
      console.error("❌ [" + tag + "] 連不到 api.minimax.io：" + r.data.base_resp.network_error);
      console.error("   這支腳本要在使用者自己的 Mac 上跑（Cowork 的 Linux VM 與雲端沙盒都連不到 MiniMax）。");
      return false;
    }
    if (attempts.length > 1) {
      console.log("   ↻ [" + tag + "] " + opt.field + (opt.dropVoiceId ? " 不送 voice_id" : " 併送 voice_id") +
        " → 失敗：" + JSON.stringify((r.data && r.data.base_resp) || r.data));
    } else {
      console.error("❌ [" + tag + "] 失敗：" + JSON.stringify((r.data && r.data.base_resp) || r.data));
    }
  }
  if (!data) {
    if (MIX) console.error("❌ [" + tag + "] 四種 timbre_weights 組合全部失敗 —— 這個帳號／模型可能不支援混音，把上面四行原文回報給 Claude");
    return false;
  }
  if (MIX && used) {
    console.log("   ✔ 可用的混音寫法：" + used.field + (used.dropVoiceId ? "（不送 voice_setting.voice_id）" : "（併送 voice_setting.voice_id）") +
      "　← 這行很重要，要搬進 run.js 的話照這個寫");
  }

  const mixTag = MIX ? "mix-" + MIX.map((m) => m._key + m.weight).join("-") : VOICE_LABEL;
  const name = [MODEL, mixTag, "text" + TEXT_KEY, USE_DICT ? "dict" : "nodict", USE_TN ? "tn" : "notn", USE_PAUSE ? "pause" + (PAUSE_SCALE !== 1 ? "x" + PAUSE_SCALE : "") : "nopause", USE_NUMFIX ? "numfix" : "nonumfix", EMOTION ? "emo-" + EMOTION : "emo-auto", KEEP_HYPHEN ? "hyphen" : "nohyphen", tag].join("_") + ".mp3";
  const out = path.join(OUT_DIR, name);
  fs.writeFileSync(out, Buffer.from(data.data.audio, "hex"));
  const info = data.extra_info || {};
  console.log(
    "✅ " + name +
    "   " + (info.audio_length ? (info.audio_length / 1000).toFixed(2) + " 秒" : "?") +
    " / " + (info.usage_characters != null ? info.usage_characters : text.length) + " 字符" +
    " / " + (fs.statSync(out).size / 1024).toFixed(0) + " KB"
  );
  return true;
}

(async () => {
  console.log("model=" + MODEL + "  text=" + TEXT_KEY + "  voice=" + VOICE_LABEL + " (" + VOICE_ID + ")  發音字典=" + (USE_DICT ? "有送" : "不送") +
    "  數字正規化=" + (USE_TN ? "開" : "關") + "  情緒=" + (EMOTION || "自動（不送欄位）") +
    (MIX ? "\n混音 timbre_weights：" + MIX.map((m) => m._key + " " + m.weight).join(" ＋ ") + "（voice_setting.voice_id 仍是 " + VOICE_LABEL + "）" : ""));
  console.log("原文 " + TEXT.length + " 字");
  // 覆蓋率表只對 text c 有意義（它就是為了「一支聽完驗完整份字典」設計的）。
  // d／e 是另外的用途，印 0/25 只會製造雜訊、讓人誤以為出事了。
  if (TEXT_KEY === "c") printCoverage(stripPauseMarks(stripStockHyphen(TEXT)));
  else console.log("（text=" + TEXT_KEY + " 不是字典驗證稿，略過覆蓋率表）");
  console.log("");
  // 順序：先 numfix 再 preparePause。標記 `<#0.20#>` 裡沒有獨立的 4 位數，
  // 且 numfix 的 lookbehind 擋掉黏著小數點的情形，兩者不會互相破壞（下方 --dry 可自己確認）。
  const prep = (t) => preparePause(maybeNumFix(stripStockHyphen(t)));
  const prepared = prep(TEXT);
  if (DRY_RUN) {
    console.log("── 實際會送出去的文字（--dry，不呼叫 API）──\n" + prepared + "\n");
    process.exit(0);
  }
  const okT = await tts(prepared, "trad");
  const okS = TRAD_ONLY ? true : await tts(prep(toSimp(TEXT)), "simp");
  console.log("\n輸出資料夾：" + OUT_DIR);
  process.exit(okT && okS ? 0 : 1);
})();
