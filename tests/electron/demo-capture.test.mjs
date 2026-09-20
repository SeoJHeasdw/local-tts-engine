import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { losslessRecordArgs, readScenario, recordAppDemo, stitchScenes } from '../../electron-app/main/capture/record-app.mjs';
import { describeTarget, launchDemoApp } from '../../electron-app/main/capture/app-page.mjs';
import { glidePath, installCursorOverlay, moveCursor } from '../../electron-app/main/capture/cursor-overlay.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = path.join(root, 'tests/fixtures/demo-app');
const ELECTRON = 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron';

// 찍는 화면을 640×360 · 1배로 줄인다. 경로는 같고 프레임만 작다.
function fixtureScenario() {
  return {
    schemaVersion: 1,
    name: 'demo-fixture',
    app: {
      kind: 'electron', cwd: root, executable: ELECTRON, args: [FIXTURE],
      files: { 'home/note.txt': '작업 폴더 표식\n' },
      ready: { console: '[demo-app] ready', timeoutMs: 60000 },
    },
    viewport: { width: 640, height: 360, scale: 1 },
    scenes: [
      { id: 'ask', steps: [
        { type: { placeholder: '요청을 입력하세요' }, text: '촬영 체크리스트를 적어 줘' },
        { press: 'Enter' } ] },
      { id: 'approve', steps: [
        { waitFor: { role: 'button', name: '승인', exact: true }, timeoutMs: 15000 },
        { pause: 600 },
        { click: { role: 'button', name: '승인', exact: true } } ] },
      { id: 'result', steps: [
        { waitGone: '[role=status][aria-label="Pondering"]', timeoutMs: 15000 },
        { pause: 500 } ] },
    ],
  };
}

async function workspace(t, scenario = fixtureScenario()) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'demo-capture-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const file = path.join(base, 'scenario.json');
  await fs.writeFile(file, JSON.stringify(scenario, null, 2));
  return { base, file, outDir: path.join(base, '2026-09-20', 'demo-fixture') };
}

test('무손실 녹화 인자는 색 변환 없이 RGB 그대로 받는다', () => {
  const args = losslessRecordArgs({ fps: 25, output: 'raw.mkv' });
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264rgb');
  assert.equal(args[args.indexOf('-qp') + 1], '0');
  assert.equal(args[args.indexOf('-framerate') + 1], '25');
  assert.deepEqual(args.slice(-3), ['-f', 'matroska', 'raw.mkv']);
  assert.ok(!args.some(arg => String(arg).includes('yuv420p')), '색 변환은 최종 인코딩에서 한 번만 한다');
});

test('장면은 빈틈없이 이어 붙고 마지막은 영상 끝까지 간다', () => {
  const stitched = stitchScenes([
    { id: 'a', startMs: 120, endMs: 4000 },
    { id: 'b', startMs: 4080, endMs: 9000 },
  ], 9400);
  assert.deepEqual(stitched, [
    { id: 'a', startMs: 0, endMs: 4080 },
    { id: 'b', startMs: 4080, endMs: 9400 },
  ]);
});

test('자리표시자는 시나리오 폴더와 작업 폴더로 푼다', async t => {
  const { file, base } = await workspace(t, {
    ...fixtureScenario(),
    app: { ...fixtureScenario().app, prepare: ['bash', '{scenario}/prep.sh', '{work}/app'], env: { DEMO_HOME: '{work}/home' } },
  });
  const scenario = readScenario(file, path.join(base, 'work'));
  assert.deepEqual(scenario.app.prepare, ['bash', path.join(base, 'prep.sh'), path.join(base, 'work/app')]);
  assert.equal(scenario.app.env.DEMO_HOME, path.join(base, 'work/home'));
});

test('대상 설명은 실패한 자리를 알아볼 수 있게 적는다', () => {
  assert.equal(describeTarget({ kind: 'role', role: 'button', name: '승인' }), 'button "승인"');
  assert.equal(describeTarget({ kind: 'selector', selector: '[role=status]' }), '[role=status]');
  assert.equal(describeTarget({ kind: 'placeholder', value: '메시지' }), 'placeholder="메시지"');
});

test('커서는 가속하고 감속하며 끝점에 정확히 닿는다', () => {
  const path_ = glidePath({ x: 0, y: 0 }, { x: 100, y: 50 }, { steps: 10 });
  assert.equal(path_.length, 10);
  assert.deepEqual(path_.at(-1), { x: 100, y: 50 });
  const steps = path_.map((at, index) => at.x - (path_[index - 1]?.x ?? 0));
  assert.ok(steps[0] < steps[4] && steps.at(-1) < steps[4], '가운데가 가장 빠르다');
});

