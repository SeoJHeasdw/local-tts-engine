import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAppDemoService } from '../../electron-app/main/app-demo.mjs';
import { dateFolder } from '../../electron-app/main/paths.mjs';
import { nextStep, sceneSeconds, scenesNeedingVoice, isStale, candidateLabel, defaultVersion, bakedVersion, englishParts } from '../../electron-app/renderer/controllers/demo-polish.mjs';

const SCENARIO = {
  schemaVersion: 1,
  name: 'rice-first-run',
  app: { kind: 'web', url: 'http://localhost:5173', ready: { selector: 'main' } },
  scenes: [
    { id: 'awakening', timeScale: 0.25, steps: [{ pause: 900 }, { waitFor: '.loop', timeoutMs: 20000 }] },
    { id: 'chat', steps: [{ pause: 2500 }] },
  ],
};

async function studio(t, { scenes = null, script = null, cancelRun = false, onRun = null } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'app-demo-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  // 촬영은 오늘 날짜 폴더에 결과를 만든다. 같은 자리를 써야 같은 이름 검사가 뜻이 있다.
  const outDir = path.join(base, 'edits', dateFolder(), 'rice-first-run');
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
    // 결과 폴더 뿌리는 outputRoot에서 나온다(editOutputRoot = outputRoot/edits). 임시 폴더에 가둔다 —
    // 가두지 않으면 촬영 검사가 실제 output/edits에 폴더를 만든다.
    readAppSettings: async () => ({ paths: { outputRoot: base } }),
    requireRuntimeTool: () => '/usr/bin/node',
    // cancelRun: 중지를 누른 것처럼 작업을 중지 표시하고 작업자가 실패로 끝난다.
    runProcess: async (stage, tool, args) => {
      runs.push({ stage, args });
      await onRun?.(args);
      if (cancelRun) { state.activeJob.cancelled = true; throw new Error('중지했습니다'); }
    },
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
  assert.match(project.videos[0].url, /^file:\/\/.*rice-first-run-high\.mp4$/);
  // 굽기 전이라 편집 계획·자막·검증이 없다. 지어내지 않고 비워 둔다.
  assert.equal(project.plan, null);
  assert.deepEqual(project.captions, []);
  assert.equal(project.ok, null);
  assert.equal(project.reviewUrl, undefined, '앱은 브라우저 검수 페이지를 열지 않는다');
});

test('다듬기가 그릴 편집 계획·자막·검증과 후보가 읽은 대본을 함께 준다', async t => {
  const { service, outDir, demoDir } = await studio(t, { scenes: scenesFile, script: scriptFile });
  await fs.writeFile(path.join(demoDir, 'narration', 'awakening', 'input.txt'), '예전 대본\n');
  await fs.writeFile(path.join(demoDir, 'narration', 'awakening', 'candidate-01.json'),
    JSON.stringify({ durationMs: 6520, voiceRouting: { segments: [{ language: 'English' }] } }));
  const plan = { fps: 25, maxSpeed: 4, durationMs: 9000, segments: [], zoom: [],
    scenes: [{ id: 'awakening', outStartMs: 0, outEndMs: 7000, srcStartMs: 0, srcEndMs: 29600, holdMs: 0 }] };
  await fs.writeFile(path.join(demoDir, 'edit-plan.json'), JSON.stringify(plan));
  await fs.writeFile(path.join(demoDir, 'captions.json'), JSON.stringify({ cues: [{ startMs: 320, endMs: 2800, text: '처음 열면' }] }));
  await fs.writeFile(path.join(outDir, 'validation-report.json'), JSON.stringify({
    checks: [{ label: '영상 규격', ok: true }], warnings: [], summary: { ok: true } }));
  const project = await service.readDemoProject(outDir);
  assert.equal(project.plan.durationMs, 9000);
  assert.equal(project.plan.scenes[0].outEndMs, 7000);
  assert.equal(project.captions[0].text, '처음 열면');
  assert.equal(project.ok, true);
  assert.equal(project.checks.length, 1);
  // 예전 기록에는 voice.text가 없어 작업자가 남긴 입력 글로 갈음한다.
  assert.equal(project.scenes[0].voicedText, '예전 대본');
  assert.equal(project.scenes[1].voicedText, null, '후보가 없으면 읽은 대본도 없다');
  assert.equal(project.scenes[0].candidates[0].voiceRouting.segments[0].language, 'English');
  assert.equal(project.scenes[0].candidates[1].voiceRouting, undefined, '기록이 없는 후보는 모른다고 둔다');
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

  // 다듬기는 할 일이 남은 장면만 골라 부른다. 여러 장면은 쉼표로 잇는다.
  await service.startDemoVoice({ outDir, candidates: 3, scenes: ['awakening', 'chat'] });
  await settle();
  assert.deepEqual(runs.at(-1).args.slice(1), ['voice', outDir, '--candidates', '3', '--scene', 'awakening,chat']);
  assert.deepEqual(events.filter(event => event.type === 'demo-started').at(-1).scenes, ['awakening', 'chat'],
    '어느 장면을 만드는지 화면이 알 수 있다');
  await service.startDemoVoice({ outDir, scene: 'chat' });
  await settle();
  assert.deepEqual(runs.at(-1).args.slice(-2), ['--scene', 'chat']);

  await service.startDemoRender({ outDir, quality: 'ultra' });
  await settle();
  const rendered = runs.at(-1);
  assert.deepEqual(rendered.args.slice(1), ['render', outDir, '--quality', 'ultra', '--no-open']);

  // 자막 굽기는 켤 때만 작업자에 건넨다.
  await service.startDemoRender({ outDir, quality: 'high', burnCaptions: true });
  await settle();
  assert.deepEqual(runs.at(-1).args.slice(1), ['render', outDir, '--quality', 'high', '--no-open', '--burn-captions']);
  assert.equal(events.filter(event => event.type === 'demo-started').at(-1).burnCaptions, true);
});

