import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingController, defaultDisplay, displayHint, formatClock } from '../../electron-app/renderer/controllers/recording.mjs';

// 화면 녹화의 동작을 실제 컨트롤러로 확인한다. 정지와 취소를 헷갈리면 15분 녹화를
// 잃거나, 버려야 할 녹화가 남는다.
function fixture({ displays, audioDevices = [{ name: 'MacBook Pro 마이크' }] } = {}) {
  const elements = new Map();
  const element = () => ({
    value: '', textContent: '', disabled: false, checked: false, type: '', className: '',
    dataset: {}, listeners: {}, children: [], attributes: {},
    classList: (() => {
      const names = new Set();
      return {
        add: (...values) => values.forEach(value => names.add(value)),
        remove: (...values) => values.forEach(value => names.delete(value)),
        contains: value => names.has(value),
        toggle(value, force = !names.has(value)) { force ? names.add(value) : names.delete(value); return force; },
      };
    })(),
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(key, value) { this.attributes[key] = value; },
    getAttribute(key) { return this.attributes[key]; },
    querySelectorAll: () => [],
    addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); },
  });
  const $ = key => {
    if (!elements.has(key)) elements.set(key, element());
    return elements.get(key);
  };
  const calls = { list: 0, start: [], finish: 0, cancel: 0, opened: [], outputs: 0 };
  const toasts = [];
  let clock = 1_000;
  const timers = [];
  const api = {
    listDisplays: async () => {
      calls.list++;
      return { displays: displays ?? [
        { name: 'Capture screen 0', width: 3456, height: 2234, thumbnail: 'data:image/jpeg;base64,AA' },
        { name: 'Capture screen 1', width: 1920, height: 1080, thumbnail: 'data:image/jpeg;base64,BB' },
      ], audioDevices };
    },
    startRecording: async options => { calls.start.push(options); },
    finishRecording: async () => { calls.finish++; return true; },
    cancel: async () => { calls.cancel++; return true; },
    open: async () => {}, reveal: async () => {},
  };
  const controller = createRecordingController({
    $, api, showToast: (message, tone) => toasts.push({ message, tone }), setIconStatus() {},
    formatDuration: ms => `${ms}ms`, review: { openReview: target => calls.opened.push(target) },
    outputs: { loadOutputs: () => { calls.outputs++; } }, suggestName: () => 'record-next',
    document: { createElement: element }, now: () => clock,
    setInterval: callback => { timers.push(callback); return timers.length; }, clearInterval() {},
  });
  const fire = async (target, name, event = { preventDefault() {} }) => {
    const node = typeof target === 'string' ? $(target) : target;
    for (const callback of node.listeners[name] || []) await callback(event);
  };
  const cards = () => $('#display-list').children;
  return { $, controller, calls, toasts, fire, cards, advance: ms => { clock += ms; timers.forEach(tick => tick()); } };
}

test('덱과 그대로 합쳐지는 화면을 알려 주고 기본으로 고른다', () => {
  assert.equal(displayHint({ width: 1920, height: 1080 }).tone, 'ready');
  assert.match(displayHint({ width: 2560, height: 1440 }).text, /1440p와 같은 크기 · 복사 합치기는 확인 전/);
  assert.match(displayHint({ width: 3456, height: 2234 }).text, /16:9가 아니라/);
  assert.equal(displayHint({ width: 3456, height: 2234 }).tone, 'warn');
  assert.equal(defaultDisplay([{ name: 'a', width: 3456, height: 2234 }, { name: 'b', width: 1920, height: 1080 }]), 'b');
  assert.equal(defaultDisplay([{ name: 'a', width: 1920, height: 1080, error: '권한' }, { name: 'b', width: 3456, height: 2234 }]), 'b',
    '찍을 수 없는 화면은 고르지 않는다');
  assert.equal(defaultDisplay([]), null);
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(754_900), '12:34');
  assert.equal(formatClock(3_725_000), '1:02:05');
});

