import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAN_DEFAULTS, buildEditPlan, zoomAt } from '../../electron-app/shared/demo-plan.mjs';

const viewport = { width: 1920, height: 1080, scale: 2 };
const recorded = (scenes, durationMs) => ({ schemaVersion: 1, scenario: 'demo', viewport, durationMs, scenes });
const totalOf = plan => plan.segments.reduce((sum, s) => sum + s.outFrames + s.holdMs / 40, 0);

// 실제 측정(설계 10절)을 줄인 모양이다. 승인 카드 17.8초, 승인 뒤 완료 41.1초처럼
// 화면 변화가 없는 기다림이 장면 길이를 지배한다.
const waitScene = {
  id: 'approve', startMs: 0, endMs: 24000,
  steps: [
    { verb: 'waitFor', startMs: 0, endMs: 18000 },
    { verb: 'pause', startMs: 18000, endMs: 19500 },
    { verb: 'click', startMs: 19500, endMs: 20100, point: { x: 1267, y: 475 } },
    { verb: 'waitGone', startMs: 20100, endMs: 24000 },
  ],
};

test('기다림만 감고 사람 동작은 1배로 둔다', () => {
  const plan = buildEditPlan(recorded([waitScene], 24000), { narration: { approve: { durationMs: 10000 } } });
  const kinds = plan.segments.map(s => [s.kind, s.srcStartMs, s.srcEndMs]);
  // 구간 경계는 프레임에 맞춘다(20100ms → 20120ms). 밀리초로 자르면 감을 때마다
  // 반 프레임이 남아 최종 프레임 수가 계획과 어긋난다.
  assert.deepEqual(kinds, [['fast', 0, 18000], ['normal', 18000, 20120], ['fast', 20120, 24000]]);
  assert.equal(plan.segments[1].speed, 1, '누르고 치는 구간은 1배다');
  assert.ok(plan.segments[0].speed > 2 && plan.segments[2].speed > 2);
  // 내레이션 10초 + 앞 0.3초 + 뒤 0.5초 = 10.8초가 장면 목표다.
  assert.equal(plan.durationMs, 10800);
  assert.equal(plan.scenes[0].narration.atMs, 320);
  assert.equal(plan.totalFrames, totalOf(plan));
});

test('최대 배율을 넘겨서까지 감지 않는다', () => {
  const plan = buildEditPlan(recorded([waitScene], 24000), { narration: { approve: { durationMs: 1000 } } });
  assert.ok(plan.segments.filter(s => s.kind === 'fast').every(s => s.speed <= PLAN_DEFAULTS.maxSpeed + 1e-6),
    JSON.stringify(plan.segments.map(s => s.speed)));
  // 2.12초 사람 동작은 1배로 남고 21.88초 기다림만 4배로 줄어 7.64초다.
  assert.equal(plan.durationMs, 7640);
  assert.equal(plan.segments.every(s => s.holdMs === 0), true, '감아도 목표보다 길면 멈출 이유가 없다');
  const slower = buildEditPlan(recorded([waitScene], 24000),
    { narration: { approve: { durationMs: 1000 } }, options: { maxSpeed: 2 } });
  assert.equal(slower.durationMs, 13080, '상한을 낮추면 결과가 길어진다');
});

test('내레이션이 짧아도 감을 수 있는 한계보다 짧아지지 않는다', () => {
  const plan = buildEditPlan(recorded([waitScene], 24000));
  assert.equal(plan.scenes[0].narration, null, '대본이 없는 장면도 계획에 들어간다');
  assert.equal(plan.durationMs, 7640);
});

test('감은 원본이 내레이션보다 짧으면 장면 끝 화면을 멈춰 채운다', () => {
  const short = { id: 'result', startMs: 0, endMs: 2000, steps: [{ verb: 'pause', startMs: 0, endMs: 2000 }] };
  const plan = buildEditPlan(recorded([short], 2000), { narration: { result: { durationMs: 9000, file: 'a.wav' } } });
  assert.equal(plan.segments.length, 1);
  assert.equal(plan.segments[0].speed, 1);
  assert.equal(plan.segments[0].holdMs, 7800, '2초 원본 뒤에 7.8초를 멈춘다');
  assert.equal(plan.durationMs, 9800);
  assert.deepEqual(plan.scenes[0].narration, { atMs: 320, durationMs: 9000, file: 'a.wav' });
  assert.equal(plan.totalFrames, totalOf(plan));
});

