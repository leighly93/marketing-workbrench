// @ts-check
'use strict';

/**
 * 版型設定表：每個版型一筆，產線（run.js）、伺服器、解析、素材與動態都讀這一份。
 * 新增版型＝加一筆設定＋寫 Remotion composition，不用再複製腳本。
 *
 * ⚠️ 宣告順序＝前台版型清單的顯示順序（2026-08-31：盤中焦點 → 大盤小報；2026-09-15 美股焦點放最右）。
 * ⚠️ 2026-09-22 三大法人、焦點股日報、投廣模板整組移除；要找回來翻 git 歷史。
 *
 * 欄位：
 *   label / emoji     顯示名稱
 *   srcDir / planFile Remotion 專案裡這個版型的資料夾與配圖計畫檔（src/<srcDir>/<planFile>）
 *   outputs           要渲染的成品：composition、產線輸出檔名、前台標籤
 *   assets            storage/shared-assets/<dir>/ 的檔案 → public/ 的目標檔名（帶版型前綴，避免撞名）
 *   anchor            固定主播：HeyGen avatar、畫面比例、HeyGen 內建語音（退路）、MiniMax 聲音（預設）
 *   motion            動態小影片要出哪些方向（p 直式、l 橫式）與安全區覆寫
 *   ui                前台：標題規則（使用者拍板的數字，不是從字級回推）、箭頭、提示、旗標
 */
/**
 * @typedef {{ file: string, composition: string, label: string }} TemplateOutput
 * @typedef {{ lines: number, per: number, wrap: boolean, where: string }} TitleRule
 * @typedef {{
 *   label: string, emoji: string, srcDir: string, planFile: string,
 *   outputs: TemplateOutput[],
 *   assets: { dir: string, files: Record<string, string> },
 *   anchor: { avatar: { id: string, gender: string }, aspectRatio: '9:16' | '16:9', heygenVoiceId: string, minimaxVoiceId: string },
 *   motion: Record<string, { safeTop?: number, safeBottom?: number }>,
 *   ui: { title: TitleRule, arrow: boolean, hint: string, flags: string[] },
 * }} TemplateConfig
 */

