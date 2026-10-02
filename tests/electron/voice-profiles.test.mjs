import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSettingsService } from '../../electron-app/main/settings.mjs';
import { createTrainingService } from '../../electron-app/main/training.mjs';
import { LEGACY_VOICE } from '../../electron-app/main/training-config.mjs';
import { readVoiceProfile, validateVoiceProfile, writeVoiceProfile } from '../../electron-app/main/voice-profile.mjs';
import { trainingClipAssessment, recommendedTrainingReference } from '../../electron-app/shared/training-review.mjs';
import crypto from 'node:crypto';

async function put(file, content = 'fixture') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

async function adapterFixture(root, id, profile) {
  const run = path.join(root, id);
  for (const file of ['adapters.safetensors', 'adapter_config.json']) await put(path.join(run, 'adapters', file));
  if (profile) {
    await put(path.join(run, 'reference.wav'), `reference ${profile.displayName}`);
    await put(path.join(run, 'reference.txt'), `${profile.displayName} 참조 전사`);
    await writeVoiceProfile(run, { schemaVersion: 1, referenceAudioPath: 'reference.wav',
      referenceTextPath: 'reference.txt', ...profile }, { exclusive: true });
  }
  return run;
}

test('서로 다른 프로필 선택마다 어댑터·참조 음성·전사가 함께 바뀌고 사라진 선택은 대체하지 않는다', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'speaker-profiles-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapterRoot = path.join(root, 'runs'), settingsPath = path.join(root, 'settings.json');
  const alphaId = '2026-10-01/speaker-alpha', betaId = '2026-10-01/speaker-beta';
  const alpha = await adapterFixture(adapterRoot, alphaId, { displayName: '첫 번째 목소리', listeningStatus: 'approved', approvedScale: 0.6 });
  const beta = await adapterFixture(adapterRoot, betaId, { displayName: '두 번째 목소리', listeningStatus: 'approved', approvedScale: 0.6 });
  await put(settingsPath, JSON.stringify({ modelId: 'qwen3-tts', adapterId: alphaId,
    paths: { voiceLibraryRoot: path.join(root, 'voice-library'), outputRoot: path.join(root, 'output') } }));
  const service = createSettingsService({ state: {}, adapterRoot, settingsPath });
  const original = await service.readAppSettings();
  const changed = await service.saveAppSettings({ ...original, adapterId: betaId });
  assert.equal(changed.paths.referenceAudioPath, path.join(beta, 'reference.wav'));
  assert.equal(changed.paths.referenceTextPath, path.join(beta, 'reference.txt'));
  assert.equal(service.applyVoiceSettings({}, changed).paths.referenceAudioPath, path.join(beta, 'reference.wav'));
  const restored = await service.saveAppSettings({ ...changed, adapterId: alphaId });
  assert.equal(restored.paths.referenceAudioPath, path.join(alpha, 'reference.wav'));
  assert.equal(restored.paths.referenceTextPath, path.join(alpha, 'reference.txt'));
  await assert.rejects(service.saveAppSettings({ ...restored, adapterId: 'unknown' }), /어댑터가 없습니다/);
  await put(settingsPath, JSON.stringify({ ...changed, adapterId: '2026-10-01/deleted-voice' }));
  const missing = await service.readAppSettings();
  assert.equal(missing.adapterId, '2026-10-01/deleted-voice');
  assert.throws(() => service.applyVoiceSettings({}, missing), /어댑터가 없습니다/);
  await put(path.join(beta, 'voice-profile.json'), '{broken');
  await assert.rejects(service.saveAppSettings({ ...changed }), /프로필을 읽지 못했습니다/);
});

