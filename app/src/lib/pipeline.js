// 工作頁的 pipeline 模型：把 job.status、steps.json 與工作欄位整理成「五個階段、每階段幾個節點」。
// 純函式，畫面在 components/pipeline/。節點 id 固定（右側面板用它決定要畫哪一種表單）。

import { ANNOTATABLE, MARKS_EDITABLE } from './status.js';
import { isImageName } from './files.js';

export const STAGES = [
  { id: 'create', label: '建立' },
  { id: 'prepare', label: '準備' },
  { id: 'confirm', label: '人工確認' },
  { id: 'render', label: '出片' },
  { id: 'output', label: '成品' },
];

/**
 * 節點狀態（跟 steps.json 的 status 對齊，再多幾個只有前台才有的）：
 *   ok／running／failed／warning／skipped／cancelled 來自步驟事件；
 *   pending＝還沒輪到；ready＝輪到你了（要人動手）；todo＝缺東西才能往下；optional＝可填可不填。
 */
export const NODE_TONE = {
  ok: 'ok', warning: 'warn', failed: 'bad', cancelled: 'bad', running: 'run',
  pending: 'dim', skipped: 'dim', ready: 'accent', todo: 'todo', optional: 'dim',
};

export const NODE_STATUS_TEXT = {
  ok: '完成', warning: '完成（有警告）', failed: '失敗', cancelled: '已取消', running: '執行中',
  pending: '等待中', skipped: '略過', ready: '等你處理', todo: '還缺東西', optional: '選填',
};

/** 準備與出片階段的節點 → 對應的步驟 id（run.js 與 server/jobs/production.js 寫進 steps.json 的）。 */
const PREPARE_NODES = [
  { id: 'inputs', label: '準備素材', steps: ['stage-inputs', 'assets'] },
  { id: 'generate', label: '生成講者影片', steps: ['generate'] },
  { id: 'analysis', label: '截圖分析', steps: ['image-analysis'], parallel: true },
  { id: 'speed', label: '備份與加速', steps: ['backup', 'speed'] },
  { id: 'transcribe', label: '字幕轉錄', steps: ['transcribe'] },
  { id: 'autoplan', label: '配圖計畫計算', steps: ['shots', 'counterfactual', 'snapshot', 'plan-view'] },
  { id: 'motionclips', label: '動態小影片', steps: ['motion-clips'] },
];
const RENDER_NODES = [
  { id: 'renderprep', label: '還原快照與套用設定', steps: ['render-prep', 'motion-render', 'plan-edits'] },
  { id: 'render', label: 'Remotion 渲染', steps: ['render'] },
  { id: 'finalize', label: '音量校正與歸檔', steps: ['finalize'] },
];

/** 每個步驟 id 只看最後一筆（重跑會 append）。 */
export function latestSteps(steps) {
  const map = {};
  for (const s of steps || []) if (s && s.id) map[s.id] = s;
  return map;
}

/**
 * 幾個步驟合成一個節點的狀態。
 * active＝工作正在跑：有些步驟還沒跑到（備份完、加速還沒開始）就當「進行中」，比較不會讓人以為卡住；
 * 工作已經停了（完成／失敗／等人）就只看有記到的 —— 有些步驟本來就不一定會寫（例如沒有人工修正就沒有 plan-edits）。
 */
function aggregate(ids, latest, active) {
  const entries = ids.map((id) => latest[id]).filter(Boolean);
  if (!entries.length) return { status: 'pending', entries };
  if (entries.some((e) => e.status === 'running')) return { status: 'running', entries };
  if (entries.some((e) => e.status === 'failed')) return { status: 'failed', entries };
  if (entries.some((e) => e.status === 'cancelled')) return { status: 'cancelled', entries };
  if (active && entries.length < ids.length && !entries.every((e) => e.status === 'skipped')) {
    return { status: 'running', entries };
  }
  if (entries.some((e) => e.status === 'warning')) return { status: 'warning', entries };
  if (entries.every((e) => e.status === 'skipped')) return { status: 'skipped', entries };
  return { status: 'ok', entries };
}

function stepNote(entries) {
  const err = entries.find((e) => e.error);
  if (err) return err.error;
  const note = entries.map((e) => e.note).filter(Boolean);
  return note.length ? note[note.length - 1] : '';
}

function msOf(entries) {
  const ms = entries.map((e) => e.ms).filter((n) => typeof n === 'number');
  return ms.length ? ms.reduce((a, b) => a + b, 0) : null;
}

