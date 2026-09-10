'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { applicationPath } = require('../paths');
const { generated } = require('./init');

function inspect(root) {
  const checks = [];
  const add = (name, ok, level = 'required') => checks.push({ name, ok: !!ok, level });
  add('Node.js 24', Number(process.versions.node.split('.')[0]) === 24);
  const requireApp = createRequire(applicationPath(root, 'package.json'));
  for (const name of ['typescript', '@remotion/bundler', 'dotenv']) {
    try { requireApp.resolve(name); add(`套件 ${name}`, true); } catch (_) { add(`套件 ${name}（npm run setup）`, false); }
  }
  add('初始化結構（npm run init）', Object.keys(generated).every((name) => fs.existsSync(applicationPath(root, 'src', name))));
  let config = { ...process.env };
  try { config = { ...requireApp('dotenv').parse(fs.readFileSync(path.join(root, '.env'))), ...process.env }; } catch (_) {}
  // 不印設定值或憑證，只回報是否存在。
  add('.env 設定檔', fs.existsSync(path.join(root, '.env')));
  for (const command of ['ffmpeg', 'ffprobe', 'whisper', 'python3']) {
    const args = command === 'whisper' ? ['--help'] : ['-version'];
    if (command === 'python3') args[0] = '--version';
    const result = spawnSync(command, args, { stdio: 'ignore', timeout: 15000 });
    add(`出片工具 ${command}`, result.status === 0, 'production');
  }
  add('字幕引擎設定有效', (config.TRANSCRIPTION_ENGINE || 'whisper') === 'whisper', 'production');
  const engine = (config.OCR_ENGINE || 'tesseract').toLowerCase();
  add('OCR 引擎設定有效', ['tesseract', 'vision'].includes(engine), 'production');
  if (engine === 'vision') add('Apple Vision 與 Swift 編譯器', process.platform === 'darwin' && spawnSync('swiftc', ['--version'], { stdio: 'ignore', timeout: 15000 }).status === 0, 'production');
  else {
    const languages = spawnSync('tesseract', ['--list-langs'], { encoding: 'utf8', timeout: 15000 });
    add('Tesseract 與 chi_tra 語言資料', languages.status === 0 && /\bchi_tra\b/.test(languages.stdout || ''), 'production');
  }
  add('新生成講者：HeyGen 與 MiniMax 憑證', config.HEYGEN_API_KEY && config.MINIMAX_API_KEY && config.MINIMAX_GROUP_ID, 'optional');
  add('遠端管理金鑰已設定', config.ADMIN_KEY, 'optional');
  return checks;
}

if (require.main === module) {
  const checks = inspect(path.resolve(__dirname, '../..'));
  for (const check of checks) console.log(`${check.ok ? 'OK' : check.level === 'required' ? '缺少' : '待設定'} [${check.level}] ${check.name}`);
  console.log('檢查不驗證 API 金鑰有效性、不下載模型，也不呼叫付費服務。');
  process.exitCode = checks.some((c) => !c.ok && (c.level === 'required' || (process.argv.includes('--production') && c.level === 'production'))) ? 1 : 0;
}
module.exports = { inspect };