test('기존 승인 목소리는 정확한 실행 ID 하나만 기본값·프로필 없는 호환 대상으로 인정한다', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-voice-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapterRoot = path.join(root, 'runs'), settingsPath = path.join(root, 'settings.json');
  await adapterFixture(adapterRoot, LEGACY_VOICE.adapterId);
  const sameNameId = `2099-12-31/${path.basename(LEGACY_VOICE.adapterId)}`;
  await adapterFixture(adapterRoot, sameNameId);
  const service = createSettingsService({ state: {}, adapterRoot, settingsPath });
  const settings = await service.readAppSettings();
  assert.equal(settings.adapterId, LEGACY_VOICE.adapterId);
  assert.equal(settings.adapterScale, 0.6);
  const legacy = settings.adapters.find(item => item.id === LEGACY_VOICE.adapterId);
  assert.equal(legacy.displayName, '내 목소리');
  assert.equal(legacy.listeningStatus, 'approved');
  assert.equal(legacy.profileError, null);
  assert.deepEqual(legacy.referencePaths, { referenceAudioPath: LEGACY_VOICE.referenceAudioPath,
    referenceTextPath: LEGACY_VOICE.referenceTextPath });
  const sameName = settings.adapters.find(item => item.id === sameNameId);
  assert.equal(sameName.referencePaths, null);
  assert.equal(sameName.listeningStatus, 'pending');
  assert.match(sameName.profileError, /프로필이 없습니다/);
  await assert.rejects(service.saveAppSettings({ ...settings, adapterId: sameNameId }), /프로필이 없습니다/);
  assert.throws(() => service.applyVoiceSettings({}, { ...settings, adapterId: sameNameId }), /프로필이 없습니다/);
  await fs.rm(path.join(adapterRoot, LEGACY_VOICE.adapterId), { recursive: true });
  const missing = await service.readAppSettings();
  assert.equal(missing.adapterId, LEGACY_VOICE.adapterId);
  assert.throws(() => service.applyVoiceSettings({}, missing), /어댑터가 없습니다/);
});

test('프로필은 실행 폴더 기준으로 읽고 지원하지 않는 형식·상태·참조를 사용하지 않는다', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-profile-schema-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = { schemaVersion: 1, displayName: '새 화자', referenceAudioPath: 'reference.wav',
    referenceTextPath: 'reference.txt', trainJsonl: 'train_raw.jsonl' };
  const written = await writeVoiceProfile(root, original, { exclusive: true });
  assert.equal(written.trainingStatus, 'complete');
  assert.equal(written.listeningStatus, 'pending');
  assert.equal(original.trainingStatus, undefined);
  const { profile, referencePaths } = await readVoiceProfile(root);
  assert.equal(profile.trainJsonl, 'train_raw.jsonl');
  assert.deepEqual(referencePaths, { referenceAudioPath: path.join(root, 'reference.wav'),
    referenceTextPath: path.join(root, 'reference.txt') });
  await assert.rejects(writeVoiceProfile(root, { ...profile, displayName: '다른 화자' }, { exclusive: true }), /EEXIST/);
  assert.equal((await readVoiceProfile(root)).profile.displayName, '새 화자');
  for (const invalid of [{ schemaVersion: 2 }, { displayName: '' }, { referenceAudioPath: '' },
    { referenceTextPath: 5 }, { trainingStatus: 'approved' }, { listeningStatus: 'complete' }]) {
    assert.throws(() => validateVoiceProfile({ ...original, ...invalid }), /목소리 프로필/);
  }
});

test('미완료·비교용 학습은 제작 선택에서 빠지고 잘못된 프로필은 참조 기본값으로 통과하지 않는다', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-profile-states-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapterRoot = path.join(root, 'runs'), settingsPath = path.join(root, 'settings.json');
  for (const trainingStatus of ['pending', 'failed', 'comparison-candidate', 'complete']) {
    await adapterFixture(adapterRoot, `2026-10-01/${trainingStatus}`, { displayName: trainingStatus, trainingStatus,
      listeningStatus: 'approved', approvedScale: 0.6 });
  }
  const malformed = await adapterFixture(adapterRoot, '2026-10-01/malformed');
  await put(path.join(malformed, 'voice-profile.json'), JSON.stringify({ schemaVersion: 1,
    displayName: '잘못된 참조', referenceAudioPath: {}, referenceTextPath: 'reference.txt' }));
  const service = createSettingsService({ state: {}, adapterRoot, settingsPath });
  const adapters = await service.discoverAdapters();
  assert.deepEqual(adapters.map(item => item.label).sort(), ['complete', 'malformed']);
  const broken = adapters.find(item => item.label === 'malformed');
  assert.equal(broken.referencePaths, null);
  assert.match(broken.profileError, /참조 음성 경로/);
  const settings = { modelId: 'qwen3-tts', adapterId: broken.id, adapters,
    paths: { voiceLibraryRoot: path.join(root, 'voice-library'), outputRoot: path.join(root, 'output') } };
  assert.throws(() => service.applyVoiceSettings({}, settings), /참조 음성 경로/);
  await assert.rejects(service.saveAppSettings(settings), /참조 음성 경로/);
  const complete = adapters.find(item => item.label === 'complete');
  await fs.rm(complete.referencePaths.referenceAudioPath);
  await assert.rejects(service.saveAppSettings({ ...settings, adapterId: complete.id }), /참조 음성 파일/);
});

