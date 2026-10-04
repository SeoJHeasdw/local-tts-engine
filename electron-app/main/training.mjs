import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FINETUNE_DATASET_ROOT, FINETUNE_RUN_ROOT, ROOT, dateFolder } from './paths.mjs';
import { LEGACY_VOICE, readTrainingConfig, trainingArguments } from './training-config.mjs';
import { writeVoiceProfile, voiceInputIdentity, voiceInputMatches } from './voice-profile.mjs';
import { inspectCachedModel } from './voice-readiness.mjs';
import { fileSha256 } from './files.mjs';
import { isInside } from '../shared/index.mjs';
import crypto from 'node:crypto';

// A speaker owns a dataset, reference and adapter together. Never train a new
// speaker from the fixed personal dataset or activate an unheard checkpoint.
export function createTrainingService({ emit, readAppSettings, requireRuntimeTool, runProcess, state,
  datasetRoot = FINETUNE_DATASET_ROOT, runRoot = FINETUNE_RUN_ROOT, inspectModel = inspectCachedModel,
  trainingConfigPath, legacyVoice = LEGACY_VOICE }) {
  async function datasetDirectory(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) {
      throw new Error('학습 데이터를 골라 주세요.');
    }
    const directory = path.join(datasetRoot, id);
    const real = await fs.realpath(directory);
    if (!isInside(await fs.realpath(datasetRoot), real)) throw new Error('학습 데이터 경로가 저장소 밖입니다.');
    return directory;
  }

  async function listTrainingDatasets() {
    const entries = await fs.readdir(datasetRoot, { withFileTypes: true }).catch(() => []);
    const datasets = [];
    for (const entry of entries.filter(item => item.isDirectory())) {
      try {
        const directory = await datasetDirectory(entry.name);
        const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
        if (!(await fs.stat(path.join(directory, 'metadata.jsonl'))).isFile()) continue;
        datasets.push({ id: entry.name, displayName: manifest.displayName
          || (entry.name === legacyVoice.datasetId ? legacyVoice.displayName : entry.name),
          clips: manifest.stats?.clips || 0, transcribed: manifest.stats?.transcribed || 0 });
      } catch { /* unrelated or incomplete directories are not training choices */ }
    }
    return datasets.sort((a, b) => a.id.localeCompare(b.id));
  }

  async function readTrainingDataset(id) {
    const directory = await datasetDirectory(id);
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
    const rows = (await fs.readFile(path.join(directory, 'metadata.jsonl'), 'utf8'))
      .split(/\r?\n/).filter(Boolean).map(JSON.parse);
    if (id === legacyVoice.datasetId) return { id, displayName: manifest.displayName || legacyVoice.displayName, legacy: true, clips: [],
      referenceId: null, transcribed: rows.filter(row => row.text).length, total: rows.length };
    const seen = new Set();
    const report = await fs.readFile(path.join(directory, 'quality-review.json'), 'utf8').then(JSON.parse).catch(() => null);
    const reportClips = new Map((report?.clips || []).map(item => [item.id, item]));
    const clips = [];
    for (const row of rows) {
      if (!row.id || seen.has(row.id) || !isInside(await fs.realpath(directory), await fs.realpath(row.audio))) {
        throw new Error('학습 클립의 ID 또는 음성 경로가 잘못됐습니다.');
      }
      seen.add(row.id);
      const review = reportClips.get(row.id);
      const sourceText = row.asrText || row.text || '';
      const textHash = crypto.createHash('sha256').update(sourceText).digest('hex');
      const bound = review?.audioSha256 === await fileSha256(row.audio);
      const quality = bound ? { ...review,
        transcriptCurrent: review.sourceTranscriptSha256 === textHash,
        transcriptAgreement: review.sourceTranscriptSha256 === textHash ? review.transcriptAgreement : null,
      } : null;
      clips.push({ id: row.id, text: row.text || '', durationMs: row.durationMs, audioSha256: await fileSha256(row.audio),
        audioUrl: pathToFileURL(row.audio).href, accepted: row.reviewStatus === 'accepted', quality });
    }
    return { id, displayName: manifest.displayName || id, legacy: false,
      note: manifest.originalSource?.decodeNote || '',
      clips,
      qualityReviewed: clips.filter(clip => clip.quality?.transcriptCurrent && clip.quality?.independentModel && clip.quality?.independentText !== null).length,
      referenceId: manifest.referenceClipId || null,
      transcribed: rows.filter(row => row.text).length, total: rows.length };
  }

  async function cachedModel(repository, options) {
    const model = await inspectModel(repository, options);
    if (model.state !== 'ready') throw new Error('필요한 로컬 모델이 없습니다. 자동으로 내려받지 않습니다.');
    return model.path;
  }

  async function runFineTune(options) {
    if (typeof options.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(options.name)) {
      throw new Error('학습 결과 이름이 올바르지 않습니다.');
    }
    const directory = await datasetDirectory(options.datasetId);
    const config = await readTrainingConfig(trainingConfigPath);
    const python = requireRuntimeTool('trainPython', '음성 학습 Python');
    const datasetCommand = (...args) => runProcess('training', python,
      ['-m', 'local_tts_engine.finetune_dataset', ...args, '--dataset-dir', directory]);
    if (options.mode === 'prepare') {
      const reviewArgs = ['-m', 'local_tts_engine.finetune_review', '--dataset-dir', directory];
      await runProcess('training', python, reviewArgs);
      const asr = await cachedModel(config.transcriptionModel);
      await datasetCommand('transcribe', '--model', asr);
      const comparison = await cachedModel(config.comparisonModel,
        { localPath: config.comparisonModelPath ? path.resolve(ROOT, config.comparisonModelPath) : undefined });
      await runProcess('training', python, [...reviewArgs, '--comparison-model', comparison]);
      state.activeJob.state = 'done';
      state.activeJob.stage = 'done';
      emit({ type: 'training-prepared', dataset: await readTrainingDataset(options.datasetId) });
      return;
    }

    if (!Number.isInteger(options.maxSteps) || options.maxSteps < 10 || options.maxSteps > 500) {
      throw new Error('학습 스텝은 10~500 사이여야 합니다.');
    }
    const dataset = await readTrainingDataset(options.datasetId);
    const displayName = options.displayName?.trim() || dataset.displayName;
    if (displayName.length > 80) throw new Error('목소리 표시 이름은 1~80자여야 합니다.');
    const model = await cachedModel(config.model);
    const outputDir = path.join(runRoot, dateFolder(), options.name);
    let trainJsonl;
    let reference;
    let referenceText;
    if (!dataset.legacy) {
      const reviews = options.reviews;
      if (!Array.isArray(reviews) || reviews.length !== dataset.clips.length) throw new Error('모든 클립의 검수 상태를 확인해 주세요.');
      const byId = new Map(reviews.map(item => [item.id, item]));
      if (byId.size !== reviews.length || dataset.clips.some(clip => !byId.has(clip.id))) throw new Error('검수 클립 목록이 다릅니다.');
      const referenceReview = byId.get(options.referenceId);
      const referenceClip = dataset.clips.find(clip => clip.id === options.referenceId);
      if (!referenceClip || referenceReview?.accepted !== true || !referenceReview.text?.trim()) {
        throw new Error('듣고 확인한 클립 중에서 참조 음성을 골라 주세요.');
      }
      const decisions = reviews.map(item => {
        if (typeof item.text !== 'string' || item.text.length > 2000 || (item.accepted && !item.text.trim())) {
          throw new Error('학습 클립의 전사문을 확인해 주세요.');
        }
        return { id: item.id, text: item.text, status: item.accepted === true ? 'accepted' : 'rejected',
          notes: item.accepted === true ? '설정창에서 사용자가 청취·전사 확인' : '설정창에서 학습 제외' };
      });
      if (decisions.filter(item => item.status === 'accepted').length < 3) throw new Error('최소 3개 클립을 듣고 확인해 주세요.');
      await fs.mkdir(path.dirname(outputDir), { recursive: true });
      await fs.mkdir(outputDir);
      const decisionsPath = path.join(directory, 'app-review.json');
      await fs.writeFile(decisionsPath, JSON.stringify({ decisions }, null, 2));
      await datasetCommand('apply-decisions', '--decisions', decisionsPath);
      await datasetCommand('validate');
      reference = path.join(directory, 'reference.wav');
      referenceText = path.join(directory, 'reference.txt');
      await fs.copyFile(new URL(referenceClip.audioUrl), reference);
      await fs.writeFile(referenceText, `${referenceReview.text.trim()}\n`);
      const manifestPath = path.join(directory, 'manifest.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      await fs.writeFile(manifestPath, `${JSON.stringify({ ...manifest, referenceAudio: reference,
        referenceSha256: await fileSha256(reference), referenceClipId: options.referenceId }, null, 2)}\n`);
      await datasetCommand('export');
      trainJsonl = path.join(directory, 'official', 'train_raw.jsonl');
    } else {
      await fs.mkdir(path.dirname(outputDir), { recursive: true });
      await fs.mkdir(outputDir);
      // The pre-profile dataset has an explicit compatibility binding. The
      // currently selected production voice is never a training input.
      trainJsonl = legacyVoice.trainJsonl;
      reference = legacyVoice.referenceAudioPath;
      referenceText = legacyVoice.referenceTextPath;
    }
    const frozenReference = path.join(outputDir, 'reference.wav');
    const frozenText = path.join(outputDir, 'reference.txt');
    await fs.copyFile(reference, frozenReference);
    await fs.copyFile(referenceText, frozenText);
    reference = frozenReference;
    referenceText = frozenText;
    const frozenTrain = path.join(outputDir, 'train_raw.jsonl');
    await fs.copyFile(trainJsonl, frozenTrain);
    trainJsonl = frozenTrain;
    const profile = { schemaVersion: 1, displayName, datasetId: dataset.id, listeningStatus: 'pending',
      trainingStatus: 'pending', referenceAudioPath: 'reference.wav', referenceTextPath: 'reference.txt',
      trainJsonl: 'train_raw.jsonl', trainJsonlSha256: await fileSha256(trainJsonl),
      referenceAudioSha256: await fileSha256(reference), referenceTextSha256: await fileSha256(referenceText),
      trainingConfig: config, model: config.model };
    await writeVoiceProfile(outputDir, profile, { exclusive: true });
    await runProcess('training', python, ['-m', 'local_tts_engine.finetune_mlx',
      '--train-jsonl', trainJsonl, '--output-dir', outputDir, '--model', model,
      '--max-steps', String(options.maxSteps), ...trainingArguments(config),
      '--reference', reference, '--reference-text', referenceText]);
    const result = JSON.parse(await fs.readFile(path.join(outputDir, 'training-result.json'), 'utf8'));
    await writeVoiceProfile(outputDir, { ...profile, trainingStatus: 'complete' });
    const previewPath = path.join(outputDir, 'preview.wav');
    const previewTextPath = path.join(outputDir, 'preview-text.txt');
    await fs.writeFile(previewTextPath, config.preview.text);
    let previewError = null;
    try {
      const identity = await voiceInputIdentity(path.join(outputDir, 'adapters'), { referenceAudioPath: reference, referenceTextPath: referenceText });
      if (identity.referenceAudioSha256 !== profile.referenceAudioSha256 || identity.referenceTextSha256 !== profile.referenceTextSha256) {
        throw new Error('학습 중 대표 녹음이나 전사가 바뀌었습니다. 시험 음성을 생성하지 않습니다.');
      }
      await runProcess('voice', python, ['-m', 'local_tts_engine.text_candidate',
        '--text-file', previewTextPath, '--reference', reference, '--reference-text', referenceText,
        '--model-path', model,
        '--adapter', path.join(outputDir, 'adapters'), '--adapter-scale', String(config.preview.scale),
        '--output', previewPath, '--metadata', path.join(outputDir, 'preview.json'), '--seed', String(config.preview.seed)]);
      if (state.activeJob.cancelled) throw new Error('시험 음성 만들기를 중지했습니다.');
      if (!voiceInputMatches(identity, await voiceInputIdentity(path.join(outputDir, 'adapters'), { referenceAudioPath: reference, referenceTextPath: referenceText }))) {
        throw new Error('시험 음성을 만드는 동안 목소리 파일·대표 녹음·전사가 바뀌었습니다. 다시 만들어 주세요.');
      }
      await writeVoiceProfile(outputDir, { ...profile, trainingStatus: 'complete',
        preview: { audioPath: 'preview.wav', audioSha256: await fileSha256(previewPath), scale: config.preview.scale,
          ...identity, generatedAt: new Date().toISOString() } });
    } catch (error) {
      if (state.activeJob.cancelled) throw error;
      previewError = error.message;
    }
    const settings = await readAppSettings();
    const adapter = settings.adapters.find(item => item.path === path.join(outputDir, 'adapters')) || null;
    state.activeJob.state = 'done';
    state.activeJob.stage = 'done';
    emit({ type: 'training-complete', result, adapter, settings,
      previewUrl: previewError ? null : pathToFileURL(previewPath).href, previewError, previewScale: config.preview.scale });
  }

  return { listTrainingDatasets, readTrainingDataset, runFineTune };
}
