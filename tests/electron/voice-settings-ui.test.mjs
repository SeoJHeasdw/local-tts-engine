import test from 'node:test';
import assert from 'node:assert/strict';
import { sameVoiceScale, voiceProfileView } from '../../electron-app/shared/voice-profile-view.mjs';

function settingsFor(adapter = {}, voice = {}) {
  return {
    modelId: 'qwen3-tts', adapterId: '2026-10-02/new-speaker', adapterScale: 0.72,
    adapters: [{ id: '2026-10-02/new-speaker', displayName: '새 발표자', label: 'internal-run-name',
      listeningStatus: 'approved', approvedScale: 0.72, previewScale: 0.72,
      previewUrl: 'file:///tmp/listening-sample.wav', ...adapter }], ...voice,
  };
}

test('어떤 사람의 이름이든 듣고 승인한 강도에서만 승인된 목소리로 표시한다', () => {
  for (const displayName of ['새 발표자', '팀장님', 'English speaker']) {
    const view = voiceProfileView(settingsFor({ displayName }));
    assert.equal(view.label, displayName);
    assert.equal(view.approved, true);
    assert.equal(view.needsListening, false);
    assert.equal(view.previewMatches, true);
    assert.equal(view.blocked, false);
    assert.match(view.description, /반영 강도 0\.72/);
    assert.doesNotMatch(view.description, /internal-run-name/);
  }
});

test('청취를 마친 목소리의 강도를 바꾸면 기존 샘플과 승인 상태를 새 값에 맞춰 구분한다', () => {
  const settings = settingsFor();
  const changed = voiceProfileView(settings, { ...settings, adapterScale: 0.64 });
  assert.equal(changed.approved, false);
  assert.equal(changed.needsListening, true);
  assert.equal(changed.previewMatches, false);
  assert.equal(changed.canGeneratePreview, true);
  assert.match(changed.explanation, /시험 음성/);
  assert.equal(voiceProfileView(settings).approved, true, '초안 변경으로 현재 적용값의 승인은 바뀌지 않는다');
});

test('새 강도의 청취를 추가한 뒤에도 이전에 승인한 강도는 확인 완료로 표시한다', () => {
  const settings = settingsFor({ approvedScale: 0.72, approvedScales: [0.6, 0.72], previewScale: 0.72 });
  const previous = voiceProfileView(settings, { ...settings, adapterScale: 0.6 });
  assert.equal(previous.approved, true);
  assert.equal(previous.needsListening, false);
  assert.equal(previous.previewMatches, false, '현재 보관된 샘플이 어느 강도인지 별도로 보여 준다');
  assert.equal(voiceProfileView(settings, { ...settings, adapterScale: 0.65 }).approved, false);
});

test('샘플이 같은 강도로 존재해도 청취 대기 중이면 승인을 표시하지 않는다', () => {
  const view = voiceProfileView(settingsFor({ listeningStatus: 'pending' }));
  assert.equal(view.previewMatches, true);
  assert.equal(view.approved, false);
  assert.equal(view.needsListening, true);
  assert.equal(view.canGeneratePreview, true);
});

test('청취 후 보류한 목소리는 새 시험 음성을 확인하도록 안내한다', () => {
  const view = voiceProfileView(settingsFor({ listeningStatus: 'rejected' }));
  assert.equal(view.approved, false);
  assert.equal(view.needsListening, true);
  assert.match(view.title, /보류/);
  assert.match(view.explanation, /다시 적용/);
});

test('샘플 파일이나 강도 정보가 없으면 현재 강도의 시험 음성으로 제시하지 않는다', () => {
  for (const adapter of [{ previewUrl: null }, { previewScale: null }, { previewScale: undefined }, { previewScale: 0.6 }]) {
    const view = voiceProfileView(settingsFor(adapter));
    assert.equal(view.previewMatches, false);
    assert.equal(view.canGeneratePreview, true);
  }
});

test('목소리 파일 누락과 프로필 오류는 사용 및 시험 음성 생성 상태로 드러난다', () => {
  const missing = voiceProfileView(settingsFor({}, { adapterId: 'missing-speaker' }));
  assert.equal(missing.missing, true);
  assert.equal(missing.blocked, true);
  assert.equal(missing.approved, false);
  assert.equal(missing.canGeneratePreview, false);
  assert.match(missing.explanation, /다시 골라/);
  const invalid = voiceProfileView(settingsFor({ profileError: '대표 녹음 연결이 잘못됐습니다.' }));
  assert.equal(invalid.blocked, true);
  assert.equal(invalid.approved, false);
  assert.equal(invalid.canGeneratePreview, false);
  assert.equal(invalid.explanation, '대표 녹음 연결이 잘못됐습니다.');
});

test('기본 복제와 다른 모델에서는 학습된 사람의 샘플·승인값이 섞이지 않는다', () => {
  for (const voice of [{ adapterId: 'none' }, { modelId: 'chatterbox-v3' }]) {
    const view = voiceProfileView(settingsFor({}, voice));
    assert.equal(view.adapter, null);
    assert.equal(view.missing, false);
    assert.equal(view.blocked, false);
    assert.equal(view.approved, false);
    assert.equal(view.previewMatches, false);
    assert.equal(view.canGeneratePreview, false);
    assert.equal(view.needsListening, false);
  }
});

test('강도 비교는 숫자 문자열을 허용하고 허용 오차 밖의 값과 비숫자를 구분한다', () => {
  assert.equal(sameVoiceScale('0.72', 0.72), true);
  assert.equal(sameVoiceScale(0.7204, 0.72), true);
  assert.equal(sameVoiceScale(0.7206, 0.72), false);
  assert.equal(sameVoiceScale(undefined, 0.72), false);
  assert.equal(sameVoiceScale(Number.NaN, 0.72), false);
});
