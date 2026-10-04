import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSettingsService } from '../../electron-app/main/settings.mjs';
import { fileSha256 } from '../../electron-app/main/files.mjs';
import { voiceInputIdentity } from '../../electron-app/main/voice-profile.mjs';
import crypto from 'node:crypto';

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-settings-approval-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapterRoot = path.join(root, 'runs');
  const adapterId = options.adapterId || '2026-10-02/new-speaker';
  const runDirectory = path.join(adapterRoot, adapterId);
  const adapterPath = path.join(runDirectory, 'adapters');
  const settingsPath = path.join(root, 'app-settings.json');
  const paths = {
    sourceProjectRoot: path.join(root, 'source'), voiceLibraryRoot: path.join(root, 'library'),
    outputRoot: path.join(root, 'output'), referenceAudioPath: path.join(root, 'manual-reference.wav'),
    referenceTextPath: path.join(root, 'manual-reference.txt'),
  };
  await fs.mkdir(adapterPath, { recursive: true });
  await fs.writeFile(path.join(adapterPath, 'adapters.safetensors'), 'fixture-adapter-weights');
  await fs.writeFile(path.join(adapterPath, 'adapter_config.json'), '{"rank":16}');
  await fs.writeFile(paths.referenceAudioPath, 'fixture-manual-reference');
  await fs.writeFile(paths.referenceTextPath, '기존 대표 녹음입니다.');
  if (options.referenceFiles !== false) {
    await fs.writeFile(path.join(runDirectory, 'reference.wav'), 'fixture-run-reference');
    await fs.writeFile(path.join(runDirectory, 'reference.txt'), '새 목소리의 대표 녹음입니다.');
  }
  const previewPath = path.join(runDirectory, '미리 듣기', '시험 음성.wav');
  await fs.mkdir(path.dirname(previewPath), { recursive: true });
  await fs.writeFile(previewPath, 'fixture-preview-wave-content');
  const previewAudioSha256 = await fileSha256(previewPath);
  const profilePath = path.join(runDirectory, 'voice-profile.json');
  const profile = {
    schemaVersion: 1, displayName: '새 발표자', referenceAudioPath: 'reference.wav',
    referenceTextPath: 'reference.txt', trainingStatus: 'complete', listeningStatus: options.status || 'pending',
    comparisonScale: 0.6,
    preview: { audioPath: path.relative(runDirectory, previewPath), audioSha256: previewAudioSha256,
      scale: options.previewScale ?? 0.6,
      adapterWeightsSha256: await fileSha256(path.join(adapterPath, 'adapters.safetensors')),
      adapterConfigSha256: await fileSha256(path.join(adapterPath, 'adapter_config.json')),
      referenceAudioSha256: options.referenceFiles === false ? null : await fileSha256(path.join(runDirectory, 'reference.wav')),
      referenceTextSha256: options.referenceFiles === false ? null : await fileSha256(path.join(runDirectory, 'reference.txt')) }, ...options.profile,
  };
  if (profile.listeningStatus === 'approved' && !profile.listeningApproval && options.referenceFiles !== false) {
    profile.listeningApproval = { status: 'approved', adapterScale: profile.approvedScale ?? 0.6,
      audioSha256: previewAudioSha256, ...await voiceInputIdentity(adapterPath,
        { referenceAudioPath: path.join(runDirectory, 'reference.wav'), referenceTextPath: path.join(runDirectory, 'reference.txt') }) };
  }
  if (options.profileMissing !== true) await fs.writeFile(profilePath, JSON.stringify(profile));
  if (options.previewMetadata) await fs.writeFile(path.join(runDirectory, 'preview.json'), JSON.stringify(options.previewMetadata));
  const legacyVoice = {
    adapterId: options.legacy ? adapterId : '2000-01-01/old-speaker', displayName: '기존 목소리',
    referenceAudioPath: paths.referenceAudioPath, referenceTextPath: paths.referenceTextPath,
    adapterScale: 0.6, listeningStatus: 'approved',
    listeningApproval: await voiceInputIdentity(adapterPath, paths),
  };
  const initial = {
    modelId: 'qwen3-tts', adapterId: options.currentAdapter ?? 'none', adapterScale: options.currentScale ?? 0.6,
    voiceParallelism: 1, preventSleep: true, notifyOnFinish: true, paths,
  };
  await fs.writeFile(settingsPath, JSON.stringify(initial));
  const state = { catalogCache: {}, catalogCacheRoot: 'previous-root' };
  const service = createSettingsService({ state, adapterRoot, settingsPath, legacyVoice });
  return { root, adapterId, adapterRoot, runDirectory, adapterPath, profile, profilePath, previewPath,
    previewAudioSha256, settingsPath, initial, paths, state, service,
    readProfile: async () => JSON.parse(await fs.readFile(profilePath, 'utf8')),
    readSaved: async () => JSON.parse(await fs.readFile(settingsPath, 'utf8')) };
}