/** @type {Record<string, TemplateConfig>} */
const TEMPLATES = {
  midday: {
    label: '盤中焦點',
    emoji: '⏱',
    srcDir: 'MiddayFocus',
    planFile: 'midday-shots.generated.json',
    // 只出直式（使用者定案）。
    outputs: [{ file: 'output-midday.mp4', composition: 'MiddayFocus', label: '直式' }],
    assets: {
      dir: 'midday',
      files: {
        'intro-frame.jpg': 'midday-intro-frame.jpg',
        'header-overlay.png': 'midday-header-overlay.png',
        'bgm.wav': 'midday-bgm.wav',
      },
    },
    anchor: {
      // 2026-09-14 換 look（原 b1be6a97…）。這支是否為直式素材還沒驗：出片後 heygen.mp4 上下有邊，才改 16:9。
      avatar: { id: '4105a6e911a24f3ab8741cdd8b13f2ba', gender: 'female' },
      aspectRatio: '9:16',
      // 2026-09-11 起有自己的 HeyGen 聲音（不再沿用大盤小報）。目前是退路，只有 --heygen-voice 會用到。
      heygenVoiceId: '9cb1516ecebf4c06b668e03f7f6e91f7',
      minimaxVoiceId: 'moss_audio_f85dc873-ada4-11f1-a626-8a59b47fb1f9',
    },
    motion: { p: {} },
    ui: {
      // 2026-09-14 使用者把每行參考值從 9 改成 10；超過只折行、字級不變。
      title: { lines: 2, per: 10, wrap: true, where: '開場第一秒' },
      // timeline 有把 arrow 傳給渲染端，前台才給畫箭頭；沒接的版型不要開，否則畫得出來、成品卻沒有。
      arrow: true,
      hint: '',
      flags: [],
    },
  },
  dapan: {
    label: '大盤小報',
    emoji: '📰',
    srcDir: 'DapanXiaobao',
    planFile: 'dapan-shots.generated.json',
    outputs: [
      { file: 'output-dapan.mp4', composition: 'DapanXiaobao', label: '直式' },
      { file: 'output-dapan-landscape.mp4', composition: 'DapanXiaobaoLandscape', label: '橫式' },
    ],
    assets: {
      dir: 'dapan',
      files: {
        'intro-frame.jpg': 'dapan-intro-frame.jpg',
        'header-overlay.png': 'dapan-header-overlay.png',
        'bgm.wav': 'dapan-bgm.wav',
        // 橫式（DapanXiaobaoLandscape）的 16:9 常駐品牌面板（1920×1080 RGBA、左側透明）
        'intro-frame_Horizontal.png': 'dapan-intro-frame-horizontal.png',
      },
    },
    anchor: {
      // 2026-10-01 改回這支。換 look 要一起確認：①左右有沒有補白 ②人物水平位置（DapanComposition 的
      // objectPosition）③人物垂直構圖（頭頂 y）—— 版型沒有垂直參數，來源高多少就原樣放大出去。
      avatar: { id: '77012ed52edb488bbf32587afc0ec288', gender: 'female' },
      // 主播素材是橫式，所以 16:9；其他版型的直式素材抄這個會上下補白。
      aspectRatio: '16:9',
      heygenVoiceId: 'dc529e16819846b2a0ba986a7fc51a85',
      minimaxVoiceId: 'moss_audio_b47d71d2-ada4-11f1-8900-9edb4a3ef07d',
    },
    motion: { p: {}, l: {} },
    ui: {
      // 橫式標題在右側面板，可用寬 706px ÷ 字級 68 ≈ 10.4 字。
      title: { lines: 2, per: 10, wrap: true, where: '直式：開場第一秒　／　橫式：右側面板全程顯示' },
      arrow: true,
      hint: '',
      flags: [],
    },
  },
  usstock: {
    label: '美股焦點',
    emoji: '🇺🇸',
    srcDir: 'UsStock',
    planFile: 'usstock-shots.generated.json',
    outputs: [{ file: 'output-usstock.mp4', composition: 'UsStock', label: '直式' }],
    assets: {
      dir: 'usstock',
      files: {
        'intro-frame.jpg': 'usstock-intro-frame.jpg',
        'header-overlay.png': 'usstock-header-overlay.png',
        'bgm.wav': 'usstock-bgm.wav',
      },
    },
    anchor: {
      // 2026-09-15 換 look（原 d7fc9954…）；比例同盤中焦點的說明。
      avatar: { id: '4a74ef949c524c17b762656d58f0c1ac', gender: 'female' },
      aspectRatio: '9:16',
      // 使用者只給了 MiniMax 聲音，沒有 HeyGen 內建語音的退路。
      heygenVoiceId: '',
      minimaxVoiceId: 'moss_audio_3a75102e-54db-11f1-981b-8a143315d498',
    },
    // 招牌比盤中焦點高，安全區往下讓到 325。
    motion: { p: { safeTop: 325 } },
    ui: {
      title: { lines: 2, per: 10, wrap: true, where: '開場第一秒' },
      arrow: true,
      hint: '',
      flags: [],
    },
  },
};

const IDS = Object.keys(TEMPLATES);

/**
 * 取得版型設定；不認得就丟例外（不默默跑一條不存在的產線）。
 * @param {string} id
 * @returns {TemplateConfig & { id: string }}
 */
function getTemplate(id) {
  if (!Object.hasOwn(TEMPLATES, id)) {
    throw new Error(`不認得的版型：${id || '（未指定）'}（目前支援：${IDS.join(' / ')}）`);
  }
  return { id, ...TEMPLATES[id] };
}

/**
 * 配圖計畫檔相對 Remotion 專案的路徑，例如 src/DapanXiaobao/dapan-shots.generated.json
 * @param {string} id
 */
function planPath(id) {
  const t = getTemplate(id);
  return `src/${t.srcDir}/${t.planFile}`;
}

/** public/ 裡屬於「套版素材」的檔名規則：版型前綴的檔案、品牌框、字型。清場時不要動。 */
const TEMPLATE_ASSET_PATTERN = new RegExp(`^(${IDS.join('|')})-|^(frame|logo)\\.png$|^NotoSans`, 'i');

/** 伺服器與前台用的版型資訊（/api/health 會原樣送到前台）。 */
function serverTemplates() {
  /** @type {Record<string, object>} */
  const out = {};
  for (const id of IDS) {
    const t = TEMPLATES[id];
    out[id] = {
      title: t.ui.title,
      label: t.label,
      arrow: t.ui.arrow,
      hint: t.ui.hint,
      outputs: t.outputs.map((o) => o.file),
      // 只有多個輸出時才需要標「直式／橫式」。
      ...(t.outputs.length > 1 ? { outputLabels: Object.fromEntries(t.outputs.map((o) => [o.file, o.label])) } : {}),
      plan: planPath(id),
      planKind: 'shots',
      flags: t.ui.flags,
    };
  }
  return out;
}

module.exports = { TEMPLATES, IDS, getTemplate, planPath, serverTemplates, TEMPLATE_ASSET_PATTERN };
