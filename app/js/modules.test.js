// @vitest-environment jsdom

import { el, api, fmt } from './dom.js';
import { arrowShownWidth, arrowShaftPx, shotGuideLines, hasArrow, arrowSVG, SHOT_W, ARROW_CANVAS_W } from './arrows.js';
import { statusText } from './status.js';
import { toggleEmph, isEmph, charsCoveredBy, inPreview } from './emphasis.js';
import { S, EMOTIONS } from './state.js';

describe('dom', () => {
  test('el：class／html／事件／屬性，null 與 false 的屬性不設', () => {
    const clicks = [];
    const n = el('button', { class: 'go', onclick: () => clicks.push(1), title: 't', hidden: false, 'data-k': null }, '送出', [el('b', {}, '!')], null);
    n.click();
    expect(n.outerHTML).toBe('<button class="go" title="t">送出<b>!</b></button>');
    expect(clicks).toEqual([1]);
    expect(el('div', { html: '<i>x</i>' }).innerHTML).toBe('<i>x</i>');
  });

  test('api：失敗時把狀態碼與回應內容一起帶上（呼叫端要看 short／clash 決定能不能 force 重送）', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: '兩個字', short: true }) }));
    const e = await api('/api/pronounce').catch((x) => x);
    expect([e.message, e.status, e.data.short]).toEqual(['兩個字', 400, true]);
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 502, json: async () => { throw new Error('不是 JSON'); } }));
    expect((await api('/x').catch((x) => x)).message).toBe('HTTP 502');
  });

  test('fmt 秒數', () => {
    expect(fmt(null)).toBe('—');
    expect(fmt(1.26)).toBe('1.3s');
  });
});

describe('arrows（跟成品 ShotFocus 的擺法一致）', () => {
  test('圈了顯示區域：放大到固定寬度；沒圈：接近直式就滿版，否則整張放成固定寬', () => {
    expect(arrowShownWidth(2000, 1000, { x: 0, y: 0, w: 500, h: 400 })).toBe(2000 * SHOT_W / 500);
    expect(arrowShownWidth(1080, 1920)).toBe(ARROW_CANVAS_W);   // 手機截圖滿版
    expect(arrowShownWidth(1600, 900)).toBe(SHOT_W);            // 橫的圖放成固定寬
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

  test('hasArrow 與 SVG', () => {
    expect(hasArrow({ x1: 0, y1: 0, x2: 0, y2: 0 })).toBe(false);
    expect(hasArrow({ x1: 0, y1: 0, x2: 3, y2: 4 })).toBe(true);
    expect(hasArrow(null)).toBe(false);
    const svg = arrowSVG(200, 100, 10, 10, 90, 50, '#00C853', 4);
    expect(svg.getAttribute('viewBox')).toBe('0 0 200 100');
    expect(svg.innerHTML).toContain('#00C853');
  });
});

describe('status', () => {
  test('重新出片停在 draft 的顯示「等你確認」；不認得的狀態原樣顯示', () => {
    expect(statusText({ status: 'draft' })).toBe('建立中');
    expect(statusText({ status: 'draft', redoOf: 'x' })).toBe('等你確認');
    expect(statusText({ status: 'detached-done' })).toBe('已在背景跑完');
    expect(statusText({ status: 'weird' })).toBe('weird');
  });
});

describe('字幕重點詞（跟伺服器 normalizeEmphasis 同一條合併規則）', () => {
  beforeEach(() => { S.EMPH = []; });

  test('新增會連相鄰的一起併；單點在已標的字上是整段取消', () => {
    toggleEmph(5, 3);
    toggleEmph(6, 8);   // 相鄰 → 併成 3~8
    toggleEmph(20, 22);
    expect(S.EMPH).toEqual([{ startCharIdx: 3, endCharIdx: 8 }, { startCharIdx: 20, endCharIdx: 22 }]);
    expect(isEmph(4)).toBe(true);
    toggleEmph(4, 4);
    expect(S.EMPH).toEqual([{ startCharIdx: 20, endCharIdx: 22 }]);
    toggleEmph(9, 9);   // 點旁邊沒標的字不會刪掉別段
    expect(S.EMPH).toHaveLength(2);
  });

  test('charsCoveredBy 略過刪掉的段與沒有範圍的段；inPreview', () => {
    expect([...charsCoveredBy([{ startCharIdx: 3, endCharIdx: 1 }, { deleted: true, startCharIdx: 9, endCharIdx: 9 }, { src: 'x' }])]).toEqual([1, 2, 3]);
    expect(inPreview({ lo: 1, hi: 2 }, 2)).toBe(true);
    expect(inPreview(null, 2)).toBe(false);
  });
});

test('語氣選項的第一個是預設（state 初始值）', () => {
  expect(EMOTIONS[0][0]).toBe('fluent');
});