test('장면을 이어 붙이고 완성 영상 시각으로 옮긴다', () => {
  const plan = buildEditPlan(recorded([
    { id: 'ask', startMs: 0, endMs: 4000, steps: [{ verb: 'type', startMs: 500, endMs: 3500, point: { x: 400, y: 900 } }] },
    { ...waitScene, startMs: 4000, endMs: 28000,
      steps: waitScene.steps.map(s => ({ ...s, startMs: s.startMs + 4000, endMs: s.endMs + 4000 })) },
  ], 28000), { narration: { ask: { durationMs: 3000 }, approve: { durationMs: 5000 } } });
  assert.deepEqual(plan.scenes.map(s => [s.id, s.outStartMs, s.outEndMs]), [['ask', 0, 4000], ['approve', 4000, 11640]]);
  assert.equal(plan.scenes[1].narration.atMs, 4320, '내레이션은 장면 시작 0.3초 뒤다');
  assert.equal(plan.durationMs, plan.scenes.at(-1).outEndMs);
  assert.equal(plan.totalFrames, totalOf(plan));
});

test('확대는 누른 자리를 중심으로 걸고 화면 밖으로 나가지 않는다', () => {
  const plan = buildEditPlan(recorded([
    { id: 'ask', startMs: 0, endMs: 8000,
      steps: [{ verb: 'click', startMs: 3000, endMs: 3600, point: { x: 20, y: 1060 } }] },
  ], 8000));
  const keys = plan.zoom;
  assert.deepEqual(keys.map(k => [k.atMs, k.z]), [[2680, 1], [3280, 1.6], [4400, 1.6], [5000, 1]]);
  // 1.6배에서 보이는 폭은 1200×675다. 중심은 600~1320·337.5~742.5 안에 갇힌다.
  assert.deepEqual([keys[1].cx, keys[1].cy], [600, 742.5]);
  // z=1에서는 화면 전체가 보이므로 중심이 한가운데 말고는 있을 수 없다.
  assert.deepEqual([keys[0].cx, keys[0].cy], [960, 540]);
  const middle = zoomAt(plan, 3000);
  assert.ok(middle.z > 1 && middle.z < 1.6, `${middle.z}`);
  assert.ok(middle.cx >= plan.viewport.width / (2 * middle.z) - 1e-9, '이징 중간에도 화면 밖을 보지 않는다');
  assert.ok(middle.cy <= plan.viewport.height - plan.viewport.height / (2 * middle.z) + 1e-9);
  assert.deepEqual(zoomAt(plan, 3280), { z: 1.6, cx: 600, cy: 742.5 });
  assert.deepEqual(zoomAt(plan, 7000), { z: 1, cx: 960, cy: 540 });
});

test('다음 확대가 곧이면 되돌리지 않고 옮겨 간다', () => {
  const near = buildEditPlan(recorded([
    { id: 'ask', startMs: 0, endMs: 10000, steps: [
      { verb: 'click', startMs: 2000, endMs: 2600, point: { x: 600, y: 500 } },
      { verb: 'click', startMs: 4500, endMs: 5100, point: { x: 1300, y: 700 } },
    ] },
  ], 10000));
  assert.deepEqual(near.zoom.map(k => [k.atMs, k.z, k.cx]),
    [[1680, 1, 960], [2280, 1.6, 600], [3400, 1.6, 600], [4800, 1.6, 1300], [5920, 1.6, 1300], [6520, 1, 960]]);
  assert.ok(near.zoom.every(k => k.z === 1 || k.z === 1.6), '옮겨 가는 동안 확대를 놓지 않는다');

  const far = buildEditPlan(recorded([
    { id: 'ask', startMs: 0, endMs: 16000, steps: [
      { verb: 'click', startMs: 2000, endMs: 2600, point: { x: 600, y: 500 } },
      { verb: 'click', startMs: 9000, endMs: 9600, point: { x: 1300, y: 700 } },
    ] },
  ], 16000));
  assert.deepEqual(far.zoom.map(k => k.z), [1, 1.6, 1.6, 1, 1, 1.6, 1.6, 1], '멀면 한 번 되돌아온다');
});

