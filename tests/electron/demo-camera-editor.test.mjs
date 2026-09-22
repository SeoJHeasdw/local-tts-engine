import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoCameraEditor } from '../../electron-app/renderer/controllers/demo-camera.mjs';
import { cameraApplication } from '../../electron-app/renderer/controllers/demo-polish.mjs';
import { cameraSetting, sourceTimeAt } from '../../electron-app/shared/demo-camera.mjs';
import { buildEditPlan } from '../../electron-app/shared/demo-plan.mjs';
import { fakeDemoDom, cameraPreviewData } from './helpers/demo-dom.mjs';

const project = { outDir: '/out/project' };
const scene = { id: 'loop', camera: 'overview', recordedCamera: 'auto' };

test('드래그한 영역은 원본 좌표로 저장되고 인코딩 요청 없이 즉시 미리 보인다', async () => {
  const { $ } = fakeDemoDom();
  const calls = [], saves = [];
  const editor = createDemoCameraEditor({ $, api: { readDemoCameraPreview: async options => {
    calls.push(options); return cameraPreviewData();
  } }, onSave: async value => saves.push(value) });
  await editor.open(project, scene);
  const before = $('#demo-camera-result').style.transform;
  await $('#demo-camera-source').fire('pointerdown', { button: 0, clientX: 180, clientY: 100, pointerId: 1, preventDefault() {} });
  await $('#demo-camera-source').fire('pointermove', { clientX: 350, clientY: 250 });
  await $('#demo-camera-source').fire('pointerup');
  assert.equal(calls.length, 1, '드래그는 원본 사진 한 장을 다시 계산할 뿐 ffmpeg를 다시 호출하지 않는다');
  assert.notEqual($('#demo-camera-result').style.transform, before);
  assert.equal($('#demo-camera-mode').value, 'focus');
  await $('#demo-camera-save').fire('click');
  assert.equal(saves[0].render, false);
  assert.deepEqual(saves[0].camera.box, { x: 240, y: 150, w: 510, h: 450 });
  assert.equal(scene.camera, 'overview', '취소 가능한 초안을 별도로 다룬다');
});

test('자동 확대 기록이 없는 장면은 까닭을 표시하고 취소는 저장하지 않는다', async () => {
  const { $ } = fakeDemoDom();
  let saved = 0;
  const preview = cameraPreviewData(); preview.automaticAvailable = false; preview.recording.scenes[0].steps = [];
  const editor = createDemoCameraEditor({ $, api: { readDemoCameraPreview: async () => preview }, onSave: async () => saved++ });
  await editor.open(project, { ...scene, camera: 'auto' });
  assert.match($('#demo-camera-result-note').textContent, /자동으로 확대할 구간이 없습니다/);
  assert.equal($('#demo-camera-auto-point').disabled, true);
  await $('#demo-camera-mode').fire('change', { target: { value: 'focus' } });
  await $('#demo-camera-cancel').fire('click');
  assert.equal(saved, 0);
  assert.equal(editor.isOpen, false);
});

test('이전 장면의 느린 응답은 새 장면 미리보기를 덮지 않는다', async () => {
  const { $ } = fakeDemoDom();
  const replies = [];
  const editor = createDemoCameraEditor({ $, api: { readDemoCameraPreview: () => new Promise(resolve => replies.push(resolve)) }, onSave: async () => {} });
  const first = editor.open(project, scene);
  await $('#demo-camera-cancel').fire('click');
  const second = editor.open(project, { ...scene, id: 'other' });
  replies[1](cameraPreviewData('other')); await second;
  replies[0](cameraPreviewData('loop')); await first;
  assert.equal($('#demo-camera-image').src, 'data:image/png;base64,other');
});

test('저장 실패는 편집 창과 초안을 유지해 다시 시도할 수 있다', async () => {
  const { $ } = fakeDemoDom();
  const editor = createDemoCameraEditor({ $, api: { readDemoCameraPreview: async () => cameraPreviewData() },
    onSave: async () => { throw new Error('저장 실패'); } });
  await editor.open(project, scene);
  await $('#demo-camera-apply').fire('click');
  assert.equal(editor.isOpen, true);
  assert.match($('#demo-camera-status').textContent, /저장 실패/);
  assert.equal($('#demo-camera-apply').disabled, false);
});

test('직접 지정한 영역은 편집 계획에도 들어가고 완성본별 반영 상태를 구분한다', () => {
  const data = cameraPreviewData(), viewport = data.recording.viewport;
  const setting = cameraSetting({ mode: 'focus', box: { x: 120, y: 200, w: 700, h: 700 } }, viewport);
  const plan = buildEditPlan(data.recording, { cameras: { loop: setting } });
  assert.deepEqual(plan.scenes[0].camera, setting);
  assert.ok(plan.zoom.some(key => key.z > 1));
  const draft = { ...scene, camera: setting };
  assert.equal(cameraApplication(draft, { cameraSettings: { loop: setting } }, viewport), 'applied');
  assert.equal(cameraApplication(draft, { cameraSettings: { loop: 'overview' } }, viewport), 'pending');
  assert.equal(cameraApplication(draft, {}, viewport), 'unknown');
  assert.equal(cameraApplication({ ...draft, cameraModifiedAt: '2026-09-22T03:00:00Z' },
    { modifiedMs: Date.parse('2026-09-22T02:00:00Z') }, viewport), 'pending', '구도 정보가 없는 옛 영상도 저장 뒤 미반영임을 표시한다');
  assert.equal(cameraApplication(draft, null, viewport), 'new');
  assert.throws(() => cameraSetting({ mode: 'focus', box: { x: -1, y: 0, w: 100, h: 100 } }, viewport), /화면 안/);
});

test('짧아서 확대를 생략할 장면은 사진에서도 확대됐다고 보여 주지 않는다', async () => {
  const { $ } = fakeDemoDom();
  const data = cameraPreviewData();
  data.endMs = 800; data.recording.scenes[0].endMs = 800; data.recording.scenes[0].steps = [];
  data.atMs = 400; data.defaultAtMs = 400; data.automaticAvailable = false;
  const editor = createDemoCameraEditor({ $, api: { readDemoCameraPreview: async () => data }, onSave: async () => {} });
  await editor.open(project, scene);
  await $('#demo-camera-mode').fire('change', { target: { value: 'focus' } });
  assert.match($('#demo-camera-result').style.transform, /scale\(1\)/);
  assert.match($('#demo-camera-result-note').textContent, /짧아 전체 화면/);
});

test('미리보기 시각은 빨리 감기와 마지막 화면 멈춤을 거꾸로 찾아 원본을 읽는다', () => {
  const plan = { fps: 25, segments: [
    { srcStartMs: 0, srcEndMs: 4000, outStartMs: 0, outFrames: 25, holdMs: 1000 },
    { srcStartMs: 4000, srcEndMs: 6000, outStartMs: 2000, outFrames: 50, holdMs: 0 },
  ] };
  assert.equal(sourceTimeAt(plan, 500), 2000);
  assert.equal(sourceTimeAt(plan, 1500), 3960);
  assert.equal(sourceTimeAt(plan, 2200), 4200);
  assert.equal(sourceTimeAt(plan, 9999), 5960);
});
