import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { dateFolder } from './paths.mjs';
import { fileSha256 } from './files.mjs';
import { readTrainingConfig } from './training-config.mjs';
import { inspectCachedModel } from './voice-readiness.mjs';
import { readVoiceProfile, writeVoiceProfile, voiceInputIdentity, voiceInputMatches } from './voice-profile.mjs';

export function createVoicePreviewService({ readAppSettings, requireRuntimeTool, runProcess, emit, state,
  inspectModel = inspectCachedModel }) {
  async function runVoicePreview(options) {
    const settings = await readAppSettings();
    const adapter = settings.adapters.find(item => item.id === options.adapterId);
    if (!adapter || adapter.profileError || !adapter.referencePaths) throw new Error('사용할 수 있는 목소리를 먼저 골라 주세요.');
    const scale = Number(options.adapterScale);
    if (!Number.isFinite(scale) || scale < 0.1 || scale > 1) throw new Error('반영 강도는 0.10~1.00 사이여야 합니다.');
    const config = await readTrainingConfig();
    const model = await inspectModel(config.model);
    if (model.state !== 'ready') throw new Error('시험 음성에 필요한 로컬 모델이 없습니다. 목소리의 제작 준비 상태를 확인하세요.');
    const output = path.join(settings.paths.voiceOutputRoot, dateFolder(), `profile-preview-${crypto.randomUUID()}`);
    await fs.mkdir(output, { recursive: true });
    const text = path.join(output, 'text.txt'), audio = path.join(output, 'preview.wav');
    await fs.writeFile(text, config.preview.text, 'utf8');
    const refs = adapter.referencePaths;
    const identity = await voiceInputIdentity(adapter.path, refs);
    await runProcess('voice', requireRuntimeTool('trainPython', '목소리 제작 도구'),
      ['-m', 'local_tts_engine.text_candidate', '--model-path', model.path,
        '--text-file', text, '--reference', refs.referenceAudioPath, '--reference-text', refs.referenceTextPath,
        '--adapter', adapter.path, '--adapter-scale', String(scale), '--output', audio,
        '--metadata', path.join(output, 'preview.json'), '--seed', String(config.preview.seed),
        '--quality-review', '--quality-attempts', String(config.comparison.qualityAttempts)]);
    if (state.activeJob.cancelled) throw new Error('시험 음성 만들기를 중지했습니다.');
    if (!voiceInputMatches(identity, await voiceInputIdentity(adapter.path, refs))) {
      throw new Error('시험 음성을 만드는 동안 목소리 파일·대표 녹음·전사가 바뀌었습니다. 다시 만들어 주세요.');
    }
    const runDirectory = path.dirname(adapter.path);
    let profile;
    try { ({ profile } = await readVoiceProfile(runDirectory)); }
    catch (error) {
      if (error.code !== 'ENOENT' || !adapter.legacy) throw error;
      profile = { schemaVersion: 1, displayName: adapter.displayName, trainingStatus: 'complete',
        listeningStatus: adapter.listeningStatus, approvedScale: adapter.approvedScale,
        referenceAudioPath: refs.referenceAudioPath, referenceTextPath: refs.referenceTextPath };
    }
    const preview = { audioPath: audio, audioSha256: await fileSha256(audio), scale,
      ...identity,
      generatedAt: new Date().toISOString() };
    await writeVoiceProfile(runDirectory, { ...profile, preview });
    state.activeJob.state = 'done';
    state.activeJob.stage = 'done';
    emit({ type: 'voice-profile-preview-ready', adapterId: adapter.id, previewUrl: pathToFileURL(audio).href,
      previewScale: scale, settings: await readAppSettings() });
  }
  return { runVoicePreview };
}
