import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createVoicePreviewService } from '../../electron-app/main/voice-preview.mjs';
import { createSettingsService } from '../../electron-app/main/settings.mjs';
import { readVoiceProfile, writeVoiceProfile } from '../../electron-app/main/voice-profile.mjs';
import { readTrainingConfig } from '../../electron-app/main/training-config.mjs';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');

async function put(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
}

async function fixture(t, { legacy = false, modelState = 'ready', generate } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-preview-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const adapterRoot = path.join(root, 'runs');
  const settingsPath = path.join(root, 'app-settings.json');
  const alphaId = '2099-01-01/speaker-alpha', betaId = '2099-01-01/speaker-beta';
  const alphaRun = path.join(adapterRoot, alphaId), betaRun = path.join(adapterRoot, betaId);
  for (const [run, name] of [[alphaRun, '현재 목소리'], [betaRun, '시험할 목소리']]) {
    await put(path.join(run, 'adapters', 'adapters.safetensors'), `weights ${name}`);
    await put(path.join(run, 'adapters', 'adapter_config.json'), JSON.stringify({ voice: name }));
    await put(path.join(run, 'reference.wav'), `reference ${name}`);
    await put(path.join(run, 'reference.txt'), `${name}의 대표 녹음 전사`);
    await put(path.join(run, 'preview.wav'), `original sample ${name}`);
  }
  await writeVoiceProfile(alphaRun, { schemaVersion: 1, displayName: '현재 목소리',
    trainingStatus: 'complete', listeningStatus: 'approved', approvedScale: 0.6,
    referenceAudioPath: 'reference.wav', referenceTextPath: 'reference.txt' });
  if (!legacy) {
    await writeVoiceProfile(betaRun, { schemaVersion: 1, displayName: '시험할 목소리', datasetId: 'beta-dataset',
      trainingStatus: 'complete', listeningStatus: 'pending', referenceAudioPath: 'reference.wav',
      referenceTextPath: 'reference.txt', preview: { audioPath: 'preview.wav', scale: 0.6,
        audioSha256: digest(await fs.readFile(path.join(betaRun, 'preview.wav'))) } });
  }
  const outputRoot = path.join(root, 'output');
  await put(settingsPath, JSON.stringify({ modelId: 'qwen3-tts', adapterId: alphaId, adapterScale: 0.6,
    paths: { outputRoot, voiceLibraryRoot: path.join(root, 'voice-library') } }));
  const legacyVoice = { adapterId: betaId, displayName: '기존 승인 목소리', adapterScale: 0.6,
    listeningStatus: 'approved', referenceAudioPath: path.join(betaRun, 'reference.wav'),
    referenceTextPath: path.join(betaRun, 'reference.txt') };
  const settings = createSettingsService({ state: {}, adapterRoot, settingsPath,
    ...(legacy ? { legacyVoice } : {}) });
  const state = { activeJob: { kind: 'training', state: 'running', stage: 'voice', cancelled: false } };
  const calls = [], events = [], inspections = [];
  const service = createVoicePreviewService({ state, readAppSettings: settings.readAppSettings,
    requireRuntimeTool: key => { assert.equal(key, 'trainPython'); return 'fixture-python'; },
    inspectModel: async repository => { inspections.push(repository); return { state: modelState, path: path.join(root, 'installed-base') }; },
    emit: event => events.push(event), runProcess: async (stage, executable, args) => {
      calls.push({ stage, executable, args });
      const audio = args[args.indexOf('--output') + 1];
      await fs.writeFile(audio, `new preview at ${args[args.indexOf('--adapter-scale') + 1]}`);
      await fs.writeFile(args[args.indexOf('--metadata') + 1], JSON.stringify({ audioSha256: digest(await fs.readFile(audio)) }));
      if (generate) await generate({ stage, executable, args, state });
    } });
  return { root, alphaId, betaId, alphaRun, betaRun, settingsPath, settings, service, calls, events, inspections, state };
}