test('화면을 처음 열 때 한 번만 찾고, 음성은 끈 채로 녹화를 시작한다', async () => {
  const { $, controller, calls, fire, cards } = fixture();
  controller.opened();
  await controller.loadDisplays();
  controller.opened();
  assert.equal(calls.list, 1, '열 때마다 화면을 다시 찍지 않는다');
  assert.equal(cards().length, 2);
  assert.equal(cards()[1].attributes['aria-checked'], 'true', '1080p 화면을 먼저 고른다');
  assert.equal(cards()[0].children[3].dataset.tone, 'warn');
  assert.equal($('#record-start').disabled, false);
  assert.equal($('#record-audio').checked, false);
  assert.equal($('#record-audio-field').classList.contains('hidden'), true);

  $('#record-name').value = 'bob-demo';
  await fire('#record-form', 'submit');
  assert.deepEqual(calls.start, [{ display: 'Capture screen 1', audioDevice: null, name: 'bob-demo' }]);

  await fire(cards()[0], 'click');
  $('#record-audio').checked = true;
  await fire('#record-audio', 'change');
  assert.equal($('#record-audio-field').classList.contains('hidden'), false);
  $('#record-audio-device').value = 'MacBook Pro 마이크';
  await fire('#record-form', 'submit');
  assert.deepEqual(calls.start[1], { display: 'Capture screen 0', audioDevice: 'MacBook Pro 마이크', name: 'bob-demo' });
});

test('녹화가 실제로 시작된 뒤에만 정지를 받고, 정지는 결과를 남기는 요청이다', async () => {
  const { $, controller, calls, fire, advance } = fixture();
  controller.handleEvent({ type: 'record-started', options: { display: 'Capture screen 1', audioDevice: null } });
  assert.equal($('#record-live').classList.contains('hidden'), false);
  assert.equal($('#record-form').classList.contains('hidden'), true);
  assert.equal($('#record-stop').disabled, true, '준비 중에는 정지할 녹화가 없다');

  controller.handleEvent({ type: 'record-phase', phase: 'recording' });
  assert.equal($('#record-stop').disabled, false);
  assert.match($('#record-phase').textContent, /녹화 중 · 음성 없음/);
  advance(65_000);
  assert.equal($('#record-elapsed').textContent, '1:05');

  controller.handleEvent({ type: 'record-phase', phase: 'progress', frames: 1600, dup: 0, drop: 4 });
  assert.equal($('#record-warning').classList.contains('hidden'), false);
  assert.match($('#record-warning').textContent, /누락 4/);

  await fire('#record-stop', 'click');
  assert.equal(calls.finish, 1);
  assert.equal(calls.cancel, 0, '정지는 취소가 아니다');
  controller.handleEvent({ type: 'record-finishing' });
  assert.equal($('#record-stop').disabled, true);
  assert.match($('#record-phase').textContent, /무음 트랙/);

  controller.handleEvent({ type: 'record-complete', report: {
    target: { root: 'edit', day: '2026-09-18', name: 'bob-demo' }, durationMs: 65_040,
    source: { display: { width: 1920, height: 1080 }, audio: 'silent' }, warnings: ['프레임 복제 0 · 누락 4.'],
  } });
  assert.equal($('#record-done').classList.contains('hidden'), false);
  assert.equal($('#record-done').dataset.tone, 'warn', '경고가 있으면 완료여도 성공 표시로 뭉개지 않는다');
  assert.equal($('#record-done-summary').textContent, '65040ms · 1920×1080 · 무음 트랙');
  assert.match($('#record-done-warnings').textContent, /누락 4/);
  assert.equal($('#record-name').value, 'record-next');
  assert.equal(calls.outputs, 1);
  await fire('#record-review', 'click');
  assert.deepEqual(calls.opened, [{ root: 'edit', day: '2026-09-18', name: 'bob-demo' }], '다듬기에서 내레이션을 넣으러 간다');
});

