import test from 'node:test';
import assert from 'node:assert/strict';
import { installRendererGlobals } from './helpers/renderer-dom.mjs';

test('a reopened paused production can resume or cancel and blocks new work', async t => {
  let events, cancels = 0, resumes = 0;
  const api = { onJobEvent: listener => { events = listener; },
    getStatus: async () => ({ catalog: { pages: [], lessons: [], totalPages: 0 }, capabilities: { editing: true },
      activeJob: { id: 'paused', kind: 'create', state: 'paused', stage: 'voice', startedAt: new Date().toISOString() } }),
    getSettings: async () => ({ modelId: 'qwen3-tts', adapterId: 'none', adapterScale: .6, adapters: [], paths: {} }),
    listOutputs: async () => [], getResumable: async () => null,
    resume: async () => { resumes++; events({ type: 'resumed', jobKind: 'create' }); },
    cancel: async () => { cancels++; return true; },
  };
  const { query: $ } = installRendererGlobals(t, { api });
  await import('../../electron-app/renderer/app.js');
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch($('#job-log').textContent, /초기화 오류/);
  assert.equal($('#pause-button').textContent, '이어하기');
  assert.equal($('#cancel-button').classList.contains('hidden'), false);
  for (const selector of ['#start-text-voices', '#record-start', '#demo-record-start']) assert.equal($(selector).inert, true);
  await $('#pause-button').click();
  assert.equal(resumes, 1);
  events({ type: 'paused', immediate: true, jobKind: 'create' });
  await $('#cancel-button').click();
  assert.equal(cancels, 1);
  assert.equal($('#cancel-button').disabled, true);
});
