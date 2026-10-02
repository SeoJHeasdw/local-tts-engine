import fs from 'node:fs/promises';
import { ROOT } from './paths.mjs';
import { legacyVoiceForRoot } from './legacy-voice.mjs';

export const LEGACY_VOICE = Object.freeze(legacyVoiceForRoot(ROOT));

export async function readTrainingConfig(configPath = new URL('../../config/voice-training.json', import.meta.url)) {
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  if (config.schemaVersion !== 1 || !config.model || !config.transcriptionModel || !config.comparisonModel
      || !config.preview?.text?.trim()) throw new Error('목소리 학습 설정이 올바르지 않습니다.');
  const positive = [config.training?.rank, config.training?.alpha, config.training?.gradientAccumulation,
    config.training?.learningRate, config.training?.maxSequenceLength];
  const nonnegative = [config.training?.warmupSteps, config.training?.seed, config.preview?.seed];
  if (positive.some(value => !Number.isFinite(value) || value <= 0)
      || nonnegative.some(value => !Number.isInteger(value) || value < 0)
      || !Number.isFinite(config.training?.weightDecay) || config.training.weightDecay < 0
      || !Number.isFinite(config.preview.scale) || config.preview.scale <= 0 || config.preview.scale > 1) {
    throw new Error('목소리 학습 설정의 수치가 올바르지 않습니다.');
  }
  return config;
}

export function trainingArguments(config) {
  const fields = { rank: '--rank', alpha: '--alpha', gradientAccumulation: '--gradient-accumulation',
    learningRate: '--learning-rate', weightDecay: '--weight-decay', maxSequenceLength: '--max-seq-length',
    warmupSteps: '--warmup-steps', seed: '--seed' };
  return Object.entries(fields).flatMap(([key, flag]) => [flag, String(config.training[key])]);
}
