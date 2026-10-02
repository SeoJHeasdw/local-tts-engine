import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrainingController } from '../../electron-app/renderer/controllers/training.mjs';
import { fakeDemoDom } from './helpers/demo-dom.mjs';

// Reuse the renderer's event/media fake, adding nested elements for the actual
// recording cards instead of replacing controller decisions with test doubles.
function trainingDom() {
  const base = fakeDemoDom();
  const decorate = (node, tag = '') => {
    if (node.trainingDom) return node;
    node.trainingDom = true;
    node.tagName = tag;
    node.children = [];
    node.append = (...items) => { for (const item of items) { item.parent = node; node.children.push(item); } };
    node.replaceChildren = (...items) => { node.children = []; node.append(...items); };
    const matches = (item, selector) => {
      if (selector === 'textarea' || selector === 'audio') return item.tagName === selector;
      const data = selector.match(/^\[data-([\w-]+)\]$/);
      if (data) return Object.hasOwn(item.dataset, data[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()));
      if (selector === '[name="training-reference"]') return item.name === 'training-reference';
      return false;
    };
    node.querySelectorAll = selector => {
      const found = [];
      for (const item of node.children) {
        if (matches(item, selector)) found.push(item);
        found.push(...item.querySelectorAll(selector));
      }
      return found;
    };
    node.querySelector = selector => node.querySelectorAll(selector)[0] || null;
    node.scrollIntoView = () => {};
    const fire = node.fire.bind(node);
    node.fire = async (type, event = {}) => {
      await fire(type, { target: node, ...event });
      if (type === 'change' && node.parent) await node.parent.fire(type, event);
    };
    return node;
  };
  return { $: selector => decorate(base.$(selector)), document: {
    createElement: tag => decorate(base.document.createElement(), tag),
  } };
}

const sample = (id = 'speaker-a', changes = {}) => ({
  id, displayName: `목소리 ${id}`, legacy: false, total: 3, transcribed: 3, qualityReviewed: 3,
  referenceId: 'clip-1', clips: [1, 2, 3].map(number => ({ id: `clip-${number}`, text: `문장 ${number}`,
    audioUrl: `file:///recordings/${id}/${number}.wav`, audioSha256: `${id}-${number}`, durationMs: 8000,
    accepted: true, quality: { audio: { warnings: [], quietRatio: 0.1, rmsDbfs: -20, clippingRatio: 0 },
      independentText: `문장 ${number}`, sourceText: `문장 ${number}`, transcriptAgreement: 1 } })), ...changes,
});

function fixture(api = {}) {
  const { $, document } = trainingDom();
  $('#finetune-steps').value = '60';
  const errors = [], starts = [];
  const controller = createTrainingController({ $, document, api: {
    listTrainingDatasets: async () => [{ id: 'speaker-a', displayName: '목소리 A', clips: 3 }],
    readTrainingDataset: async id => sample(id), ...api,
  }, start: async options => starts.push(options), showError: error => errors.push(error) });
  controller.bind();
  return { $, controller, errors, starts, cards: () => $('#training-clips').children };
}

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('목소리 전환 대기·실패 중 이전 사람의 녹음으로 학습을 시작할 수 없고 재시도한다', async () => {
  const pending = deferred();
  let failed = true;
  const f = fixture({ listTrainingDatasets: async () => ['speaker-a', 'speaker-b'].map(id => ({ id, displayName: id, clips: 3 })),
    readTrainingDataset: id => id === 'speaker-b' && failed ? pending.promise : Promise.resolve(sample(id)) });
  await f.controller.load();
  assert.equal(f.controller.options().datasetId, 'speaker-a');
  f.$('#training-dataset').value = 'speaker-b';
  const changing = f.$('#training-dataset').fire('change');
  assert.equal(f.$('#start-finetune').disabled, true);
  assert.equal(f.$('#prepare-training').disabled, true);
  assert.equal(f.cards().length, 0);
  assert.throws(() => f.controller.options(), /먼저.*녹음을 선택/);
  pending.reject(new Error('녹음 파일이 없습니다.'));
  await changing;
  assert.match(f.$('#training-summary').textContent, /불러오지 못/);
  assert.match(f.$('#training-selection-hint').textContent, /다시 불러오기/);
  assert.equal(f.$('#reload-training-datasets').disabled, false);
  assert.throws(() => f.controller.options(), /먼저.*녹음을 선택/);
  failed = false;
  await f.$('#reload-training-datasets').fire('click');
  assert.equal(f.controller.options().datasetId, 'speaker-b');
  assert.equal(f.$('#start-finetune').disabled, false);
});

test('늦게 도착한 다른 사람의 응답은 현재 선택과 확인한 녹음을 덮어쓰지 않는다', async () => {
  const pending = deferred();
  const f = fixture({ readTrainingDataset: id => id === 'speaker-b' ? pending.promise : Promise.resolve(sample(id)) });
  await f.controller.load();
  f.$('#training-dataset').value = 'speaker-b';
  const oldRead = f.$('#training-dataset').fire('change');
  f.$('#training-dataset').value = 'speaker-a';
  await f.$('#training-dataset').fire('change');
  pending.resolve(sample('speaker-b'));
  await oldRead;
  assert.equal(f.controller.options().datasetId, 'speaker-a');
  assert.equal(f.$('#training-profile-name').value, '목소리 speaker-a');
});

