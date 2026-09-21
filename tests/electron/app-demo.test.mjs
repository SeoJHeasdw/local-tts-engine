import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAppDemoService } from '../../electron-app/main/app-demo.mjs';
import { nextStep, sceneSeconds } from '../../electron-app/renderer/controllers/app-demo.mjs';

const SCENARIO = {
  schemaVersion: 1,
  name: 'rice-first-run',
  app: { kind: 'web', url: 'http://localhost:5173', ready: { selector: 'main' } },
  scenes: [
    { id: 'awakening', timeScale: 0.25, steps: [{ pause: 900 }, { waitFor: '.loop', timeoutMs: 20000 }] },
    { id: 'chat', steps: [{ pause: 2500 }] },
  ],
};

async function studio(t, { scenes = null, script = null } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'app-demo-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const outDir = path.join(base, 'edits', '2026-09-21', 'rice-first-run');
  const demoDir = path.join(outDir, 'demo');
  await fs.mkdir(path.join(demoDir, 'narration', 'awakening'), { recursive: true });
  if (scenes) await fs.writeFile(path.join(demoDir, 'scenes.json'), JSON.stringify(scenes));
  if (script) await fs.writeFile(path.join(demoDir, 'script.json'), JSON.stringify(script));
  const scenarioFile = path.join(base, 'rice-first-run.json');
  await fs.writeFile(scenarioFile, JSON.stringify(SCENARIO));

  const runs = [];
  const events = [];
  const state = { activeJob: null, mainWindow: null };
  const service = createAppDemoService({
    dialog: {
      showOpenDialog: async (_window, options) => ({
        canceled: false,
        filePaths: [options.properties?.includes("openDirectory") ? outDir : scenarioFile],
      }),
    },
    emit: event => events.push(event),
    jobSnapshot: () => ({ kind: state.activeJob?.kind }),
    readAppSettings: async () => ({ paths: { editOutputRoot: path.join(base, 'edits') } }),
    requireRuntimeTool: () => '/usr/bin/node',
    runProcess: async (stage, tool, args) => { runs.push({ stage, args }); },
    state,
  });
  return { service, runs, events, base, outDir, demoDir, scenarioFile };
}

const scenesFile = {
  schemaVersion: 1, scenario: 'rice-first-run', durationMs: 94300,
  viewport: { width: 1920, height: 1080, scale: 2 },
  scenes: [
    { id: 'awakening', startMs: 0, endMs: 29600, timeScale: 0.25, steps: [], screenText: '코어 온라인' },
    { id: 'chat', startMs: 29600, endMs: 32100, timeScale: 1, steps: [], screenText: 'RICE에게 메시지' },
  ],
};

const scriptFile = {
  schemaVersion: 1, scenario: 'rice-first-run',
  scenes: [
    { id: 'awakening', text: '처음 열면 코어가 깨어납니다.', status: 'approved',
      voice: { candidates: ['narration/awakening/candidate-01.wav', 'narration/awakening/candidate-02.wav'], selected: null } },
    { id: 'chat', text: '', status: 'draft', voice: { candidates: [], selected: null } },
  ],
};

test('시나리오를 고르면 장면과 배율을 화면에 줄 만큼만 읽는다', async t => {
  const { service } = await studio(t);
  const picked = await service.pickDemoScenario();
  assert.equal(picked.name, 'rice-first-run');
  assert.deepEqual(picked.scenes.map(scene => [scene.id, scene.timeScale]), [['awakening', 0.25], ['chat', 1]]);
  assert.ok(picked.budgetMs > 0);
});

test('찍어 둔 결과 폴더를 화면에서 이어 받는다', async t => {
  const { service, outDir } = await studio(t, { scenes: scenesFile, script: scriptFile });
  // 폴더 고르기는 결과 폴더 뿌리에서 시작한다. CLI로 찍은 것도 같은 자리에 있다.
  const picked = await service.pickDemoProject();
  assert.equal(picked.outDir, outDir);
  assert.equal(picked.scenes.length, 2);
});

test('결과 폴더에서 대본·후보·완성본을 한 벌로 모은다', async t => {
  const { service, outDir, demoDir } = await studio(t, { scenes: scenesFile, script: scriptFile });
  await fs.writeFile(path.join(demoDir, 'narration', 'awakening', 'candidate-01.wav'), '');
  await fs.writeFile(path.join(demoDir, 'narration', 'awakening', 'candidate-01.json'), JSON.stringify({ durationMs: 6520 }));
  await fs.writeFile(path.join(outDir, 'rice-first-run-high.mp4'), '');
  const project = await service.readDemoProject(outDir);
  assert.equal(project.scenario, 'rice-first-run');
  assert.equal(project.scenes[0].screenText, '코어 온라인');
  assert.equal(project.scenes[0].timeScale, 0.25);
  assert.equal(project.scenes[0].candidates.length, 2);
  assert.equal(project.scenes[0].candidates[0].durationMs, 6520, '후보 길이를 함께 준다');
  assert.match(project.scenes[0].candidates[0].url, /^file:\/\/.*candidate-01\.wav$/);
  assert.deepEqual(project.videos.map(video => video.name), ['rice-first-run-high.mp4']);
  assert.equal(project.reviewUrl, null, '검수 화면이 없으면 지어내지 않는다');
});

