import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertVoiceAssetsReady, inspectCachedModel, inspectVoiceReadiness, localVoiceEnvironment } from '../../electron-app/main/voice-readiness.mjs';
import { createRuntimeService } from '../../electron-app/main/runtime.mjs';

async function put(file, value = 'data') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
}

test('모델 준비 검사는 실제 가중치를 확인하고 다운로드하지 않는다', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-readiness-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const hub = path.join(root, 'hub');
  const repo = 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16';
  const snapshot = path.join(hub, `models--${repo.replaceAll('/', '--')}`, 'snapshots', 'revision-1');
  const options = { env: { HF_HUB_CACHE: hub }, home: root };

  assert.equal((await inspectCachedModel(repo, options)).state, 'missing');
  await put(path.join(snapshot, 'config.json'), '{}');
  assert.equal((await inspectCachedModel(repo, options)).state, 'incomplete');
  await put(path.join(snapshot, 'model.safetensors'));
  assert.equal((await inspectCachedModel(repo, options)).state, 'incomplete', '텍스트·음성 토크나이저 없이 준비됐다고 할 수 없다');
  for (const file of ['tokenizer_config.json', 'vocab.json', 'merges.txt',
    'speech_tokenizer/config.json', 'speech_tokenizer/model.safetensors']) await put(path.join(snapshot, file));
  assert.equal((await inspectCachedModel(repo, options)).state, 'ready');
  await fs.writeFile(path.join(snapshot, 'model.safetensors'), '');
  assert.equal((await inspectCachedModel(repo, options)).state, 'incomplete');
});

test('분할 가중치 하나라도 비어 있으면 모델 파일을 준비됐다고 표시하지 않는다', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-shards-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = 'example/tts';
  const snapshot = path.join(root, 'hub', 'models--example--tts', 'snapshots', 'a');
  await put(path.join(snapshot, 'config.json'), '{}');
  await put(path.join(snapshot, 'model.safetensors.index.json'), JSON.stringify({ weight_map: {
    first: 'part-1.safetensors', second: 'part-2.safetensors',
  } }));
  await put(path.join(snapshot, 'part-1.safetensors'));
  const options = { env: { HF_HUB_CACHE: path.join(root, 'hub') }, home: root };
  assert.equal((await inspectCachedModel(repo, options)).state, 'incomplete');
  await put(path.join(snapshot, 'part-2.safetensors'));
  assert.equal((await inspectCachedModel(repo, options)).state, 'ready');
});

test('Python이 먼저 고를 main snapshot이 불완전하면 오래된 완전본으로 통과시키지 않는다', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-main-ref-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = 'example/tts';
  const cache = path.join(root, 'hub', 'models--example--tts');
  const old = path.join(cache, 'snapshots', 'old'), current = path.join(cache, 'snapshots', 'current');
  await put(path.join(old, 'config.json'), '{}');
  await put(path.join(old, 'model.safetensors'));
  await put(path.join(current, 'config.json'), '{}');
  await put(path.join(cache, 'refs', 'main'), 'current');
  assert.equal((await inspectCachedModel(repo, { env: { HF_HUB_CACHE: path.join(root, 'hub') }, home: root })).state,
    'incomplete');
});

test('참조 전사문과 Chatterbox 부속 토크나이저 상태를 별도로 확인한다', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-inputs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const audio = path.join(root, 'reference.wav'), transcript = path.join(root, 'reference.txt');
  await put(audio);
  await put(transcript, '   \n');
  const studio = { referenceAudioPath: audio, referenceTextPath: transcript };
  const settings = { modelId: 'chatterbox-v3', adapterId: 'none', adapters: [] };
  const options = { root, env: { HF_HUB_CACHE: path.join(root, 'hub') }, home: root };
  let readiness = await inspectVoiceReadiness(settings, studio, options);
  assert.equal(readiness.referenceAudio.state, 'ready');
  assert.equal(readiness.referenceText.state, 'incomplete');
  assert.equal(readiness.models['chatterbox-v3'].state, 'missing');
  assert.equal(readiness.adapter.state, 'unused');

  const model = path.join(root, 'hub', 'models--mlx-community--chatterbox-multilingual-v3', 'snapshots', 'a');
  await put(path.join(model, 'config.json'), '{}');
  await put(path.join(model, 'model.safetensors'));
  await put(path.join(model, 'tokenizer.json'));
  await put(path.join(model, 'Cangjie5_TC.json'));
  readiness = await inspectVoiceReadiness(settings, studio, options);
  assert.equal(readiness.models['chatterbox-v3'].state, 'missing', '부속 토크나이저 없는 모델은 준비된 것이 아니다');
  assert.match(readiness.models['chatterbox-v3'].detail, /S3TokenizerV2/);
});