test('굽기를 중지하면 반쯤 쓴 임시 영상을 결과 폴더에 남기지 않는다', async t => {
  const { service, outDir, events } = await studio(t, { scenes: scenesFile, script: scriptFile, cancelRun: true });
  const part = path.join(outDir, 'rice-first-run-high.mp4.5d0ae275-b23d-4121-82ea-444c440f3875.part');
  const kept = path.join(outDir, 'rice-first-run-high.mp4');
  await fs.writeFile(part, 'half');
  await fs.writeFile(kept, 'done');
  // 작업자가 SIGKILL로 끝나 제 finally를 돌지 못한 경우다.
  await service.startDemoRender({ outDir, quality: 'high' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(events.at(-1).type, 'demo-failed');
  assert.equal(events.at(-1).cancelled, true);
  await assert.rejects(fs.stat(part), '임시 파일은 지운다');
  assert.equal(await fs.readFile(kept, 'utf8'), 'done', '완성본은 건드리지 않는다');
});

test('촬영을 중지하면 이번 촬영이 만든 폴더를 남기지 않는다', async t => {
  let outDir = null;
  // 작업자가 결과 폴더를 만들고 원본을 반쯤 쓰다 중지로 끝난 자리를 흉내 낸다.
  const { service, events, scenarioFile } = await studio(t, {
    cancelRun: true,
    onRun: async args => {
      outDir = args[args.indexOf('--out-dir') + 1];
      await fs.mkdir(path.join(outDir, 'demo', 'work'), { recursive: true });
      await fs.writeFile(path.join(outDir, 'demo', 'raw.mkv'), 'half');
    },
  });
  await service.startDemoRecord({ scenarioFile, name: 'stopped-take' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(events.at(-1).type, 'demo-failed');
  assert.equal(events.at(-1).cancelled, true);
  await assert.rejects(fs.stat(outDir), '끝나지 않은 촬영 폴더는 치운다');
  // 그래서 같은 이름으로 곧바로 다시 찍을 수 있다.
  await service.startDemoRecord({ scenarioFile, name: 'stopped-take' });
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

test('대본을 고친 뒤 후보를 다시 만들지 않은 장면을 가려낸다', () => {
  const scene = (id, extra) => ({ id, status: 'approved', text: '지금 대본', candidates: [], selected: null, ...extra });
  const project = { scenes: [
    scene('fresh'),
    scene('same', { candidates: [{}], voicedText: '지금 대본', selected: 'a.wav' }),
    scene('changed', { candidates: [{}], voicedText: '예전 대본', selected: 'a.wav' }),
    scene('unknown', { candidates: [{}], voicedText: null, selected: 'a.wav' }),
    scene('draft', { status: 'draft' }),
  ] };
  assert.equal(isStale(project.scenes[2]), true);
  assert.equal(isStale(project.scenes[3]), false, '기록이 없으면 바뀌었다고 지어내지 않는다');
  assert.deepEqual(scenesNeedingVoice(project), ['fresh', 'changed']);
  assert.equal(nextStep(project), 'voice');
  assert.equal(nextStep({ scenes: [scene('same', { candidates: [{}], voicedText: '지금 대본', selected: null })] }), 'select');
});

test('후보 이름·영어 구간·기본 화질을 사람이 읽는 말로 적는다', () => {
  assert.equal(candidateLabel({ name: 'candidate-03' }), '후보 3');
  assert.equal(englishParts({ voiceRouting: { segments: [{ language: 'English' }, { language: 'Korean' }] } }), '영어 1구간');
  assert.equal(englishParts({ voiceRouting: null }), '');
  // 1440p가 기본 화질이다. 없으면 가장 큰 것을 연다.
  assert.equal(defaultVersion([{ name: 'x-standard.mp4' }, { name: 'x-high.mp4' }, { name: 'x-ultra.mp4' }]), 'x-high.mp4');
  assert.equal(defaultVersion([{ name: 'x-standard.mp4' }, { name: 'x-ultra.mp4' }]), 'x-ultra.mp4');
  assert.equal(defaultVersion([]), null);
  // 방금 구운 화질로 바꿔 보여 준다. 1080p는 이름에 꼬리가 없다.
  const baked = { name: 'x', videos: [{ name: 'x.mp4' }, { name: 'x-high.mp4' }] };
  assert.equal(bakedVersion(baked, 'standard'), 'x.mp4');
  assert.equal(bakedVersion(baked, 'high'), 'x-high.mp4');
  assert.equal(bakedVersion(baked, 'ultra'), null, '없는 파일은 지어내지 않는다');
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
