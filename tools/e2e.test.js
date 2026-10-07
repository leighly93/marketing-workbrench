'use strict';

const { parseArgs } = require('./e2e');

describe('parseArgs', () => {
  test('預設盤中焦點、不保留工作區', () => {
    expect(parseArgs([])).toEqual({ template: 'midday', keep: false });
    expect(parseArgs(['--template=dapan', '--keep'])).toEqual({ template: 'dapan', keep: true });
  });

  test('不認得的版型在開工前擋下', () => {
    expect(() => parseArgs(['--template=institution'])).toThrow(/不認得的版型/);
  });
});
