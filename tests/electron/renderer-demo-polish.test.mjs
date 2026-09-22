import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoPolishController } from '../../electron-app/renderer/controllers/demo-polish.mjs';
import { createAppDemoController } from '../../electron-app/renderer/controllers/app-demo.mjs';

// 다듬기의 앱 데모 작업면. 실제 컨트롤러에 가짜 화면을 물려 무엇을 저장하고 무엇을 굽게
// 하는지 본다. 화면 모양은 실제 창에서 찍어 확인한다.
import { fakeDemoDom as fakeDom, cameraPreviewData } from "./helpers/demo-dom.mjs";

const project = () => ({
  outDir: '/out/rice-first-run', name: 'rice-first-run', scenario: 'rice-first-run', durationMs: 137600,
  frame: { width: 3840, height: 2160 }, viewport: { width: 1920, height: 1080, scale: 2 },
  videos: [
    { name: 'rice-first-run-high.mp4', label: '2560×1440', bytes: 4e6, url: 'file:///out/rice-first-run-high.mp4' },
    { name: 'rice-first-run-ultra.mp4', label: '3840×2160', bytes: 9e6, url: 'file:///out/rice-first-run-ultra.mp4' },
  ],
  plan: { fps: 25, maxSpeed: 4, durationMs: 29200, zoom: [], segments: [],
    scenes: [{ id: 'awakening', outStartMs: 0, outEndMs: 7900, narration: { atMs: 320, durationMs: 6520 } },
      { id: 'loop', outStartMs: 7900, outEndMs: 12000 }] },
  captions: [], checks: [{ label: '영상 규격', ok: true }], warnings: [], ok: true,
  scenes: [
    { id: 'awakening', startMs: 0, endMs: 31600, timeScale: 0.25, text: '처음 열면 코어가 깨어납니다.', status: 'approved',
      selected: 'narration/awakening/candidate-01.wav', voicedText: '처음 열면 코어가 깨어납니다.',
      candidates: [{ file: 'narration/awakening/candidate-01.wav', name: 'candidate-01', url: 'file:///c1.wav', durationMs: 6520 }] },
    { id: 'loop', startMs: 31600, endMs: 52600, timeScale: 0.125, text: '고친 대본', status: 'approved',
      selected: 'narration/loop/candidate-01.wav', voicedText: '예전 대본',
      candidates: [{ file: 'narration/loop/candidate-01.wav', name: 'candidate-01', url: 'file:///l1.wav', durationMs: 4000 }] },
  ],
});

function controller(t) {
  const { $, document } = fakeDom();
  const calls = [];
  const toasts = [];
  let shown = 0;
  const api = {
    saveDemoScript: async (outDir, scenes) => { calls.push(['save', outDir, scenes]); return { ...project(), scenes: project().scenes.map((scene, index) => ({ ...scene, ...scenes[index] })) }; },
    startDemoVoice: async options => { calls.push(['voice', options]); },
    startDemoRender: async options => { calls.push(['render', options]); },
    readDemoProject: async () => project(),
    readDemoCameraPreview: async options => cameraPreviewData(options.sceneId),
    demoProjectDir: async () => '/out/rice-first-run',
    cancel: async () => true,
  };
  const polish = createDemoPolishController({ $, api, document, showToast: (message, kind) => toasts.push([message, kind]), show: () => { shown += 1; } });
  return { $, polish, calls, toasts, shown: () => shown };
}

test('처음에는 빈 작업면이고 결과를 열면 1440p 완성본과 할 일이 남은 장면에서 시작한다', () => {
  const { $, polish, shown } = controller();
  assert.equal($('#demo-render-start').disabled, true, '열 결과가 없으면 굽지 않는다');
  polish.load(project());
  assert.equal(shown(), 1);
  assert.equal($('#demo-polish-name').textContent, 'rice-first-run');
  assert.equal($('#demo-player').src, 'file:///out/rice-first-run-high.mp4');
  assert.match($('#demo-polish-verdict').textContent, /검증 1\/1 통과/);
  // loop는 대본을 고친 뒤 후보를 다시 만들지 않았다. 다음 할 일은 목소리다.
  assert.match($('#demo-polish-hint').innerHTML, /목소리 후보를 만듭니다/);
  assert.match($('#demo-command-note').textContent, /후보를 새로 만들 장면 loop/);
  assert.match($('#demo-scene-panel').innerHTML, /<h2>loop<\/h2>/, '할 일이 남은 첫 장면에서 연다');
  assert.match($('#demo-scene-panel').innerHTML, /예전 대본을 읽습니다/);
  assert.match($('#demo-scene-panel').innerHTML, /영상에 맞춰 듣기/, '구운 완성본이 있으면 영상에 맞춰 듣는다');
  assert.equal($('#demo-voice-all').disabled, false);
  assert.equal($('#demo-voice-all').textContent, '후보 만들기 · 1장면');
  assert.equal($('#demo-voice-all').classList.contains('primary-small'), true, '차례인 단추만 밝다');
  assert.equal($('#demo-render-start').classList.contains('primary-small'), false);
});

