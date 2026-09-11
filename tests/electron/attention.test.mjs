import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttentionService } from '../../electron-app/main/attention.mjs';

// 한 챕터 제작은 일곱 시간을 넘는다. 그동안 맥이 잠들면 제작도 멈추고, 두 시간
// 뒤에 끝나는 작업을 계속 들여다볼 수도 없다. 둘 다 '자리를 비울 수 있게' 하는
// 일이므로 같은 자리에서 확인한다.
function fixture({ preventSleep = true, notifyOnFinish = true, notifications = true } = {}) {
  const blocks = [];
  const shown = [];
  let nextId = 1;
  const started = new Set();
  const powerSaveBlocker = {
    start(type) { const id = nextId++; started.add(id); blocks.push({ type, id }); return id; },
    stop(id) { started.delete(id); blocks.push({ stop: id }); },
    isStarted: (id) => started.has(id),
  };
  class FakeNotification {
    constructor(options) { this.options = options; }
    on() { return this; }
    show() { shown.push(this.options); }
    static isSupported() { return notifications; }
  }
  const state = { activeJob: null, mainWindow: null };
  const attention = createAttentionService({
    powerSaveBlocker, Notification: FakeNotification, state,
    readAppSettings: async () => ({ preventSleep, notifyOnFinish }),
  });
  const running = () => { state.activeJob = { state: 'running' }; };
  return { attention, state, blocks, shown, started, running };
}

test('작업이 도는 동안 잠을 막고, 끝나면 놓는다', async () => {
  const { attention, blocks, running, started } = fixture();
  running();
  await attention.watch({ type: 'started' });
  assert.equal(attention.holdsSleep, true);
  assert.deepEqual(blocks.map((item) => item.type), ['prevent-app-suspension']);

  // 도는 동안 사건이 수백 번 지나가도 막는 것은 한 번뿐이다.
  for (const type of ['log', 'stage', 'unit', 'voice-progress']) await attention.watch({ type });
  assert.equal(blocks.filter((item) => item.type).length, 1, '이미 막고 있으면 다시 걸지 않는다');

  await attention.watch({ type: 'complete', report: {} });
  assert.equal(attention.holdsSleep, false);
  assert.equal(started.size, 0, '풀지 않은 채 남기지 않는다');
});

// 상태 표시가 늦게 따라오더라도 잠을 막은 채로 남아서는 안 된다.
test('끝난 사건이면 상태와 무관하게 놓는다', async () => {
  const { attention, running } = fixture();
  running();
  await attention.watch({ type: 'started' });
  assert.equal(attention.holdsSleep, true);
  // 실패 사건이 왔는데 activeJob 은 아직 running 으로 남아 있는 경우.
  await attention.watch({ type: 'edit-failed', message: '실패' });
  assert.equal(attention.holdsSleep, false);
});

test('설정이 꺼져 있으면 잠을 막지도 알리지도 않는다', async () => {
  const { attention, blocks, shown, running } = fixture({ preventSleep: false, notifyOnFinish: false });
  running();
  await attention.watch({ type: 'started' });
  assert.equal(attention.holdsSleep, false);
  assert.deepEqual(blocks, []);
  await attention.watch({ type: 'complete', report: {} });
  assert.deepEqual(shown, []);
});

test('무엇으로 끝났는지에 따라 알림의 말이 달라진다', async () => {
  const { attention, shown, running } = fixture();
  running();
  await attention.watch({ type: 'complete', report: { units: [{}, {}, {}] } });
  assert.equal(shown.at(-1).title, '제작 완료');
  assert.match(shown.at(-1).body, /3편/);

  await attention.watch({ type: 'partial-complete', report: { units: [{}] } });
  assert.equal(shown.at(-1).title, '일부만 완료');

  await attention.watch({ type: 'failed', message: '참조 음성을 찾지 못했습니다' });
  assert.equal(shown.at(-1).title, '제작 실패');
  assert.match(shown.at(-1).body, /참조 음성/);

  // 중지는 실패와 다른 일이다. 원인을 찾으라고 하면 안 된다.
  await attention.watch({ type: 'failed', cancelled: true, message: '사용자가 작업을 중지했습니다.' });
  assert.match(shown.at(-1).body, /중지/);

  await attention.watch({ type: 'training-complete', adapter: { label: 'jaeho-ko-r16-v2' } });
  assert.match(shown.at(-1).body, /jaeho-ko-r16-v2/);
});

test('진행 중 사건은 알림을 띄우지 않는다', async () => {
  const { attention, shown, running } = fixture();
  running();
  for (const type of ['started', 'log', 'stage', 'unit', 'plan', 'paused', 'slept']) {
    await attention.watch({ type });
  }
  assert.deepEqual(shown, []);
});

// 알림을 못 띄운다고 제작이 멈출 이유는 없다.
test('알림과 잠 막기를 쓸 수 없는 환경에서도 터지지 않는다', async () => {
  const state = { activeJob: { state: 'running' }, mainWindow: null };
  const attention = createAttentionService({
    powerSaveBlocker: null, Notification: null, state,
    readAppSettings: async () => ({ preventSleep: true, notifyOnFinish: true }),
  });
  await attention.watch({ type: 'started' });
  await attention.watch({ type: 'complete', report: {} });
  attention.release();
  assert.equal(attention.holdsSleep, false);
});

test('설정을 읽지 못해도 작업 사건은 그대로 흐른다', async () => {
  const state = { activeJob: { state: 'running' }, mainWindow: null };
  const attention = createAttentionService({
    powerSaveBlocker: { start: () => 1, stop() {}, isStarted: () => false },
    Notification: null, state,
    readAppSettings: async () => { throw new Error('설정 파일이 깨졌습니다'); },
  });
  await attention.watch({ type: 'started' });
  // 설정을 모르면 기본값(켬)으로 본다 — 일곱 시간짜리 작업에서 꺼져 있어 좋을 까닭이 없다.
  assert.equal(attention.holdsSleep, true);
});