test('등록 목소리의 실제 샘플·강도·청취 승인 상태를 함께 제공한다', async t => {
  const f = await fixture(t, { status: 'approved', profile: { approvedScale: 0.73 }, previewScale: 0.73 });
  const [adapter] = await f.service.discoverAdapters();
  assert.equal(adapter.displayName, '새 발표자');
  assert.equal(adapter.listeningStatus, 'approved');
  assert.equal(adapter.approvedScale, 0.73);
  assert.equal(adapter.previewScale, 0.73);
  assert.equal(adapter.previewAudioSha256, f.previewAudioSha256);
  assert.equal(fileURLToPath(adapter.previewUrl), f.previewPath);
  assert.equal(adapter.runDirectory, f.runDirectory);
  assert.equal(adapter.legacy, false);
  assert.deepEqual(adapter.referencePaths, { referenceAudioPath: path.join(f.runDirectory, 'reference.wav'),
    referenceTextPath: path.join(f.runDirectory, 'reference.txt') });
});

test('승인한 실제 샘플의 강도와 해시를 확인하고 목소리 프로필에 승인을 기록한다', async t => {
  const f = await fixture(t);
  const saved = await f.service.saveAppSettings({ adapterId: f.adapterId, adapterScale: 0.6,
    listeningApproval: { audioSha256: f.previewAudioSha256 } });
  const profile = await f.readProfile();
  assert.equal(profile.listeningStatus, 'approved');
  assert.equal(profile.approvedScale, 0.6);
  assert.equal(profile.listeningApproval.status, 'approved');
  assert.equal(profile.listeningApproval.audioPath, f.previewPath, '공백·한글을 포함한 실제 경로를 기록한다');
  assert.equal(profile.listeningApproval.audioSha256, f.previewAudioSha256);
  assert.equal(profile.listeningApproval.adapterScale, 0.6);
  assert.equal(profile.listeningApproval.adapterWeightsSha256, await fileSha256(path.join(f.adapterPath, 'adapters.safetensors')));
  assert.equal(profile.listeningApproval.adapterConfigSha256, await fileSha256(path.join(f.adapterPath, 'adapter_config.json')));
  assert.equal(profile.listeningApproval.referenceAudioSha256, await fileSha256(path.join(f.runDirectory, 'reference.wav')));
  assert.equal(profile.listeningApproval.referenceTextSha256, await fileSha256(path.join(f.runDirectory, 'reference.txt')));
  assert.equal(saved.adapters.find(item => item.id === f.adapterId).listeningStatus, 'approved');
  assert.equal((await f.readSaved()).adapterId, f.adapterId);
  assert.equal(f.state.catalogCache, null);
  assert.equal(f.state.catalogCacheRoot, null);
});

test('다른 샘플의 해시로 승인 요청하면 기존 설정과 청취 상태를 보존한다', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.saveAppSettings({ adapterId: f.adapterId, adapterScale: 0.6,
    listeningApproval: { audioSha256: 'another-sample-hash' } }), /시험 음성|다시.*듣/);
  assert.equal((await f.readProfile()).listeningStatus, 'pending');
  assert.deepEqual(await f.readSaved(), f.initial);
});

test('기존 샘플과 다른 강도로 바꿀 때에는 그 강도의 샘플을 요구한다', async t => {
  const f = await fixture(t, { status: 'approved', profile: { approvedScale: 0.6 } });
  await assert.rejects(f.service.saveAppSettings({ adapterId: f.adapterId, adapterScale: 0.72,
    listeningApproval: { audioSha256: f.previewAudioSha256 } }), /시험 음성|다시.*듣/);
  assert.equal((await f.readProfile()).approvedScale, 0.6);
  assert.deepEqual(await f.readSaved(), f.initial);
});

