'use strict';

/**
 * 模擬模式端對端（npm run e2e）：在隔離工作區開一個 WORKBENCH_MOCK=1 的工作台，
 * 照前台的順序打 API —— 建工作 → 上傳截圖 → 送出 → 等配圖計畫 → 確認 → 等出片 ——
 * 最後下載成品、用 ffprobe 檢查長度與畫面尺寸。
 *
 * 會真的跑 ffmpeg 與 Remotion 渲染（約 1～3 分鐘），不呼叫任何付費 API、不碰正式工作與 .run.lock。
 *   npm run e2e [-- --template=<版型>] [--keep]   --keep 留下隔離工作區方便查看
 */
const fs = require('node:fs');
const path = require('node:path');
const { fork, execFileSync } = require('node:child_process');
const { createSandbox } = require('./sandbox');
const { IDS, getTemplate } = require('../video/templates/registry');

const SCRIPT_BODY = '今天台股上漲兩百點，台積電(image1)領軍走強(image1)。外資買超百億，電子股全面翻紅。';
const STEP_TIMEOUT_MS = 10 * 60 * 1000;

/** @param {string[]} argv */
function parseArgs(argv) {
  const template = (argv.find((a) => a.startsWith('--template=')) || '--template=midday').slice('--template='.length);
  if (!IDS.includes(template)) throw new Error(`不認得的版型：${template}（可用：${IDS.join('、')}）`);
  return { template, keep: argv.includes('--keep') };
}

/** 在隔離工作區啟動工作台，回傳 port 與停止方法。 @param {ReturnType<typeof createSandbox>} sb */
async function startServer(sb) {
  const bootstrap = sb.path('e2e-server.cjs');
  fs.writeFileSync(bootstrap, "const server = require('./server/start');\nserver.on('listening', () => process.send({ port: server.address().port }));\n");
  const child = fork(bootstrap, [], {
    cwd: sb.dir,
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', ADMIN_KEY: '', WORKBENCH_MOCK: '1' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk.toString(); });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('隔離工作台啟動逾時')), 15000);
    child.once('message', (m) => { clearTimeout(timer); resolve(m.port); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`隔離工作台提前結束：${code} ${errors}`)); });
  });
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(undefined);
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
  return { port, stop };
}

/** @param {number} port */
function client(port) {
  const base = `http://127.0.0.1:${port}`;
  /** @param {string} method @param {string} url @param {unknown} [body] */
  return async function api(method, url, body) {
    const res = await fetch(base + url, {
      method,
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const type = res.headers.get('content-type') || '';
    const data = type.startsWith('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
}

/**
 * 輪詢到工作進入期望狀態；失敗就把執行記錄最後幾行帶出來。
 * @param {ReturnType<typeof client>} api @param {string} id @param {string} want
 */
async function waitFor(api, id, want) {
  const until = Date.now() + STEP_TIMEOUT_MS;
  for (;;) {
    const { jobs } = await api('GET', '/api/jobs');
    const job = jobs.find((/** @type {any} */ j) => j.id === id);
    if (job && job.status === want) return job;
    if (job && ['failed', 'cancelled'].includes(job.status) || Date.now() > until) {
      const log = await api('GET', `/api/jobs/${id}/log`).catch(() => ({}));
      const tail = String(log.log || log.text || JSON.stringify(log)).split('\n').slice(-40).join('\n');
      throw new Error(`工作停在 ${job ? job.status : '（找不到）'}，等不到 ${want}：${job && job.error || ''}\n${tail}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** @param {string} file */
function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  const j = JSON.parse(out);
  return { width: j.streams[0].width, height: j.streams[0].height, duration: Number(j.format.duration) };
}

async function main(argv) {
  const { template, keep } = parseArgs(argv);
  const tpl = getTemplate(template);
  const started = Date.now();
  const step = (/** @type {string} */ m) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`);

  const sb = createSandbox({ env: { WORKBENCH_MOCK: '1' }, prefix: 'workbench-e2e-' });
  step(`隔離工作區：${sb.dir}`);
  const server = await startServer(sb);
  try {
    const api = client(server.port);
    const health = await api('GET', '/api/health');
    if (!health.mock) throw new Error('工作台沒有進入模擬模式（/api/health 的 mock 不是 true）');
    step(`工作台已啟動（port ${server.port}，模擬模式）`);

    const { job } = await api('POST', '/api/jobs', { template, owner: 'e2e', title: '模擬端對端', body: SCRIPT_BODY });
    const png = sb.path('e2e-shot.png');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=750x1334', '-frames:v', '1', png]);
    await api('POST', `/api/jobs/${job.id}/upload?name=image1.png`, fs.readFileSync(png));
    await api('POST', `/api/jobs/${job.id}/submit`);
    step(`已送出工作 ${job.id}（${tpl.label}），等配圖計畫…`);

    await waitFor(api, job.id, 'review');
    step('配圖計畫完成，確認出片…');
    await api('POST', `/api/jobs/${job.id}/approve`, { edits: [], by: 'e2e' });

    const done = await waitFor(api, job.id, 'done');
    const outputs = done.outputs || [];
    if (outputs.length !== tpl.outputs.length) throw new Error(`成品數量不對：預期 ${tpl.outputs.length}，實際 ${outputs.length}`);
    for (const o of outputs) {
      const file = sb.path(`e2e-${o.name}`);
      fs.writeFileSync(file, await api('GET', `/api/jobs/${job.id}/file/${encodeURIComponent(o.name)}`));
      const info = probe(file);
      if (!(info.duration > 2)) throw new Error(`${o.name} 長度不對：${info.duration}`);
      step(`✅ ${o.name}：${info.width}x${info.height}、${info.duration.toFixed(2)} 秒、${(o.size / 1024).toFixed(0)} KB`);
    }
    step('端對端通過：建立 → 上傳 → 模擬生成 → 配圖計畫 → 確認 → 渲染 → 下載');
  } finally {
    await server.stop();
    if (keep) console.log(`保留隔離工作區：${sb.dir}`);
    else sb.cleanup();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => { console.error(`❌ ${e.message}`); process.exitCode = 1; });
}

module.exports = { parseArgs, probe };
