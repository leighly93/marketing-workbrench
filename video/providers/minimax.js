// @ts-check
'use strict';

/**
 * MiniMax T2A（文字轉語音）。固定主播線預設的配音來源：MiniMax 配音 → 上傳 HeyGen → 音訊驅動對嘴。
 * 只負責「送出與解碼」，聲音由版型設定（registry 的 anchor.minimaxVoiceId）決定。
 */

// 2026-09-01：speech-02-hd → speech-2.8-hd（使用者定案）。
// ⚠️ 換世代**不是為了發音**：實測 2.8 對台灣讀音沒有比較好 —— 專門塞滿舊字典 16 條的驗證稿
//    裡，使用者聽出 10 條讀成大陸音（收斂／企業／衝擊／意識／曝險／液晶／南亞科・亞洲／
//    成熟／攜手／血本）。換模型救不了讀音，把大陸模型拉回台灣讀音的**只有下面那份字典**。
//    2.8 換的是音質與斷句（使用者實測後選定）。要退回舊世代改這一行即可，字典兩邊通用。
//    對照素材留在 out/tts-ab/，重跑用 tools/experiments/tts-ab.js。
const MODEL = "speech-2.8-hd"; // HD 品質。要省可改 speech-2.8-turbo

// language_boost 明示語言（2026-08-24）。
// ⚠️ 不送這個欄位時 MiniMax 的預設是 null → 它會「看字猜語言」，而粵語書面就是用繁體寫的，
//    所以一段繁體中文有機率被判成粵語（使用者早期踩過：繁體出粵語、簡體才出普通話）。
//    釘住 "Chinese" 之後語言就固定是普通話，不再靠偵測。合法值裡沒有台灣腔／zh-TW ——
//    腔調完全來自 voice_id 本身（clone 的樣本），這個參數只決定「哪一種中文」。
const LANGUAGE_BOOST = "Chinese";

// emotion（2026-09-01 上線，2026-09-14 起改由前台每支片選）。
// **不送這個欄位＝MiniMax 依文字自動挑**，實測結果偏平：
// 使用者聽完 institution 那支說「聲音可以，但有可能在有一點點情緒嗎？」，
// 接著 A/B 聽 happy 與 fluent →「fluent 斷句可以就是有點平」「happy 這情緒還行，比較下會偏好這個」。
//
// 2026-09-14 定案改成**前台選、預設 fluent**。起因是 happy 拿去講重挫不合適
// （使用者：「講股市有時候是重挫的內容 Happy 不適合」）。當天拿真實重挫稿
// （工作 20260911-161722-wai2，大盤小報、下跌 755 點）配 dapan 聲音、產線參數全套，
// 只換 emotion 出四支試聽：happy 69.23 秒／calm 63.04／sad 75.35／fluent 56.56（同 588 字符，
// 檔案在 storage/tmp/pipeline-output/tts-ab/）。使用者聽後：**sad 太誇張**，定案只開放 fluent 與 happy 兩個值。
// ⚠️ 同一份字不同情緒長度差 33%（56.6～75.4 秒）—— 這是「段落各挑情緒」會讓整支語速忽快忽慢的依據，
//    所以這顆開關是**整支一個值**，不做段落級。
// ⚠️ 前台只給兩個值，白名單在 server/index.js 的 EMOTIONS（前台不顯示擋得住同事，擋不住直接打 API 的人）。
//    這裡的 --emotion= 是給終端機用的，九個合法值都收 —— 真的要試別的值請先走 tools/experiments/tts-ab.js。
//
// ⚠️ 合法值只有九個（happy/sad/angry/fearful/disgusted/surprised/calm/fluent/whisper），
//    **沒有 neutral／auto**，送了會回 error 2013。要退回「自動挑」下 `--emotion=`（空值）即可。
// ⚠️ 而且不是每個值都跟每個模型相容：2026-09-11 實測 **speech-2.8 系列不支援 whisper**
//    （2013「speech 2.8 don't support whisper」），要用得連 MODEL 一起退到 2.6／02。
//    whisper 會讓**整支出片直接失敗**，不是只有音色變掉 —— 所以下面在開跑前就先擋，
//    不要等 HeyGen 都生完了才死在配音那一步。
// ⚠️ 這是**全域**設定：四條固定主播線＋投廣模板／雙人 path 都會套到同一個值。
//    2026-09-11 使用者在大盤小報／盤中焦點的兩支新聲音上也 A/B 聽過 happy 與「不送 emotion」，
//    當時定案「有特別改 happy 的不錯，保留」；09-14 的重挫稿試聽把預設換成 fluent，happy 改成手動選。
//    （順帶一提：不送 emotion 時 b47d71d2 那支同一段字會慢 4 秒，平又拖，不要退回「自動挑」。）
// ⚠️ emotion **沒有強度參數**，九個值是離散的。voice_modify.intensity（−100~100）是另一組東西
//    （變聲器），跟 timbre_weights 同一類風險 —— 混音已實測「聽起來很假」，要用要單獨測。
const EMOTIONS = ["happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm", "fluent", "whisper"];
const DEFAULT_EMOTION = "fluent";