test('화면이 고친 대본과 고른 후보만 돌려 쓴다', async t => {
  const { service, outDir, demoDir } = await studio(t, { scenes: scenesFile, script: scriptFile });
  const saved = await service.saveDemoScript(outDir, [
    { id: 'awakening', text: '  고친 대본  ', status: 'approved', selected: 'narration/awakening/candidate-02.wav' },
    { id: 'chat', text: '이제 일을 맡기면 됩니다.', status: 'approved', selected: null },
  ]);
  assert.equal(saved.scenes[0].text, '고친 대본');
  assert.equal(saved.scenes[0].selected, 'narration/awakening/candidate-02.wav');
  assert.equal(saved.scenes[1].status, 'approved');
  const onDisk = JSON.parse(await fs.readFile(path.join(demoDir, 'script.json'), 'utf8'));
  assert.deepEqual(onDisk.scenes[0].voice.candidates, scriptFile.scenes[0].voice.candidates,
    '후보 목록은 만든 쪽이 소유한다');

  await assert.rejects(
    () => service.saveDemoScript(outDir, [{ id: 'awakening', selected: 'narration/awakening/candidate-09.wav' }]),
    /그 후보가 없습니다/);
});

test('촬영·목소리·렌더는 CLI와 같은 작업자를 같은 인자로 부른다', async t => {
  const { service, runs, events, outDir, scenarioFile } = await studio(t, { scenes: scenesFile, script: scriptFile });
  // 작업자는 따로 돈다. 시작은 바로 돌아오고 실행은 다음 차례에 일어난다.
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  await service.startDemoRecord({ scenarioFile, name: 'demo-two' });
  await settle();
  const recorded = runs.at(-1);
  assert.equal(recorded.stage, 'demo');
  assert.ok(recorded.args[0].endsWith('workers/demo.mjs'));
  assert.equal(recorded.args[1], 'record');
  assert.equal(recorded.args[recorded.args.indexOf('--name') + 1], 'demo-two');
  assert.equal(events[0].type, 'demo-started');

  await service.startDemoVoice({ outDir, candidates: 4 });
  await settle();
  const voiced = runs.at(-1);
  assert.deepEqual(voiced.args.slice(1), ['voice', outDir, '--candidates', '4']);

  await service.startDemoRender({ outDir, quality: 'ultra' });
  await settle();
  const rendered = runs.at(-1);
  assert.deepEqual(rendered.args.slice(1), ['render', outDir, '--quality', 'ultra', '--no-open']);
});

test('같은 이름의 촬영이 있으면 덮어쓰지 않고 멈춘다', async t => {
  const { service, outDir, scenarioFile } = await studio(t, { scenes: scenesFile, script: scriptFile });
  await assert.rejects(() => service.startDemoRecord({ scenarioFile, name: path.basename(outDir) }),
    /같은 이름의 촬영이 이미 있습니다/);
});

test('다음에 할 일은 결과 폴더의 상태만 보고 정한다', () => {
  assert.equal(nextStep(null), 'record');
  assert.equal(nextStep({ scenes: [{ id: 'a', status: 'draft', text: '', candidates: [] }] }), 'script');
  assert.equal(nextStep({ scenes: [{ id: 'a', status: 'approved', text: '말', candidates: [] }] }), 'voice');
  assert.equal(nextStep({ scenes: [{ id: 'a', status: 'approved', text: '말', candidates: [{}], selected: null }] }), 'select');
  assert.equal(nextStep({ scenes: [{ id: 'a', status: 'approved', text: '말', candidates: [{}], selected: 'x.wav' }] }), 'render');
});

test('느리게 찍은 장면의 길이는 되돌린 뒤로 보여 준다', () => {
  assert.deepEqual(sceneSeconds({ startMs: 0, endMs: 20000, timeScale: 0.25 }), { src: 20, out: 5 });
  assert.deepEqual(sceneSeconds({ startMs: 0, endMs: 2000 }), { src: 2, out: 2 });
});

test('옆 저장소의 demo/scenarios를 훑어 고를 거리를 만든다', async t => {
  const { service } = await studio(t);
  const found = await service.listDemoScenarios();
  // 이 저장소의 형제 저장소에 실제로 있는 시나리오를 읽는다. 읽으면서 검증한다.
  assert.ok(Array.isArray(found));
  for (const item of found) {
    assert.ok(item.file.endsWith('.json'));
    assert.ok(item.from.includes('/'), '어느 저장소가 내놓았는지 함께 준다');
    if (!item.error) assert.ok(item.scenes.length > 0);
  }
});
