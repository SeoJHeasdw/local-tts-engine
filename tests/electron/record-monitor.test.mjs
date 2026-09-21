import test from 'node:test';
import assert from 'node:assert/strict';
import { COUNTDOWN_SECONDS, FRAME_BORDER_CSS, createRecordMonitorService, edgeBounds, matchDisplay } from '../../electron-app/main/record-monitor.mjs';

// 이 Mac의 실제 배치(2026-09-21): avfoundation "Capture screen 0"이 내장 3456×2234,
// "Capture screen 1"이 DELL 1920×1080이고 Electron 목록도 같은 순서였다.
const BUILT_IN = { id: 1, label: '내장 Retina 디스플레이', bounds: { x: 0, y: 0, width: 1728, height: 1117 }, size: { width: 1728, height: 1117 }, scaleFactor: 2 };
const DELL = { id: 4, label: 'DELL P2419HC', bounds: { x: 1728, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 };

test('avfoundation 화면을 순서로 찾되 원본 크기로 확인하고, 모르면 감싸지 않는다', () => {
  const displays = [BUILT_IN, DELL];
  assert.equal(matchDisplay('Capture screen 1', { width: 1920, height: 1080 }, displays), DELL);
  assert.equal(matchDisplay('Capture screen 0', { width: 3456, height: 2234 }, displays), BUILT_IN, '배율 2는 픽셀로 비교한다');
  assert.equal(matchDisplay('Capture screen 0', { width: 1920, height: 1080 }, displays), DELL, '순서가 어긋나면 크기가 같은 하나를 고른다');
  assert.equal(matchDisplay('Capture screen 1', { width: 1920, height: 1080 }, [DELL, { ...DELL, id: 9 }]).id, 9,
    '같은 모니터 둘은 순서로 가른다');
  assert.equal(matchDisplay('Capture screen 2', { width: 1920, height: 1080 }, [BUILT_IN, DELL, { ...DELL, id: 9 }]).id, 9);
  assert.equal(matchDisplay('Capture screen 0', { width: 1920, height: 1080 }, [BUILT_IN, DELL, { ...DELL, id: 9 }]), null,
    '크기가 같은 화면이 여럿이면 어느 것인지 모른다');
  assert.equal(matchDisplay('Capture screen 5', { width: 2560, height: 1440 }, displays), null);
  assert.equal(matchDisplay('Capture screen 1', null, displays), DELL, '크기를 모르면 순서를 따른다');
});

function fixture({ displays = [BUILT_IN, DELL], cancelAfterMs = Infinity, mainOn = BUILT_IN } = {}) {
  const events = [];
  const windows = [];
  const intervals = [];
  let waited = 0;
  const job = { cancelled: false };
  class FakeWindow {
    constructor(options) { this.options = options; this.destroyed = false; this.shown = false; this.pages = []; windows.push(this); }
    setIgnoreMouseEvents(value) { this.clickThrough = value; }
    setAlwaysOnTop(value, level) { this.level = value && level; }
    async loadFile(file, options) { this.file = file; this.pages.push(options?.query); }
    setBounds(bounds) { this.bounds = bounds; }
    showInactive() { this.shown = true; }
    destroy() { this.destroyed = true; }
    isDestroyed() { return this.destroyed; }
  }
  const mainWindow = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, getBounds: () => mainOn.bounds };
  const service = createRecordMonitorService({
    BrowserWindow: FakeWindow,
    screen: { getAllDisplays: () => displays, getDisplayMatching: bounds => displays.find(display => display.bounds === bounds) },
    desktopCapturer: {
      getSources: async ({ thumbnailSize }) => displays.map(display => ({
        display_id: String(display.id), thumbnailSize,
        thumbnail: { isEmpty: () => false, toJPEG: () => Buffer.from(`shot-${display.id}`) },
      })),
    },
    emit: event => events.push(event),
    state: { mainWindow },
    wait: async ms => {
      waited += ms;
      if (waited >= cancelAfterMs) job.cancelled = true;
    },
    setInterval: callback => { intervals.push({ callback, cleared: false }); return intervals.length - 1; },
    clearInterval: id => { intervals[id].cleared = true; },
  });
  return { service, events, windows, intervals, job, waited: () => waited };
}

