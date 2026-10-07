'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { unitWorkbench } = require('../tests/unit-workbench');

describe('voice rules', () => {
  test('語氣只收白名單，其他一律預設 fluent', (t) => {
    const { normalizeEmotion, EMOTIONS } = unitWorkbench(t);
    expect(EMOTIONS).toEqual(['fluent', 'happy']);
    expect(normalizeEmotion('happy')).toBe('happy');
    expect(normalizeEmotion('whisper')).toBe('fluent');
    expect(normalizeEmotion(undefined)).toBe('fluent');
  });

  test('buildScript 組成四段式；parseVoiceLines 跳過註解與不完整的行', (t) => {
    const { buildScript, parseVoiceLines } = unitWorkbench(t);
    expect(buildScript({ voice: ' 台積電→台基電 ', title: '標題', body: '內文' })).toBe('台積電→台基電\n===\n===\n標題\n===\n內文\n');
    expect(parseVoiceLines('# 註解→x\n台積電→台基電\n沒有箭頭\n→缺原文\n缺唸法→ ')).toEqual([{ from: '台積電', to: '台基電' }]);
  });

  test('mergeVoiceRules：本支優先蓋過詞庫同原文；詞庫停用的不帶；詞庫長詞排前面', (t) => {
    const wb = unitWorkbench(t);
    fs.mkdirSync(path.dirname(wb.config.PRONOUNCE_PATH), { recursive: true });
    wb.writePronounce([
      { from: '玉山', to: '玉衫' }, { from: '采鈺科技', to: '彩玉科技' },
      { from: '台積電', to: '詞庫版' }, { from: '停用詞', to: 'x', enabled: false },
    ]);
    const { own, shared } = wb.mergeVoiceRules('台積電→本支版');
    expect(own).toEqual([{ from: '台積電', to: '本支版' }]);
    expect(shared.map((r) => r.from)).toEqual(['采鈺科技', '玉山']);
    expect(wb.voiceSection(own, shared)).toBe('台積電→本支版\n# ↓ 共用發音詞庫（自動帶入，不用手改）\n采鈺科技→彩玉科技\n玉山→玉衫');
  });

  test('voiceRuleHits 照實際取代方式數：長詞吃掉的短詞不重複算', (t) => {
    const { voiceRuleHits } = unitWorkbench(t);
    const rules = [{ from: '采鈺', to: '彩玉', src: 'own' }, { from: '鈺', to: '玉' }];
    expect(voiceRuleHits('采鈺與鈺創，采鈺', rules)).toEqual([
      { from: '采鈺', to: '彩玉', src: 'own', times: 2 },
      { from: '鈺', to: '玉', src: 'shared', times: 1 },
    ]);
    expect(voiceRuleHits('', rules)).toEqual([]);
  });

  test('reportOwnVoiceRules：詞庫有的、收件匣還沒處理的都不重送', (t) => {
    const wb = unitWorkbench(t);
    wb.writePronounce([{ from: '已收錄', to: 'x', enabled: false }]);
    wb.appendMessage({ id: 'm1', kind: 'pronounce', word: '處理中', status: 'new' });
    wb.reportOwnVoiceRules({ id: 'job-1', owner: '小明' },
      [{ from: '已收錄', to: 'a' }, { from: '處理中', to: 'b' }, { from: '新詞', to: 'c' }, { from: '新詞', to: 'd' }]);
    const auto = wb.readMessages().filter((m) => m.auto);
    expect(auto).toEqual([expect.objectContaining({ word: '新詞', suggest: 'c', by: '小明', job: 'job-1', status: 'new' })]);
  });
});

describe('messages store', () => {
  test('狀態用追加一行摺疊；ID 同一毫秒也不撞', (t) => {
    const wb = unitWorkbench(t);
    wb.appendMessage({ id: 'a', text: '1' });
    wb.appendMessage({ op: 'status', id: 'a', status: 'done' });
    wb.appendMessage({ op: 'status', id: '沒有這筆', status: 'done' });
    fs.appendFileSync(wb.config.MESSAGES_LOG, '壞掉的一行\n');
    expect(wb.readMessages()).toEqual([{ id: 'a', text: '1', status: 'done' }]);
    const ids = new Set(Array.from({ length: 50 }, () => wb.nextMessageId()));
    expect(ids.size).toBe(50);
  });
});