test('확인 해제와 글 수정은 대표 녹음 선택도 해제하며 재확인 이유를 안내한다', async () => {
  const f = fixture();
  await f.controller.load();
  const first = f.cards()[0], accept = first.querySelector('[data-accept]'), reference = first.querySelector('[name="training-reference"]');
  assert.equal(reference.checked, true);
  accept.checked = false;
  await accept.fire('change');
  assert.equal(reference.checked, false);
  assert.equal(reference.disabled, true);
  assert.match(f.$('#training-selection-hint').textContent, /최소 3개/);
  accept.checked = true;
  await accept.fire('change');
  assert.equal(reference.disabled, false);
  assert.equal(reference.checked, false, '재확인은 대표 녹음을 자동 선택하지 않는다');
  reference.checked = true;
  await reference.fire('change');
  const text = first.querySelector('textarea');
  text.value = '직접 듣고 고친 문장';
  await text.fire('input');
  assert.equal(accept.checked, false);
  assert.equal(reference.checked, false);
  assert.equal(reference.disabled, true);
  assert.match(first.querySelector('[data-review-note]').textContent, /글을 수정해.*해제/);
  assert.throws(() => f.controller.options(), /최소 3개/);
});

test('시작 버튼과 실행값 검증이 이름·횟수·빈 글·대표 녹음에서 같은 조건을 사용한다', async () => {
  const f = fixture();
  await f.controller.load();
  for (const [selector, value, message] of [
    ['#training-profile-name', '', /목소리 이름/], ['#finetune-name', '결과 폴더', /결과 폴더 이름/],
    ['#finetune-steps', '9', /10~500/], ['#finetune-steps', '10.5', /정수/],
  ]) {
    const field = f.$(selector), old = field.value;
    field.value = value;
    await field.fire('input');
    assert.equal(f.$('#start-finetune').disabled, true);
    assert.throws(() => f.controller.options(), message);
    field.value = old;
    await field.fire('input');
  }
  const first = f.cards()[0];
  first.querySelector('textarea').value = '';
  await first.fire('change');
  assert.equal(f.$('#start-finetune').disabled, true);
  assert.throws(() => f.controller.options(), /글이 비어/);
  first.querySelector('textarea').value = '다시 입력한 문장';
  await first.fire('change');
  assert.throws(() => f.controller.options(), /대표 녹음/);
});

test('화면을 다시 열고 자동 분석이 새 글을 보내도 직접 고친 글을 보존하고 달라진 녹음은 재확인한다', async () => {
  const f = fixture();
  await f.controller.load();
  const first = f.cards()[0];
  first.querySelector('textarea').value = '수동으로 고친 문장';
  await first.querySelector('textarea').fire('input');
  f.$('#training-profile-name').value = '새 이름';
  await f.$('#training-profile-name').fire('input');
  await f.controller.load();
  assert.equal(f.cards()[0].querySelector('textarea').value, '수동으로 고친 문장');
  assert.equal(f.$('#training-profile-name').value, '새 이름');
  const prepared = sample();
  prepared.clips[0].text = '분석한 다른 글';
  f.controller.render(prepared);
  assert.equal(f.cards()[0].querySelector('textarea').value, '수동으로 고친 문장');
  assert.equal(f.cards()[0].querySelector('[data-accept]').checked, false);
  const changed = sample();
  changed.clips[0].audioSha256 = 'new-audio';
  changed.clips[1].audioSha256 = 'other-new-audio';
  f.controller.render(changed);
  assert.equal(f.cards()[0].querySelector('textarea').value, '문장 1');
  assert.equal(f.cards()[0].querySelector('[data-accept]').checked, false);
  assert.equal(f.cards()[1].querySelector('[data-accept]').checked, false, '이미 확인한 녹음도 내용이 바뀌면 확인을 해제한다');
});

test('목록이 비었거나 실패하면 녹음을 불러올 방법과 재시도를 보이고 학습을 막는다', async () => {
  let fail = false;
  const f = fixture({ listTrainingDatasets: async () => { if (fail) throw new Error('목록 읽기 실패'); return []; } });
  await f.controller.load();
  assert.equal(f.$('#training-dataset').disabled, true);
  assert.equal(f.$('#start-finetune').disabled, true);
  assert.match(f.$('#training-review-empty').textContent, /한 사람의 녹음 파일을 불러오면/);
  fail = true;
  await f.$('#reload-training-datasets').fire('click');
  assert.match(f.$('#training-summary').textContent, /목록을 불러오지 못/);
  assert.equal(f.$('#reload-training-datasets').disabled, false);
  assert.equal(f.errors.length, 1);
});

test('새로 가져온 녹음 묶음을 선택 목록에 추가하고 자동 분석에서만 사용할 수 있다', async () => {
  const f = fixture();
  await f.controller.load();
  f.controller.render(sample('new-speaker', { transcribed: 0, qualityReviewed: 0,
    referenceId: null, clips: sample('new-speaker').clips.map(clip => ({ ...clip, text: '', accepted: false, quality: null })) }));
  assert.equal(f.$('#training-dataset').value, 'new-speaker');
  assert.equal(f.$('#training-dataset').children.some(item => item.value === 'new-speaker'), true);
  assert.equal(f.$('#prepare-training').disabled, false);
  assert.equal(f.$('#start-finetune').disabled, true);
  await f.$('#prepare-training').fire('click');
  assert.equal(f.starts[0].datasetId, 'new-speaker');
  assert.equal(f.starts[0].mode, 'prepare');
});