test('테두리는 화면 가장자리 네 막대로 빈틈없이 두른다', () => {
  const [top, bottom, left, right] = edgeBounds(DELL.bounds, 3);
  assert.deepEqual(top, { x: 1728, y: 0, width: 1920, height: 3 });
  assert.deepEqual(bottom, { x: 1728, y: 1077, width: 1920, height: 3 });
  assert.deepEqual(left, { x: 1728, y: 3, width: 3, height: 1074 });
  assert.deepEqual(right, { x: 3645, y: 3, width: 3, height: 1074 });
});

// 테두리는 녹화하는 동안 남아 있다가 정지·취소에 사라진다. 녹화는 테두리 폭을 채워 지운다.
test('녹화할 화면을 테두리로 감싸 세고, 녹화 중에는 숫자 없이 테두리만 남긴다', async () => {
  const { service, events, windows, job, waited } = fixture();
  const shown = await service.countdown(job, { display: 'Capture screen 1', size: { width: 1920, height: 1080 } });
  assert.deepEqual(shown, { ready: true, edgeMask: FRAME_BORDER_CSS }, 'DELL은 배율 1이라 포인트 두께가 곧 픽셀 폭이다');
  assert.deepEqual(events.map(event => event.remaining), [3, 2, 1, 0]);
  assert.ok(events.every(event => event.type === 'record-countdown' && event.label === 'DELL P2419HC' && event.framed));

  const edges = windows.filter(panel => panel.options.backgroundColor);
  const [badge] = windows.filter(panel => panel.file);
  assert.equal(edges.length, 4, '가장자리 네 막대');
  assert.deepEqual(edges.map(edge => edge.bounds), edgeBounds(DELL.bounds, FRAME_BORDER_CSS), '고른 화면 가장자리를 두른다');
  assert.ok(edges.every(edge => !edge.options.transparent && !edge.file), '막대는 페이지 없는 불투명 창이라 합성할 것이 적다');
  for (const panel of windows) {
    assert.equal(panel.options.focusable, false, '초점을 뺏지 않는다');
    assert.equal(panel.clickThrough, true, '클릭은 아래 창으로 간다');
    assert.equal(panel.shown, true);
  }
  assert.match(badge.file, /renderer\/record-countdown\.html$/);
  assert.deepEqual(badge.pages, [{ seconds: String(COUNTDOWN_SECONDS), label: 'DELL P2419HC' }]);
  assert.equal(badge.destroyed, true, '가운데 숫자는 녹화 전에 걷는다');
  assert.ok(edges.every(edge => !edge.destroyed), '녹화하는 동안 테두리가 남는다');
  assert.ok(waited() >= COUNTDOWN_SECONDS * 1000 + 250, '숫자가 사라질 틈까지 기다린다');

  service.watch({ type: 'record-phase', phase: 'recording' });
  service.watch({ type: 'record-phase', phase: 'progress', frames: 100, dup: 0, drop: 0 });
  assert.ok(edges.every(edge => !edge.destroyed));
  service.watch({ type: 'record-finishing' });
  assert.ok(edges.every(edge => edge.destroyed), '정지를 누르면 테두리가 사라진다');
});

test('배율 2 화면은 테두리 폭을 픽셀로 두 배 채운다', async () => {
  const { service, job } = fixture();
  assert.deepEqual(await service.countdown(job, { display: 'Capture screen 0', size: { width: 3456, height: 2234 } }),
    { ready: true, edgeMask: FRAME_BORDER_CSS * 2 });
});

test('취소·실패·앱 종료에도 테두리를 걷는다', async () => {
  for (const ending of [{ type: 'cancelling' }, { type: 'record-failed', cancelled: false }, { type: 'record-complete' }, null]) {
    const { service, windows, job } = fixture();
    await service.countdown(job, { display: 'Capture screen 1', size: { width: 1920, height: 1080 } });
    if (ending) service.watch(ending);
    else service.stop();
    assert.ok(windows.every(panel => panel.destroyed), JSON.stringify(ending));
  }
});