// 실제 Electron 앱을 띄워 시나리오를 돌린다. 브라우저·ffmpeg·앱이 모두 실제다.
test('픽스처 앱을 찍어 무손실 원본과 장면 기록을 남긴다', { timeout: 180_000 }, async t => {
  try {
    await import('playwright');
  } catch {
    t.skip('playwright가 설치되지 않았습니다.');
    return;
  }
  const { file, outDir } = await workspace(t);
  const phases = [];
  const record = await recordAppDemo({
    scenarioFile: file, outDir, name: 'demo-fixture',
    onEvent: event => phases.push(event.phase),
  });

  assert.equal(record.scenario, 'demo-fixture');
  assert.deepEqual(record.frame, { width: 640, height: 360 });
  assert.deepEqual(record.scenes.map(scene => scene.id), ['ask', 'approve', 'result']);
  assert.equal(record.scenes[0].startMs, 0);
  assert.equal(record.scenes.at(-1).endMs, record.durationMs);
  for (const [index, scene] of record.scenes.entries()) {
    const next = record.scenes[index + 1];
    if (next) assert.equal(scene.endMs, next.startMs, `${scene.id} 뒤에 빈틈이 없다`);
  }

  const ask = record.scenes[0].steps;
  assert.deepEqual(ask.map(step => step.verb), ['type', 'press']);
  assert.ok(ask[0].point, '친 자리는 좌표로 남는다');
  assert.ok(ask[0].endMs - ask[0].startMs > 13 * 35, '사람 속도로 친다');

  const approve = record.scenes[1].steps;
  assert.deepEqual(approve.map(step => step.verb), ['waitFor', 'pause', 'click']);
  assert.ok(approve[0].endMs - approve[0].startMs >= 300, '승인 버튼이 뜰 때까지 기다린다');
  assert.ok(approve[2].box.w > 0 && approve[2].box.h > 0);
  assert.ok(approve[2].point.x > approve[2].box.x, '누른 점은 대상 상자 안이다');

  const result = record.scenes[2].steps;
  assert.deepEqual(result.map(step => step.verb), ['waitGone', 'pause']);
  assert.ok(result[0].endMs - result[0].startMs >= 800, '2초 뜨는 상태가 사라질 때까지 기다린다');
  assert.match(record.scenes[2].screenText, /완료했습니다/, '장면 끝 화면의 글이 대본 초안의 근거다');

  assert.ok(phases.includes('recording') && phases.includes('recorded'), phases.join(','));
  const raw = path.join(outDir, 'demo', 'raw.mkv');
  const probe = JSON.parse((await exec('ffprobe', ['-v', 'error', '-count_frames',
    '-select_streams', 'v:0', '-show_streams', '-of', 'json', raw])).stdout).streams[0];
  assert.equal(probe.codec_name, 'h264');
  assert.equal(probe.width, 640);
  assert.equal(probe.height, 360);
  assert.equal(probe.pix_fmt, 'gbrp', '무손실 RGB로 받는다');
  // finish({ endAt })가 실제로 끝난 시각에서 끊는다. 상한까지 마지막 화면을 채우지 않는다.
  assert.equal(Number(probe.nb_read_frames), record.frames.written);
  assert.equal(record.frames.written, Math.ceil(record.durationMs * 25 / 1000));
  assert.ok(record.durationMs < 30_000, `${record.durationMs}ms — 시나리오 제한 시간까지 채우지 않는다`);
  assert.equal((await fs.readdir(path.join(outDir, 'demo'))).includes('work'), false, '작업 폴더는 지운다');
});

test('없는 대상에서 멈추면 어느 장면의 어느 걸음인지 말한다', { timeout: 120_000 }, async t => {
  try {
    await import('playwright');
  } catch {
    t.skip('playwright가 설치되지 않았습니다.');
    return;
  }
  const scenario = fixtureScenario();
  scenario.scenes = [{ id: 'ask', steps: [{ click: { role: 'button', name: '없는 버튼', exact: true }, timeoutMs: 2000 }] }];
  const { file, outDir } = await workspace(t, scenario);
  await assert.rejects(
    recordAppDemo({ scenarioFile: file, outDir, name: 'demo-fixture' }),
    /장면 ask의 click \(button "없는 버튼"\)에서 멈췄습니다/,
  );
  assert.equal((await fs.readdir(path.join(outDir, 'demo'))).includes('raw.mkv'), false, '끝내지 못한 원본은 남기지 않는다');
});

// 2026-09-20 RICE 파일럿: 화면 위에 놓여 있던 실제 마우스의 mousemove가 화살표를
// 끌고 가 입력창 대신 엉뚱한 빈 공간에 찍혔다. 그림은 우리가 보낸 좌표만 따른다.
test('그려진 커서는 페이지가 받은 마우스 사건이 아니라 우리가 보낸 좌표를 따른다', { timeout: 120_000 }, async t => {
  try {
    await import('playwright');
  } catch {
    t.skip('playwright가 설치되지 않았습니다.');
    return;
  }
  const { base, file } = await workspace(t);
  const scenario = readScenario(file, path.join(base, 'work'));
  const app = await launchDemoApp(scenario, { workDir: path.join(base, 'work') });
  try {
    await installCursorOverlay(app.page);
    await moveCursor(app.page, 120, 240);
    const placed = () => app.page.evaluate(() =>
      document.getElementById('app-demo-cursor')?.querySelector('.point')?.style.transform ?? null);
    assert.equal(await placed(), 'translate(120px, 240px)');

    // 사람이 창 위에서 마우스를 움직인 것과 같은 사건을 페이지에 직접 일으킨다.
    await app.page.evaluate(() => dispatchEvent(new MouseEvent('mousemove', { clientX: 500, clientY: 90 })));
    assert.equal(await placed(), 'translate(120px, 240px)', '떠도는 마우스 사건에 끌려가지 않는다');

    await moveCursor(app.page, 300, 300);
    assert.equal(await placed(), 'translate(300px, 300px)');
  } finally {
    await app.close();
  }
});