test('새 강도의 시험 음성은 새 위치에 저장하고 기존 샘플과 제작 목소리를 보존한다', async t => {
  const f = await fixture(t);
  const savedSettings = await fs.readFile(f.settingsPath);
  const oldSample = await fs.readFile(path.join(f.betaRun, 'preview.wav'));
  const oldReference = await fs.readFile(path.join(f.betaRun, 'reference.wav'));
  const oldWeights = await fs.readFile(path.join(f.betaRun, 'adapters', 'adapters.safetensors'));
  const { profile: before } = await readVoiceProfile(f.betaRun);
  const config = await readTrainingConfig();

  await f.service.runVoicePreview({ adapterId: f.betaId, adapterScale: 0.72 });

  assert.deepEqual(await fs.readFile(f.settingsPath), savedSettings);
  assert.deepEqual(await fs.readFile(path.join(f.betaRun, 'preview.wav')), oldSample);
  assert.deepEqual(await fs.readFile(path.join(f.betaRun, 'reference.wav')), oldReference);
  assert.deepEqual(await fs.readFile(path.join(f.betaRun, 'adapters', 'adapters.safetensors')), oldWeights);
  assert.equal((await f.settings.readAppSettings()).adapterId, f.alphaId);
  assert.equal((await f.settings.readAppSettings()).adapterScale, 0.6);
  const { profile: after } = await readVoiceProfile(f.betaRun);
  const { preview: _oldPreview, ...previousProfile } = before;
  const { preview, ...updatedProfile } = after;
  assert.deepEqual(updatedProfile, previousProfile);
  assert.equal(after.listeningStatus, 'pending', '시험 음성을 만드는 것만으로 청취 승인하지 않는다');
  assert.equal(preview.scale, 0.72);
  assert.equal(preview.audioSha256, digest(await fs.readFile(preview.audioPath)));
  assert.equal(preview.adapterWeightsSha256, digest(oldWeights));
  assert.equal(preview.adapterConfigSha256, digest(await fs.readFile(path.join(f.betaRun, 'adapters', 'adapter_config.json'))));
  assert.ok(Number.isFinite(Date.parse(preview.generatedAt)));
  assert.match(path.basename(path.dirname(preview.audioPath)), /^profile-preview-[0-9a-f-]+$/);
  const current = await f.settings.readAppSettings();
  assert.ok(preview.audioPath.startsWith(`${current.paths.voiceOutputRoot}${path.sep}`));
  assert.notEqual(preview.audioPath, path.join(f.betaRun, 'preview.wav'));
  assert.equal(f.calls.length, 1);
  const call = f.calls[0], value = flag => call.args[call.args.indexOf(flag) + 1];
  assert.equal(call.stage, 'voice');
  assert.equal(call.executable, 'fixture-python');
  assert.deepEqual(call.args.slice(0, 2), ['-m', 'local_tts_engine.text_candidate']);
  assert.equal(value('--reference'), path.join(f.betaRun, 'reference.wav'));
  assert.equal(value('--reference-text'), path.join(f.betaRun, 'reference.txt'));
  assert.equal(value('--adapter'), path.join(f.betaRun, 'adapters'));
  assert.equal(value('--adapter-scale'), '0.72');
  assert.equal(value('--model-path'), path.join(f.root, 'installed-base'));
  assert.equal(value('--quality-attempts'), String(config.comparison.qualityAttempts));
  assert.ok(call.args.includes('--quality-review'));
  assert.deepEqual(f.inspections, [config.model]);
  assert.equal(await fs.readFile(value('--text-file'), 'utf8'), config.preview.text);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].type, 'voice-profile-preview-ready');
  assert.equal(f.events[0].adapterId, f.betaId);
  assert.equal(fileURLToPath(f.events[0].previewUrl), preview.audioPath);
  assert.equal(f.events[0].previewScale, 0.72);
  assert.equal(f.events[0].settings.adapterId, f.alphaId);
  assert.equal(f.state.activeJob.state, 'done');
});