test('청취 대기 중인 새 목소리를 확인 기록 없이 적용하지 않는다', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.saveAppSettings({ adapterId: f.adapterId, adapterScale: 0.6 }), /청취|시험 음성|듣고.*확인/);
  assert.deepEqual(await f.readSaved(), f.initial);
  assert.equal((await f.readProfile()).listeningStatus, 'pending');
});

test('청취 승인된 강도를 바꿀 때에도 확인 기록 없이 새 값을 적용하지 않는다', async t => {
  const f = await fixture(t, { status: 'approved', profile: { approvedScale: 0.6 } });
  await assert.rejects(f.service.saveAppSettings({ adapterId: f.adapterId, adapterScale: 0.74 }), /청취|시험 음성|듣고.*확인/);
  assert.deepEqual(await f.readSaved(), f.initial);
});

test('보류한 목소리는 새 샘플을 청취 확인한 뒤 승인할 수 있다', async t => {
  const f = await fixture(t, { status: 'rejected' });
  await assert.rejects(f.service.saveAppSettings({ adapterId: f.adapterId, adapterScale: 0.6 }), /보류/);
  await f.service.saveAppSettings({ adapterId: f.adapterId, adapterScale: 0.6,
    listeningApproval: { audioSha256: f.previewAudioSha256 } });
  assert.equal((await f.readProfile()).listeningStatus, 'approved');
});

test('새 강도의 청취 승인을 추가해도 기존 강도의 승인 기록과 복귀 가능 상태를 보존한다', async t => {
  const adapterId = '2026-10-02/new-speaker';
  const previousApproval = { status: 'approved', adapterScale: 0.6, source: 'existing-human-review',
    date: '2026-10-01T12:00:00.000Z', audioSha256: 'previous-listened-sample',
    ...Object.fromEntries(Object.entries({ adapterWeightsSha256: 'fixture-adapter-weights', adapterConfigSha256: '{"rank":16}',
      referenceAudioSha256: 'fixture-run-reference', referenceTextSha256: '새 목소리의 대표 녹음입니다.' })
      .map(([key, value]) => [key, crypto.createHash('sha256').update(value).digest('hex')])) };
  const f = await fixture(t, { status: 'approved', currentAdapter: adapterId, previewScale: 0.72,
    profile: { approvedScale: 0.6, listeningApproval: previousApproval } });
  const saved = await f.service.saveAppSettings({ adapterScale: 0.72,
    listeningApproval: { audioSha256: f.previewAudioSha256 } });
  const profile = await f.readProfile();
  assert.equal(profile.approvedScale, 0.72);
  assert.deepEqual(JSON.parse(JSON.stringify(profile.listeningApprovals[0])), previousApproval);
  assert.equal(profile.listeningApprovals[1].adapterScale, 0.72);
  assert.deepEqual(saved.adapters.find(item => item.id === adapterId).approvedScales.toSorted(), [0.6, 0.72]);
  const restored = await f.service.saveAppSettings({ adapterScale: 0.6 });
  assert.equal(restored.adapterScale, 0.6);
  assert.equal((await f.readProfile()).listeningApprovals.length, 2, '기존 승인값으로 복귀할 때 기록을 덮지 않는다');
});

test('참조 파일이 일시적으로 없어도 목소리와 무관한 일반 설정은 저장할 수 있다', async t => {
  const adapterId = '2026-10-02/new-speaker';
  const f = await fixture(t, { currentAdapter: adapterId, referenceFiles: false });
  const saved = await f.service.saveAppSettings({ voiceParallelism: 2, notifyOnFinish: false });
  assert.equal(saved.adapterId, adapterId);
  assert.equal(saved.adapterScale, 0.6);
  assert.equal(saved.voiceParallelism, 2);
  assert.equal(saved.notifyOnFinish, false);
  assert.equal((await f.readProfile()).listeningStatus, 'pending');
});

test('등록된 목소리는 사람이 수동 참조 경로를 섞어도 그 목소리의 대표 녹음을 사용한다', async t => {
  const f = await fixture(t, { status: 'approved', profile: { approvedScale: 0.6 } });
  const saved = await f.service.saveAppSettings({ adapterId: f.adapterId, paths: f.paths });
  assert.equal(saved.paths.referenceAudioPath, path.join(f.runDirectory, 'reference.wav'));
  assert.equal(saved.paths.referenceTextPath, path.join(f.runDirectory, 'reference.txt'));
});

