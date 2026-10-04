import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createIpcService } from '../../electron-app/main/ipc.mjs';
import { RENDERER_DIR } from '../../electron-app/main/paths.mjs';
import { cancelJobProcesses, jobIsActive, withJobStartReservation } from '../../electron-app/main/job-process.mjs';

const event = { senderFrame: { url: pathToFileURL(path.join(RENDERER_DIR, 'index.html')).href } };
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture({ readAppSettings = async () => ({ paths: {} }), activeJob = null, ...dependencies } = {}) {
  const handlers = new Map(), runs = [], events = [], state = { activeJob };
  const ipc = createIpcService({ state, ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    readAppSettings, applyVoiceSettings: options => options, assertRuntime: async () => {},
    emit: item => events.push(item), jobSnapshot: () => ({ id: state.activeJob?.id, state: state.activeJob?.state }),
    runTextVoiceCandidates: options => { const pending = deferred(); runs.push({ options, job: state.activeJob, ...pending }); return pending.promise; },
    runFineTune: () => { throw new Error('a competing job must not reach execution'); },
    readTrainingDataset: () => { throw new Error('a competing job must not reach preflight'); },
    ...dependencies,
  });
  ipc.registerIpc();
  return { handlers, runs, events, state };
}

test('the first start reserves all start channels before asynchronous preflight', async () => {
  const gate = deferred();
  const f = fixture({ readAppSettings: () => gate.promise });
  const first = f.handlers.get('studio:start-text-voices')(event, { name: 'first', text: '첫 문장입니다.' });
  await tick();
  assert.equal(f.state.activeJob, null, 'preflight has not launched a process');
  for (const channel of ['studio:start-text-voices', 'studio:start-finetune', 'studio:start-edit',
    'studio:start', 'studio:resume-job', 'studio:import-training-dataset', 'studio:start-voice-preview',
    'studio:start-recording', 'studio:start-demo-record', 'studio:start-demo-voice', 'studio:start-demo-render']) {
    await assert.rejects(f.handlers.get(channel)(event, { name: 'second', text: '다른 문장입니다.' }), /이미 실행 중/);
  }
  gate.resolve({ paths: {} });
  const snapshot = await first;
  assert.equal(f.runs.length, 1);
  assert.equal(f.state.activeJob.id, snapshot.id);
  assert.equal(f.state.startReservation, undefined);
  f.runs[0].resolve();
});

test('failed preflight releases the reservation and foreign senders cannot reserve', async () => {
  const state = { activeJob: null };
  await assert.rejects(withJobStartReservation(state, async () => { throw new Error('preflight failed'); }), /preflight failed/);
  assert.equal(state.startReservation, undefined);
  assert.equal(await withJobStartReservation(state, async () => 42), 42);
  const f = fixture();
  await assert.rejects(f.handlers.get('studio:start-text-voices')({ senderFrame: { url: 'https://example.invalid' } }, {}), /허용되지 않은/);
  assert.equal(f.state.startReservation, undefined);
});

test('a stale asynchronous failure changes only the job that owns it', async () => {
  const f = fixture();
  await f.handlers.get('studio:start-text-voices')(event, { name: 'first', text: '첫 문장입니다.' });
  const current = { id: 'new-owner', state: 'running' };
  f.state.activeJob = current;
  f.runs[0].reject(new Error('old job failed'));
  await tick();
  assert.equal(current.state, 'running');
  assert.ok(!f.events.some(item => item.type === 'text-voice-failed'));
});

test('a lesson-boundary paused job can cancel and blocks every new start', async () => {
  const paused = { id: 'paused', kind: 'create', state: 'paused', pauseRequested: true, cancelled: false, children: new Set() };
  const f = fixture({ activeJob: paused });
  for (const channel of ['studio:start-text-voices', 'studio:start', 'studio:start-recording', 'studio:start-demo-render']) {
    await assert.rejects(f.handlers.get(channel)(event, {}), /이미 실행 중/);
    assert.equal(f.state.activeJob, paused);
  }
  assert.equal(await f.handlers.get('studio:cancel')(event), true);
  assert.equal(paused.cancelled, true);
  assert.equal(paused.pauseRequested, false);
  assert.equal(paused.state, 'cancelling');
  clearTimeout(paused.stopTimer);
  assert.equal(jobIsActive(paused), true);
  assert.equal(cancelJobProcesses({ state: 'done' }), false);
});

test('legacy resume acquires existing approval evidence without changing its recorded voice', async () => {
  const identity = { adapterWeightsSha256: 'approved-weights' }, path = '/approved/voice/adapters';
  const recorded = { name: 'original', voiceMode: 'finetuned', modelId: 'qwen3-tts', adapterPath: path, adapterScale: .6, paths: {} };
  let launched;
  const f = fixture({ readAppSettings: async () => ({ modelId: 'qwen3-tts', adapters: [{ id: 'original-voice', path }], paths: {} }),
    readActiveJob: async () => ({ options: recorded, completed: ['lesson-1'] }),
    applyVoiceSettings: (options, settings) => {
      assert.equal(settings.adapterId, 'original-voice');
      assert.equal(settings.adapterScale, .6);
      return { ...options, voiceInputIdentity: identity };
    },
    assertRuntime: async options => { assert.equal(options.voiceInputIdentity, identity); },
    launchPipeline: options => { launched = options; return { id: 'resumed' }; },
  });
  await f.handlers.get('studio:resume-job')(event);
  assert.equal(launched.adapterPath, recorded.adapterPath);
  assert.equal(launched.adapterScale, recorded.adapterScale);
  assert.deepEqual(launched.resumeFrom, ['lesson-1']);
  const missing = fixture({ readActiveJob: async () => ({ options: recorded }) });
  await assert.rejects(missing.handlers.get('studio:resume-job')(event), /청취 확인 기록/);
  const rejected = fixture({ readActiveJob: async () => ({ options: { ...recorded, voiceInputIdentity: identity } }),
    readAppSettings: async () => ({ adapters: [{ id: 'original-voice', path }], paths: {} }),
    applyVoiceSettings: () => { throw new Error('사용을 보류한 목소리입니다.'); },
  });
  await assert.rejects(rejected.handlers.get('studio:resume-job')(event), /보류한 목소리/);
});