test('후보 만들기는 할 일이 남은 장면만, 굽기는 고른 화질로 부르고 그 전에 대본을 저장한다', async () => {
  const { $, polish, calls } = controller();
  polish.load(project());
  $('#demo-candidates').value = '4';
  await $('#demo-voice-all').fire('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0][0], 'save');
  assert.deepEqual(calls[1], ['voice', { outDir: '/out/rice-first-run', candidates: 4, scenes: ['loop'] }]);

  $('#demo-quality').value = 'ultra';
  await $('#demo-render-start').fire('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.at(-1), ['render', { outDir: '/out/rice-first-run', quality: 'ultra', burnCaptions: false }],
    '자막은 기본으로 굽지 않는다');
  $('#demo-burn').checked = true;
  await $('#demo-render-start').fire('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.at(-1), ['render', { outDir: '/out/rice-first-run', quality: 'ultra', burnCaptions: true }]);
});

test('확정과 고르기는 바로 script.json에 적는다', async () => {
  const { $, polish, calls } = controller();
  polish.load(project());
  const panel = $('#demo-scene-panel');
  await panel.fire('change', { target: { id: 'demo-scene-approved', checked: false, matches: () => false } });
  await new Promise(resolve => setImmediate(resolve));
  const [, outDir, scenes] = calls.at(-1);
  assert.equal(outDir, '/out/rice-first-run');
  assert.deepEqual(scenes.find(scene => scene.id === 'loop'), { id: 'loop', text: '고친 대본', status: 'draft', selected: 'narration/loop/candidate-01.wav', camera: null });
});

test('구도 편집에서 저장하고 영상에 적용하면 같은 화질로 렌더까지 이어진다', async () => {
  const { $, polish, calls } = controller();
  polish.load(project());
  assert.match($('#demo-scene-panel').innerHTML, /드래그로 확대/);
  await $('#demo-scene-panel').fire('click', { target: { closest: selector => selector === '#demo-camera-edit' ? {} : null } });
  assert.equal($('#demo-camera-dialog').open, true);
  await $('#demo-camera-mode').fire('change', { target: { value: 'overview' } });
  assert.match($('#demo-camera-result').style.transform, /scale\(1\)/);
  await $('#demo-camera-apply').fire('click');
  assert.equal($('#demo-camera-dialog').open, false);
  const edit = calls.find(call => call[0] === 'save')[2].find(scene => scene.id === 'loop');
  assert.equal(edit.camera, 'overview');
  assert.equal(edit.text, '고친 대본');
  assert.equal(edit.selected, 'narration/loop/candidate-01.wav');
  assert.deepEqual(calls.at(-1), ['render', { outDir: '/out/rice-first-run', quality: 'high', burnCaptions: false }]);
});

test('굽는 동안은 진행을 보이고, 끝나면 방금 구운 화질로 바꿔 보여 준다', () => {
  const { $, polish } = controller();
  polish.load(project());
  polish.handleEvent({ type: 'demo-started', jobKind: 'demo-render', step: 'demo-render', quality: 'ultra', burnCaptions: true, outDir: '/out/rice-first-run' });
  assert.equal($('#demo-running').classList.contains('hidden'), false);
  assert.equal($('#demo-command-actions').classList.contains('hidden'), true, '도는 동안은 단추 자리에 진행이 선다');
  assert.equal($('#demo-running-note').textContent, '4K · 자막 굽기');
  assert.equal($('#demo-render-start').disabled, true);
  polish.handleEvent({ type: 'log', jobKind: 'demo-render', text: 'ffmpeg…\n' });
  assert.match($('#demo-polish-log').textContent, /ffmpeg/);
  const baked = project();
  baked.videos.push({ name: 'rice-first-run-ultra-captioned.mp4', label: '3840×2160 · 자막', bytes: 9e6, url: 'file:///out/rice-first-run-ultra-captioned.mp4' });
  polish.handleEvent({ type: 'demo-complete', jobKind: 'demo-render', step: 'demo-render', project: baked });
  assert.equal($('#demo-running').classList.contains('hidden'), true);
  assert.equal($('#demo-player').src, 'file:///out/rice-first-run-ultra-captioned.mp4', '방금 구운 자막본으로 바꿔 보여 준다');
  // 촬영은 새로 만들기의 일이다. 이 작업면은 그 사건을 받지 않는다.
  polish.handleEvent({ type: 'demo-started', jobKind: 'demo-record', step: 'demo-record' });
  assert.equal($('#demo-running').classList.contains('hidden'), true);
});

test('같은 화질·같은 이름으로 다시 구워도 새 영상 주소를 다시 읽는다', () => {
  const { $, polish } = controller();
  const initial = project(); initial.videos[0].url += '?v=old';
  polish.load(initial);
  polish.handleEvent({ type: 'demo-started', jobKind: 'demo-render', step: 'demo-render', quality: 'high' });
  const next = project(); next.videos[0].url += '?v=new';
  next.videos[0].cameraSettings = { loop: 'overview', awakening: 'auto' };
  next.scenes[1].camera = 'overview';
  polish.handleEvent({ type: 'demo-complete', jobKind: 'demo-render', step: 'demo-render', project: next });
  assert.equal($('#demo-player').src, 'file:///out/rice-first-run-high.mp4?v=new');
  assert.match($('#demo-scene-panel').innerHTML, /지금 재생하는 완성본에 반영됐습니다/);
});

test('다른 작업이 돌면 굽기·후보 만들기만 막고 까닭을 적는다', () => {
  const { $, polish } = controller();
  polish.load(project());
  polish.setBlocked('강의 영상을 만드는 중입니다');
  assert.equal($('#demo-render-start').inert, true);
  assert.equal($('#demo-voice-all').inert, true);
  assert.equal($('#demo-blocked').classList.contains('hidden'), false);
  assert.match($('#demo-blocked').textContent, /강의 영상을 만드는 중입니다 · 끝나면/);
  polish.setBlocked(null);
  assert.equal($('#demo-render-start').inert, false);
  assert.equal($('#demo-blocked').classList.contains('hidden'), true);
});

// 촬영은 새로 만들기에서 하고 대본은 다듬기에서 쓴다. 촬영이 끝나면 결과 카드가 그 사이를 잇는다.
test('촬영이 끝나면 결과 카드가 방금 찍은 결과를 다듬기로 넘긴다', async () => {
  const { $, document } = fakeDom();
  const opened = [];
  const demo = createAppDemoController({ $, $$: () => [], api: {}, document, showToast() {}, setIconStatus() {},
    openInPolish: async value => { opened.push(value); } });
  demo.bind();
  demo.handleEvent({ type: 'demo-started', jobKind: 'demo-record', step: 'demo-record' });
  assert.equal($('#demo-progress').classList.contains('hidden'), false);
  assert.equal($('#demo-setup').classList.contains('hidden'), true, '찍는 동안은 설정 대신 진행이 선다');
  demo.handleEvent({ type: 'log', jobKind: 'demo-record', text: '장면 awakening\n' });
  assert.match($('#demo-log').textContent, /awakening/);
  // 다듬기의 일(목소리·완성본)은 이 화면이 받지 않는다.
  demo.handleEvent({ type: 'demo-complete', jobKind: 'demo-voice', step: 'demo-voice', project: project() });
  assert.equal($('#demo-done').classList.contains('hidden'), true);

  const recorded = project();
  demo.handleEvent({ type: 'demo-complete', jobKind: 'demo-record', step: 'demo-record', project: recorded });
  assert.equal($('#demo-done').classList.contains('hidden'), false);
  assert.equal($('#demo-setup').classList.contains('hidden'), false, '다시 찍는 길은 늘 보인다');
  assert.match($('#demo-done-summary').textContent, /rice-first-run · 장면 2개 · 촬영 137\.6초/);
  assert.equal($('#demo-polish-go').classList.contains('hidden'), false);
  await $('#demo-polish-go').fire('click');
  assert.deepEqual(opened, [recorded]);

  demo.handleEvent({ type: 'demo-failed', jobKind: 'demo-record', step: 'demo-record', message: 'RICE가 뜨지 않았습니다' });
  assert.equal($('#demo-done').dataset.tone, 'failed');
  assert.equal($('#demo-polish-go').classList.contains('hidden'), true, '실패하면 넘길 결과가 없다');
});
