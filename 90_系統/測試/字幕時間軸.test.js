'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createEngine, shiftTimes } = require('../應用程式/scripts/transcription-engine');

// 2026-09-16 出片事故：whisper 把 24.72 秒那句的結束時間報成 36.56 秒（那句只有 22 個字），
// 之後整條字幕落後語音 8 秒，結尾 49 個字全擠在最後 0.19 秒 —— 成品是「字幕上到一半就不動了，
// 最後一瞬間閃過」，而整條 pipeline 一聲不吭照樣出片。
// 這個檔案綁住事後補的兩道防線：
//   ① correct-subtitles 出片前會判定時間軸壞掉並用 exit 3 擋下來
//   ② 重轉時墊靜音換 whisper 的 30 秒 window 邊界，墊進去的時間要減得回來
// （whisper.cpp 在這裡是確定性的：同一個音檔跑三次結果完全相同，原樣重轉一定再壞一次。
//  實測改 beam-size／threads／max-len 都無效，只有墊靜音有效。）

const APP = path.join(__dirname, '..', '應用程式');

// ── 墊靜音：時間戳要減得回來 ────────────────────────────

test('墊了幾秒靜音就要減回幾秒，負的一律當 0', () => {
  const result = {
    language: 'zh',
    segments: [{
      id: 0, text: '測試', start: 0.5, end: 2.0,
      words: [
        { word: '測', start: 0.5, end: 1.2 },   // 墊進去那段裡的字：減完會變負數 → 夾成 0
        { word: '試', start: 1.2, end: 2.0 },
      ],
    }],
  };
  shiftTimes(result, 0.5);
  assert.equal(result.segments[0].start, 0);
  assert.equal(result.segments[0].end, 1.5);
  assert.deepEqual(result.segments[0].words.map((w) => [w.start, w.end]), [[0, 0.7], [0.7, 1.5]]);
});