async function trainingFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'speaker-training-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const datasetRoot = path.join(root, 'datasets'), directory = path.join(datasetRoot, 'speaker-ko-v1');
  const rows = [];
  for (let index = 1; index <= 4; index++) {
    const audio = path.join(directory, 'clips', `clip-${index}.wav`);
    await put(audio, `audio ${index}`);
    rows.push({ id: `clip-${index}`, audio, text: `문장 ${index}`, durationMs: 8000, reviewStatus: 'pending' });
  }
  await put(path.join(directory, 'metadata.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
  await put(path.join(directory, 'manifest.json'), JSON.stringify({ displayName: '새 화자', stats: { clips: 4, transcribed: 4 } }));
  const calls = [], events = [], state = { activeJob: { state: 'running', cancelled: false } };
  const runRoot = path.join(root, 'runs');
  const settings = { adapterId: 'personal', paths: {}, adapters: [] };
  const service = createTrainingService({ datasetRoot, runRoot, state, emit: event => events.push(event),
    readAppSettings: async () => settings, requireRuntimeTool: () => 'python',
    inspectModel: async () => ({ state: 'ready', path: '/cached/model' }),
    runProcess: async (stage, executable, args) => {
      calls.push({ stage, args });
      if (args.includes('export')) await put(path.join(directory, 'official', 'train_raw.jsonl'), '{}\n');
      if (args.includes('local_tts_engine.finetune_mlx')) {
        const output = args[args.indexOf('--output-dir') + 1];
        await put(path.join(output, 'training-result.json'), JSON.stringify({ status: 'complete' }));
      }
      if (args.includes('local_tts_engine.text_candidate')) await put(args[args.indexOf('--output') + 1], 'preview');
    } });
  const options = { name: 'speaker-test', datasetId: 'speaker-ko-v1', displayName: '새 화자', maxSteps: 60,
    referenceId: 'clip-2', reviews: rows.map(row => ({ id: row.id, text: row.text, accepted: true })), paths: {} };
  return { service, options, calls, events, state, directory, runRoot, settings };
}

test('새 화자 학습은 선택한 데이터만 쓰며 참조를 고정하고 기본값을 적용하지 않는다', async t => {
  const f = await trainingFixture(t);
  await f.service.runFineTune(f.options);
  const train = f.calls.find(call => call.args.includes('local_tts_engine.finetune_mlx')).args;
  const output = train[train.indexOf('--output-dir') + 1];
  assert.equal(train[train.indexOf('--train-jsonl') + 1], path.join(output, 'train_raw.jsonl'));
  const profile = JSON.parse(await fs.readFile(path.join(output, 'voice-profile.json'), 'utf8'));
  assert.equal(profile.referenceAudioPath, 'reference.wav');
  assert.equal(profile.referenceTextPath, 'reference.txt');
  assert.equal(profile.listeningStatus, 'pending');
  assert.equal(profile.trainingStatus, 'complete');
  assert.equal(profile.trainJsonl, 'train_raw.jsonl');
  assert.equal(profile.trainJsonlSha256, crypto.createHash('sha256').update('{}\n').digest('hex'));
  assert.equal(await fs.readFile(path.join(output, 'reference.wav'), 'utf8'), 'audio 2');
  await fs.writeFile(path.join(f.directory, 'reference.wav'), 'next reference');
  assert.equal(await fs.readFile(path.join(output, 'reference.wav'), 'utf8'), 'audio 2', '재학습이 예전 프로필의 참조를 바꾸지 않는다');
  await fs.writeFile(path.join(f.directory, 'official', 'train_raw.jsonl'), '{"next":true}\n');
  assert.equal(await fs.readFile(path.join(output, 'train_raw.jsonl'), 'utf8'), '{}\n', '재검수·내보내기가 이전 실행의 학습 입력을 바꾸지 않는다');
  assert.equal(f.settings.adapterId, 'personal');
  assert.equal(f.events.at(-1).type, 'training-complete');
  assert.match(f.events.at(-1).previewUrl, /preview\.wav$/);
  await assert.rejects(f.service.runFineTune(f.options), /EEXIST/);
});

test('전사 준비는 학습·기본값 변경 없이 끝나며 확인 안 한 참조로 학습하지 않는다', async t => {
  const f = await trainingFixture(t);
  await f.service.runFineTune({ ...f.options, mode: 'prepare' });
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls[0].args.includes('local_tts_engine.finetune_review'));
  assert.ok(f.calls[1].args.includes('transcribe'));
  assert.ok(f.calls[1].args.includes('/cached/model'));
  assert.ok(f.calls[2].args.includes('--comparison-model'));
  assert.equal(f.events.at(-1).type, 'training-prepared');
  assert.equal(f.state.activeJob.state, 'done');
  await assert.rejects(f.service.runFineTune({ ...f.options, referenceId: 'unknown' }), /참조 음성을 골라/);
  await assert.rejects(f.service.readTrainingDataset('../outside'), /학습 데이터를 골라/);
  const repeated = f.options.reviews.map(() => f.options.reviews[0]);
  await assert.rejects(f.service.runFineTune({ ...f.options, reviews: repeated }), /클립 목록이 다릅니다/);
});

