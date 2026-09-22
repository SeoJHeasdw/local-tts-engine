import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { abortable, demoDelay, startDemoCommand } from '../../electron-app/main/capture/demo-runtime.mjs';
import { waitForServer } from '../../electron-app/main/capture/site.mjs';
import { recordAppDemo, isRetryableDemoFailure } from '../../electron-app/main/capture/record-app.mjs';
import { runScenes } from '../../electron-app/main/capture/app-page.mjs';
import { normalizeScenario } from '../../electron-app/shared/demo-scenario.mjs';

const scenario = extra => ({ schemaVersion: 1, name: 'failure-test',
  app: { kind: 'web', url: 'http://127.0.0.1:1', ...extra },
  viewport: { width: 640, height: 360, scale: 1 },
  scenes: [{ id: 'one', steps: [{ pause: 100 }] }],
});

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'demo-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, file: path.join(root, 'scenario.json'), outDir: path.join(root, 'take') };
}

test('신호는 응답 없는 호출과 긴 pause를 즉시 끝내고 뒤의 조작을 막는다', async () => {
  const stop = new AbortController();
  const error = new Error('인코더 실패');
  const called = [];
  const page = {
    mouse: { move: async () => {} }, evaluate: async () => {},
    keyboard: { press: async key => called.push(key) },
  };
  const input = scenario();
  input.scenes[0].steps = [{ pause: 60000 }, { press: 'Enter' }];
  const started = performance.now();
  const run = runScenes(page, normalizeScenario(input), {
    clock: () => Math.round(performance.now() - started), signal: stop.signal,
    onEvent: event => { if (event.phase === 'step') setTimeout(() => stop.abort(error), 20); },
  });
  await assert.rejects(run, /인코더 실패/);
  assert.deepEqual(called, [], '녹화 실패 뒤 실제 앱에 Enter를 보내지 않는다');
  assert.ok(performance.now() - started < 1000);
  await assert.rejects(abortable(new Promise(() => {}), stop.signal), error);
});

test('focus는 콘텐츠 영역을 기록하며 클릭·타이핑을 하지 않는다', async () => {
  const events = [];
  const box = { x: 40, y: 30, width: 300, height: 200 };
  const locator = {
    waitFor: async () => {}, elementHandle: async () => ({
      waitForElementState: async () => {}, boundingBox: async () => box, dispose: async () => {},
    }),
    first() { return this; }, isVisible: async () => true, innerText: async () => '보여 줄 내용',
  };
  const page = { mouse: { move: async () => events.push('move') }, evaluate: async () => {}, locator: () => locator };
  const input = scenario();
  input.scenes[0].steps = [{ focus: '#panel', padding: 24 }, { overview: true }];
  const recorded = await runScenes(page, normalizeScenario(input), { clock: () => 100 });
  assert.deepEqual(recorded[0].steps[0].box, { x: 40, y: 30, w: 300, h: 200 });
  assert.equal(recorded[0].steps[0].padding, 24);
  assert.deepEqual(events, ['move'], '처음 커서 배치 외에는 마우스를 움직이지 않는다');
  assert.equal(recorded[0].steps[1].verb, 'overview');
});

test('오버레이를 닫은 장면도 닫기 직전의 글을 대본 근거로 남긴다', async () => {
  let visible = true;
  const locator = { first() { return this; }, isVisible: async () => visible, innerText: async () => {
    if (!visible) throw new Error('오버레이가 닫혔다');
    return '지금 보이는 안내';
  } };
  const page = { mouse: { move: async () => {} }, evaluate: async () => {}, locator: () => locator,
    keyboard: { press: async () => { visible = false; } } };
  const input = scenario();
  input.scenes[0] = { id: 'one', textFrom: '#overlay', steps: [{ press: 'Escape' }] };
  const recorded = await runScenes(page, normalizeScenario(input), { clock: () => 100 });
  assert.equal(recorded[0].screenText, '지금 보이는 안내');
});

