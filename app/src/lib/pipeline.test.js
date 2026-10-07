import { buildPipeline, latestSteps, stageStatus } from './pipeline.js';

const base = { id: 'j1', template: 'dapan', owner: '小明', title: '今日盤勢', files: ['shot1.png', 'script.txt'], voiceRules: { own: [] } };

describe('pipeline 模型', () => {
  test('草稿：截圖與送出是待辦，右側先開「送出」或缺的那格', () => {
    const p = buildPipeline({ ...base, status: 'draft', files: [] }, []);
    expect(p.nodes.shots.status).toBe('todo');
    expect(p.nodes.submit.status).toBe('ready');
    expect(p.current).toBe('shots');
    const p2 = buildPipeline({ ...base, status: 'draft', skipGenerate: true }, []);
    expect(p2.nodes.anchor.status).toBe('todo');
    expect(p2.nodes.submit.status).toBe('todo');
  });

  test('排隊中：準備節點都在等，備註帶排隊位置；用現成講者影片時「生成」直接略過', () => {
    const p = buildPipeline({ ...base, status: 'queued', queuePosition: 2, skipGenerate: true }, []);
    expect(p.nodes.inputs.status).toBe('pending');
    expect(p.nodes.inputs.note).toMatch(/前面還有 2 支/);
    expect(p.nodes.generate.status).toBe('skipped');
    expect(p.current).toBe('annotate');
    expect(p.nodes.annotate.status).toBe('ready');
  });

  test('準備中：步驟事件決定節點狀態，多步驟節點取最後一筆、部分完成算進行中', () => {
    const steps = [
      { id: 'stage-inputs', status: 'ok', ms: 10 }, { id: 'assets', status: 'ok', ms: 20 },
      { id: 'generate', status: 'running' },
      { id: 'image-analysis', status: 'running' },
      { id: 'backup', status: 'ok', ms: 5 },
    ];
    const p = buildPipeline({ ...base, status: 'preparing' }, steps);
    expect(p.nodes.inputs.status).toBe('ok');
    expect(p.nodes.inputs.ms).toBe(30);
    expect(p.nodes.generate.status).toBe('running');
    expect(p.nodes.speed.status).toBe('running');   // backup 完了、speed 還沒開始
    expect(p.nodes.transcribe.status).toBe('pending');
    expect(stageStatus(p.stages[1])).toBe('running');
  });

  test('警告與重跑：同一個 id 只看最後一筆；⚠️ 的 warning 傳到節點', () => {
    const steps = [
      { id: 'shots', status: 'failed', error: '第一次' },
      { id: 'shots', status: 'warning', note: '⚠️ 自動配圖失敗，這支不會插圖', attempt: 2 },
      { id: 'counterfactual', status: 'ok' }, { id: 'snapshot', status: 'ok' }, { id: 'plan-view', status: 'ok' },
    ];
    expect(latestSteps(steps).shots.attempt).toBe(2);
    const p = buildPipeline({ ...base, status: 'review', planView: {} }, steps);
    expect(p.nodes.autoplan.status).toBe('warning');
    expect(p.nodes.autoplan.note).toMatch(/自動配圖失敗/);
    expect(p.nodes.review.status).toBe('ready');
    expect(p.current).toBe('review');
  });

  test('失敗但沒有步驟記錄的舊工作：錯誤掛在第一個沒完成的準備節點', () => {
    const p = buildPipeline({ ...base, status: 'failed', error: '合成錯誤' }, []);
    expect(p.nodes.inputs.status).toBe('failed');
    expect(p.nodes.inputs.note).toBe('合成錯誤');
    expect(p.current).toBe('inputs');
    expect(p.nodes.redo.status).toBe('ready');
  });

  test('完成：成品節點顯示支數，自動出片的工作「確認」是略過', () => {
    const p = buildPipeline({ ...base, status: 'done', outputs: [{ name: 'portrait.mp4', size: 1 }], autoApprove: true, approvedBy: '（自動出片）', annotationCount: 2, emphasisCount: 1 }, [
      { id: 'render', status: 'ok', ms: 1000 }, { id: 'finalize', status: 'ok' }, { id: 'render-prep', status: 'ok' }, { id: 'motion-render', status: 'skipped' }, { id: 'plan-edits', status: 'ok' },
    ]);
    expect(p.nodes.outputs.status).toBe('ok');
    expect(p.nodes.outputs.note).toBe('1 支');
    expect(p.nodes.review.status).toBe('skipped');
    expect(p.nodes.annotate.status).toBe('ok');
    expect(p.nodes.emphasis.note).toBe('已標 1 處');
    expect(p.current).toBe('outputs');
    expect(stageStatus(p.stages[3])).toBe('ok');
  });

  test('已經停下來的工作：節點裡少記一步（例如沒有人工修正就沒有 plan-edits）不算進行中', () => {
    const steps = [{ id: 'render-prep', status: 'ok' }, { id: 'motion-render', status: 'ok' }, { id: 'render', status: 'ok' }, { id: 'finalize', status: 'ok' }];
    const done = buildPipeline({ ...base, status: 'done', outputs: [{ name: 'a.mp4', size: 1 }] }, steps);
    expect(done.nodes.renderprep.status).toBe('ok');
    expect(stageStatus(done.stages[3])).toBe('ok');
    // 還在跑的時候同樣的記錄就是「進行中」
    const running = buildPipeline({ ...base, status: 'rendering' }, [{ id: 'render-prep', status: 'ok' }]);
    expect(running.nodes.renderprep.status).toBe('running');
    // 失敗在準備階段：出片節點維持等待，不要被誤標成失敗
    const failed = buildPipeline({ ...base, status: 'failed', error: 'x' }, [{ id: 'assets', status: 'ok' }, { id: 'generate', status: 'failed', error: 'HeyGen 掛了' }]);
    expect(failed.nodes.generate.status).toBe('failed');
    expect(failed.nodes.render.status).toBe('pending');
  });

  test('取消：還沒跑到的節點全部標成已取消', () => {
    const p = buildPipeline({ ...base, status: 'cancelled' }, [{ id: 'generate', status: 'cancelled' }]);
    expect(p.nodes.generate.status).toBe('cancelled');
    expect(p.nodes.render.status).toBe('cancelled');
    expect(p.nodes.outputs.status).toBe('cancelled');
  });
});