test('샘플 파일이 등록된 해시와 달라지면 청취용 샘플로 반환하거나 승인하지 않는다', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.previewPath, 'changed-after-registration');
  const [adapter] = await f.service.discoverAdapters();
  assert.equal(adapter.previewUrl, null);
  assert.equal(adapter.previewAudioSha256, null);
  await assert.rejects(f.service.saveAppSettings({ adapterId: f.adapterId,
    listeningApproval: { audioSha256: f.previewAudioSha256 } }), /시험 음성|다시.*듣/);
  assert.equal((await f.readProfile()).listeningStatus, 'pending');
});

test('샘플 생성 후 학습 가중치나 설정이 바뀌면 과거 샘플 청취로 새 파일을 승인하지 않는다', async t => {
  for (const hashSource of ['profile', 'metadata']) {
    for (const changedFile of ['adapters.safetensors', 'adapter_config.json']) {
      const f = await fixture(t);
      if (hashSource === 'metadata') {
        const profile = await f.readProfile();
        const weightsSha256 = profile.preview.adapterWeightsSha256;
        const configSha256 = profile.preview.adapterConfigSha256;
        delete profile.preview.adapterWeightsSha256;
        delete profile.preview.adapterConfigSha256;
        await fs.writeFile(f.profilePath, JSON.stringify(profile));
        await fs.writeFile(path.join(f.runDirectory, 'preview.json'), JSON.stringify({
          audioSha256: f.previewAudioSha256, adapter: { weightsSha256, configSha256 },
        }));
      }
      const beforeProfile = await fs.readFile(f.profilePath);
      const beforeSettings = await fs.readFile(f.settingsPath);
      const beforeSample = await fs.readFile(f.previewPath);
      await fs.writeFile(path.join(f.adapterPath, changedFile), 'changed-after-sample-generation');

      await assert.rejects(f.service.saveAppSettings({ adapterId: f.adapterId, adapterScale: 0.6,
        listeningApproval: { audioSha256: f.previewAudioSha256 } }), /학습 파일이 바뀌었습니다.*다시 만들어/);

      assert.deepEqual(await fs.readFile(f.profilePath), beforeProfile, `${hashSource}/${changedFile}: 승인 상태를 보존한다`);
      assert.deepEqual(await fs.readFile(f.settingsPath), beforeSettings);
      assert.deepEqual(await fs.readFile(f.previewPath), beforeSample);
      assert.equal((await f.readProfile()).listeningStatus, 'pending');
    }
  }
});

test('기존 승인 목소리는 프로필 파일이 없을 때 호환 참조와 승인값을 유지한다', async t => {
  const f = await fixture(t, { legacy: true, profileMissing: true });
  const [adapter] = await f.service.discoverAdapters();
  assert.equal(adapter.legacy, true);
  assert.equal(adapter.profileError, null);
  assert.equal(adapter.listeningStatus, 'approved');
  assert.equal(adapter.approvedScale, 0.6);
  assert.deepEqual(adapter.referencePaths, { referenceAudioPath: f.paths.referenceAudioPath,
    referenceTextPath: f.paths.referenceTextPath });
});

test('청취 승인 뒤 어댑터·대표 녹음·전사 교체는 승인을 재사용하거나 제작하지 못한다', async t => {
  for (const relative of ['adapters/adapters.safetensors', 'adapters/adapter_config.json', 'reference.wav', 'reference.txt']) {
    const f = await fixture(t);
    await f.service.saveAppSettings({ adapterId: f.adapterId, listeningApproval: { audioSha256: f.previewAudioSha256 } });
    const beforeProfile = await fs.readFile(f.profilePath), beforeSettings = await fs.readFile(f.settingsPath);
    await fs.writeFile(path.join(f.runDirectory, relative), 'unheard replacement');
    const current = await f.service.readAppSettings();
    assert.equal(current.adapters[0].listeningStatus, 'pending', relative);
    assert.deepEqual(current.adapters[0].approvedScales, []);
    assert.throws(() => f.service.applyVoiceSettings({}, current), /청취|다시.*확인/);
    assert.deepEqual(await fs.readFile(f.profilePath), beforeProfile, '읽기 검증이 기존 승인 기록을 고쳐 쓰지 않는다');
    assert.deepEqual(await fs.readFile(f.settingsPath), beforeSettings);
  }
});