test('세는 동안 취소하면 곧바로 멈추고 테두리를 걷는다', async () => {
  const { service, events, windows, job, waited } = fixture({ cancelAfterMs: 1500 });
  assert.deepEqual(await service.countdown(job, { display: 'Capture screen 1', size: { width: 1920, height: 1080 } }), { ready: false, edgeMask: 0 });
  assert.deepEqual(events.map(event => event.remaining), [3, 2], '다 셌다는 0을 보내지 않는다');
  assert.ok(waited() < 2000, '남은 초를 기다리지 않는다');
  assert.ok(windows.every(panel => panel.destroyed));
});

test('어느 화면인지 모르면 테두리 없이 세고, 녹화 가장자리도 채우지 않는다', async () => {
  const { service, events, windows, job } = fixture();
  assert.deepEqual(await service.countdown(job, { display: 'Capture screen 7', size: { width: 2560, height: 1440 } }), { ready: true, edgeMask: 0 });
  assert.equal(windows.length, 0);
  assert.deepEqual(events.map(event => [event.remaining, event.framed, event.label]), [[3, false, null], [2, false, null], [1, false, null], [0, false, null]]);
});

test('녹화 중에는 그 화면을 1초마다 비추고, 앱 창이 그 화면 위에 있으면 알린다', async () => {
  const { service, events, intervals, job } = fixture({ mainOn: DELL });
  await service.countdown(job, { display: 'Capture screen 1', size: { width: 1920, height: 1080 } });
  events.length = 0;
  service.watch({ type: 'record-phase', phase: 'recording' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(intervals.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'record-preview');
  assert.equal(events[0].image, `data:image/jpeg;base64,${Buffer.from('shot-4').toString('base64')}`, '녹화하는 화면을 뜬다');
  assert.equal(events[0].mirrored, true);

  service.watch({ type: 'record-finishing' });
  assert.equal(intervals[0].cleared, true, '마무리가 시작되면 더 뜨지 않는다');
  await intervals[0].callback();
  assert.equal(events.length, 1, '멈춘 뒤 늦게 온 한 장은 보내지 않는다');
});

test('앱 창이 다른 화면에 있으면 거울 경고를 내지 않고, 녹화가 끝나면 대상을 비운다', async () => {
  const { service, events, intervals, job } = fixture({ mainOn: BUILT_IN });
  await service.countdown(job, { display: 'Capture screen 1', size: { width: 1920, height: 1080 } });
  service.watch({ type: 'record-phase', phase: 'recording' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.at(-1).mirrored, false);
  service.watch({ type: 'record-complete', report: {} });
  service.watch({ type: 'record-phase', phase: 'recording' });
  assert.equal(intervals.length, 1, '끝난 녹화의 화면을 다시 비추지 않는다');
});

// 미리보기가 녹화를 늦추는지 가르지 못했다. 녹화가 프레임을 놓치기 시작하면 미리보기를 멈춘다.
test('녹화가 프레임을 복제·누락하기 시작하면 미리보기를 멈추고 알린다', async () => {
  const { service, events, intervals, job } = fixture();
  await service.countdown(job, { display: 'Capture screen 1', size: { width: 1920, height: 1080 } });
  service.watch({ type: 'record-phase', phase: 'recording' });
  await new Promise(resolve => setImmediate(resolve));
  service.watch({ type: 'record-phase', phase: 'progress', frames: 250, dup: 0, drop: 0 });
  assert.equal(intervals[0].cleared, false, '놓친 프레임이 없으면 계속 비춘다');
  service.watch({ type: 'record-phase', phase: 'progress', frames: 300, dup: 2, drop: 0 });
  assert.equal(intervals[0].cleared, true);
  assert.equal(events.at(-1).type, 'record-preview-paused');
  const count = events.length;
  service.watch({ type: 'record-phase', phase: 'progress', frames: 350, dup: 5, drop: 0 });
  assert.equal(events.length, count, '멈춘 뒤에는 다시 알리지 않는다');
});