test('잘못된 강도와 사용할 수 없는 프로필은 생성이나 프로필 변경 전에 거절한다', async t => {
  const f = await fixture(t);
  const originalProfile = await fs.readFile(path.join(f.betaRun, 'voice-profile.json'));
  for (const adapterScale of [0, 0.09, 1.01, NaN, Infinity, undefined]) {
    await assert.rejects(f.service.runVoicePreview({ adapterId: f.betaId, adapterScale }), /반영 강도/);
  }
  await assert.rejects(f.service.runVoicePreview({ adapterId: 'missing', adapterScale: 0.6 }), /목소리/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await fs.readFile(path.join(f.betaRun, 'voice-profile.json')), originalProfile);
});

test('로컬 모델이 없으면 내려받지 않고 기존 프로필·설정·샘플을 보존한다', async t => {
  const f = await fixture(t, { modelState: 'missing' });
  const oldProfile = await fs.readFile(path.join(f.betaRun, 'voice-profile.json'));
  const oldSettings = await fs.readFile(f.settingsPath);

  await assert.rejects(f.service.runVoicePreview({ adapterId: f.betaId, adapterScale: 0.6 }), /로컬 모델/);

  assert.equal(f.calls.length, 0);
  assert.equal(f.events.length, 0);
  assert.deepEqual(await fs.readFile(path.join(f.betaRun, 'voice-profile.json')), oldProfile);
  assert.deepEqual(await fs.readFile(f.settingsPath), oldSettings);
  await assert.rejects(fs.stat((await f.settings.readAppSettings()).paths.voiceOutputRoot), { code: 'ENOENT' });
});

test('프로필 없는 기존 승인 목소리의 시험 음성을 만들어도 기존 승인·참조·샘플을 보존한다', async t => {
  const f = await fixture(t, { legacy: true });
  const oldSample = await fs.readFile(path.join(f.betaRun, 'preview.wav'));
  const oldSettings = await fs.readFile(f.settingsPath);
  await assert.rejects(fs.stat(path.join(f.betaRun, 'voice-profile.json')), { code: 'ENOENT' });

  await f.service.runVoicePreview({ adapterId: f.betaId, adapterScale: 0.67 });

  const { profile, referencePaths } = await readVoiceProfile(f.betaRun);
  assert.equal(profile.displayName, '기존 승인 목소리');
  assert.equal(profile.listeningStatus, 'approved');
  assert.equal(profile.approvedScale, 0.6);
  assert.equal(profile.preview.scale, 0.67);
  assert.equal(referencePaths.referenceAudioPath, path.join(f.betaRun, 'reference.wav'));
  assert.deepEqual(await fs.readFile(path.join(f.betaRun, 'preview.wav')), oldSample);
  assert.deepEqual(await fs.readFile(f.settingsPath), oldSettings);
  const adapter = (await f.settings.readAppSettings()).adapters.find(item => item.id === f.betaId);
  assert.deepEqual(adapter.approvedScales, [0.6]);
  assert.equal(adapter.previewScale, 0.67);
});

test('시험 음성 생성의 실패·취소는 기존 프로필의 시험 음성 기록을 바꾸지 않는다', async t => {
  for (const cancelled of [false, true]) {
    const f = await fixture(t, { generate: async ({ state }) => {
      if (cancelled) state.activeJob.cancelled = true;
      else throw new Error('fixture generation failure');
    } });
    const oldProfile = await fs.readFile(path.join(f.betaRun, 'voice-profile.json'));
    const oldSettings = await fs.readFile(f.settingsPath);
    const oldSample = await fs.readFile(path.join(f.betaRun, 'preview.wav'));

    await assert.rejects(f.service.runVoicePreview({ adapterId: f.betaId, adapterScale: 0.6 }),
      cancelled ? /중지/ : /generation failure/);

    assert.deepEqual(await fs.readFile(path.join(f.betaRun, 'voice-profile.json')), oldProfile);
    assert.deepEqual(await fs.readFile(f.settingsPath), oldSettings);
    assert.deepEqual(await fs.readFile(path.join(f.betaRun, 'preview.wav')), oldSample);
    assert.equal(f.events.length, 0);
  }
});
