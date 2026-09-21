import test from 'node:test';
import assert from 'node:assert/strict';
import { installRendererGlobals } from './helpers/renderer-dom.mjs';

// 창을 닫았다 다시 열면 main은 돌던 작업을 그대로 들고 있고 화면만 새로 뜬다. 앱 데모의
// 목소리·완성본은 다듬기에서 도는 일이라, 다시 뜬 화면이 그 진행을 다듬기에서 되살리고
// 새로 만들기의 시작은 막아야 한다(예전에는 강의 제작 진행으로 잘못 떨어졌다).
// 모듈은 한 번만 불러오므로 이 파일은 이 한 경우만 본다.
test('앱 데모 굽기 중에 창을 다시 열면 다듬기가 진행을 되살리고 다른 시작은 막는다', async t => {
  const api = {
    onJobEvent() {},
    getStatus: async () => ({
      catalog: { pages: [], lessons: [], totalPages: 0 }, capabilities: { editing: true },
      activeJob: { id: 'job-1', kind: 'demo-render', state: 'running', stage: 'demo-render', startedAt: new Date().toISOString() },
    }),
    getSettings: async () => ({ modelId: 'qwen3-tts', adapterId: 'none', adapterScale: .6, voiceParallelism: 2, adapters: [], paths: {} }),
    listOutputs: async () => [],
    getResumable: async () => null,
  };
  const { query } = installRendererGlobals(t, { api });
  await import('../../electron-app/renderer/app.js');
  await new Promise(resolve => setImmediate(resolve));

  assert.doesNotMatch(query('#job-log').textContent, /초기화 오류/);
  assert.equal(query('#demo-running').classList.contains('hidden'), false, '다듬기의 앱 데모 작업면이 진행을 되살린다');
  assert.match(query('#demo-running-label').textContent, /완성본을 굽고 있습니다/);
  assert.notEqual(query('#job-state').textContent, '실행 중', '강의 제작 진행으로 떨어지지 않는다');
  for (const selector of ['#start-button', '#start-text-voices', '#record-start', '#demo-record-start']) {
    assert.equal(query(selector).inert, true, `${selector}는 앱 데모 굽기가 끝날 때까지 막힌다`);
  }
  assert.equal(query('.nav-item[data-view="review"]').classList.contains('running'), true, '다듬기 메뉴가 도는 표시를 한다');
  assert.match(query('#create-busy-text').textContent, /앱 데모 완성본을 굽는 중/);
});