test('沒墊靜音就不動時間戳，padSec 不收負數', () => {
  const untouched = { segments: [{ id: 0, text: 'x', start: 1, end: 2, words: [{ word: 'x', start: 1, end: 2 }] }] };
  assert.equal(shiftTimes(untouched, 0).segments[0].start, 1);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-'));
  try {
    const model = path.join(dir, 'ggml-base-q5_1.bin');
    fs.writeFileSync(model, 'synthetic-model');
    const engine = createEngine('whisper-cpp', () => {}, { binary: 'whisper-cli', model });
    assert.throws(() => engine.transcribe('/synthetic/in.wav', dir, { padSec: -1 }), /負數/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Adapter 吃 padSec：whisper 回來的時間戳寫出去之前就已經減回原本的時間軸', () => {
  const raw = { result: { language: 'zh' }, transcription: [{
    text: '你好', offsets: { from: 700, to: 1700 },
    tokens: [{ text: '你好', offsets: { from: 700, to: 1700 }, p: 0.9 }],
  }] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-engine-'));
  try {
    const model = path.join(dir, 'ggml-base-q5_1.bin');
    fs.writeFileSync(model, 'synthetic-model');
    const engine = createEngine('whisper-cpp', (cmd, args) => {
      if (args.includes('--output-file')) {
        fs.writeFileSync(args[args.indexOf('--output-file') + 1] + '.json', JSON.stringify(raw));
      }
    }, { binary: 'whisper-cli', model });
    const result = engine.transcribe('/synthetic/in.wav', dir, { padSec: 0.5 });
    assert.equal(result.segments[0].words[0].start, 0.2); // 0.7 − 0.5
    assert.equal(result.segments[0].words[0].end, 1.2);
    // 寫到磁碟的那份也要是減回去之後的，不然下游讀檔的人拿到的字幕整體慢 0.5 秒
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'in.json'), 'utf8')).segments[0].words[0].start, 0.2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── 出片前的時間軸檢查 ──────────────────────────────────

/** 造一個只有 correct-subtitles 需要的檔案的假工作區，跑一次，回傳 { code, out }。 */
function runCorrect(body, segments) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subcheck-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    for (const name of ['correct-subtitles.js', 'script-utils.js', 'subtitles-replacements.json']) {
      fs.copyFileSync(path.join(APP, 'scripts', name), path.join(dir, 'scripts', name));
    }
    // script.txt 的格式：發音詞庫 === === 標題 === 內文
    fs.writeFileSync(path.join(dir, 'public', 'script.txt'), ['', '===', '===', '標題', '===', body, ''].join('\n'));
    fs.writeFileSync(path.join(dir, 'src', 'subtitles.json'), JSON.stringify({
      language: 'zh', text: segments.map((s) => s.text).join(''), segments,
    }));
    try {
      const out = execFileSync('node', [path.join(dir, 'scripts', 'correct-subtitles.js')], { encoding: 'utf8', stdio: 'pipe' });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** 一個字一顆 word 的正常 whisper 輸出。 */
function evenSegment(id, text, start, perChar) {
  const words = [...text].map((c, i) => ({
    word: c, start: Number((start + i * perChar).toFixed(3)), end: Number((start + (i + 1) * perChar).toFixed(3)), probability: 0.9,
  }));
  return { id, text, start, end: words[words.length - 1].end, words };
}

const BODY30 = '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌';

test('時間軸正常的字幕照樣寫回去，不會被誤擋', () => {
  const { code, out } = runCorrect(BODY30, [
    evenSegment(0, BODY30.slice(0, 10), 0, 0.3),
    evenSegment(1, BODY30.slice(10, 20), 3, 0.3),
    evenSegment(2, BODY30.slice(20, 30), 6, 0.3),
  ]);
  assert.equal(code, 0, out);
  assert.match(out, /Forced alignment 完成/);
});

test('whisper 少轉一大段 → 稿件剩下的字全擠在最後一顆 word，要擋下來', () => {
  // whisper 只聽出前 11 個字就結束（真實事故就是這樣：音檔時間用完，稿件還剩 49 個字）。
  // 剩下 19 個字會被「附給時間上最近的 word」規則全部掛到最後那顆 0.1 秒的 word 上。
  const { code, out } = runCorrect(BODY30, [evenSegment(0, BODY30.slice(0, 11), 0, 0.3)]);
  assert.equal(code, 3, out);
  assert.match(out, /字幕時間軸壞掉/);
  assert.match(out, /最後 \d+ 個字/);
  assert.match(out, /全部擠在/);
  // 訊息要講得出「觀眾會看到什麼」，不是只丟一句對齊失敗
  assert.match(out, /之後就不動/);
  assert.match(out, /一瞬間全部閃過/);
});

test('whisper 把某句的結束時間報過頭（秒數對不上字數）→ 要擋下來', () => {
  // 事故指紋：24.72 秒那句只有 22 個字卻被報成撐到 36.56 秒（每字 0.54 秒，正常約 0.15）。
  const body = '一二三四五六七八九十';
  const { code, out } = runCorrect(body, [evenSegment(0, body, 0, 1.2)]); // 10 字 12 秒
  assert.equal(code, 3, out);
  assert.match(out, /結束時間報成/);
  assert.match(out, /正常約 0\.15/);
});

test('擠成一團的位置在中間時，訊息要講對位置，不能一律說「最後」', () => {
  // whisper 中間漏聽一整段（前 5 字、後 5 字各聽到一次）→ 中間那 20 個字會被
  // 「附給時間上最近的 word」規則堆到第 5 個字上，團塊在中間而不是結尾。
  const { code, out } = runCorrect(BODY30, [
    evenSegment(0, BODY30.slice(0, 5), 0, 0.3),
    evenSegment(1, BODY30.slice(25, 30), 10, 0.3),
  ]);
  assert.equal(code, 3, out);
  assert.match(out, /第 \d+～\d+ 個字（共 \d+ 個）/);
  assert.doesNotMatch(out.split('・')[1] || out, /^最後/);
});

test('第一個字就跟不上時，不要印出空的「停在「」之後」', () => {
  // whisper 只聽出一個字 → 整份稿件都堆在那顆 word 上，團塊從第 1 個字就開始。
  const { code, out } = runCorrect(BODY30, [evenSegment(0, BODY30.slice(0, 1), 0, 0.1)]);
  assert.equal(code, 3, out);
  assert.match(out, /從頭就跟不上語音/);
  assert.doesNotMatch(out, /停在「」/);
});

test('判定失敗時不能把半成品寫回 subtitles.json', () => {
  const { out } = runCorrect(BODY30, [evenSegment(0, BODY30.slice(0, 11), 0, 0.3)]);
  assert.match(out, /沒有寫回 subtitles\.json/);
});

// ── 重轉階梯 ────────────────────────────────────────────

test('重轉階梯：第一次不墊靜音（維持原本行為），後面每次墊不同秒數', () => {
  const src = fs.readFileSync(path.join(APP, 'run.js'), 'utf8');
  const m = src.match(/const SUBTITLE_PAD_LADDER = \[([^\]]+)\]/);
  assert.ok(m, 'run.js 找不到 SUBTITLE_PAD_LADDER');
  const ladder = m[1].split(',').map((s) => Number(s.trim()));
  assert.equal(ladder[0], 0, '第一次一定不能墊 —— 墊了等於改掉所有影片的字幕結果');
  assert.equal(new Set(ladder).size, ladder.length, '每次墊的秒數要不一樣，墊一樣的等於原樣重轉（whisper 是確定性的）');
  // 2026-09-17 使用者定案：總共只轉兩次，連兩次都壞就停下來交給人，不自動跑第三次。
  // 要改這個數字得是新的決定，不是順手調參。
  assert.deepEqual(ladder, [0, 0.5]);
  // 只有「時間軸判定失敗」(exit 3) 才重轉，其他錯誤照舊往上丟
  assert.match(src, /e\.status !== 3/);
});

test('transcribe.sh 的 --pad 會一路傳到 Adapter，時長偵測不受影響', () => {
  const sh = fs.readFileSync(path.join(APP, 'scripts', 'transcribe.sh'), 'utf8');
  assert.match(sh, /--pad=\*\)\s*PAD_SEC=/, '要認得 --pad= 參數');
  assert.match(sh, /adelay=\$\{PAD_MS\}\|\$\{PAD_MS\}/, '要用 ffmpeg adelay 墊在音檔前面');
  assert.match(sh, /transcription-engine\.js.*--pad=\$PAD_SEC/, '墊了多少要告訴 Adapter，它才減得回來');
  // 影片時長是拿原始 mp4 量的，不能受墊靜音影響 —— 不然 video-meta 會比影片長
  assert.match(sh, /ffprobe -v error -show_entries format=duration -of csv=p=0 "\$INPUT"/);
});

test('秒轉毫秒用 awk（救場路徑不該多綁一個直譯器），而且不會被浮點誤差少 1 毫秒', () => {
  const sh = fs.readFileSync(path.join(APP, 'scripts', 'transcribe.sh'), 'utf8');
  assert.match(sh, /PAD_MS=\$\(awk /);
  assert.doesNotMatch(sh, /PAD_MS=\$\(python3/);
  for (const [sec, ms] of [['0.5', '500'], ['1.2', '1200'], ['0.05', '50'], ['2', '2000']]) {
    assert.equal(execFileSync('awk', [`BEGIN { printf "%d", ${sec} * 1000 + 0.5 }`], { encoding: 'utf8' }), ms);
  }
});