/**
 * @param {object} job 伺服器回來的 publicJob
 * @param {Array} steps GET /api/jobs/:id/steps 的 steps
 * @returns {{ stages: Array<{id,label,nodes:Array}>, nodes: object, current: string }}
 */
export function buildPipeline(job, steps) {
  const st = job.status;
  const latest = latestSteps(steps);
  const images = (job.files || []).filter(isImageName);
  const hasHeygen = (job.files || []).some((n) => /^heygen\.mp4$/i.test(n));
  const draft = st === 'draft';
  const submitted = !draft;
  const failedAt = st === 'failed';

  // ── 建立 ──
  const create = [
    { id: 'script', label: '稿件與標題', status: 'ok', note: (job.title || '').replace(/\n/g, ' ') || '（沒有標題）', panel: 'script' },
    { id: 'shots', label: '截圖',
      status: images.length ? 'ok' : (draft ? 'todo' : 'skipped'),
      note: images.length ? `${images.length} 張` : (draft ? '還沒上傳' : '沒有截圖'), panel: 'shots' },
    { id: 'voice', label: '唸法',
      status: (job.voiceRules && job.voiceRules.own && job.voiceRules.own.length) ? 'ok' : 'optional',
      note: (job.voiceRules && job.voiceRules.own && job.voiceRules.own.length) ? `${job.voiceRules.own.length} 條` : '選填', panel: 'voice' },
    { id: 'anchor', label: '講者影片與語氣',
      status: job.skipGenerate ? (hasHeygen ? 'ok' : (draft ? 'todo' : 'failed')) : 'ok',
      note: job.skipGenerate ? (hasHeygen ? '用現成的講者影片' : '還沒上傳 heygen.mp4') : '重新生成', panel: 'anchor' },
    { id: 'submit', label: '送出出片',
      status: submitted ? 'ok' : ((!job.skipGenerate || hasHeygen) ? 'ready' : 'todo'),
      note: submitted ? '已送出' : (job.redoOf ? '重新出片，確認後開始' : '檢查後按下開始出片'), panel: 'submit' },
  ];

  // ── 準備 ──
  const active = ['preparing', 'rendering', 'detached'].includes(st);
  const prepare = PREPARE_NODES.map((n) => {
    const { status, entries } = aggregate(n.steps, latest, active);
    let s = status;
    if (s === 'pending' && draft) s = 'pending';
    return { id: n.id, label: n.label, status: s, note: stepNote(entries), ms: msOf(entries), parallel: !!n.parallel, panel: 'step', steps: n.steps };
  });
  if (st === 'queued') prepare.forEach((n) => { if (n.status === 'pending') n.note = job.queuePosition > 0 ? `排隊中，前面還有 ${job.queuePosition} 支` : '排隊中'; });
  if (job.skipGenerate) { const g = prepare.find((n) => n.id === 'generate'); if (g.status === 'pending') { g.status = 'skipped'; g.note = '用現成的講者影片'; } }
  // 失敗了但沒有任何步驟記到（例如舊工作、或在步驟之外就炸了）→ 把錯誤掛在第一個還沒完成的節點上
  if (failedAt && !prepare.some((n) => n.status === 'failed') && !['approved', 'rendering'].includes(job.failedFrom || '')) {
    const first = prepare.find((n) => ['pending', 'running'].includes(n.status));
    if (first && !latest['render']) { first.status = 'failed'; first.note = job.error || '失敗'; }
  }

  // ── 人工確認 ──
  const annotatable = ANNOTATABLE.includes(st);
  const marksEditable = MARKS_EDITABLE.includes(st);
  const review = latest['review'];
  const reviewStatus = st === 'review' ? 'ready'
    : review ? (review.status === 'running' ? 'ready' : review.status === 'ok' ? 'ok' : review.status)
    : (['approved', 'rendering', 'done'].includes(st) ? (job.autoApprove && job.approvedBy === '（自動出片）' ? 'skipped' : 'ok') : 'pending');
  const confirm = [
    { id: 'annotate', label: '手動標記',
      status: annotatable ? 'ready' : (job.annotationCount ? 'ok' : 'skipped'),
      note: job.annotationCount ? `${job.annotationCount} 筆標注` : (annotatable ? '可以先標' : '沒有標注'), panel: 'annotate' },
    { id: 'review', label: '配圖計畫確認', status: reviewStatus,
      note: st === 'review' ? '計畫算好了，等你確認' : (reviewStatus === 'skipped' ? '標好了，直接出片' : (review && review.note) || (reviewStatus === 'ok' ? `已確認${job.approvedBy ? '：' + job.approvedBy : ''}` : '要等準備跑完')),
      panel: 'plan' },
    { id: 'emphasis', label: '字幕重點詞',
      status: job.emphasisCount ? 'ok' : (marksEditable ? 'optional' : 'skipped'),
      note: job.emphasisCount ? `已標 ${job.emphasisCount} 處` : '選填', panel: 'emphasis' },
    { id: 'motion', label: '動態小影片',
      status: job.motionCount ? 'ok' : (marksEditable ? 'optional' : 'skipped'),
      note: job.motionCount ? '已選一段' : '選填', panel: 'motion' },
  ];

  // ── 出片 ──
  const render = RENDER_NODES.map((n) => {
    const { status, entries } = aggregate(n.steps, latest, active);
    return { id: n.id, label: n.label, status, note: stepNote(entries), ms: msOf(entries), panel: 'step', steps: n.steps };
  });
  if (st === 'approved') render.forEach((n) => { if (n.status === 'pending') n.note = job.queuePosition > 0 ? `排隊等出片，前面還有 ${job.queuePosition} 支` : '排隊等出片'; });
  if (failedAt && !render.some((n) => n.status === 'failed') && latest['render-prep']) {
    const first = render.find((n) => ['pending', 'running'].includes(n.status));
    if (first) { first.status = 'failed'; first.note = job.error || '失敗'; }
  }

  // ── 成品 ──
  const outs = job.outputs || [];
  const output = [
    { id: 'outputs', label: '成品影片',
      status: st === 'done' ? (job.pruned ? 'warning' : (outs.length ? 'ok' : 'failed')) : 'pending',
      note: st === 'done' ? (job.pruned ? '部分檔案可能缺失' : (outs.length ? `${outs.length} 支` : '沒有成品檔')) : '', panel: 'outputs' },
    { id: 'report', label: '發音回報', status: st === 'done' ? 'optional' : 'pending', note: st === 'done' ? '聽到唸錯的字寫這裡' : '', panel: 'report' },
    { id: 'redo', label: '重新出片', status: ['done', 'failed'].includes(st) ? 'ready' : 'pending', note: ['done', 'failed'].includes(st) ? '不扣點數' : '', panel: 'redo' },
  ];

  if (st === 'cancelled') {
    for (const list of [prepare, confirm, render, output]) for (const n of list) if (['pending', 'running', 'ready', 'optional'].includes(n.status)) { n.status = 'cancelled'; n.note = n.note || '已取消'; }
  }

  const stages = [
    { ...STAGES[0], nodes: create },
    { ...STAGES[1], nodes: prepare },
    { ...STAGES[2], nodes: confirm },
    { ...STAGES[3], nodes: render },
    { ...STAGES[4], nodes: output },
  ];
  const nodes = {};
  for (const s of stages) for (const n of s.nodes) { n.stage = s.id; nodes[n.id] = n; }
  return { stages, nodes, current: currentNode(job, stages) };
}