test('취소는 공통 중지로 보내고, 끝나면 결과 없이 설정 화면으로 돌아온다', async () => {
  const { $, controller, calls, fire, toasts } = fixture();
  controller.handleEvent({ type: 'record-started', options: {} });
  controller.handleEvent({ type: 'record-phase', phase: 'recording' });
  await fire('#record-cancel', 'click');
  assert.equal(calls.cancel, 1);
  assert.equal(calls.finish, 0);
  controller.handleEvent({ type: 'cancelling' });
  assert.equal($('#record-stop').disabled, true);
  controller.handleEvent({ type: 'record-finishing' });
  assert.match($('#record-phase').textContent, /취소하는 중/, '취소 중에 늦게 온 마무리 사건이 되돌리지 않는다');
  controller.handleEvent({ type: 'record-failed', cancelled: true, message: '사용자가 작업을 중지했습니다.' });
  assert.equal($('#record-form').classList.contains('hidden'), false);
  assert.equal($('#record-done').classList.contains('hidden'), true);
  assert.match(toasts.at(-1).message, /결과는 남기지 않았습니다/);
  assert.equal(controller.phase, 'idle');
});

test('실패는 원인을 보여 주고, 음성 포함은 다음 녹화에서 다시 꺼진다', async () => {
  const { $, controller, fire } = fixture();
  await controller.loadDisplays();
  $('#record-audio').checked = true;
  await fire('#record-audio', 'change');
  controller.handleEvent({ type: 'record-started', options: { audioDevice: 'MacBook Pro 마이크' } });
  controller.handleEvent({ type: 'record-phase', phase: 'recording' });
  assert.match($('#record-phase').textContent, /음성 포함/);
  controller.handleEvent({ type: 'record-failed', cancelled: false, message: '녹화 파일 검증 실패: 음성 길이 = 영상 길이' });
  assert.equal($('#record-done').dataset.tone, 'failed');
  assert.match($('#record-done-summary').textContent, /음성 길이/);
  assert.equal($('#record-review').classList.contains('hidden'), true, '결과가 없으면 열 곳도 없다');
  assert.equal($('#record-audio').checked, false);
  assert.equal($('#record-audio-field').classList.contains('hidden'), true);
});