test('녹음 경고·미측정 일치도를 구분하고 좋은 길이의 클립만 참조 후보로 제안한다', () => {
  const clean = { id: 'clean', text: '안녕하세요', durationMs: 8000,
    quality: { audio: { warnings: [] }, transcriptAgreement: 0.98 } };
  const quiet = { ...clean, id: 'quiet', quality: { ...clean.quality,
    audio: { warnings: [{ code: 'long-silence', message: '긴 무음' }] } } };
  const disagreement = { ...clean, id: 'different', quality: { ...clean.quality, transcriptAgreement: 0.5 } };
  assert.equal(trainingClipAssessment({ ...clean, quality: null }).agreement, null);
  assert.equal(trainingClipAssessment({ ...clean, quality: null }).referenceCandidate, false);
  assert.equal(trainingClipAssessment({ ...clean, text: '' }).trainingLabel, '녹음의 글 필요');
  assert.equal(trainingClipAssessment({ ...clean, text: '' }).referenceCandidate, false);
  assert.equal(trainingClipAssessment(disagreement).warnings[0].code, 'transcript-disagreement');
  assert.equal(recommendedTrainingReference([quiet, disagreement, { ...clean, id: 'long', durationMs: 15000 }, clean]), 'clean');
  assert.equal(recommendedTrainingReference([quiet, disagreement]), null);
});

test('받아쓰기 일치도는 실제 음성·초벌 전사와 일치하는 기록일 때만 표시한다', async t => {
  const f = await trainingFixture(t);
  const hash = text => crypto.createHash('sha256').update(text).digest('hex');
  await put(path.join(f.directory, 'quality-review.json'), JSON.stringify({ clips: [{ id: 'clip-1',
    audioSha256: hash('audio 1'), sourceTranscriptSha256: hash('문장 1'),
    audio: { warnings: [] }, independentText: '문장 1', independentModel: 'whisper', transcriptAgreement: 1 }] }));
  let dataset = await f.service.readTrainingDataset('speaker-ko-v1');
  assert.equal(dataset.clips[0].quality.transcriptAgreement, 1);
  assert.equal(dataset.qualityReviewed, 1);
  const metadataPath = path.join(f.directory, 'metadata.jsonl');
  await fs.writeFile(metadataPath, (await fs.readFile(metadataPath, 'utf8')).replace('문장 1', '다른 내용'));
  dataset = await f.service.readTrainingDataset('speaker-ko-v1');
  assert.equal(dataset.clips[0].quality.transcriptAgreement, null);
  assert.equal(dataset.qualityReviewed, 0);
  await fs.writeFile(path.join(f.directory, 'clips', 'clip-1.wav'), 'changed audio');
  dataset = await f.service.readTrainingDataset('speaker-ko-v1');
  assert.equal(dataset.clips[0].quality, null);
});
