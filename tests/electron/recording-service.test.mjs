import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRecordingService } from '../../electron-app/main/recording.mjs';
import { dateFolder } from '../../electron-app/main/paths.mjs';

// 녹화 작업자 자리에는 흉내 낸 실행을 넣는다. 실제 작업자는 record-display 검사가 맡는다.
async function fixture(t, worker, { monitor = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-service-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const events = [];
  const calls = [];
  const state = { activeJob: null };
  const service = createRecordingService({
    emit: event => events.push(event),
    jobSnapshot: () => ({ id: state.activeJob.id, kind: state.activeJob.kind, state: state.activeJob.state }),
    monitor,
    readAppSettings: async () => ({ paths: { outputRoot: root } }),
    requireRuntimeTool: key => `/tools/${key}`,
    runProcess: async (stage, executable, args) => {
      calls.push({ stage, executable, args });
      state.activeJob.stage = stage;
      return worker(args, state.activeJob);
    },
    state,
  });
  const outputDir = name => path.join(root, 'edits', dateFolder(), name);
  const settled = () => new Promise(resolve => {
    const wait = () => events.some(event => /^record-(complete|failed)$/.test(event.type)) ? resolve() : setTimeout(wait, 5);
    wait();
  });
  return { service, events, calls, state, outputDir, settled };
}

const flag = (args, key) => args[args.indexOf(`--${key}`) + 1];

test('녹화 결과를 편집 결과 자리에 남기고 보고서로 완료를 알린다', async t => {
  const { service, events, calls, state, outputDir, settled } = await fixture(t, async args => {
    const out = flag(args, 'out-dir');
    await fs.writeFile(path.join(out, 'validation-report.json'), JSON.stringify({ operation: 'record-display', summary: { ok: true } }));
  });
  await service.startRecording({ name: 'bob-demo', display: 'Capture screen 1', audioDevice: '' });
  await settled();
  assert.equal(calls[0].stage, 'record');
  assert.equal(calls[0].executable, '/tools/node');
  assert.match(calls[0].args[0], /workers\/record-display\.mjs$/);
  assert.equal(flag(calls[0].args, 'display'), 'Capture screen 1');
  assert.equal(flag(calls[0].args, 'out-dir'), outputDir('bob-demo'));
  assert.equal(flag(calls[0].args, 'ffmpeg'), '/tools/ffmpeg');
  assert.ok(!calls[0].args.includes('--audio'), '음성은 기본으로 끈다');
  assert.deepEqual(events.map(event => event.type), ['record-started', 'record-complete']);
  assert.equal(events[1].report.operation, 'record-display');
  assert.equal(state.activeJob.state, 'done');
});

test('음성을 켜면 고른 입력 장치를 이름으로 넘긴다', async t => {
  const { service, calls, settled } = await fixture(t, async args => {
    await fs.writeFile(path.join(flag(args, 'out-dir'), 'validation-report.json'), '{}');
  });
  await service.startRecording({ name: 'bob-voice', display: 'Capture screen 1', audioDevice: 'MacBook Pro 마이크' });
  await settled();
  assert.equal(flag(calls[0].args, 'audio'), 'MacBook Pro 마이크');
});

test('취소한 녹화는 폴더째 버리고, 검증에 걸린 녹화는 남긴다', async t => {
  const cancelled = await fixture(t, async (args, job) => {
    await fs.writeFile(path.join(flag(args, 'out-dir'), 'leftover.part'), 'x');
    job.cancelled = true;
    throw new Error('사용자가 작업을 중지했습니다.');
  });
  await cancelled.service.startRecording({ name: 'bob-cancel', display: 'Capture screen 1' });
  await cancelled.settled();
  assert.deepEqual(cancelled.events.at(-1), { type: 'record-failed', cancelled: true, message: '사용자가 작업을 중지했습니다.' });
  await assert.rejects(fs.stat(cancelled.outputDir('bob-cancel')), { code: 'ENOENT' });
  assert.equal(cancelled.state.activeJob.state, 'cancelled');

  const rejected = await fixture(t, async args => {
    await fs.writeFile(path.join(flag(args, 'out-dir'), 'validation-report.json'), JSON.stringify({ summary: { ok: false } }));
    throw new Error('화면 녹화 단계가 실패했습니다. (종료 1)');
  });
  await rejected.service.startRecording({ name: 'bob-failed', display: 'Capture screen 1' });
  await rejected.settled();
  assert.equal(rejected.events.at(-1).cancelled, false);
  assert.deepEqual(await fs.readdir(rejected.outputDir('bob-failed')), ['validation-report.json'],
    '다시 찍기 어려운 녹화를 검사 하나로 지우지 않는다');

  const empty = await fixture(t, async () => { throw new Error('화면을 찾지 못했습니다.'); });
  await empty.service.startRecording({ name: 'bob-empty', display: 'Capture screen 7' });
  await empty.settled();
  await assert.rejects(fs.stat(empty.outputDir('bob-empty')), { code: 'ENOENT' }, '빈 폴더는 남기지 않는다');
});

// 다 센 뒤에 작업자를 띄운다. 테두리는 녹화 내내 남으므로 그 폭을 작업자에게 넘겨 지우게 한다.
test('녹화할 화면을 다 센 뒤에 작업자를 띄우고, 세는 동안 취소하면 띄우지 않는다', async t => {
  const order = [];
  let service = null;
  // 세는 동안에는 정지할 녹화가 없다. 정지 요청은 거절된다.
  const counting = { countdown: async (job, target) => {
    order.push(['countdown', target, job.stage, service.finishRecording()]);
    return { ready: true, edgeMask: 6 };
  } };
  const started = await fixture(t, async args => {
    order.push(['worker', flag(args, 'edge-mask')]);
    await fs.writeFile(path.join(flag(args, 'out-dir'), 'validation-report.json'), '{}');
  }, { monitor: counting });
  service = started.service;
  await service.startRecording({ name: 'bob-count', display: 'Capture screen 1' });
  await started.settled();
  assert.deepEqual(order, [['countdown', { display: 'Capture screen 1', size: null }, 'starting', false], ['worker', '6']]);

  const cancelled = await fixture(t, async () => { throw new Error('작업자를 띄우면 안 된다'); }, {
    monitor: { countdown: async job => { job.cancelled = true; return { ready: false, edgeMask: 0 }; } },
  });
  await cancelled.service.startRecording({ name: 'bob-early', display: 'Capture screen 1' });
  await cancelled.settled();
  assert.equal(cancelled.calls.length, 0);
  assert.equal(cancelled.events.at(-1).type, 'record-failed');
  assert.equal(cancelled.events.at(-1).cancelled, true);
  await assert.rejects(fs.stat(cancelled.outputDir('bob-early')), { code: 'ENOENT' }, '세다 취소한 녹화는 폴더도 남기지 않는다');
});

test('테두리를 띄우지 못했으면 녹화 가장자리를 채우지 않는다', async t => {
  const { service, calls, settled } = await fixture(t, async args => {
    await fs.writeFile(path.join(flag(args, 'out-dir'), 'validation-report.json'), '{}');
  }, { monitor: { countdown: async () => ({ ready: true, edgeMask: 0 }) } });
  await service.startRecording({ name: 'bob-plain', display: 'Capture screen 1' });
  await settled();
  assert.ok(!calls[0].args.includes('--edge-mask'));
});

test('이름·화면·실행 중 작업·기존 결과를 시작 전에 막는다', async t => {
  const { service, state, outputDir } = await fixture(t, async () => {});
  await assert.rejects(service.startRecording({ name: 'Bob Demo', display: 'Capture screen 1' }), /영문 소문자/);
  await assert.rejects(service.startRecording({ name: 'bob-demo', display: '' }), /화면을 골라/);
  await fs.mkdir(outputDir('bob-demo'), { recursive: true });
  await fs.writeFile(path.join(outputDir('bob-demo'), 'bob-demo.mp4'), 'previous');
  await assert.rejects(service.startRecording({ name: 'bob-demo', display: 'Capture screen 1' }), /같은 이름의 결과/);
  state.activeJob = { kind: 'create', state: 'running' };
  await assert.rejects(service.startRecording({ name: 'bob-next', display: 'Capture screen 1' }), /이미 실행 중/);
});

test('정지는 녹화 단계에서만 받는다', async t => {
  const { service, state, events } = await fixture(t, async () => {});
  assert.equal(service.finishRecording(), false, '녹화가 없으면 정지할 것이 없다');
  state.activeJob = { kind: 'record', state: 'running', stage: 'starting', children: new Set() };
  assert.equal(service.finishRecording(), false, '녹화가 시작되기 전에는 정지를 받지 않는다');
  state.activeJob = { kind: 'record', state: 'running', stage: 'record', finishing: true, children: new Set() };
  assert.equal(service.finishRecording(), true, '이미 마무리 중이면 같은 요청을 다시 보내지 않는다');
  assert.deepEqual(events, []);
  state.activeJob = { kind: 'record', state: 'running', stage: 'record', children: new Set() };
  assert.throws(() => service.listRecordingSources(), /녹화 중에는/);
});

// 녹화 작업자는 단계를 한 줄 JSON으로 알린다. 렌더러가 로그 글자를 다시 읽지 않도록
// 실행기가 사건으로 바꿔 준다. 다른 단계의 같은 모양 줄은 녹화 사건이 아니다.
test('녹화 작업자의 단계 줄을 녹화 사건으로 바꾼다', async () => {
  const { createRuntimeService } = await import('../../electron-app/main/runtime.mjs');
  const events = [];
  const state = { activeJob: { kind: 'record', state: 'running', cancelled: false, children: new Set() }, mainWindow: null };
  const runtime = createRuntimeService({ state, onEvent: event => events.push(event) });
  const script = `console.log('[record] {"phase":"recording"}');
    console.log('[record] {"phase":"progress","frames":250,"dup":0,"drop":2}\\n[record] {"phase":"ignored"}\\n[record] {broken');
    console.log('[record] {"phase":"finishing"}');`;
  await runtime.runProcess('record', process.execPath, ['-e', script]);
  await runtime.runProcess('verify', process.execPath, ['-e', script]);
  assert.deepEqual(events.filter(event => event.type === 'record-phase').map(({ type, ...event }) => event), [
    { phase: 'recording', frames: undefined, dup: undefined, drop: undefined },
    { phase: 'progress', frames: 250, dup: 0, drop: 2 },
    { phase: 'finishing', frames: undefined, dup: undefined, drop: undefined },
  ]);
});
