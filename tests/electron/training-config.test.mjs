import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTrainingService } from '../../electron-app/main/training.mjs';
import { readTrainingConfig, LEGACY_VOICE } from '../../electron-app/main/training-config.mjs';

async function put(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-training-config-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const datasetRoot = path.join(root, 'datasets'), runRoot = path.join(root, 'runs');
  const config = await readTrainingConfig();
  config.training = { ...config.training, rank: 8, alpha: 12, warmupSteps: 3, seed: 1234 };
  config.preview = { text: '설정에서 선택한 공통 시험 문장입니다.\n', scale: 0.7, seed: 4321 };
  const trainingConfigPath = path.join(root, 'config.json');
  await put(trainingConfigPath, JSON.stringify(config));
  const calls = [], events = [], models = [];
  const legacyVoice = { ...LEGACY_VOICE, datasetId: 'previous-speaker',
    trainJsonl: path.join(root, 'previous-train.jsonl'),
    referenceAudioPath: path.join(root, 'previous-reference.wav'),
    referenceTextPath: path.join(root, 'previous-reference.txt') };
  const settings = { adapterId: 'another-person', adapters: [],
    paths: { referenceAudioPath: '/wrong-person.wav', referenceTextPath: '/wrong-person.txt' } };
  const service = createTrainingService({ datasetRoot, runRoot, trainingConfigPath, legacyVoice,
    state: { activeJob: { state: 'running' } }, emit: event => events.push(event),
    readAppSettings: async () => settings, requireRuntimeTool: () => 'python',
    inspectModel: async (repository, options) => {
      models.push({ repository, options });
      return { state: 'ready', path: '/installed/base' };
    },
    runProcess: async (stage, executable, args) => {
      calls.push(args);
      const value = flag => args[args.indexOf(flag) + 1];
      if (args.includes('export')) await put(path.join(value('--dataset-dir'), 'official/train_raw.jsonl'), '{"text":"accepted"}\n');
      if (args.includes('local_tts_engine.finetune_mlx')) {
        await put(path.join(value('--output-dir'), 'training-result.json'), '{"status":"complete"}');
        await put(path.join(value('--output-dir'), 'adapters', 'adapters.safetensors'), 'trained weights');
        await put(path.join(value('--output-dir'), 'adapters', 'adapter_config.json'), '{"rank":8}');
      }
      if (args.includes('local_tts_engine.text_candidate')) await put(value('--output'), 'preview');
    } });
  return { root, datasetRoot, config, trainingConfigPath, legacyVoice, service, calls, events, models, settings };
}

test('새 사람은 공통 설정과 자기 데이터로 학습하고 학습 목록을 실행별로 고정한다', async t => {
  const f = await fixture(t);
  const directory = path.join(f.datasetRoot, 'new-speaker');
  const rows = [];
  for (let index = 0; index < 3; index++) {
    const audio = path.join(directory, 'clips', `${index}.wav`);
    await put(audio, `voice ${index}`);
    rows.push({ id: `clip-${index}`, audio, text: `문장 ${index}`, durationMs: 8000 });
  }
  await put(path.join(directory, 'manifest.json'), JSON.stringify({ stats: { clips: 3 } }));
  await put(path.join(directory, 'metadata.jsonl'), rows.map(JSON.stringify).join('\n'));
  assert.equal((await f.service.listTrainingDatasets())[0].displayName, 'new-speaker');
  await f.service.runFineTune({ datasetId: 'new-speaker', name: 'new-speaker-run', displayName: '새 화자',
    maxSteps: 20, referenceId: rows[1].id, reviews: rows.map(row => ({ ...row, accepted: true })) });
  const train = f.calls.find(args => args.includes('local_tts_engine.finetune_mlx'));
  const value = flag => train[train.indexOf(flag) + 1];
  const output = value('--output-dir');
  assert.equal(value('--rank'), '8');
  assert.equal(value('--alpha'), '12');
  assert.equal(value('--seed'), '1234');
  assert.equal(value('--warmup-steps'), '3');
  assert.equal(value('--train-jsonl'), path.join(output, 'train_raw.jsonl'));
  await put(path.join(directory, 'official/train_raw.jsonl'), 'a later export');
  assert.equal(await fs.readFile(value('--train-jsonl'), 'utf8'), '{"text":"accepted"}\n');
  const profile = JSON.parse(await fs.readFile(path.join(output, 'voice-profile.json'), 'utf8'));
  assert.equal(profile.datasetId, 'new-speaker');
  assert.equal(profile.displayName, '새 화자');
  assert.equal(profile.trainJsonl, 'train_raw.jsonl');
  assert.match(profile.trainJsonlSha256, /^[a-f0-9]{64}$/);
  assert.equal(profile.listeningStatus, 'pending');
  assert.equal(await fs.readFile(path.join(output, 'preview-text.txt'), 'utf8'), f.config.preview.text);
  const preview = f.calls.find(args => args.includes('local_tts_engine.text_candidate'));
  assert.equal(preview[preview.indexOf('--adapter-scale') + 1], '0.7');
  assert.equal(preview[preview.indexOf('--model-path') + 1], value('--model'));
  assert.equal(f.events.at(-1).previewScale, 0.7);
  assert.equal(f.settings.adapterId, 'another-person');
});

test('이전 데이터의 참조가 없으면 현재 선택된 다른 사람의 참조를 대신 쓰지 않는다', async t => {
  const f = await fixture(t);
  const directory = path.join(f.datasetRoot, f.legacyVoice.datasetId);
  await put(path.join(directory, 'manifest.json'), '{}');
  await put(path.join(directory, 'metadata.jsonl'), '{"text":"검수 완료"}\n');
  await put(f.legacyVoice.trainJsonl, '{"text":"기존 학습"}\n');
  const options = { datasetId: f.legacyVoice.datasetId, name: 'missing-reference', maxSteps: 20, paths: f.settings.paths };
  await assert.rejects(f.service.runFineTune(options), /ENOENT/);
  assert.equal(f.calls.length, 0);
  await put(f.legacyVoice.referenceAudioPath, 'canonical voice');
  await put(f.legacyVoice.referenceTextPath, 'canonical transcript');
  await f.service.runFineTune({ ...options, name: 'bound-reference' });
  const train = f.calls.find(args => args.includes('local_tts_engine.finetune_mlx'));
  const audio = train[train.indexOf('--reference') + 1];
  assert.equal(await fs.readFile(audio, 'utf8'), 'canonical voice');
});
