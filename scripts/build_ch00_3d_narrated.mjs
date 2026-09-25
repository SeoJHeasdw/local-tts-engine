#!/usr/bin/env node
// Make a narrated CH00 film from the already frozen 47-state 3D deck.
// This script never writes to udemy-agent or replaces an existing result.
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { presetFromManifest, providerForOptions } from '../electron-app/shared/options.mjs';
import { captureFrameCount, captureVideoFileName, videoQuality } from '../electron-app/shared/video-quality.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SNAPSHOT = path.join(ROOT, 'output/reviews/2026-09-25/3d-capture-live/frozen-input');
const DEFAULT_OUTPUT = path.join(ROOT, 'output/reviews/2026-09-25/ch00-3d-narrated-v2');
const EXPECTED_FINGERPRINT = '2a366ae609f241c441a835a0471876da5d662d9ee698b851c476595079f0c60d';
const ADAPTER_SHA256 = 'da66f67e4cac9f4dadcd35d8101674909c44106f07cc6e5ee98cbc20059a93de';
const ADAPTER_CONFIG_SHA256 = '8a521013edbfb715b021960e59a077298c8d075762e3204b912b5ca8e4688ea4';
const MODEL = 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16';
const ASR = 'mlx-community/whisper-large-v3-turbo-asr-fp16';
const ALIGNER = 'mlx-community/Qwen3-ForcedAligner-0.6B-8bit';
const NAME = 'ch00-3d-narrated';
const TITLE = 'CH00 전체 · 3D 강의';
const TRAIN_PYTHON = path.join(ROOT, '.venv-train/bin/python');
const BASE_PYTHON = path.join(ROOT, '.venv/bin/python');
const REFERENCE = path.join(ROOT, 'artifacts/benchmarks/2026-08-23/reference.wav');
const REFERENCE_TEXT = path.join(ROOT, 'artifacts/benchmarks/2026-08-23/reference.txt');
const ADAPTER = path.join(ROOT, 'artifacts/finetune-runs/2026-08-25/jaeho-ko-r16-v1/adapters');
const QUALITY = videoQuality('high');
const OFFLINE_ENV = {
  ...process.env,
  PYTHONPATH: [path.join(ROOT, 'src'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
  PYTHONUNBUFFERED: '1',
  HF_HUB_OFFLINE: '1',
  TRANSFORMERS_OFFLINE: '1',
  HF_DATASETS_OFFLINE: '1',
};

function valueAfter(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return fallback;
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) {
    throw new Error(`${flag} 뒤에 경로를 지정해 주세요.`);
  }
  return process.argv[index + 1];
}
function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function requireCondition(ok, message) { if (!ok) throw new Error(message); }
async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function requireFile(file) {
  const info = await fs.stat(file);
  requireCondition(info.isFile() && info.size > 0, `필수 파일이 비어 있습니다: ${file}`);
  return file;
}
async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function writeJson(file, data) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`);
  await fs.rename(temporary, file);
}
function identity(state) {
  return [state.chapter, state.slideId, state.slideNumber, state.step, state.sourceText];
}
function sameStates(left, right) {
  return left.length === right.length && left.every((item, index) =>
    JSON.stringify(identity(item)) === JSON.stringify(identity(right[index])));
}
async function cachedModel(repository) {
  const hub = process.env.HF_HUB_CACHE || path.join(process.env.HF_HOME || path.join(os.homedir(), '.cache/huggingface'), 'hub');
  const cache = path.join(hub, `models--${repository.replace('/', '--')}`);
  const revision = (await fs.readFile(path.join(cache, 'refs/main'), 'utf8')).trim();
  requireCondition(Boolean(revision), `모델 캐시 판본이 없습니다: ${repository}`);
  const snapshot = path.join(cache, 'snapshots', revision);
  await Promise.all(['config.json', 'model.safetensors'].map(name => requireFile(path.join(snapshot, name))));
  return { repository, revision, snapshot };
}

const STATIC_ENTRIES_PY = `import json,sys\nfrom pathlib import Path\nfrom local_tts_engine.course.script import course_entries\nroot=Path(sys.argv[1])\nitems=course_entries(root,'ch00',end_slide_number=11)\nprint(json.dumps([{'chapter':x.chapter,'slideId':x.slide_id,'slideNumber':x.slide_number,'step':x.step,'sourceText':x.source_text} for x in items],ensure_ascii=False))`;

async function preflight(snapshot) {
  await Promise.all([TRAIN_PYTHON, BASE_PYTHON, REFERENCE, REFERENCE_TEXT,
    path.join(ADAPTER, 'adapters.safetensors'), path.join(ADAPTER, 'adapter_config.json'),
    path.join(snapshot, 'deck/tools/preflight.mjs'), path.join(snapshot, 'site/index.html'),
  ].map(requireFile));
  const [adapterHash, adapterConfigHash, model, asr, aligner] = await Promise.all([
    sha256(path.join(ADAPTER, 'adapters.safetensors')),
    sha256(path.join(ADAPTER, 'adapter_config.json')),
    cachedModel(MODEL), cachedModel(ASR), cachedModel(ALIGNER),
  ]);
  requireCondition(adapterHash === ADAPTER_SHA256 && adapterConfigHash === ADAPTER_CONFIG_SHA256,
    '승인된 jaeho-ko-r16-v1 어댑터의 해시가 다릅니다.');
  const metadata = await readJson(path.join(snapshot, 'production-input.json'));
  const siteMetadata = await readJson(path.join(snapshot, 'site/production-input.json'));
  const states = metadata.states;
  requireCondition(metadata.sourceContract?.fingerprint === EXPECTED_FINGERPRINT
    && siteMetadata.sourceContract?.fingerprint === EXPECTED_FINGERPRINT,
  'CH00 고정본과 촬영 사이트의 판본이 다릅니다.');
  requireCondition(Array.isArray(states) && states.length === 47
    && states.every(state => state.chapter === 'ch00' && state.slideNumber >= 1 && state.slideNumber <= 11)
    && new Set(states.map(state => state.slideId)).size === 11,
  'CH00 고정본은 1~11쪽, 47상태여야 합니다.');
  requireCondition(sameStates(states, siteMetadata.states), '고정 대본과 촬영 사이트 상태가 다릅니다.');
  const { preflight: inspectDeck } = await import(pathToFileURL(path.join(snapshot, 'deck/tools/preflight.mjs')).href);
  const inspected = inspectDeck({ root: path.join(snapshot, 'deck'), from: 1, to: 11 });
  requireCondition(inspected.ok, `고정 덱 입력 검사 실패: ${inspected.errors?.join('; ')}`);
  requireCondition(sameStates(states, inspected.states), '고정본 대본과 덱의 현재 상태가 다릅니다.');
  const { stdout } = await execFileAsync(BASE_PYTHON, ['-c', STATIC_ENTRIES_PY, snapshot],
    { cwd: ROOT, env: OFFLINE_ENV, maxBuffer: 1024 * 1024 });
  requireCondition(sameStates(states, JSON.parse(stdout)), 'TTS 대본과 고정 촬영 상태가 다릅니다.');
  requireCondition(JSON.stringify(metadata.sourceContract.selected) === JSON.stringify(
    states.map(({ slideId, slideNumber, chapter, step }) => ({ slideId, slideNumber, chapter, step }))),
  '고정본의 선택 상태 계약이 다릅니다.');
  return { snapshot, fingerprint: EXPECTED_FINGERPRINT, pages: 11, states: 47,
    quality: QUALITY.id, adapter: 'jaeho-ko-r16-v1', adapterScale: 0.6,
    modelCache: [model, asr, aligner], reference: REFERENCE };
}

let activeChild = null;
let interrupted = null;
function interrupt(signal) {
  interrupted ||= signal;
  if (activeChild?.pid) {
    try { process.kill(-activeChild.pid, 'SIGTERM'); } catch { activeChild.kill('SIGTERM'); }
  }
}
process.on('SIGINT', () => interrupt('SIGINT'));
process.on('SIGTERM', () => interrupt('SIGTERM'));

async function runCommand(report, output, id, executable, args) {
  requireCondition(!interrupted, `작업이 중지됐습니다: ${interrupted}`);
  const stage = { id, status: 'running', startedAt: new Date().toISOString(), command: [executable, ...args] };
  report.stages.push(stage);
  await writeJson(path.join(output, 'build-report.json'), report);
  const log = createWriteStream(path.join(output, 'logs', `${id}.log`), { flags: 'wx' });
  console.log(`[ch00] ${id} 시작`);
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd: ROOT, env: OFFLINE_ENV, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      activeChild = child;
      child.stdout.on('data', chunk => { log.write(chunk); process.stdout.write(chunk); });
      child.stderr.on('data', chunk => { log.write(chunk); process.stderr.write(chunk); });
      child.once('error', reject);
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });
    requireCondition(code.exitCode === 0 && !interrupted,
      `${id} 실패: ${code.signal || code.exitCode}${interrupted ? ` (${interrupted})` : ''}`);
    stage.status = 'complete';
    console.log(`[ch00] ${id} 완료`);
  } catch (error) {
    stage.status = interrupted ? 'interrupted' : 'failed';
    stage.error = error.message;
    throw error;
  } finally {
    activeChild = null;
    await new Promise(resolve => log.end(resolve));
    stage.finishedAt = new Date().toISOString();
    stage.durationMs = Date.parse(stage.finishedAt) - Date.parse(stage.startedAt);
    await writeJson(path.join(output, 'build-report.json'), report);
  }
}

function validateEntries(entries, states) {
  requireCondition(entries?.length === 47, '음성 타임라인이 47상태가 아닙니다.');
  requireCondition(sameStates(entries, states), '음성 원문과 고정 덱 상태가 다릅니다.');
}
async function probeVideo(file) {
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
    { cwd: ROOT, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout);
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('node scripts/build_ch00_3d_narrated.mjs [--prepare-only] [--snapshot <frozen-input>] [--output <new-dir>]');
    return;
  }
  const snapshot = path.resolve(valueAfter('--snapshot', DEFAULT_SNAPSHOT));
  const output = path.resolve(valueAfter('--output', DEFAULT_OUTPUT));
  const reviewRoot = path.join(ROOT, 'output/reviews');
  requireCondition(inside(reviewRoot, output) && output !== reviewRoot && !inside(snapshot, output),
    '출력은 이 저장소의 output/reviews 아래 새 폴더로 지정해 주세요.');
  const preparationOnly = process.argv.includes('--prepare-only');
  if (preparationOnly) {
    console.log(JSON.stringify({ status: 'ready', ...(await preflight(snapshot)), output, writesOutput: false }, null, 2));
    return;
  }

  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.mkdir(output); // EEXIST is intentional: never replace a prior run.
  await fs.mkdir(path.join(output, 'logs'));
  const report = { schemaVersion: 1, status: 'running', createdAt: new Date().toISOString(),
    snapshot, output, stages: [], ttsDir: path.join(output, 'tts'), renderDir: path.join(output, 'render'),
    automaticFileValidation: 'pending', contentListeningApproval: 'pending' };
  await writeJson(path.join(output, 'build-report.json'), report);
  let phase = 'preflight';
  try {
    report.preflight = await preflight(snapshot);
    await writeJson(path.join(output, 'build-report.json'), report);
    const states = (await readJson(path.join(snapshot, 'production-input.json'))).states;
    phase = 'voice';
    await runCommand(report, output, 'voice', TRAIN_PYTHON, [
      '-m', 'local_tts_engine.course_pilot', '--source-project', snapshot,
      '--output-dir', report.ttsDir, '--reference', REFERENCE, '--reference-text', REFERENCE_TEXT,
      '--target-seconds', '0', '--start-page', '1', '--end-page', '11', '--model', 'qwen3-tts',
      '--adapter', ADAPTER, '--adapter-scale', '0.6', '--no-cache',
    ]);
    phase = 'voice-validation';
    const manifest = await readJson(path.join(report.ttsDir, 'manifest.json'));
    requireCondition(manifest.sourceContract?.fingerprint === EXPECTED_FINGERPRINT && manifest.model === MODEL,
      '생성 음성의 모델 또는 소스 판본이 다릅니다.');
    requireCondition(manifest.adapter?.scale === 0.6 && manifest.adapter?.weightsSha256 === ADAPTER_SHA256,
      '생성 음성의 어댑터가 승인값과 다릅니다.');
    validateEntries(manifest.entries?.map(item => ({ chapter: item.chapter, slideId: item.slide_id,
      slideNumber: item.slide_number, step: item.step, sourceText: item.source_text })), states);
    await Promise.all([manifest.audioPath, manifest.previewPath].map(requireFile));
    report.voiceQuality = manifest.quality?.summary || null;
    report.durationMs = manifest.durationMs;
    await writeJson(path.join(output, 'build-report.json'), report);

    const options = { name: NAME, title: TITLE, voiceMode: 'finetuned', adapterLabel: 'jaeho-ko-r16-v1', adapterScale: 0.6 };
    const preset = { name: NAME, ...presetFromManifest(manifest, options) };
    const provider = { provider: `${NAME}-provider`, ...providerForOptions(options,
      { repository: manifest.model, revision: manifest.modelRevision }) };
    phase = 'export';
    await runCommand(report, output, 'export', BASE_PYTHON, [
      '-m', 'local_tts_engine.export_udemy', '--source-dir', report.ttsDir, '--out-dir', report.renderDir,
      '--preset-json', JSON.stringify(preset), '--provider-json', JSON.stringify(provider),
    ]);
    phase = 'timeline-validation';
    const timelineFile = path.join(report.renderDir, 'timeline.json');
    const timeline = await readJson(timelineFile);
    requireCondition(timeline.sourceContract?.fingerprint === EXPECTED_FINGERPRINT
      && timeline.totalMs === manifest.durationMs, '내보낸 타임라인의 길이 또는 판본이 다릅니다.');
    validateEntries(timeline.entries, states);
    await Promise.all(['track.wav', 'track.m4a'].map(name => requireFile(path.join(report.renderDir, 'audio', name))));

    phase = 'captions';
    await runCommand(report, output, 'captions', process.execPath, [
      path.join(ROOT, 'electron-app/main/workers/captions.mjs'), '--timeline', timelineFile,
      '--out-dir', report.renderDir,
    ]);
    phase = 'captions-validation';
    const captions = await readJson(path.join(report.renderDir, 'captions.json'));
    requireCondition(captions.length > 0 && captions.at(-1).endMs <= timeline.totalMs + 50,
      '자막이 없거나 타임라인 범위를 벗어났습니다.');
    await Promise.all(['captions.srt', 'captions.vtt'].map(name => requireFile(path.join(report.renderDir, name))));

    const captureArgs = [
      path.join(ROOT, 'electron-app/main/workers/capture.mjs'), '--timeline', timelineFile,
      '--out-dir', report.renderDir, '--deck-root', path.join(snapshot, 'deck'),
      '--site-dir', path.join(snapshot, 'site'), '--quality', 'high', '--burn-captions', '--no-cache',
    ];
    phase = 'capture';
    try {
      await runCommand(report, output, 'capture', process.execPath, captureArgs);
    } catch (error) {
      if (interrupted) throw error;
      console.error('[ch00] 화면 촬영을 같은 음성과 타임라인으로 한 번 다시 시도합니다.');
      phase = 'capture-retry';
      await runCommand(report, output, 'capture-retry', process.execPath, captureArgs);
    }
    phase = 'video-validation';
    const videoFile = path.join(report.renderDir, captureVideoFileName(NAME, { videoQuality: 'high', burnCaptions: true }));
    await requireFile(videoFile);
    const capture = await readJson(`${videoFile}.capture.json`);
    const video = await probeVideo(videoFile);
    const stream = video.streams?.find(item => item.codec_type === 'video');
    const audio = video.streams?.find(item => item.codec_type === 'audio');
    const fps = String(stream?.avg_frame_rate || '').split('/').map(Number);
    requireCondition(stream?.width === QUALITY.width && stream?.height === QUALITY.height
      && stream?.codec_name === 'h264' && stream?.pix_fmt === 'yuv420p'
      && fps[1] > 0 && Math.abs(fps[0] / fps[1] - QUALITY.fps) < 0.01 && Boolean(audio),
    '완성 영상의 크기·프레임률·코덱·음성 트랙이 1440p 제작 규격과 다릅니다.');
    requireCondition(Math.abs(Number(video.format?.duration) * 1000 - timeline.totalMs) <= 200
      && Number(stream.nb_frames) === captureFrameCount(timeline.totalMs, QUALITY.fps),
    '완성 영상의 길이 또는 프레임 수가 실제 음성과 다릅니다.');
    requireCondition(capture.profile?.id === 'high'
      && capture.sourceContract?.fingerprint === EXPECTED_FINGERPRINT
      && capture.fileSha256 === await sha256(videoFile), '촬영 보고서의 화질·판본·파일 해시가 다릅니다.');
    await requireFile(path.join(report.renderDir, 'lesson-review.json'));
    report.videoPath = videoFile;
    report.captionsPath = path.join(report.renderDir, 'captions.srt');
    report.capture = { frames: capture.frames, resourceUsage: capture.resourceUsage,
      firstSceneReadyAtMs: capture.firstSceneReadyAtMs };
    report.automaticFileValidation = 'passed';
    report.status = 'complete';
    report.completedAt = new Date().toISOString();
    await writeJson(path.join(output, 'build-report.json'), report);
    console.log(`[ch00] 완성: ${videoFile}`);
  } catch (error) {
    report.status = interrupted ? 'interrupted' : 'failed';
    report.error = error.message;
    report.failedStage = phase;
    report.completedAt = new Date().toISOString();
    await writeJson(path.join(output, 'build-report.json'), report);
    throw error;
  }
}

main().catch(error => { console.error(`[ch00] ${error.message}`); process.exitCode = 1; });
