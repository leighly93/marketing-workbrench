// @ts-check
'use strict';

/**
 * run.js 的參數解析（純函式）。不認得的旗標一律忽略：前台舊工作的 job.json 可能帶著已移除的旗標
 * （--with-ad、--brand=、--minimax、--simp、--heygen-v2…），重跑舊工作不能因此失敗。
 *
 *   --template=<版型>     必填（2026-09-22 起沒有預設版型）
 *   --skip-generate       不呼叫 HeyGen／MiniMax，用現成的 public/heygen.mp4（加速照樣做）
 *   --no-speed            不做 125% 加速
 *   --stop-before-render  算完配圖計畫就停，給前台插入人工確認關卡
 *   --render-only         跳過前面全部，用現有的 public/ 與計畫檔直接出片
 *   --heygen-voice        這次改用 HeyGen 內建語音（文字驅動），不經 MiniMax
 *   --emotion=<值>        MiniMax 情緒；空值＝讓 MiniMax 自動挑；預設 fluent
 *   --avatar-iii          HeyGen 引擎改 Avatar III（便宜 7~13%，表情對嘴較差；要比請用正式長度的稿子）
 */
const { getTemplate } = require('./templates/registry');
const { emotionError, DEFAULT_EMOTION } = require('./providers/minimax');
const { DEFAULT_ENGINE } = require('./providers/heygen');

/**
 * @param {string[]} argv
 * @returns {{ template: string, tpl: ReturnType<typeof getTemplate>, skipGenerate: boolean, noSpeed: boolean,
 *   stopBeforeRender: boolean, renderOnly: boolean, heygenVoice: boolean, emotion: string, engine: string }}
 * @throws {Error} 版型或情緒參數不合法
 */
function parseRunOptions(argv) {
  const valueOf = (/** @type {string} */ name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? undefined : hit.slice(name.length + 3);
  };
  const template = valueOf('template') || '';
  const tpl = getTemplate(template);
  const emotionArg = valueOf('emotion');
  const emotion = emotionArg === undefined ? DEFAULT_EMOTION : emotionArg;
  const problem = emotionError(emotion);
  if (problem) throw new Error(problem);
  return {
    template,
    tpl,
    skipGenerate: argv.includes('--skip-generate'),
    noSpeed: argv.includes('--no-speed'),
    stopBeforeRender: argv.includes('--stop-before-render'),
    renderOnly: argv.includes('--render-only'),
    heygenVoice: argv.includes('--heygen-voice'),
    emotion,
    engine: argv.includes('--avatar-iii') ? 'avatar_iii' : DEFAULT_ENGINE,
  };
}

module.exports = { parseRunOptions };