test('확대를 끈 걸음과 기다림에는 확대를 걸지 않는다', () => {
  const plan = buildEditPlan(recorded([
    { id: 'ask', startMs: 0, endMs: 6000, steps: [
      { verb: 'click', startMs: 1000, endMs: 1600, point: { x: 600, y: 500 }, zoom: false },
      { verb: 'waitFor', startMs: 1600, endMs: 6000, point: { x: 100, y: 100 } },
    ] },
  ], 6000));
  assert.deepEqual(plan.zoom, []);
});

test('잘못된 촬영 기록은 계획을 만들지 않는다', () => {
  assert.throws(() => buildEditPlan(null), /촬영 기록이 없습니다/);
  assert.throws(() => buildEditPlan({ schemaVersion: 2, scenes: [] }), /schemaVersion/);
  assert.throws(() => buildEditPlan(recorded([], 0)), /장면이 없습니다/);
  assert.throws(() => buildEditPlan(recorded([{ id: 'a', startMs: 0, endMs: 0, steps: [] }], 0)), /길이가 0/);
  assert.throws(() => buildEditPlan(recorded([
    { id: 'a', startMs: 0, endMs: 4000, steps: [] }, { id: 'b', startMs: 3000, endMs: 5000, steps: [] },
  ], 5000)), /겹칩니다/);
});

// 데모 모드로 ¼ 속도로 찍은 장면은 기다림만 감아서는 안 된다. 그러면 같은 장면에서
// 사람이 누르는 자리는 ¼ 속도로, 기다림만 제 속도로 흘러 어긋난다.
test('느리게 찍은 장면은 통째로 되돌리고 기다림을 따로 감지 않는다', () => {
  const scenes = {
    schemaVersion: 1, viewport: { width: 1920, height: 1080, scale: 2 }, durationMs: 24000,
    scenes: [
      { id: 'awakening', startMs: 0, endMs: 20000, timeScale: 0.25, steps: [
        { verb: 'pause', startMs: 0, endMs: 2000 },
        { verb: 'click', startMs: 2000, endMs: 2600, point: { x: 960, y: 540 } },
        { verb: 'waitFor', startMs: 2600, endMs: 20000 },
      ] },
      { id: 'chat', startMs: 20000, endMs: 24000, timeScale: 1, steps: [
        { verb: 'waitFor', startMs: 20000, endMs: 24000 },
      ] },
    ],
  };
  const plan = buildEditPlan(scenes);
  const slowed = plan.segments.filter(segment => segment.sceneId === 'awakening');
  assert.equal(slowed.length, 1, '느린 장면은 구간을 쪼개지 않는다');
  assert.equal(slowed[0].kind, 'slowed');
  assert.equal(slowed[0].speed, 4);
  assert.equal(slowed[0].outFrames, 125, '20초를 5초로 되돌린다');
  // 느리지 않은 장면의 기다림은 예전처럼 감는다.
  const chat = plan.segments.filter(segment => segment.sceneId === 'chat');
  assert.equal(chat[0].kind, 'fast');
  assert.ok(chat[0].speed > 1.01);
});

test('느린 장면에 긴 내레이션이 오면 멈추지 않고 덜 되돌린다', () => {
  const scenes = {
    schemaVersion: 1, viewport: { width: 1920, height: 1080, scale: 2 }, durationMs: 20000,
    scenes: [{ id: 'awakening', startMs: 0, endMs: 20000, timeScale: 0.25, steps: [
      { verb: 'waitFor', startMs: 0, endMs: 20000 },
    ] }],
  };
  // 4배로 되돌리면 5초인데 내레이션이 8초다. 3D가 멈춘 채 말이 이어지면 고장 난 것처럼
  // 보이므로 배율을 낮춰 그림이 계속 흐르게 한다.
  const plan = buildEditPlan(scenes, { narration: { awakening: { durationMs: 8000, file: 'a.wav' } } });
  const scene = plan.scenes[0];
  const segment = plan.segments[0];
  assert.equal(scene.holdMs, 0, '멈춰 채우지 않는다');
  assert.ok(segment.speed > 1 && segment.speed < 4, `배율 ${segment.speed}`);
  assert.ok(scene.outEndMs - scene.outStartMs >= 8800);

  // 내레이션이 찍은 길이보다도 길면 그때는 멈춰서 채운다. 찍은 것보다 느리게 틀지 않는다.
  const long = buildEditPlan(scenes, { narration: { awakening: { durationMs: 30000, file: 'a.wav' } } });
  assert.equal(long.segments[0].speed, 1);
  assert.ok(long.scenes[0].holdMs > 0);
});
