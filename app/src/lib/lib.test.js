// @vitest-environment jsdom

import { api, fmt } from './api.js';
import { arrowShownWidth, arrowShaftPx, shotGuideLines, hasArrow, arrowSVG, arrowGeometry, SHOT_W, ARROW_CANVAS_W } from './arrows.js';
import { statusText, FINISHED } from './status.js';
import { toggleEmph, isEmph, charsCoveredBy, inPreview, charSecOf } from './emphasis.js';
import { EMOTIONS, voiceProblem, voiceText, voiceRows, voiceDupes } from './voice.js';
import { isShotFile, nextShotName } from './files.js';

describe('api', () => {
  test('失敗時把狀態碼與回應內容一起帶上（呼叫端要看 short／clash 決定能不能 force 重送）', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: '兩個字', short: true }) }));
    const e = await api('/api/pronounce').catch((x) => x);
    expect([e.message, e.status, e.data.short]).toEqual(['兩個字', 400, true]);
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 502, json: async () => { throw new Error('不是 JSON'); } }));
    expect((await api('/x').catch((x) => x)).message).toBe('HTTP 502');
  });
  test('fmt 秒數', () => { expect(fmt(null)).toBe('—'); expect(fmt(1.26)).toBe('1.3s'); });
});

describe('arrows（跟成品 ShotFocus 的擺法一致）', () => {
  test('圈了顯示區域：放大到固定寬度；沒圈：接近直式就滿版，否則整張放成固定寬', () => {
    expect(arrowShownWidth(2000, 1000, { x: 0, y: 0, w: 500, h: 400 })).toBe(2000 * SHOT_W / 500);
    expect(arrowShownWidth(1080, 1920)).toBe(ARROW_CANVAS_W);
    expect(arrowShownWidth(1600, 900)).toBe(SHOT_W);
    expect(arrowShownWidth(0, 0)).toBe(ARROW_CANVAS_W);
    expect(arrowShaftPx(SHOT_W / 2, 1600, 900)).toBeCloseTo(5.5);
  });
  test('參考線：滿版圖不畫；扁的圖整塊在字幕上方也不畫；長圖會畫兩條', () => {
    expect(shotGuideLines(1080, 1920)).toEqual([]);
    expect(shotGuideLines(1600, 400)).toEqual([]);
    const lines = shotGuideLines(1000, 2000, { x: 0, y: 0, w: 1000, h: 2000 });
    expect(lines.map((l) => l.cut)).toEqual([false, true]);
    expect(lines[0].y).toBeLessThan(lines[1].y);
  });
  test('hasArrow、SVG 與 template 用的幾何同一套', () => {
    expect(hasArrow({ x1: 0, y1: 0, x2: 0, y2: 0 })).toBe(false);
    expect(hasArrow({ x1: 0, y1: 0, x2: 3, y2: 4 })).toBe(true);
    expect(hasArrow(null)).toBe(false);
    const svg = arrowSVG(200, 100, 10, 10, 90, 50, '#00C853', 4);
    expect(svg.getAttribute('viewBox')).toBe('0 0 200 100');
    expect(svg.innerHTML).toContain('#00C853');
    const g = arrowGeometry(200, 100, 10, 10, 90, 50, '#00C853', 4);
    expect(svg.innerHTML).toContain(`points="${g.points}"`);
    expect(svg.innerHTML).toContain(g.transform);
  });
});

describe('status', () => {
  test('重新出片停在 draft 的顯示「等你確認」；不認得的狀態原樣顯示', () => {
    expect(statusText({ status: 'draft' })).toBe('草稿');
    expect(statusText({ status: 'draft', redoOf: 'x' })).toBe('等你確認');
    expect(statusText({ status: 'detached-done' })).toBe('已在背景跑完');
    expect(statusText({ status: 'weird' })).toBe('weird');
    expect(FINISHED).toEqual(['done', 'failed', 'cancelled']);
  });
});

describe('字幕重點詞（跟伺服器 normalizeEmphasis 同一條合併規則）', () => {
  test('新增會連相鄰的一起併；單點在已標的字上是整段取消', () => {
    let m = toggleEmph([], 5, 3);
    m = toggleEmph(m, 6, 8);   // 相鄰 → 併成 3~8
    m = toggleEmph(m, 20, 22);
    expect(m).toEqual([{ startCharIdx: 3, endCharIdx: 8 }, { startCharIdx: 20, endCharIdx: 22 }]);
    expect(isEmph(m, 4)).toBe(true);
    m = toggleEmph(m, 4, 4);
    expect(m).toEqual([{ startCharIdx: 20, endCharIdx: 22 }]);
    m = toggleEmph(m, 9, 9);   // 點旁邊沒標的字不會刪掉別段
    expect(m).toHaveLength(2);
  });
  test('charsCoveredBy 略過刪掉的段與沒有範圍的段；inPreview；charSecOf', () => {
    expect([...charsCoveredBy([{ startCharIdx: 3, endCharIdx: 1 }, { deleted: true, startCharIdx: 9, endCharIdx: 9 }, { src: 'x' }])]).toEqual([1, 2, 3]);
    expect(inPreview({ lo: 1, hi: 2 }, 2)).toBe(true);
    expect(inPreview(null, 2)).toBe(false);
    expect(charSecOf([{ start: 0, end: 2, startCharIdx: 0, endCharIdx: 9 }])).toBeCloseTo(0.2);
    expect(charSecOf([{ start: 0, end: 2, startCharIdx: 0, endCharIdx: 3 }])).toBe(null);
  });
});

describe('唸法', () => {
  test('語氣選項的第一個是預設', () => { expect(EMOTIONS[0][0]).toBe('fluent'); });
  test('組字串、拆回來、重複與檢查', () => {
    const rows = [{ from: '收斂', to: '收練' }, { from: ' ', to: '' }, { from: '收斂', to: '收連' }];
    expect(voiceText(rows)).toBe('收斂→收練\n收斂→收連');
    expect(voiceRows(['收斂→收練'])).toEqual([{ from: '收斂', to: '收練' }]);
    expect(voiceRows([])).toEqual([{ from: '', to: '' }]);
    expect([...voiceDupes(rows)]).toEqual([2]);
    expect(voiceProblem(rows)).toMatch(/重複/);
    expect(voiceProblem([{ from: 'a', to: '' }])).toMatch(/只填了/);
    expect(voiceProblem([{ from: 'a->b', to: 'c' }])).toMatch(/箭頭/);
    expect(voiceProblem([{ from: '#x', to: 'y' }])).toMatch(/註解/);
    expect(voiceProblem([{ from: 'x', to: 'x' }])).toMatch(/一模一樣/);
    expect(voiceProblem([{ from: '', to: '' }])).toBe(null);
  });
});

describe('檔案', () => {
  test('截圖判斷不只看 MIME；編號接在既有最大號後面', () => {
    expect(isShotFile({ type: '', name: 'a.HEIC' })).toBe(true);
    expect(isShotFile({ type: 'video/mp4', name: 'a.mp4' })).toBe(false);
    expect(nextShotName(['shot1.png', 'shot3.jpg', 'heygen.mp4'], { name: 'x.jpeg' })).toBe('shot4.jpg');
    expect(nextShotName([], { name: 'x.png' })).toBe('shot1.png');
  });
});
