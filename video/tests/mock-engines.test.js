'use strict';

// 模擬模式的 OCR 與動態引擎：介面與正式引擎一致、不呼叫任何外部程式。
const { ENGINES: OCR_ENGINES } = require('../shots/ocr-engine');
const motionEngine = require('../pipeline/motion-engine');

describe('OCR mock 引擎', () => {
  test('方法與 tesseract／vision 相同，什麼字都讀不到', () => {
    const { mock, tesseract } = OCR_ENGINES;
    for (const name of ['ensure', 'ocrDigits', 'ocrPage', 'ocrCrop']) expect(typeof mock[name]).toBe(typeof tesseract[name]);
    expect(mock.ensure()).toBeUndefined();
    expect(mock.ocrPage('x.png')).toEqual({ words: [], lines: [] });
    expect(mock.ocrCrop('x.png', [0, 0, 1, 1], 2)).toBe('');
    expect(mock.ocrDigits('x.png')).toEqual([]);
  });
});

describe('動態 mock 引擎', () => {
  test('WORKBENCH_MOCK=1 蓋過 MOTION_ENGINE，不呼叫 claude', () => {
    const spec = motionEngine.plan({ text: '外資買超，台股大漲兩百點' }, { WORKBENCH_MOCK: '1', MOTION_ENGINE: 'claude-cli' });
    expect(spec).toEqual({ template: 'quote', kicker: '模擬動態', lines: [[{ t: '外資買超台股大漲兩', c: 'hl' }]] });
  });

  test('前台貼了合格參數就用它；沒文字也沒參數就不做動態', () => {
    const manualSpec = { template: 'contrast', negative: '傳統', positives: ['新'] };
    expect(motionEngine.plan({ text: '隨便', manualSpec }, { WORKBENCH_MOCK: '1' })).toMatchObject(manualSpec);
    expect(motionEngine.plan({ text: '，。' }, { WORKBENCH_MOCK: '1' })).toBeNull();
  });
});