test('시험 음성을 만든 뒤 대표 녹음이나 전사를 바꾸면 그 시험 음성으로 승인하지 않는다', async t => {
  for (const relative of ['reference.wav', 'reference.txt']) {
    const f = await fixture(t);
    const beforeProfile = await fs.readFile(f.profilePath), beforeSettings = await fs.readFile(f.settingsPath);
    await fs.writeFile(path.join(f.runDirectory, relative), 'replacement after preview');
    await assert.rejects(f.service.saveAppSettings({ adapterId: f.adapterId,
      listeningApproval: { audioSha256: f.previewAudioSha256 } }), /대표 녹음이나 전사가 바뀌었습니다/);
    assert.deepEqual(await fs.readFile(f.profilePath), beforeProfile);
    assert.deepEqual(await fs.readFile(f.settingsPath), beforeSettings);
  }
});

test('해시 증거 없는 과거 승인·시험 음성에는 현재 파일로 청취 승인을 자동 보충하지 않는다', async t => {
  const f = await fixture(t, { status: 'approved', profile: { approvedScale: 0.6 } });
  const profile = await f.readProfile();
  delete profile.listeningApproval;
  for (const key of ['adapterWeightsSha256', 'adapterConfigSha256', 'referenceAudioSha256', 'referenceTextSha256']) delete profile.preview[key];
  await fs.writeFile(f.profilePath, JSON.stringify(profile));
  const before = await fs.readFile(f.profilePath);
  const [adapter] = await f.service.discoverAdapters();
  assert.equal(adapter.listeningStatus, 'pending');
  await assert.rejects(f.service.saveAppSettings({ adapterId: f.adapterId,
    listeningApproval: { audioSha256: f.previewAudioSha256 } }), /확인 기록이 없습니다/);
  assert.deepEqual(await fs.readFile(f.profilePath), before);
});

test('기존 비교 샘플의 승인·학습 계획 해시를 대조해 청취 승인과 강도를 보존한다', async t => {
  const f = await fixture(t);
  const profile = await f.readProfile();
  const planPath = path.join(f.root, 'training-plan.json');
  await fs.writeFile(planPath, JSON.stringify({ referenceAudioSha256: profile.preview.referenceAudioSha256,
    referenceTextSha256: profile.preview.referenceTextSha256 }));
  profile.listeningStatus = 'approved'; profile.reviewPlan = planPath;
  profile.listeningApproval = { status: 'approved', adapterScale: 0.6, audioPath: f.previewPath, audioSha256: f.previewAudioSha256,
    adapterWeightsSha256: profile.preview.adapterWeightsSha256, adapterConfigSha256: profile.preview.adapterConfigSha256 };
  delete profile.preview.referenceAudioSha256; delete profile.preview.referenceTextSha256;
  await fs.writeFile(f.profilePath, JSON.stringify(profile));
  await fs.writeFile(path.join(f.runDirectory, 'preview.json'), JSON.stringify({ audioSha256: f.previewAudioSha256,
    adapter: { weightsSha256: profile.listeningApproval.adapterWeightsSha256, configSha256: profile.listeningApproval.adapterConfigSha256, scale: 0.6 } }));
  const before = await fs.readFile(f.profilePath);
  let [adapter] = await f.service.discoverAdapters();
  assert.equal(adapter.listeningStatus, 'approved'); assert.deepEqual(adapter.approvedScales, [0.6]);
  assert.deepEqual(await fs.readFile(f.profilePath), before);
  const nextPreview = path.join(f.root, 'new-preview', 'preview.wav');
  await fs.mkdir(path.dirname(nextPreview)); await fs.writeFile(nextPreview, 'new unapproved sample');
  profile.preview = { audioPath: nextPreview, audioSha256: await fileSha256(nextPreview), scale: 0.72,
    ...await voiceInputIdentity(f.adapterPath, { referenceAudioPath: path.join(f.runDirectory, 'reference.wav'), referenceTextPath: path.join(f.runDirectory, 'reference.txt') }) };
  await fs.writeFile(f.profilePath, JSON.stringify(profile));
  const afterPreview = await fs.readFile(f.profilePath);
  [adapter] = await f.service.discoverAdapters();
  assert.equal(adapter.listeningStatus, 'approved'); assert.deepEqual(adapter.approvedScales, [0.6], '새 강도 샘플이 과거 청취 증거의 참조 연결을 지우지 않는다');
  await fs.writeFile(path.join(f.runDirectory, 'reference.wav'), 'different speaker');
  [adapter] = await f.service.discoverAdapters();
  assert.equal(adapter.listeningStatus, 'pending');
  assert.deepEqual(await fs.readFile(f.profilePath), afterPreview);
});