/** 一進頁面右邊先開哪個節點：輪到人做的那一格優先，其次是正在跑的，再其次是出事的。 */
export function currentNode(job, stages) {
  const all = stages.flatMap((s) => s.nodes);
  const st = job.status;
  if (st === 'draft') {
    if (job.redoOf) return 'submit';
    return (all.find((n) => n.stage === 'create' && n.status === 'todo') || { id: 'submit' }).id;
  }
  if (st === 'review') return 'review';
  if (st === 'done') return 'outputs';
  if (st === 'failed') return (all.find((n) => n.status === 'failed') || { id: 'redo' }).id;
  if (st === 'approved') return 'review';
  if (['queued', 'preparing', 'detached'].includes(st)) return 'annotate';
  const running = all.find((n) => n.status === 'running');
  if (running) return running.id;
  return 'script';
}

/** 階段整體的狀態（階段標頭的顏色）。 */
export function stageStatus(stage) {
  const s = stage.nodes.map((n) => n.status);
  if (s.includes('failed')) return 'failed';
  if (s.includes('running')) return 'running';
  if (s.includes('ready') || s.includes('todo')) return 'ready';
  if (s.every((x) => ['ok', 'skipped', 'warning', 'optional'].includes(x))) return s.includes('warning') ? 'warning' : 'ok';
  if (s.includes('cancelled')) return 'cancelled';
  return 'pending';
}