// ── MiniMax 發音字典（2026-08-24 建立，2026-09-01 在 speech-2.8-hd 上全面重校）──────
// 取代「拿錯字騙 TTS」的字元替換做法。差別很實際：
//   ① 只影響合成的音訊，稿子的字完全不動 → 字幕天生就是原文，不需要 correct-subtitles 反向還原
//   ② 單字可以指定（`跌` 是單音字，全稿一致才是對的），而共用詞庫 data/pronounce.json
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
// 要加新條目之前：先用 `node tools/experiments/tts-ab.js` 實際聽過，不要憑字典硬塞。
// 那支腳本的 --text=c 是 107 字的精簡驗證稿，把下面每一條都至少命中一次，跑之前會印覆蓋率表。
const PRONUNCIATION_DICT = [
  // ── 詞級（長→短）─────────────────────────
  // 「期貨淨空」這條的用意是**詞邊界**不是發音：使用者實測回報聽起來像「還有期｜貨淨空」，
  // 停頓落在詞中間（「還有期」很可能被當成「有期」那個詞）。明確宣告「這幾個字是一個單位、
  // 對應這幾個音節」，模型就沒有空間把它拆開。官方文件只講「指定發音」，沒承諾影響韻律邊界 ——
  // 這是推論，靠耳朵驗過有效。若哪天失效，退路是改寫稿子（期貨淨空 → 期貨的淨空單）。
  "期貨淨空/(qi2)(huo4)(jing4)(kong1)", // 期＝台灣讀 ㄑㄧˊ；空＝空單／空方的 kōng 一聲
  "穎崴/影威",           // 公司名。**文字替換**語法，2026-09-01 實測有效
  // 「重」是多音字，**不能下單字級條目**（會像註解裡的「和」那樣誤傷另一個讀音）——
  // 兩個讀音在財經稿裡都會出現，所以一律走詞級。2026-09-11 使用者指定這六條。
  // 這批跟兩岸腔調無關（普通話本來就分這兩讀），是防模型挑錯讀音；漏掉的詞要補就照樣加詞級條目。
  "重新/(chong2)(xin1)",  // ㄔㄨㄥˊ「再一次」：重新布局、重新評估
  "重估/(chong2)(gu1)",   // ㄔㄨㄥˊ「再一次」：法人重估目標價
  "重複/(chong2)(fu4)",   // ㄔㄨㄥˊ「再一次」：重複計算
  "重挫/(zhong4)(cuo4)",  // ㄓㄨㄥˋ「程度深」：台股重挫
  "重壓/(zhong4)(ya1)",   // ㄓㄨㄥˋ「分量大」：資金重壓某族群
  "沉重/(chen2)(zhong4)", // ㄓㄨㄥˋ「分量大」：賣壓沉重。⚠️「重」在詞尾，音節照樣要寫滿兩個
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

/**
 * 情緒參數是否可用；不可用時回傳錯誤訊息（在呼叫 HeyGen 前就擋下，免得配音那一步才整支失敗）。
 * @param {string} emotion 空字串＝讓 MiniMax 自動挑
 * @param {string} [model]
 * @returns {string | null}
 */
function emotionError(emotion, model = MODEL) {
  if (emotion && !EMOTIONS.includes(emotion)) {
    return `不認得的 --emotion=${emotion}（合法值：${EMOTIONS.join(" / ")}；沒有 neutral／auto，要「自動挑」請下 --emotion= 空值）`;
  }
  if (emotion === "whisper" && model.startsWith("speech-2.8")) {
    return `${model} 不支援 --emotion=whisper（API 回 2013），這樣跑會在配音那一步整支失敗。
`
      + "   要聽 whisper 請一起把 MODEL 退到 speech-2.6-hd 或 speech-02-hd。";
  }
  return null;
}

/**
 * @param {{ text: string, voiceId: string, emotion?: string, model?: string, dict?: string[] }} o
 */
function ttsPayload({ text, voiceId, emotion = DEFAULT_EMOTION, model = MODEL, dict = PRONUNCIATION_DICT }) {
  return {
    model,
    text,
    // 不送 language_boost＝讓 MiniMax 猜語言，繁體有機率被判成粵語。
    language_boost: LANGUAGE_BOOST,
    voice_setting: { voice_id: voiceId, speed: 1.0, vol: 1.0, pitch: 0, ...(emotion ? { emotion } : {}) },
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
    output_format: "hex",
    stream: false,
    // 發音字典：空陣列就不送這個欄位
    ...(dict.length ? { pronunciation_dict: { tone: dict } } : {}),
  };
}

/**
 * @param {{ apiKey: string, groupId: string, emotion?: string, model?: string,
 *   fetch?: typeof globalThis.fetch, log?: (m: string) => void, error?: (...m: unknown[]) => void }} options
 */
function createMiniMaxClient({ apiKey, groupId, emotion = DEFAULT_EMOTION, model = MODEL, fetch = globalThis.fetch, log = console.log, error = console.error }) {
  /**
   * @param {string} text 送 TTS 的文字（已清洗、已套發音替換；繁體直送）
   * @param {string} voiceId
   * @returns {Promise<Buffer>} mp3
   */
  async function synthesize(text, voiceId) {
    log(`呼叫 MiniMax T2A（${text.length} 字符、model: ${model}、voice: ${voiceId}、情緒: ${emotion || "自動"}）`);
    const payload = ttsPayload({ text, voiceId, emotion, model });
    if (payload.pronunciation_dict) log(`  發音字典：${PRONUNCIATION_DICT.join("　")}`);
    const res = await fetch(`https://api.minimax.io/v1/t2a_v2?GroupId=${groupId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data.data?.audio) {
      error("MiniMax 回應：", JSON.stringify(data, null, 2));
      throw new Error("MiniMax T2A 生成失敗");
    }
    // data.audio 是 hex 編碼的 mp3
    return Buffer.from(data.data.audio, "hex");
  }
  return { synthesize };
}

module.exports = { createMiniMaxClient, ttsPayload, emotionError, EMOTIONS, DEFAULT_EMOTION, MODEL, LANGUAGE_BOOST, PRONUNCIATION_DICT };