test('프로필 preview 항목 없는 시험 음성도 생성 metadata의 음성 해시에 묶는다', async t => {
  const f = await fixture(t);
  const profile = await f.readProfile();
  const metadata = { audioSha256: f.previewAudioSha256, adapter: { scale: 0.6,
    weightsSha256: profile.preview.adapterWeightsSha256, configSha256: profile.preview.adapterConfigSha256 } };
  delete profile.preview;
  await fs.writeFile(f.profilePath, JSON.stringify(profile));
  const fallback = path.join(f.runDirectory, 'preview.wav');
  await fs.copyFile(f.previewPath, fallback);
  await fs.writeFile(path.join(f.runDirectory, 'preview.json'), JSON.stringify(metadata));
  assert.ok((await f.service.discoverAdapters())[0].previewUrl);
  await fs.writeFile(fallback, 'different recording presented as the sample');
  assert.equal((await f.service.discoverAdapters())[0].previewUrl, null);
});

test('새 참조의 강도를 승인해도 참조 증거 없는 과거 강도는 새 참조의 승인을 상속하지 않는다', async t => {
  const f = await fixture(t);
  const profile = await f.readProfile();
  profile.listeningStatus = 'approved';
  profile.listeningApproval = { status: 'approved', adapterScale: 0.6, audioSha256: 'unbound-old-sample',
    adapterWeightsSha256: profile.preview.adapterWeightsSha256, adapterConfigSha256: profile.preview.adapterConfigSha256 };
  await fs.writeFile(path.join(f.runDirectory, 'reference.wav'), 'new representative recording');
  await fs.writeFile(path.join(f.runDirectory, 'reference.txt'), '새 대표 녹음의 전사입니다.');
  profile.preview = { audioPath: f.previewPath, audioSha256: f.previewAudioSha256, scale: 0.7,
    ...await voiceInputIdentity(f.adapterPath, { referenceAudioPath: path.join(f.runDirectory, 'reference.wav'), referenceTextPath: path.join(f.runDirectory, 'reference.txt') }) };
  await fs.writeFile(f.profilePath, JSON.stringify(profile));
  assert.equal((await f.service.discoverAdapters())[0].listeningStatus, 'pending');
  const saved = await f.service.saveAppSettings({ adapterId: f.adapterId, adapterScale: 0.7,
    listeningApproval: { audioSha256: f.previewAudioSha256 } });
  assert.deepEqual(saved.adapters[0].approvedScales, [0.7]);
  assert.throws(() => f.service.applyVoiceSettings({}, { ...saved, adapterScale: 0.6 }), /듣고 확인/);
  assert.equal(f.service.applyVoiceSettings({}, saved).adapterScale, 0.7);
  await assert.rejects(f.service.saveAppSettings({ adapterScale: 0.6 }), /듣고 확인/);
});

test('참조 증거 없는 과거 시험 음성은 현재 프로필의 참조 지문으로 보충해 승인하지 않는다', async t => {
  const f = await fixture(t, { status: 'approved', profile: { approvedScale: 0.6 } });
  const profile = await f.readProfile();
  profile.referenceAudioSha256 = profile.listeningApproval.referenceAudioSha256;
  profile.referenceTextSha256 = profile.listeningApproval.referenceTextSha256;
  delete profile.preview.referenceAudioSha256; delete profile.preview.referenceTextSha256;
  profile.preview.scale = 0.7;
  await fs.writeFile(f.profilePath, JSON.stringify(profile));
  const before = await fs.readFile(f.profilePath);
  assert.deepEqual((await f.service.discoverAdapters())[0].approvedScales, [0.6]);
  await assert.rejects(f.service.saveAppSettings({ adapterId: f.adapterId, adapterScale: 0.7,
    listeningApproval: { audioSha256: f.previewAudioSha256 } }), /확인 기록이 없습니다/);
  assert.deepEqual(await fs.readFile(f.profilePath), before);
});
