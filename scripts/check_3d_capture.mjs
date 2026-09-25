#!/usr/bin/env node
// Diagnostic only: capture the frozen current deck with silence and a synthetic
// clock. This measures the real browser/PNG/ffmpeg path without generating TTS or
// claiming that an old voice timeline matches the deck's current 3D cues.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { captureVideo } from '../electron-app/main/capture/record.mjs';
import { VIDEO_QUALITIES } from '../electron-app/shared/video-quality.mjs';

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DEFAULT_SOURCE = path.resolve(REPO, '../../edu/udemy-agent/deck');
const DEFAULT_LAYOUTS = ['chapter', 'promptify-world', 'rag-world', 'dive-world', 'stack-world', 'checkpoint-world'];
const SMOKE_MS = 6000;

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}
function flag(name) { return process.argv.includes(name); }
function positiveInteger(name, fallback) {
  const value = Number(option(name, fallback));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name}은 양의 정수여야 합니다.`);
  return value;
}
function qualityList(value) {
  const ids = value.split(',').map(item => item.trim()).filter(Boolean);
  if (!ids.length || ids.some(id => !VIDEO_QUALITIES[id]) || new Set(ids).size !== ids.length) {
    throw new Error(`화질 목록이 잘못됐습니다: ${value}`);
  }
  return ids;
}

if (flag('--help')) {
  console.log('node scripts/check_3d_capture.mjs --output <new-dir> [--snapshot <frozen-input>] [--prepare-only] [--ch00] [--representatives] [--slides id,id] [--ch00-qualities high] [--ch00-sample-qualities standard,ultra] [--ch00-sample-slides open-say-1,open-warn,open-why-first] [--representative-quality high] [--hold-ms 6000] [--ch00-limit N] [--representative-states 3]');
  process.exit(0);
}
const outputArg = option('--output');
if (!outputArg) throw new Error('새 진단 결과 폴더를 --output으로 지정하세요.');
const output = path.resolve(outputArg);
const sourceRoot = path.resolve(option('--source-root', DEFAULT_SOURCE));
const sourceProject = path.dirname(sourceRoot);
if (output === sourceProject || output.startsWith(`${sourceProject}${path.sep}`)) {
  throw new Error('진단 결과는 udemy-agent 바깥에 두세요. 덱 작업 트리는 읽기 전용입니다.');
}
const existingSnapshot = option('--snapshot') ? path.resolve(option('--snapshot')) : null;
const holdMs = positiveInteger('--hold-ms', 6000);
const representativeStates = positiveInteger('--representative-states', 3);
const ch00Limit = option('--ch00-limit') ? positiveInteger('--ch00-limit', 47) : null;
const ch00Qualities = qualityList(option('--ch00-qualities', 'high'));
const ch00SampleQualities = qualityList(option('--ch00-sample-qualities', 'standard,ultra'));
const ch00SampleSlides = option('--ch00-sample-slides', 'open-say-1,open-warn,open-why-first').split(',').map(item => item.trim()).filter(Boolean);
const representativeQuality = qualityList(option('--representative-quality', 'high'));
const requestedSlides = option('--slides', '').split(',').map(item => item.trim()).filter(Boolean);
const defaultScope = !flag('--ch00') && !flag('--representatives') && !requestedSlides.length;
const includeCh00 = flag('--ch00') || defaultScope;
const includeRepresentatives = flag('--representatives') || defaultScope;
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.mkdir(output); // Never replace an existing diagnostic run.
const snapshot = path.join(output, 'frozen-input');
let frozen;
if (existingSnapshot) {
  console.log(`[3d-probe] 이전에 고정한 덱을 재사용합니다: ${existingSnapshot}`);
  await fs.access(path.join(existingSnapshot, 'site/index.html'));
  frozen = { project: existingSnapshot, deck: path.join(existingSnapshot, 'deck'), site: path.join(existingSnapshot, 'site') };
} else {
  const { createProductionInput } = await import(pathToFileURL(path.join(sourceRoot, 'tools/production.mjs')).href);
  const { readCourse: readSourceCourse } = await import(pathToFileURL(path.join(sourceRoot, 'tools/source-model.mjs')).href);
  const lastCh00Slide = readSourceCourse(sourceRoot).filter(slide => slide.chapter === 'ch00').at(-1);
  if (!lastCh00Slide) throw new Error('원본 덱에서 CH00 장표를 찾지 못했습니다.');
  console.log(`[3d-probe] 덱을 읽기 전용으로 고정하고 정적 사이트를 빌드합니다: ${snapshot}`);
  frozen = await createProductionInput({ root: sourceRoot, destination: snapshot, from: 1, to: lastCh00Slide.n });
}
const metadata = JSON.parse(await fs.readFile(path.join(frozen.project, 'production-input.json'), 'utf8'));
frozen.sourceContract ||= metadata.sourceContract;
const { readCourse } = await import(pathToFileURL(path.join(frozen.deck, 'tools/source-model.mjs')).href);
const { preflight } = await import(pathToFileURL(path.join(frozen.deck, 'tools/preflight.mjs')).href);
const course = readCourse(frozen.deck);
const ch00SlideCount = course.filter(slide => slide.chapter === 'ch00').length;
const selectedCh00SlideCount = new Set(metadata.states.filter(state => state.chapter === 'ch00').map(state => state.slideId)).size;
if (selectedCh00SlideCount !== ch00SlideCount) {
  throw new Error(`CH00 전체가 스냅샷 선택 범위에 없습니다: 선택 ${selectedCh00SlideCount}장 / 실제 ${ch00SlideCount}장`);
}
const plans = [];
const firstCh00State = metadata.states.find(state => state.chapter === 'ch00');
if (!firstCh00State) throw new Error('고정한 입력에 CH00 첫 상태가 없습니다.');
plans.push({ label: 'smoke-ch00', kind: 'shared-smoke', states: [firstCh00State],
  qualities: ['high'], holdMs: SMOKE_MS, fullChapter: false });

if (includeCh00) {
  const states = metadata.states.filter(state => state.chapter === 'ch00');
  if (!states.length) throw new Error('고정한 입력에 CH00 상태가 없습니다.');
  plans.push({ label: 'ch00', kind: 'ch00', states: ch00Limit ? states.slice(0, ch00Limit) : states,
    qualities: ch00Qualities, fullChapter: !ch00Limit });
  for (const id of ch00SampleSlides) {
    const slide = course.find(spec => spec.id === id && spec.chapter === 'ch00');
    if (!slide) throw new Error(`CH00 표본 장표가 없습니다: ${id}`);
    const inspected = preflight({ root: frozen.deck, from: slide.n, to: slide.n });
    if (!inspected.ok) throw new Error(`${id} 제작 입력 검사 실패:\n${inspected.errors.join('\n')}`);
    plans.push({ label: `ch00-sample-${id}`, kind: 'ch00-sample',
      states: inspected.states.slice(0, representativeStates), qualities: ch00SampleQualities, fullChapter: false });
  }
}
const picked = new Set();
if (includeRepresentatives) {
  for (const layout of DEFAULT_LAYOUTS) {
    const spec = course.find(slide => slide.layout === layout);
    if (!spec) throw new Error(`${layout} 장표를 고정한 덱에서 찾지 못했습니다.`);
    picked.add(spec.id);
    requestedSlides.push(spec.id);
  }
}
for (const id of new Set(requestedSlides)) {
  const slide = course.find(spec => spec.id === id);
  if (!slide) throw new Error(`고정한 덱에 없는 장표입니다: ${id}`);
  const inspected = preflight({ root: frozen.deck, from: slide.n, to: slide.n });
  if (!inspected.ok) throw new Error(`${id} 제작 입력 검사 실패:\n${inspected.errors.join('\n')}`);
  plans.push({ label: id, kind: picked.has(id) ? slide.layout : 'selected-slide',
    states: inspected.states.slice(0, representativeStates), qualities: representativeQuality, fullChapter: false });
}

// The frozen production input contains only CH00 states, while Vite builds the
// whole deck. Check that every selected CH01/02 ID reached the static bundle.
// Runtime navigation still requires the real-browser trial below.
const bundleDir = path.join(frozen.site, 'assets');
const bundleFiles = (await fs.readdir(bundleDir)).filter(name => name.endsWith('.js'));
const bundles = await Promise.all(bundleFiles.map(name => fs.readFile(path.join(bundleDir, name), 'utf8')));
const selectedIds = [...new Set(plans.flatMap(plan => plan.states.map(state => state.slideId)))];
const bundleChecks = selectedIds.map(slideId => ({
  slideId, presentInBuiltJavaScript: bundles.some(bundle => bundle.includes(JSON.stringify(slideId))),
}));
const missingFromBundle = bundleChecks.filter(item => !item.presentInBuiltJavaScript);
if (missingFromBundle.length) throw new Error(`고정한 정적 사이트에서 장표 ID를 찾지 못했습니다: ${missingFromBundle.map(item => item.slideId).join(', ')}`);

const results = {
  schemaVersion: 1, diagnosticOnly: true, syntheticAudio: 'silence', syntheticTimingMsPerState: holdMs,
  sourceRoot: metadata.sourceRoot, snapshot: frozen.project, fingerprint: frozen.sourceContract.fingerprint,
  currentCh00StateCount: metadata.states.filter(state => state.chapter === 'ch00').length,
  currentCh00SlideCount: ch00SlideCount,
  bundleChecks: { method: 'static JavaScript string presence; navigation requires browser capture', slides: bundleChecks },
  plannedTrials: plans.reduce((count, plan) => count + plan.qualities.length, 0),
  plannedRecordingMs: plans.reduce((duration, plan) => duration + plan.states.length * (plan.holdMs ?? holdMs) * plan.qualities.length, 0),
  createdAt: new Date().toISOString(), plans: plans.map(plan => ({
    label: plan.label, scope: plan.kind, qualities: plan.qualities, stateCount: plan.states.length,
    recordingMsPerQuality: plan.states.length * (plan.holdMs ?? holdMs),
    first: `${plan.states[0].slideId}:${plan.states[0].step}`,
    last: `${plan.states.at(-1).slideId}:${plan.states.at(-1).step}`,
    fullChapter: plan.fullChapter,
  })), trials: [],
};
const resultsFile = path.join(output, 'probe-results.json');
await fs.writeFile(resultsFile, `${JSON.stringify(results, null, 2)}\n`);
if (flag('--prepare-only')) {
  results.preparationOnly = true;
  results.completedAt = new Date().toISOString();
  await fs.writeFile(resultsFile, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`[3d-probe] 정적 검사와 실행 계획 완료: ${resultsFile}`);
  process.exit(0);
}

function timelineFor(plan) {
  const stateMs = plan.holdMs ?? holdMs;
  return {
    totalMs: plan.states.length * stateMs,
    provider: { provider: 'capture-diagnostic-silence' },
    preset: { name: `3d-probe-${plan.label}` },
    // The fingerprint identifies the frozen source. The selected set here is
    // synthetic and must never be used as a real narration contract.
    sourceContract: null,
    entries: plan.states.map((state, index) => ({
      slideId: state.slideId, slideNumber: state.slideNumber, chapter: state.chapter,
      step: state.step, sourceText: state.sourceText, key: `${state.slideId}:${state.step}`,
      startMs: index * stateMs, endMs: (index + 1) * stateMs,
      transitionAtMs: (index + 1) * stateMs,
    })),
  };
}

async function makeSilentTrack(dir, durationMs) {
  const audioDir = path.join(dir, 'audio');
  await fs.mkdir(audioDir, { recursive: true });
  const file = path.join(audioDir, 'track.wav');
  await exec('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'anullsrc=r=48000:cl=mono', '-t', (durationMs / 1000).toFixed(3),
    '-c:a', 'pcm_s16le', file]);
}

async function startSampler(file) {
  const child = spawn('python3.13', [path.join(HERE, 'capture_memory_sample.py'),
    '--root-pid', String(process.pid), '--output', file], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode !== null) throw new Error(`메모리 샘플러 실행 실패: ${stderr.trim()}`);
    try {
      if ((await fs.stat(file)).size > 0) return { child, stderr: () => stderr };
    }
    catch { /* The sampler has not created its file yet. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  throw new Error(`메모리 샘플러가 기록을 시작하지 못했습니다: ${stderr.trim()}`);
}
async function stopSampler(handle) {
  if (!handle) return;
  const { child } = handle;
  if (child.exitCode !== null) return;
  await new Promise(resolve => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
}
async function summarizeMemory(file) {
  const lines = (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean);
  const samples = lines.map(line => JSON.parse(line));
  const complete = samples.filter(sample => sample.knownFamilyRssComplete);
  const start = complete[0], peak = complete.reduce((best, item) =>
    item.residentSumBytes > best.residentSumBytes ? item : best, start);
  const observedFree = samples.map(item => item.systemFreePercent).filter(Number.isFinite);
  const groupPeak = (fragment) => Math.max(0, ...complete.map(sample => sample.processes
    .filter(item => item.name.toLowerCase().includes(fragment))
    .reduce((total, item) => total + item.residentBytes, 0)));
  return {
    sampleCount: samples.length, completeSampleCount: complete.length,
    incompleteSampleCount: samples.length - complete.length,
    unmeasuredPids: [...new Set(samples.flatMap(item => item.unmeasuredPids || []))],
    startResidentSumBytes: start?.residentSumBytes ?? null,
    peakResidentSumBytes: peak?.residentSumBytes ?? null,
    peakIncreaseBytes: start && peak ? peak.residentSumBytes - start.residentSumBytes : null,
    peakProcessCount: Math.max(0, ...samples.map(item => item.processes.length)),
    peakBrowserResidentBytes: groupPeak('chrom'),
    peakFfmpegResidentBytes: groupPeak('ffmpeg'),
    peakNodeResidentBytes: groupPeak('node'),
    minSystemFreePercent: observedFree.length ? Math.min(...observedFree) : null,
    peakProcesses: peak?.processes ?? [],
    note: '프로세스 RSS 합계는 공유 페이지를 중복 계산할 수 있는 상한 성격의 지표입니다.',
  };
}

function commonCaptureSetupError(error) {
  const message = String(error?.message || error);
  return /browser\.process is not a function/i.test(message)
    || /listen (?:EPERM|EACCES|EADDRINUSE)/i.test(message)
    || /화면 촬영에는 playwright가 필요합니다/i.test(message)
    || /browserType\.launch|Failed to launch browser|Executable doesn't exist/i.test(message)
    || /캡처 화면 서버가 .* 준비되지 않았습니다/i.test(message)
    || /오디오가 촬영 범위보다 짧습니다|오디오와 타임라인 길이가 다릅니다/i.test(message);
}

trialLoop: for (const plan of plans) {
  for (const quality of plan.qualities) {
    const label = `${plan.label}-${quality}`;
    const dir = path.join(output, label);
    await fs.mkdir(dir);
    const timeline = timelineFor(plan);
    const memoryFile = path.join(dir, 'memory.jsonl');
    const startedAt = Date.now();
    const trial = { label, scope: plan.kind, quality, stateCount: plan.states.length,
      fullChapter: plan.fullChapter, diagnosticOnly: true, status: 'running',
      timelineMs: timeline.totalMs, memoryFile };
    results.trials.push(trial);
    await fs.writeFile(resultsFile, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`[3d-probe] ${label}: ${plan.states.length}상태 × ${plan.holdMs ?? holdMs}ms 촬영 시작`);
    let sampler = null;
    let stage = 'audio';
    let stopForSharedSetup = false;
    try {
      await makeSilentTrack(dir, timeline.totalMs);
      stage = 'memory-sampler';
      sampler = await startSampler(memoryFile);
      stage = 'capture';
      const file = await captureVideo({ timeline, outDir: dir, siteDir: frozen.site,
        quality, noCache: true, burnCaptions: false });
      stage = 'report';
      const report = JSON.parse(await fs.readFile(path.join(dir, 'capture-report.json'), 'utf8'));
      trial.status = 'captured';
      trial.file = file;
      trial.frames = report.frames;
      trial.video = { width: report.video.width, height: report.video.height,
        frameCount: Number(report.video.nb_frames), fps: report.video.avg_frame_rate };
      trial.duplicatedPercent = +(100 * report.frames.duplicated / report.frames.written).toFixed(2);
      trial.longestStallMs = Math.round(report.frames.longestStall * 1000 / 25);
      trial.peakEncoderBacklogBytes = report.frames.peakBacklog;
      trial.sourceResolutionLimits = report.sourceResolutionLimits;
    } catch (error) {
      trial.status = 'failed';
      trial.error = error.message;
      trial.failureStage = stage;
      const knownSharedSetup = stage === 'audio' || stage === 'memory-sampler'
        || (stage === 'capture' && commonCaptureSetupError(error));
      stopForSharedSetup = knownSharedSetup || plan.kind === 'shared-smoke';
      trial.failureKind = knownSharedSetup ? 'shared-setup'
        : plan.kind === 'shared-smoke' ? 'smoke-failure' : 'individual-capture';
      console.error(`[3d-probe] ${label} 실패: ${error.message}`);
    } finally {
      await stopSampler(sampler);
      try { trial.memory = await summarizeMemory(memoryFile); }
      catch (error) { trial.memoryError = error.message; }
      trial.elapsedMs = Date.now() - startedAt;
      await fs.writeFile(resultsFile, `${JSON.stringify(results, null, 2)}\n`);
    }
    if (stopForSharedSetup) {
      results.abortedEarly = {
        kind: trial.failureKind, reason: trial.error, afterTrial: label,
        skippedTrials: results.plannedTrials - results.trials.length,
      };
      const reason = trial.failureKind === 'smoke-failure' ? '예비 촬영 실패' : '공통 촬영 준비 오류';
      console.error(`[3d-probe] ${reason}로 중단합니다. 남은 ${results.abortedEarly.skippedTrials}회는 시작하지 않았습니다.`);
      break trialLoop;
    }
  }
}
results.completedAt = new Date().toISOString();
await fs.writeFile(resultsFile, `${JSON.stringify(results, null, 2)}\n`);
console.log(`[3d-probe] 진단 완료: ${resultsFile}`);
if (results.trials.some(trial => trial.status !== 'captured')) process.exitCode = 1;