// 테두리는 녹화에 찍히므로 세는 동안만 뜬다. 녹화 중에 무엇이 찍히는지는 미리보기가 보인다.
test('시작 직전에는 녹화할 화면을 세어 보이고, 녹화 중에는 그 화면을 비춘다', async () => {
  const { $, controller, cards } = fixture({ displays: [
    { name: 'Capture screen 1', label: 'DELL P2419HC', width: 1920, height: 1080, thumbnail: 'data:image/jpeg;base64,BB' },
  ] });
  await controller.loadDisplays();
  assert.equal(cards()[0].children[2].textContent, 'DELL P2419HC', '화면 번호 대신 모니터 이름을 적는다');

  controller.handleEvent({ type: 'record-started', options: { display: 'Capture screen 1', audioDevice: null } });
  assert.equal($('#record-preview').src, 'data:image/jpeg;base64,BB', '첫 미리보기 전에는 목록의 썸네일을 비춘다');
  controller.handleEvent({ type: 'record-countdown', remaining: 3, label: 'DELL P2419HC', framed: true });
  assert.equal($('#record-monitor').dataset.state, 'countdown');
  assert.equal($('#record-countdown').textContent, '3');
  assert.equal($('#record-countdown').classList.contains('hidden'), false);
  assert.match($('#record-phase').textContent, /3초 뒤 녹화합니다 · 빨간 테두리/);
  assert.equal($('#record-monitor-caption').textContent, 'DELL P2419HC · 1920×1080 · 녹화할 화면');
  assert.equal($('#record-stop').disabled, true, '세는 동안에는 정지할 녹화가 없다');
  controller.handleEvent({ type: 'record-preview', image: 'data:image/jpeg;base64,EARLY' });
  assert.equal($('#record-preview').src, 'data:image/jpeg;base64,BB', '녹화 전에 온 미리보기는 쓰지 않는다');

  controller.handleEvent({ type: 'record-countdown', remaining: 0, framed: true });
  assert.equal($('#record-monitor').dataset.state, 'starting');
  assert.equal($('#record-countdown').classList.contains('hidden'), true);
  assert.match($('#record-phase').textContent, /시작하고 있습니다/);

  controller.handleEvent({ type: 'record-phase', phase: 'recording' });
  assert.equal($('#record-monitor').dataset.state, 'live');
  assert.equal($('#record-monitor-tag-text').textContent, 'REC');
  controller.handleEvent({ type: 'record-preview', image: 'data:image/jpeg;base64,LIVE', mirrored: true });
  assert.equal($('#record-preview').src, 'data:image/jpeg;base64,LIVE');
  assert.equal($('#record-mirror').classList.contains('hidden'), false, '앱 창도 함께 녹화되고 있음을 알린다');
  controller.handleEvent({ type: 'record-preview', image: 'data:image/jpeg;base64,NEXT', mirrored: false });
  assert.equal($('#record-mirror').classList.contains('hidden'), true);

  controller.handleEvent({ type: 'record-preview-paused' });
  assert.match($('#record-monitor-caption').textContent, /녹화 품질을 지키려고 미리보기를 멈췄습니다/);

  controller.handleEvent({ type: 'record-finishing' });
  assert.equal($('#record-monitor').dataset.state, 'finishing');
  assert.equal($('#record-monitor-tag-text').textContent, '저장 중');
});

// 완료 화면이 녹화 설정을 대신하면 다시 찍는 길을 찾아 헤맨다(2026-09-21 사용자 지적).
// 방금 녹화는 설정 위의 결과 카드로 두고, 설정은 늘 보이게 한다.
test('녹화가 끝나도 녹화 설정은 그대로 보이고, 방금 녹화는 그 위 결과 카드로 남는다', async () => {
  const { $, controller, calls, fire } = fixture();
  await controller.loadDisplays();
  assert.equal(calls.list, 1);
  controller.handleEvent({ type: 'record-started', options: { display: 'Capture screen 1' } });
  assert.equal($('#record-form').classList.contains('hidden'), true, '녹화 중에는 진행 카드만 보인다');
  controller.handleEvent({ type: 'record-phase', phase: 'recording' });
  controller.handleEvent({ type: 'record-complete', report: {
    target: { root: 'edit', day: '2026-09-21', name: 'bob-one' }, durationMs: 5000,
    source: { display: { width: 1920, height: 1080 }, audio: 'silent' }, warnings: [],
  } });
  assert.equal($('#record-done').classList.contains('hidden'), false);
  assert.equal($('#record-form').classList.contains('hidden'), false, '다시 찍는 길이 바로 아래에 있다');
  assert.equal($('#record-live').classList.contains('hidden'), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.list, 2, '방금 녹화한 화면의 썸네일을 새로 찍는다');
  assert.equal($('#record-start').disabled, false);

  await fire('#record-dismiss', 'click');
  assert.equal($('#record-done').classList.contains('hidden'), true);

  controller.handleEvent({ type: 'record-failed', cancelled: false, message: '화면을 찾지 못했습니다.' });
  assert.equal($('#record-done').classList.contains('hidden'), false, '실패도 같은 자리에 알린다');
  assert.equal($('#record-form').classList.contains('hidden'), false);
  controller.handleEvent({ type: 'record-started', options: { display: 'Capture screen 1' } });
  assert.equal($('#record-done').classList.contains('hidden'), true, '새 녹화를 시작하면 지난 결과 카드를 걷는다');
});
