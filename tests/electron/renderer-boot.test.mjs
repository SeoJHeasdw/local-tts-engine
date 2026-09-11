import test from 'node:test';
import assert from 'node:assert/strict';

test('실제 화면 모듈을 함께 불러와 초기화하고 공통 이벤트까지 연결한다', async t => {
  const elements = new Map();
  const listeners = new Map();
  const timers = [];
  const element = () => {
    const classes = new Set();
    return {
      value: '', textContent: '', innerHTML: '', dataset: {}, style: { setProperty() {} },
      disabled: false, children: [], currentTime: 0, duration: 0, scrollTop: 0,
      classList: {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        contains: name => classes.has(name),
        toggle(name, force = !classes.has(name)) { force ? classes.add(name) : classes.delete(name); },
      },
      addEventListener() {}, setAttribute() {}, removeAttribute() {},
      append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; },
      querySelector: () => element(), querySelectorAll: () => [], closest() { return this; },
      getBoundingClientRect: () => ({ height: 0, width: 0 }), pause() {}, click() {},
    };
  };
  const query = selector => {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  };
  let jobListener;
  const api = {
    onJobEvent: callback => { jobListener = callback; },
    getStatus: async () => ({ catalog: { pages: [], lessons: [], totalPages: 0 }, capabilities: { editing: true } }),
    getSettings: async () => ({ modelId: 'qwen3-tts', adapterId: 'none', adapterScale: .6, voiceParallelism: 2, adapters: [], paths: {} }),
    listOutputs: async () => [],
  };
  const globals = {
    window: { ttsStudio: api, scrollTo() {}, location: { search: '' } },
    document: {
      querySelector: query, querySelectorAll: () => [], createElement: element,
      documentElement: element(), body: element(),
      addEventListener: (name, callback) => listeners.set(name, callback),
    },
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    localStorage: { getItem: () => null, setItem() {} },
    setInterval: callback => { timers.push(callback); return 0; },
  };
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  t.after(() => {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  await import('../../electron-app/renderer/app.js');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(query('#runtime-label').textContent, '전체 기능 준비됨', query('#job-log').textContent);
  assert.equal(typeof jobListener, 'function');
  assert.equal(typeof listeners.get('play'), 'function', '삭제된 편집 탭 호출이 공통 재생 연결을 막으면 안 된다');
  assert.doesNotMatch(query('#job-log').textContent, /초기화 오류/);

  // Exercise the actual event subscription across all production modes/qualities.
  for (const videoQuality of ['standard', 'high', 'ultra']) {
    for (const [mode, chapterMode] of [['lesson', 'single'], ['page', 'single'], ['chapter', 'single'], ['chapter', 'lesson']]) {
      jobListener({ type: 'started', options: { name: 'timer-check', mode, chapterMode, videoQuality } });
      const split = chapterMode === 'lesson';
      assert.equal(query('#job-eta').textContent, `${split ? '이 편 ' : ''}남은 시간 계산 중`);
      assert.equal(query('#job-eta').classList.contains('eta-calculating'), true);
      assert.equal(query('#job-total-eta').classList.contains('hidden'), !split);
      assert.equal(query('#job-total-eta').classList.contains('eta-calculating'), split);
    }
  }

  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });
  jobListener({ type: 'plan', units: Array.from({ length: 11 }, () => ({ pages: 10 })) });
  jobListener({ type: 'unit', index: 1, total: 11 });
  now += 10 * 60_000;
  jobListener({ type: 'unit', index: 2, total: 11 });
  now += 10 * 60_000;
  jobListener({ type: 'unit', index: 3, total: 11 });
  jobListener({ type: 'voice-progress', done: 0, total: 20 });
  now += 60_000;
  jobListener({ type: 'voice-progress', done: 2, total: 20 });
  assert.match(query('#job-eta').textContent, /이 편 약/);
  assert.match(query('#job-total-eta').textContent, /전체 약/);
  assert.equal(query('#job-eta').classList.contains('eta-calculating'), false);

  const beforePause = query('#job-eta').textContent;
  jobListener({ type: 'paused', immediate: true });
  now += 30 * 60_000;
  timers.forEach(tick => tick());
  assert.equal(query('#job-eta').textContent, '일시정지');
  assert.equal(query('#job-total-eta').textContent, '전체 일시정지');
  assert.equal(query('#job-eta').classList.contains('eta-calculating'), false);
  jobListener({ type: 'resumed' });
  assert.equal(query('#job-eta').textContent, beforePause, '정지한 30분을 생성 시간으로 세지 않는다');

  jobListener({ type: 'stage', stage: 'capture', state: 'running' });
  assert.equal(query('#job-eta').textContent, '이 편 남은 시간 계산 중', '음성 추정치를 촬영 완료 시각으로 표시하지 않는다');
  jobListener({ type: 'failed', message: '335페이지 B-3102: 읽기를 지정하세요.' });
  now += 60_000;
  timers.forEach(tick => tick());
  jobListener({ type: 'voice-progress', done: 3, total: 20 });
  jobListener({ type: 'unit', index: 4, total: 11 });
  assert.equal(query('#job-unit').textContent, '레슨 3/11');
  for (const selector of ['#job-eta', '#job-total-eta']) {
    assert.equal(query(selector).textContent, '');
    assert.equal(query(selector).classList.contains('eta-calculating'), false);
  }
  jobListener({ type: 'started', options: { name: 'next', mode: 'lesson' } });
  jobListener({ type: 'cancelling' });
  timers.forEach(tick => tick());
  assert.equal(query('#job-eta').textContent, '');
  jobListener({ type: 'failed', cancelled: true, message: '중지됨' });
  assert.equal(query('#job-total-eta').textContent, '');

  jobListener({ type: 'started', options: { name: 'batch', mode: 'chapter', chapterMode: 'lesson' } });
  jobListener({ type: 'plan', units: [{ pages: 10 }, { pages: 10 }, { pages: 10 }] });
  jobListener({ type: 'unit', index: 1, total: 3 });
  now += 10 * 60_000;
  jobListener({ type: 'unit', index: 2, total: 3 });
  now += 60_000;
  jobListener({ type: 'unit-failed', index: 2, title: 'L02', failedCount: 1 });
  assert.equal(query('#start-button').disabled, true, '한 레슨 실패 후에도 제작은 실행 중이다');
  assert.match(query('#job-failure-note').textContent, /1개 레슨 실패/);
  jobListener({ type: 'unit', index: 3, total: 3 });
  assert.equal(query('#job-total-eta').textContent, '전체 약 10분 남음', '실패한 10페이지를 1분 만에 완료한 것으로 세지 않는다');
  const partial = { totalUnits: 3, durationMs: 2000, target: { root: 'render', name: 'first' },
    summary: { ok: false }, failedUnits: [{ name: 'l02', title: 'L02', message: '음성 생성 실패' }],
    units: [{ name: 'l01', target: { root: 'render', name: 'first' } }, { name: 'l03' }] };
  jobListener({ type: 'partial-complete', report: partial });
  assert.equal(query('#job-state').textContent, '일부 제작 실패');
  assert.match(query('#complete-summary').textContent, /3개 레슨 중 2개 완료 · 1개 실패/);
  assert.match(query('#complete-failures').textContent, /L02\n음성 생성 실패/);
  assert.equal(query('#complete-panel .complete-icon').textContent, '!');
  timers.forEach(tick => tick());
  assert.equal(query('#job-eta').textContent, '');
  assert.equal(query('#job-total-eta').textContent, '');
  assert.equal(query('#pause-button').classList.contains('hidden'), true);

  jobListener({ type: 'partial-complete', report: { ...partial, target: null, units: [] } });
  assert.equal(query('#job-state').textContent, '제작 실패');
  assert.equal(query('#complete-panel .complete-actions').classList.contains('hidden'), true);
  assert.match(query('#complete-summary').textContent, /완성된 영상 없음/);
});
