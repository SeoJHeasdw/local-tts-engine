import test from 'node:test';
import assert from 'node:assert/strict';
import { installRendererGlobals } from './helpers/renderer-dom.mjs';

test('실제 화면 모듈을 함께 불러와 초기화하고 공통 이벤트까지 연결한다', async t => {
  let jobListener;
  let jobRunning = false;
  const api = {
    onJobEvent: callback => { jobListener = callback; },
    getStatus: async () => ({ catalog: { pages: [], lessons: [], totalPages: 0 }, capabilities: { editing: true } }),
    getSettings: async () => ({ modelId: 'qwen3-tts', adapterId: 'none', adapterScale: .6, voiceParallelism: 2, adapters: [], paths: {} }),
    listOutputs: async () => [],
    // main 은 실행 중인 작업이 있으면 이어할 것이 없다고 답한다.
    getResumable: async () => (jobRunning ? null : { name: 'ch03', title: 'CH03 전체', total: 11, done: 4, remaining: 7 }),
  };
  const { query, listeners, timers } = installRendererGlobals(t, { api });
  await import('../../electron-app/renderer/app.js');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(query('#runtime-label').textContent, '전체 기능 준비됨', query('#job-log').textContent);
  assert.equal(typeof jobListener, 'function');
  assert.equal(typeof listeners.get('play'), 'function', '삭제된 편집 탭 호출이 공통 재생 연결을 막으면 안 된다');
  assert.doesNotMatch(query('#job-log').textContent, /초기화 오류/);

  // 이어할 작업은 열었을 때 알려 주고, 새 작업을 시작하면 그 자리를 비운다.
  // 그러지 않으면 11편 중 0편 완료 같은 옛 기록이 진행 중인 작업 위에 남는다.
  assert.equal(query('#resume-banner').classList.contains('hidden'), false);
  assert.match(query('#resume-detail').textContent, /11편 중 4편 완료/);
  jobRunning = true;
  jobListener({ type: 'started', options: { name: 'ch03-run', mode: 'chapter', chapterMode: 'lesson' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(query('#resume-banner').classList.contains('hidden'), true, '실행 중에는 이어하기 안내를 띄우지 않는다');

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
  // 실제 제작과 같은 순서로 두 편을 지나 보낸다. 편마다 목소리 → 촬영이고,
  // 촬영 길이는 합성이 끝난 뒤 오는 음성 길이로 잰다.
  for (const index of [1, 2]) {
    jobListener({ type: 'unit', index, total: 11 });
    jobListener({ type: 'stage', stage: 'voice', state: 'running' });
    now += 4 * 60_000;
    jobListener({ type: 'stage', stage: 'voice', state: 'done' });
    jobListener({ type: 'unit-duration', durationMs: 5 * 60_000 });
    jobListener({ type: 'stage', stage: 'capture', state: 'running' });
    now += 6 * 60_000;
    jobListener({ type: 'stage', stage: 'capture', state: 'done' });
  }
  jobListener({ type: 'unit', index: 3, total: 11 });
  jobListener({ type: 'stage', stage: 'voice', state: 'running' });
  jobListener({ type: 'voice-progress', done: 0, total: 20 });
  now += 60_000;
  jobListener({ type: 'voice-progress', done: 2, total: 20 });
  assert.match(query('#job-eta').textContent, /이 편 \d+:\d\d 남음/);
  assert.match(query('#job-total-eta').textContent, /전체 \d+:\d\d:\d\d 남음/);
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

  // 촬영으로 넘어가도 시계가 꺼지지 않는다. 음성 길이만큼 실시간으로 도는
  // 단계라, 남은 촬영 시간이 곧 이 편의 남은 시간이다.
  jobListener({ type: 'stage', stage: 'voice', state: 'done' });
  jobListener({ type: 'unit-duration', durationMs: 5 * 60_000 });
  jobListener({ type: 'stage', stage: 'capture', state: 'running' });
  now += 60_000;
  timers.forEach(tick => tick());
  assert.match(query('#job-eta').textContent, /이 편 \d+:\d\d 남음/, '촬영 중에도 남은 시간을 말한다');
  assert.equal(query('#job-eta').classList.contains('eta-calculating'), false);
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
  assert.equal(query('#job-total-eta').textContent, '전체 10:00 남음', '실패한 10페이지를 1분 만에 완료한 것으로 세지 않는다');
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

  // 새로 만들기의 갈래는 작업 하나를 나눠 쓴다. 한 갈래가 돌면 나머지 갈래의 시작 단추만
  // 막고, 보고 있는 갈래 화면 위에서 무엇이 도는지 알린다. 끝나면 모두 풀린다.
  const starters = ['#start-button', '#start-text-voices', '#record-start', '#demo-record-start', '#demo-voice-all', '#demo-render-start'];
  for (const selector of starters) assert.equal(query(selector).inert, false, `${selector}는 작업이 없으면 열려 있다`);
  assert.equal(query('#create-busy').classList.contains('hidden'), true);

  jobListener({ type: 'record-started', jobKind: 'record', options: { display: 'Capture screen 0' } });
  assert.equal(query('#record-start').inert, false, '도는 갈래는 제 화면이 막는다');
  for (const selector of ['#start-button', '#start-text-voices', '#demo-record-start']) assert.equal(query(selector).inert, true, selector);
  assert.equal(query('#create-busy').classList.contains('hidden'), false, '강의 영상 화면에서 녹화 중임을 알린다');
  assert.match(query('#create-busy-text').textContent, /화면을 녹화하는 중/);
  assert.equal(query('.nav-item[data-view="new"]').classList.contains('running'), true);
  jobListener({ type: 'record-phase', jobKind: 'record', phase: 'recording' });
  assert.equal(query('.nav-item[data-view="new"]').classList.contains('recording'), true, '녹화 중에는 사이드바가 빨강이다');
  jobListener({ type: 'log', jobKind: 'record', text: 'frame=1\n' });
  jobListener({ type: 'record-failed', jobKind: 'record', cancelled: true, message: '취소' });
  for (const selector of starters) assert.equal(query(selector).inert, false, `${selector}는 녹화가 끝나면 풀린다`);
  assert.equal(query('#create-busy').classList.contains('hidden'), true);
  assert.equal(query('.nav-item[data-view="new"]').classList.contains('recording'), false);

  // 앱 데모의 목소리·완성본은 다듬기에서 돈다. 새로 만들기의 시작은 모두 막고, 다듬기
  // 메뉴에 도는 표시를 두고, 앱 데모 작업면은 제 진행을 보인다.
  jobListener({ type: 'demo-started', jobKind: 'demo-voice', step: 'demo-voice', scenes: ['loop'] });
  for (const selector of ['#start-button', '#record-start', '#demo-record-start']) assert.equal(query(selector).inert, true, selector);
  assert.equal(query('#demo-voice-all').inert, false, '도는 작업면은 제 진행으로 막는다');
  assert.equal(query('#demo-running').classList.contains('hidden'), false);
  assert.match(query('#demo-running-note').textContent, /loop/);
  assert.match(query('#create-busy-text').textContent, /앱 데모 목소리 후보를 만드는 중/);
  assert.equal(query('.nav-item[data-view="review"]').classList.contains('running'), true, '다듬기 메뉴가 도는 표시를 한다');
  assert.equal(query('.nav-item[data-view="new"]').classList.contains('running'), false);
  jobListener({ type: 'demo-failed', jobKind: 'demo-voice', step: 'demo-voice', message: '실패' });
  // 끝난 뒤 늦게 온 로그가 다시 막지 않는다.
  jobListener({ type: 'log', jobKind: 'demo-voice', text: 'late\n' });
  for (const selector of starters) assert.equal(query(selector).inert, false, selector);
  assert.equal(query('#demo-running').classList.contains('hidden'), true);
  assert.equal(query('.nav-item[data-view="review"]').classList.contains('running'), false);

  // 새로 만들기에서 강의가 돌면 앱 데모 작업면은 굽기·후보 만들기만 막고 까닭을 적는다.
  jobListener({ type: 'started', jobKind: 'create', options: { name: 'lesson', mode: 'lesson' } });
  assert.equal(query('#demo-render-start').inert, true);
  assert.match(query('#demo-blocked').textContent, /강의 영상을 만드는 중/);
  jobListener({ type: 'failed', jobKind: 'create', cancelled: true, message: '중지됨' });
  assert.equal(query('#demo-render-start').inert, false);
});
