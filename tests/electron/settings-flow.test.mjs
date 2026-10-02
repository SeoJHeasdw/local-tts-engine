import test from 'node:test';
import assert from 'node:assert/strict';
import { installRendererGlobals } from './helpers/renderer-dom.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};

// Import the real application and exercise its bound UI handlers. No extracted
// snippets: settings, job events and the training controller share real state.
test('실제 설정 화면은 미적용 목소리·저장·청취 확인·완료 후 이동을 안전하게 연결한다', async t => {
  const adapter = (id, approved) => ({ id, label: id, displayName: `목소리 ${id}`, path: `/runs/${id}/adapters`,
    listeningStatus: approved ? 'approved' : 'pending', approvedScale: approved ? .6 : null,
    previewUrl: `file:///runs/${id}/preview.wav`, previewScale: .6, previewAudioSha256: `audio-${id}`,
    referencePaths: { referenceAudioPath: `/runs/${id}/reference.wav`, referenceTextPath: `/runs/${id}/reference.txt` } });
  let saved = { modelId: 'qwen3-tts', adapterId: 'a', adapterScale: .6, voiceParallelism: 2,
    preventSleep: true, notifyOnFinish: true, adapters: [adapter('a', true), adapter('b', false)],
    paths: { referenceAudioPath: '/runs/a/reference.wav', referenceTextPath: '/runs/a/reference.txt', outputRoot: '/out' } };
  const saves = [], previews = [];
  let onJob, failSave = false, gateSave = null;
  let readSettings = async () => structuredClone(saved);
  const api = {
    onJobEvent: listener => { onJob = listener; },
    getStatus: async () => ({ catalog: { pages: [], lessons: [], totalPages: 0 }, capabilities: { editing: true } }),
    getSettings: () => readSettings(), listOutputs: async () => [], getResumable: async () => null,
    listTrainingDatasets: async () => { throw new Error('학습 목록 읽기 실패'); },
    saveSettings: async value => {
      saves.push(structuredClone(value));
      if (gateSave) { const pending = gateSave; gateSave = null; await pending.promise; }
      if (failSave) throw new Error('저장 경로에 쓸 수 없습니다.');
      saved = { ...saved, ...value, paths: { ...saved.paths, ...value.paths } };
      if (value.listeningApproval) saved.adapters = saved.adapters.map(item => item.id === value.adapterId
        ? { ...item, listeningStatus: 'approved', approvedScale: value.adapterScale } : item);
      return structuredClone(saved);
    },
    startVoicePreview: async options => {
      previews.push(options);
      onJob({ jobKind: 'training', type: 'training-started', options: { mode: 'preview', ...options } });
    },
  };
  const { query: $, setQueryList } = installRendererGlobals(t, { api });
  const sections = ['general', 'voice', 'training'];
  const rails = sections.map(name => {
    const node = $(`#settings-rail [data-settings-section="${name}"]`);
    node.dataset.settingsSection = name; return node;
  });
  const panels = sections.map(name => {
    const node = $(`#settings-${name}-panel`); node.dataset.settingsPanel = name; return node;
  });
  setQueryList('#settings-rail button', rails);
  setQueryList('[data-settings-panel]', panels);
  const pathInputs = Object.keys(saved.paths).map(key => { const node = $(`#path-${key}`); node.id = `path-${key}`; return node; });
  setQueryList("[id^='path-']", pathInputs);
  const pickers = ['referenceAudioPath', 'referenceTextPath'].map(key => {
    const node = $(`[data-pick-path="${key}"]`); node.dataset.pickPath = key; return node;
  });
  setQueryList('[data-pick-path]', pickers);
  $('#finetune-steps').value = '60';
  await import('../../electron-app/renderer/app.js');
  await tick();
  assert.doesNotMatch($('#job-log').textContent, /초기화 오류/);

  await t.test('학습 목록 오류가 목소리 설정을 막지 않고 선택한 목소리와 실제 적용값을 구분한다', async () => {
    await $('#open-model-settings').click();
    await tick();
    assert.equal($('#model-settings-dialog').open, true);
    assert.equal($('#global-adapter').value, 'a');
    $('#global-adapter').value = 'b';
    await $('#global-adapter').fire('change');
    assert.equal(saves.length, 0);
    assert.equal($('#sidebar-adapter').textContent, '목소리 a · 0.60');
    assert.match($('#voice-profile-summary').textContent, /아직 적용 전.*목소리 b/);
    assert.equal($('#voice-profile-preview').getAttribute('src'), 'file:///runs/b/preview.wav');
    assert.equal($('#path-referenceAudioPath').dataset.path, '/runs/b/reference.wav');
    assert.equal($('[data-pick-path="referenceAudioPath"]').disabled, true);
    assert.equal($('#voice-commit-apply').disabled, true, '청취 확인 전에 적용을 막는다');
    $('#voice-listening-confirm').checked = true;
    await $('#voice-listening-confirm').fire('change');
    assert.equal($('#voice-commit-apply').disabled, false);
    $('#global-scale').value = '0.7';
    await $('#global-scale').fire('input');
    assert.equal($('#voice-listening-confirm').checked, false);
    assert.equal($('#voice-commit-apply').disabled, true, '다른 강도에 같은 확인을 재사용하지 않는다');
    $('#global-scale').value = '0.6';
    await $('#global-scale').fire('input');
  });

  await t.test('일반 설정 저장은 아직 적용하지 않은 목소리를 보존하고 실패 이유를 화면에 남긴다', async () => {
    $('#voice-listening-confirm').checked = true;
    await $('#voice-listening-confirm').fire('change');
    $('#global-parallelism').value = '3';
    await $('#global-parallelism').fire('change');
    assert.equal(saves.at(-1).adapterId, 'a');
    assert.equal(saves.at(-1).paths.referenceAudioPath, '/runs/a/reference.wav');
    assert.equal($('#global-adapter').value, 'b');
    assert.equal($('#global-parallelism').value, '3');
    assert.equal($('#voice-listening-confirm').checked, true, '목소리·강도·음성 파일이 같으면 청취 확인도 유지한다');
    failSave = true;
    $('#notify-finish').checked = false;
    await $('#notify-finish').fire('change');
    assert.equal($('#settings-status').classList.contains('failed'), true);
    assert.equal($('#settings-status').classList.contains('hidden'), false, '미적용 목소리 안내에 저장 오류가 가려지지 않는다');
    assert.match($('#settings-status').textContent, /저장하지 못/);
    assert.equal($('#global-adapter').value, 'b');
    failSave = false;
  });

  await t.test('저장 중 새 입력은 뒤이어 저장하고 늦은 응답이 목소리 편집이나 일반 설정을 되돌리지 않는다', async () => {
    const gate = deferred(); gateSave = gate;
    $('#prevent-sleep').checked = false;
    const first = $('#prevent-sleep').fire('change');
    await tick();
    $('#notify-finish').checked = false;
    const second = $('#notify-finish').fire('change');
    $('#global-adapter').value = 'a';
    await $('#global-adapter').fire('change');
    gate.resolve();
    await Promise.all([first, second]);
    await tick();
    assert.equal(saved.preventSleep, false);
    assert.equal(saved.notifyOnFinish, false);
    assert.equal($('#notify-finish').checked, false);
    assert.equal($('#global-adapter').value, 'a');
  });

  await t.test('설정을 닫으면 시험 음성을 멈추며 시험 음성 만들기는 선택한 미적용값을 사용한다', async () => {
    $('#global-adapter').value = 'b';
    await $('#global-adapter').fire('change');
    await $('#voice-profile-preview').play();
    await $('#model-settings-dialog').close();
    assert.equal($('#voice-profile-preview').paused, true);
    await $('#open-model-settings').click();
    $('#global-adapter').value = 'b';
    await $('#global-adapter').fire('change');
    await $('#create-voice-preview').click();
    assert.deepEqual(previews.at(-1), { adapterId: 'b', adapterScale: .6 });
    assert.equal($('#edit-job-dialog').open, true);
    assert.equal($('#model-settings-dialog').open, false);
    assert.match($('#edit-dialog-title').textContent, /시험 음성/);
  });

  await t.test('학습 완료 후 검토 버튼은 새 목소리로 이동하되 실제 제작 목소리를 적용하지 않는다', async () => {
    const count = saves.length;
    onJob({ jobKind: 'training', type: 'training-started', options: { mode: 'train' } });
    onJob({ jobKind: 'training', type: 'training-complete', settings: structuredClone(saved), adapter: saved.adapters[1],
      previewUrl: 'file:///runs/b/preview.wav', previewScale: .6 });
    assert.equal($('#review-trained-voice').classList.contains('hidden'), false);
    await $('#review-trained-voice').click();
    await tick();
    assert.equal($('#model-settings-dialog').open, true);
    assert.equal($('#global-adapter').value, 'b');
    assert.equal($('#sidebar-adapter').textContent, '목소리 a · 0.60');
    assert.equal(saves.length, count);
    assert.equal($('#settings-voice-panel').classList.contains('hidden'), false);
  });

  await t.test('직접 청취 확인하고 적용할 때만 해당 시험 음성의 확인 기록과 목소리를 저장한다', async () => {
    $('#voice-listening-confirm').checked = true;
    await $('#voice-listening-confirm').fire('change');
    const count = saves.length;
    await $('#voice-commit-apply').click();
    assert.equal(saves.length, count + 1);
    assert.equal(saves.at(-1).adapterId, 'b');
    assert.deepEqual(saves.at(-1).listeningApproval, { audioSha256: 'audio-b' });
    assert.equal($('#sidebar-adapter').textContent, '목소리 b · 0.60');
    assert.equal($('#voice-listening-review').classList.contains('hidden'), true);
  });
});
