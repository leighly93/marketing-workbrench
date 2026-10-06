'use strict';

const { TEMPLATES, IDS, getTemplate, planPath, serverTemplates, TEMPLATE_ASSET_PATTERN } = require('./registry');

describe('版型設定表', () => {
  test('順序就是前台顯示順序：盤中焦點 → 大盤小報 → 美股焦點', () => {
    expect(IDS).toEqual(['midday', 'dapan', 'usstock']);
  });

  test.each(IDS)('%s 的設定欄位齊全', (id) => {
    const t = TEMPLATES[id];
    expect(t.label).toBeTruthy();
    expect(t.outputs.length).toBeGreaterThan(0);
    for (const o of t.outputs) expect(o.file).toMatch(new RegExp(`^output-${id}(-landscape)?\\.mp4$`));
    for (const to of Object.values(t.assets.files)) expect(to.startsWith(`${id}-`)).toBe(true);
    expect(t.anchor.avatar.id).toMatch(/^[0-9a-f]{32}$/);
    expect(t.anchor.minimaxVoiceId).toMatch(/^moss_audio_/);
    expect(['9:16', '16:9']).toContain(t.anchor.aspectRatio);
    expect(Object.keys(t.motion).every((k) => k === 'p' || k === 'l')).toBe(true);
  });

  test('只有大盤小報出橫式，橫式素材與動態要一起有', () => {
    expect(IDS.filter((id) => TEMPLATES[id].outputs.length > 1)).toEqual(['dapan']);
    expect(TEMPLATES.dapan.motion.l).toBeDefined();
    expect(TEMPLATES.dapan.assets.files['intro-frame_Horizontal.png']).toBe('dapan-intro-frame-horizontal.png');
  });

  test('不認得的版型直接丟例外，不默默跑', () => {
    expect(() => getTemplate('institution')).toThrow(/不認得的版型：institution/);
    expect(() => getTemplate('')).toThrow(/未指定/);
    expect(() => getTemplate('toString')).toThrow();
  });

  test('配圖計畫路徑', () => {
    expect(planPath('dapan')).toBe('src/DapanXiaobao/dapan-shots.generated.json');
    expect(planPath('usstock')).toBe('src/UsStock/usstock-shots.generated.json');
  });

  test('伺服器版型資訊：單一輸出不帶 outputLabels，多輸出才標直式／橫式', () => {
    const s = serverTemplates();
    expect(Object.keys(s)).toEqual(IDS);
    expect(s.midday).not.toHaveProperty('outputLabels');
    expect(s.dapan.outputs).toEqual(['output-dapan.mp4', 'output-dapan-landscape.mp4']);
    expect(s.dapan.outputLabels).toEqual({ 'output-dapan.mp4': '直式', 'output-dapan-landscape.mp4': '橫式' });
    expect(s.usstock).toMatchObject({ label: '美股焦點', plan: 'src/UsStock/usstock-shots.generated.json', planKind: 'shots', arrow: true });
  });

  test('套版素材規則：版型前綴、品牌框與字型保留，截圖與講者影片不算', () => {
    for (const keep of ['dapan-bgm.wav', 'midday-intro-frame.jpg', 'frame.png', 'logo.png', 'NotoSansTC-VF.ttf']) {
      expect(TEMPLATE_ASSET_PATTERN.test(keep)).toBe(true);
    }
    for (const drop of ['image1.png', 'heygen.mp4', 'script.txt', 'institution-bgm.wav']) {
      expect(TEMPLATE_ASSET_PATTERN.test(drop)).toBe(false);
    }
  });
});