test('서버 HTTP가 응답하지 않아도 요청과 대기에 같은 제한 시간이 적용된다', async t => {
  let requestSignal;
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => {
    requestSignal = signal;
    return abortable(new Promise(() => {}), signal);
  });
  const started = performance.now();
  await assert.rejects(waitForServer('http://example.invalid', { timeoutMs: 60 }), /0.06초/);
  assert.equal(requestSignal.aborted, true);
  assert.ok(performance.now() - started < 1000);
});

test('없는 서버 명령은 처리하지 않은 error 사건 대신 원인이 있는 실패로 돌아온다', async () => {
  const child = startDemoCommand(['/does-not-exist/demo-server'], { label: '화면 서버' });
  await assert.rejects(child.exited, /화면 서버 실행 실패.*ENOENT/);
  await child.stop();
});

test('중지는 SIGTERM을 무시하는 준비 명령도 끝낸다', { timeout: 5000 }, async t => {
  const { root } = await workspace(t);
  const ready = path.join(root, 'ready');
  const child = startDemoCommand([process.execPath, '-e',
    'process.on("SIGTERM", () => {}); require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 100);', ready],
  { label: '준비' });
  t.after(() => child.stop());
  for (let i = 0; i < 100 && !await fs.stat(ready).catch(() => null); i++) await demoDelay(10);
  const pid = Number(await fs.readFile(ready, 'utf8'));
  await child.stop();
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('준비 실패의 진단만 남기고 같은 이름으로 다시 시작할 수 있다', { timeout: 10000 }, async t => {
  const { file, outDir } = await workspace(t);
  await fs.writeFile(file, JSON.stringify(scenario({
    prepare: [process.execPath, '-e', 'process.stderr.write("prepare-broken"); process.exit(7)'],
    files: { 'isolated/profile.txt': 'temporary data' },
  })));
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(recordAppDemo({ scenarioFile: file, outDir }), /prepare-broken/);
    const files = await fs.readdir(path.join(outDir, 'demo'));
    assert.deepEqual(files, ['failure.json']);
    const failure = JSON.parse(await fs.readFile(path.join(outDir, 'demo/failure.json'), 'utf8'));
    assert.equal(failure.progress.phase, 'launching');
    assert.equal(await isRetryableDemoFailure(outDir), true);
  }
  await fs.writeFile(path.join(outDir, 'demo/script.json'), '{"text":"keep"}');
  assert.equal(await isRetryableDemoFailure(outDir), false, '기존 대본이 있으면 덮어쓰지 않는다');
  await assert.rejects(recordAppDemo({ scenarioFile: file, outDir }), /이미 있습니다/);
});

test('준비 명령의 제한 시간과 외부 중지가 앱 기동 전에도 적용된다', { timeout: 10000 }, async t => {
  const { file, outDir } = await workspace(t);
  await fs.writeFile(file, JSON.stringify(scenario({
    prepare: [process.execPath, '-e', 'setInterval(() => {}, 100)'], prepareTimeoutMs: 80,
  })));
  await assert.rejects(recordAppDemo({ scenarioFile: file, outDir }), /준비 명령의 제한 시간/);
  assert.equal(await fs.stat(path.join(outDir, 'demo/work')).catch(() => null), null);

  const stop = new AbortController();
  await fs.writeFile(file, JSON.stringify(scenario({
    prepare: [process.execPath, '-e', 'setInterval(() => {}, 100)'], prepareTimeoutMs: 60000,
  })));
  const timer = setTimeout(() => stop.abort(new Error('사용자 중지')), 100);
  try { await assert.rejects(recordAppDemo({ scenarioFile: file, outDir, signal: stop.signal }), /사용자 중지/); }
  finally { clearTimeout(timer); }
  assert.equal(await fs.stat(path.join(outDir, 'demo/work')).catch(() => null), null);
});
