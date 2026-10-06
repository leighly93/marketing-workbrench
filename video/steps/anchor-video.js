// @ts-check
'use strict';

/**
 * 固定主播講者影片：稿件 → （MiniMax 配音 → HeyGen 音訊驅動對嘴）或（HeyGen 內建語音文字驅動）→ 下載。
 *
 * 計費差別：文字驅動是 HeyGen 連 TTS 一起算；音訊驅動是 MiniMax 按字符＋HeyGen 按音檔秒數，兩邊都扣。
 */
const { parseVoiceReplacements, cleanScript } = require('../pipeline/tts-text');

/** 設定缺漏：在呼叫任何付費 API 之前擋下。 */
class AnchorConfigError extends Error {}

/**
 * 送 TTS 的文字：清洗（去標記、括號、減號，年份轉中文）後套發音替換。字幕不走這條路。
 * @param {string} rawScript script.txt 全文
 */
function ttsTextOf(rawScript) {
  let text = cleanScript(rawScript);
  for (const rule of parseVoiceReplacements(rawScript)) text = text.split(rule.from).join(rule.to);
  return text;
}

/**
 * 這次用哪一種配音、缺什麼設定。
 * @param {{ id: string, label: string, anchor: { avatar: { id: string }, voice: string, minimaxVoiceId: string, heygenVoiceId: string } }} tpl
 * @param {{ heygenVoice?: boolean }} [flags] heygenVoice：--heygen-voice（單次退回 HeyGen 內建語音）
 * @returns {{ useMinimax: boolean }}
 * @throws {AnchorConfigError}
 */
function planVoice(tpl, { heygenVoice = false } = {}) {
  const { avatar, voice, minimaxVoiceId, heygenVoiceId } = tpl.anchor;
  const where = `video/templates/registry.js 的 ${tpl.id}.anchor`;
  const useMinimax = voice !== 'heygen' && !heygenVoice;
  if (!avatar.id) throw new AnchorConfigError(`${tpl.label}還沒填 HeyGen avatar id（${where}.avatar.id）。`);
  if (useMinimax && !minimaxVoiceId) {
    throw new AnchorConfigError(`${tpl.label}還沒填 MiniMax voice id（${where}.minimaxVoiceId）。\n`
      + '   填進去，或臨時加 --heygen-voice 改走 HeyGen 內建語音（那需要 heygenVoiceId）。');
  }
  if (!useMinimax && !heygenVoiceId) {
    throw new AnchorConfigError(`${tpl.label}要用 HeyGen 內建語音，但 ${where}.heygenVoiceId 是空值。\n`
      + '   去 HeyGen 後台「Voice Library」或呼叫 GET https://api.heygen.com/v3/voices 找一個中文女聲 voice_id 填進去。');
  }
  return { useMinimax };
}

/**
 * @param {{
 *   tpl: { id: string, label: string, anchor: { avatar: { id: string }, voice: string, minimaxVoiceId: string, heygenVoiceId: string } },
 *   rawScript: string, heygenPath: string, minimaxAudioPath: string, heygenVoice?: boolean,
 *   heygen: ReturnType<typeof import('../providers/heygen').createHeyGenClient>,
 *   minimax?: ReturnType<typeof import('../providers/minimax').createMiniMaxClient>,
 *   writeFile?: (file: string, data: Buffer) => void, log?: (m: string) => void,
 * }} input
 */
async function generateAnchorVideo({
  tpl, rawScript, heygenPath, minimaxAudioPath, heygenVoice = false, heygen, minimax,
  writeFile = (file, data) => require('node:fs').writeFileSync(file, data), log = console.log,
}) {
  const { useMinimax } = planVoice(tpl, { heygenVoice });
  const text = ttsTextOf(rawScript);
  log(`清洗後腳本（繁）：\n  ${text}`);
  const { avatar, minimaxVoiceId, heygenVoiceId } = tpl.anchor;
  log(`固定 avatar（${tpl.label}）：${avatar.id}`);
  const title = `marketing-auto-${tpl.id}`;

  let videoId;
  if (useMinimax) {
    if (!minimax) throw new AnchorConfigError('要用 MiniMax 配音，但沒有 MiniMax 設定（MINIMAX_API_KEY／MINIMAX_GROUP_ID）');
    log(`配音來源：MiniMax voice ${minimaxVoiceId}`);
    log('繁體直送 MiniMax（language_boost=Chinese 釘住普通話）');
    const audio = await minimax.synthesize(text, minimaxVoiceId);
    // 音檔留一份：出問題時可以直接聽，分辨是配音壞了還是對嘴壞了
    writeFile(minimaxAudioPath, audio);
    log(`音檔備份 → ${minimaxAudioPath}`);
    const assetId = await heygen.uploadAudio(audio);
    log('⏳ 正在呼叫 HeyGen（音訊驅動對嘴），請勿重複執行此腳本...');
    log('   預計等待 3-5 分鐘，請耐心等候 ☕');
    videoId = await heygen.createAudioDrivenVideo(assetId, avatar.id, title);
  } else {
    log('⏳ 正在呼叫 HeyGen（文字驅動），請勿重複執行此腳本...');
    log('   預計等待 3-5 分鐘，請耐心等候 ☕');
    videoId = await heygen.createTextDrivenVideo(text, avatar.id, heygenVoiceId, title);
  }
  const url = await heygen.waitForVideo(videoId);
  await heygen.downloadVideo(url, heygenPath);
  return { useMinimax, videoId };
}

module.exports = { generateAnchorVideo, planVoice, ttsTextOf, AnchorConfigError };
