import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScenario, normalizeTarget, resolvePlaceholders } from '../../electron-app/shared/demo-scenario.mjs';

const base = {
  schemaVersion: 1,
  name: 'rice-core-flow',
  app: { kind: 'electron', executable: 'bin/Electron', args: ['{work}/app'], ready: { console: 'runtime connected' } },
  viewport: { width: 1920, height: 1080, scale: 2 },
  scenes: [{ id: 'ask', steps: [{ type: { placeholder: 'RICE에게 메시지' }, text: '안녕' }, { press: 'Enter' }] }],
};
const scenario = (patch = {}) => normalizeScenario({ ...base, ...patch });

test('동사·대상·장면 id를 굳히고 확대 기본값을 정한다', () => {
  const value = scenario({
    scenes: [{
      id: 'approve',
      steps: [
        { waitFor: { role: 'button', name: '승인', exact: true }, timeoutMs: 180000 },
        { pause: 1500 },
        { click: { role: 'button', name: '승인', exact: true } },
        { scroll: '.list', delta: -400, zoom: false },
      ],
    }],
  });
  const [scene] = value.scenes;
  assert.equal(scene.textFrom, 'main', '장면의 글 근거는 기본이 main이다');
  assert.deepEqual(scene.steps.map(step => step.verb), ['waitFor', 'pause', 'click', 'scroll']);
  assert.deepEqual(scene.steps[0].target, { kind: 'role', role: 'button', name: '승인', exact: true });
  assert.equal(scene.steps[0].timeoutMs, 180000);
  assert.equal(scene.steps[1].ms, 1500);
  assert.equal(scene.steps[2].zoom, true, '사람이 누르는 자리는 기본으로 확대한다');
  assert.equal(scene.steps[0].zoom, false, '기다림은 확대 대상이 아니다');
  assert.equal(scene.steps[3].delta, -400);
  // 제한 시간의 총합이 촬영 상한이 된다.
  assert.equal(value.budgetMs, 180000 + 1500 + 15000 + 15000);
});

test('대상은 선택자 하나 또는 getBy* 하나로만 적는다', () => {
  assert.deepEqual(normalizeTarget('[role=status]', 'x'), { kind: 'selector', selector: '[role=status]' });
  assert.deepEqual(normalizeTarget({ placeholder: '메시지' }, 'x'), { kind: 'placeholder', value: '메시지', exact: false });
  assert.deepEqual(normalizeTarget({ text: '승인', exact: true }, 'x'), { kind: 'text', value: '승인', exact: true });
  assert.throws(() => normalizeTarget({ role: 'button', placeholder: '메시지' }, 'x'), /함께 쓸 수 없습니다/);
  assert.throws(() => normalizeTarget({ text: '승인', label: '승인' }, 'x'), /하나여야 합니다/);
  assert.throws(() => normalizeTarget({ name: '승인' }, 'x'), /하나여야 합니다/);
  assert.throws(() => normalizeTarget({ role: 'button', nmae: '승인' }, 'x'), /알 수 없는 항목/);
  assert.throws(() => normalizeTarget('', 'x'), /비어 있습니다/);
});

test('앱을 띄우고 나서야 드러날 오타를 파일을 읽을 때 잡는다', () => {
  assert.throws(() => scenario({ schemaVersion: 2 }), /schemaVersion/);
  assert.throws(() => scenario({ name: 'RICE Core' }), /영소문자/);
  assert.throws(() => scenario({ scenes: [] }), /scenes가 비어/);
  assert.throws(() => scenario({ scenes: [{ id: 'a', steps: [] }, { id: 'a', steps: [{ press: 'Enter' }] }] }), /steps가 비어/);
  assert.throws(() => scenario({ scenes: [{ id: 'ask', steps: [{ press: 'Enter' }] }, { id: 'ask', steps: [{ press: 'Enter' }] }] }),
    /중복/);
  assert.throws(() => scenario({ scenes: [{ id: 'ask', steps: [{ click: '.a', press: 'Enter' }] }] }), /동사 하나/);
  assert.throws(() => scenario({ scenes: [{ id: 'ask', steps: [{}] }] }), /동사 하나/);
  assert.throws(() => scenario({ scenes: [{ id: 'ask', steps: [{ type: '.box' }] }] }), /칠 글/);
  assert.throws(() => scenario({ scenes: [{ id: 'ask', steps: [{ waitFor: '.a', zoom: true }] }] }), /확대를 켤 수 없습니다/);
  assert.throws(() => scenario({ scenes: [{ id: 'ask', steps: [{ pause: 0 }] }] }), /pause는/);
  assert.throws(() => scenario({ scenes: [{ id: 'ask', steps: [{ press: 'Enter' }], textFrom: '' }] }), /textFrom/);
  assert.throws(() => scenario({ app: { ...base.app, kind: 'native' } }), /kind는/);
  assert.throws(() => scenario({ app: { kind: 'electron' } }), /executable/);
  assert.throws(() => scenario({ app: { ...base.app, files: { '../out.txt': 'x' } } }), /작업 폴더 안/);
  assert.throws(() => scenario({ viewport: { width: 1921, height: 1080, scale: 1 } }), /짝수가 아닙니다/);
});

test('웹 화면은 주소만 있으면 된다', () => {
  const value = normalizeScenario({ ...base, app: { kind: 'web', url: 'http://127.0.0.1:4173/' } });
  assert.equal(value.app.url, 'http://127.0.0.1:4173/');
  assert.deepEqual(value.viewport.frame, { width: 3840, height: 2160 });
});

test('자리표시자는 실행 시점에 풀고 모르는 표시는 조용히 넘기지 않는다', () => {
  const resolved = resolvePlaceholders(
    { prepare: ['bash', '{scenario}/bundle.sh', '{work}/app'], env: { HOME: '{work}/home' } },
    { scenario: '/cfg', work: '/tmp/w' },
  );
  assert.deepEqual(resolved, { prepare: ['bash', '/cfg/bundle.sh', '/tmp/w/app'], env: { HOME: '/tmp/w/home' } });
  assert.throws(() => resolvePlaceholders('{home}/x', { work: '/tmp/w' }), /알 수 없는 자리표시자/);
});