test('제작 시작 전 모델 자동 다운로드를 막고 용량과 목적을 알린다', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-start-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const audio = path.join(root, 'reference.wav'), transcript = path.join(root, 'reference.txt');
  await put(audio);
  await put(transcript, '정확한 참조 전사');
  const settings = { modelId: 'qwen3-tts', adapterId: 'none', adapters: [] };
  const studio = { referenceAudioPath: audio, referenceTextPath: transcript };
  const dependencies = { root, env: { HF_HUB_CACHE: path.join(root, 'hub') }, home: root };
  await assert.rejects(assertVoiceAssetsReady(settings, studio, { quality: false }, dependencies),
    /음성 모델.*약 4 GB.*자동 다운로드/);
  const snapshot = path.join(root, 'hub', 'models--mlx-community--Qwen3-TTS-12Hz-1.7B-Base-bf16', 'snapshots', 'a');
  await put(path.join(snapshot, 'config.json'), '{}');
  await put(path.join(snapshot, 'model.safetensors'));
  for (const file of ['tokenizer_config.json', 'vocab.json', 'merges.txt',
    'speech_tokenizer/config.json', 'speech_tokenizer/model.safetensors']) await put(path.join(snapshot, file));
  await assert.rejects(assertVoiceAssetsReady(settings, studio, { quality: true }, dependencies),
    /Whisper 자동 음성 검수 모델.*약 1.7 GB.*자동 다운로드/);
});

test('Whisper 가중치만 남은 캐시는 자동 검수 준비 상태가 아니다', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-whisper-support-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = 'mlx-community/whisper-large-v3-turbo-asr-fp16';
  const snapshot = path.join(root, 'hub', `models--${repo.replaceAll('/', '--')}`, 'snapshots', 'a');
  await put(path.join(snapshot, 'config.json'), '{}');
  await put(path.join(snapshot, 'model.safetensors'));
  const options = { env: { HF_HUB_CACHE: path.join(root, 'hub') }, home: root };
  assert.equal((await inspectCachedModel(repo, options)).state, 'incomplete');
  await put(path.join(snapshot, 'tokenizer.json'));
  await put(path.join(snapshot, 'tokenizer_config.json'));
  await put(path.join(snapshot, 'preprocessor_config.json'));
  assert.equal((await inspectCachedModel(repo, options)).state, 'ready');
  await fs.unlink(path.join(snapshot, 'tokenizer.json'));
  await put(path.join(snapshot, 'vocab.json'));
  await put(path.join(snapshot, 'merges.txt'));
  assert.equal((await inspectCachedModel(repo, options)).state, 'ready', 'Whisper의 분리된 텍스트 토크나이저도 허용한다');
});

test('Chatterbox 부속 토크나이저는 오프라인 snapshot_download가 읽을 main 참조가 있어야 한다', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-s3-main-ref-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = 'mlx-community/S3TokenizerV2';
  const cache = path.join(root, 'hub', `models--${repo.replaceAll('/', '--')}`);
  const snapshot = path.join(cache, 'snapshots', 'revision-a');
  await put(path.join(snapshot, 'config.json'), '{}');
  await put(path.join(snapshot, 'model.safetensors'));
  const options = { env: { HF_HUB_CACHE: path.join(root, 'hub') }, home: root, requireMainRef: true };
  assert.equal((await inspectCachedModel(repo, options)).state, 'incomplete');
  await put(path.join(cache, 'refs', 'main'), 'revision-a');
  assert.equal((await inspectCachedModel(repo, options)).state, 'ready');
});

test('음성 생성 자식 프로세스만 Hugging Face 캐시를 오프라인으로 사용한다', async () => {
  const original = { HF_HUB_OFFLINE: '0', ALL_PROXY: 'socks5://example.invalid:1080' };
  const scoped = localVoiceEnvironment(original);
  assert.equal(scoped.HF_HUB_OFFLINE, '1');
  assert.equal('ALL_PROXY' in scoped, false);
  assert.equal(original.HF_HUB_OFFLINE, '0', '부모 환경과 설치 도구의 환경을 바꾸지 않는다');

  const job = { state: 'running', cancelled: false, children: new Set(), stage: null };
  const runtime = createRuntimeService({ state: { activeJob: job, runtimeTools: {} } });
  const childCode = 'process.stdout.write(JSON.stringify({ offline: process.env.HF_HUB_OFFLINE || "", proxy: "ALL_PROXY" in process.env }) + "\\n")';
  const voice = JSON.parse(await runtime.runProcess('voice', process.execPath, ['-e', childCode], { capture: true }));
  assert.deepEqual(voice, { offline: '1', proxy: false });
  const training = JSON.parse(await runtime.runProcess('training', process.execPath, ['-e', childCode], { capture: true }));
  assert.equal(training.offline, process.env.HF_HUB_OFFLINE || '', '학습 등 별도 작업에는 오프라인 설정을 강제로 넣지 않는다');
});

test('앱 생성 시작 검사는 모델 준비 실패를 Python 실행 전에 돌려준다', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-gate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const audio = path.join(root, 'reference.wav'), transcript = path.join(root, 'reference.txt');
  await put(audio);
  await put(transcript, '전사');
  let checked = false;
  const runtime = createRuntimeService({
    state: { runtimeTools: { trainPython: process.execPath } },
    assertVoiceReady: async (_settings, _studio, requirements) => {
      checked = true;
      assert.deepEqual(requirements, { quality: true, aligner: false });
      throw new Error('선택 모델 파일 없음');
    },
  });
  await assert.rejects(runtime.assertRuntime({ modelId: 'qwen3-tts', voiceMode: 'zero' },
    { referenceAudioPath: audio, referenceTextPath: transcript }, { course: false, ffprobe: false }),
  /선택 모델 파일 없음/);
  assert.equal(checked, true);
});
