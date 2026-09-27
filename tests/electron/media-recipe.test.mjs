import test from 'node:test';
import assert from 'node:assert/strict';
import { recipeFromManifest } from '../../electron-app/main/media.mjs';

test('영상이 가리키는 바로 그 음성 manifest만 제작 기록으로 보여 준다', () => {
  const manifest = { audioPath: '/tmp/source.wav', model: 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16',
    modelRevision: 'revision-123', adapter: { path: '/tmp/jaeho-ko-r16-v1/adapters', scale: .6 },
    quality: { enabled: true, model: 'mlx-community/whisper-large-v3-turbo-asr-fp16', maxAttempts: 4 },
    aligner: { model: 'mlx-community/Qwen3-ForcedAligner-0.6B-8bit' } };
  assert.deepEqual(recipeFromManifest(manifest, { audioPath: '/tmp/source.wav' }), {
    model: manifest.model, modelRevision: 'revision-123', adapter: 'jaeho-ko-r16-v1', adapterScale: .6,
    qualityModel: manifest.quality.model, maxAttempts: 4, aligner: manifest.aligner.model,
  });
  assert.equal(recipeFromManifest(manifest, { audioPath: '/tmp/replacement.wav' }), null);
  assert.equal(recipeFromManifest({}, { audioPath: '/tmp/source.wav' }), null);
});
