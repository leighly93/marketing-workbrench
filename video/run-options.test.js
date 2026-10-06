'use strict';

const { parseRunOptions } = require('./run-options');

describe('parseRunOptions', () => {
  test('前台送的參數組合', () => {
    const o = parseRunOptions(['--template=dapan', '--stop-before-render', '--skip-generate', '--no-speed', '--emotion=happy']);
    expect(o).toMatchObject({ template: 'dapan', stopBeforeRender: true, skipGenerate: true, noSpeed: true, renderOnly: false,
      heygenVoice: false, emotion: 'happy', engine: 'avatar_iv' });
    expect(o.tpl.label).toBe('大盤小報');
  });

  test('預設情緒 fluent；--emotion= 空值＝讓 MiniMax 自動挑；--avatar-iii 換引擎', () => {
    expect(parseRunOptions(['--template=midday']).emotion).toBe('fluent');
    expect(parseRunOptions(['--template=midday', '--emotion=']).emotion).toBe('');
    expect(parseRunOptions(['--template=midday', '--avatar-iii']).engine).toBe('avatar_iii');
  });

  test('版型必填、要認得；情緒要合法', () => {
    expect(() => parseRunOptions([])).toThrow(/未指定/);
    expect(() => parseRunOptions(['--template=institution'])).toThrow(/不認得的版型/);
    expect(() => parseRunOptions(['--template=dapan', '--emotion=neutral'])).toThrow(/不認得的 --emotion/);
  });

  test('舊工作帶來的已移除旗標照樣收下、不報錯', () => {
    expect(() => parseRunOptions(['--template=usstock', '--with-ad', '--brand=x', '--minimax', '--simp', '--heygen-v2', '--no-simp'])).not.toThrow();
  });
});
