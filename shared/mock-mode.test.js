'use strict';

const { isMockMode, engineName } = require('./mock-mode');

describe('isMockMode', () => {
  test('只有明確打開才算', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' 1 ']) expect(isMockMode({ WORKBENCH_MOCK: v })).toBe(true);
    for (const v of [undefined, '', '0', 'false', 'off', 'no', 'mock']) expect(isMockMode({ WORKBENCH_MOCK: v })).toBe(false);
  });
});

describe('engineName', () => {
  test('模擬模式蓋過個別引擎設定；否則用設定或預設', () => {
    expect(engineName('OCR_ENGINE', 'tesseract', { WORKBENCH_MOCK: '1', OCR_ENGINE: 'vision' })).toBe('mock');
    expect(engineName('OCR_ENGINE', 'tesseract', { OCR_ENGINE: 'vision' })).toBe('vision');
    expect(engineName('OCR_ENGINE', 'tesseract', {})).toBe('tesseract');
  });
});
