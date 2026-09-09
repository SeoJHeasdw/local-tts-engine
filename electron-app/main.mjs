import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  combineLessonCatalogs,
  reviewPages,
  muteRegionFilter,
  replaceRegionPlan,
  isInside,
  lessonCatalogFromPresets,
  mapWithConcurrency,
  nextDisplayVideoFileName,
  normalizeEditName,
  normalizeOptions,
  normalizeVoiceText,
  outputPathsForRoot,
  pageVoicePatchPlan,
  patchedTimeline,
  presetFromManifest,
  providerForOptions,
  summarizeChecks,
  clipTimeline,
  composeTotalMs,
  concatTimelines,
  normalizeComposeClips,
  pageVoicePatchesPlan,
  clearedFindingKeys,
  pendingUnits,
  withClearedFindings,
  timeRangeForPages,
  assertPageReplaceable,
  pageRangeFromTimeline,
  videoTimelineCandidates,
  videoTimelineFileName,
  voiceQualityFindings,
  withOutputReview,
} from "./pipeline-utils.mjs";
import {
  defaultStudioPaths,
  resolveRuntimeTools,
} from "./runtime-config.mjs";

import { cancelJobProcesses, pauseJobProcesses, resumeJobProcesses, runJobProcess, stopJobProcesses } from "./job-process.mjs";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(APP_DIR);
const RENDERER_DIR = path.join(APP_DIR, "renderer");
const APP_SETTINGS_PATH = path.join(ROOT, "artifacts/app-settings.json");
// 한 챕터를 만드는 데 두 시간 반이 걸린다. 앱이 꺼지면 그 시간이 통째로 사라지는
// 것을 막으려면 진행이 프로세스가 아니라 디스크에 남아 있어야 한다. 끝난 편의
// 이름만 적어 두면 되는데, 끝난 편은 검증까지 마친 영상이라 다시 만들 이유가
// 없기 때문이다.
const ACTIVE_JOB_PATH = path.join(ROOT, "artifacts/active-job.json");

async function writeActiveJob(record) {
  await fs.mkdir(path.dirname(ACTIVE_JOB_PATH), { recursive: true });
  await fs.writeFile(ACTIVE_JOB_PATH, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

async function clearActiveJob() {
  await fs.rm(ACTIVE_JOB_PATH, { force: true }).catch(() => {});
}

async function readActiveJob() {
  return fs.readFile(ACTIVE_JOB_PATH, "utf8").then(JSON.parse).catch(() => null);
}

// 끝난 편의 표식은 그 편이 스스로 남긴 검증 결과다. 별도 장부를 두면 장부와
// 실제 결과가 어긋날 수 있어, 결과 자체를 근거로 삼는다.
async function finishedUnitNames(units, studio) {
  const checked = await Promise.all(units.map(async (unit) => {
    const report = await fs
      .readFile(path.join(studio.captionOutputRoot, unit.name, "validation-report.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    return report?.summary?.ok && report?.videoPath ? unit.name : null;
  }));
  return checked.filter(Boolean);
}

const FINETUNE_RUN_ROOT = path.join(ROOT, "artifacts/finetune-runs");
const FINETUNE_TRAIN_JSONL = path.join(ROOT, "artifacts/finetune-datasets/jaeho-ko-v1/official/train.jsonl");
const ADAPTER = path.join(ROOT, "artifacts/finetune-runs/2026-08-25/jaeho-ko-r16-v1/adapters");
// How many different seeds a chunk may spend before a page is handed to a
// person. Mirrors MAX_AUTOMATIC_ATTEMPTS in speech_quality.py.
const DEFAULT_QUALITY_ATTEMPTS = 4;
const DEFAULT_STUDIO_PATHS = Object.freeze(defaultStudioPaths(ROOT));
const LEGACY_OUTPUT_PATHS = Object.freeze({
  ttsOutputRoot: path.join(ROOT, "artifacts/course-pilots"),
  voiceOutputRoot: path.join(ROOT, "artifacts/voice-candidates"),
  captionOutputRoot: path.join(ROOT, "artifacts/production/captions"),
  videoOutputRoot: path.join(ROOT, "artifacts/production/videos"),
  editOutputRoot: path.join(ROOT, "artifacts/video-edits"),
});

let mainWindow = null;
let activeJob = null;
let catalogCache = null;
let catalogCacheRoot = null;
let runtimeTools = {
  basePython: null,
  trainPython: null,
  node: null,
  ffmpeg: null,
  ffprobe: null,
};
const selectedFiles = new Map();

function normalizeStudioPaths(raw = {}) {
  const inputs = Object.fromEntries(
    Object.entries(DEFAULT_STUDIO_PATHS).map(([key, fallback]) => {
      const value = String(raw?.[key] || fallback).trim();
      return [key, path.resolve(value || fallback)];
    }),
  );
  return { ...inputs, ...outputPathsForRoot(inputs.outputRoot) };
}

function runtimePaths(raw = {}) {
  const studio = normalizeStudioPaths(raw);
  const deckRoot = path.join(studio.sourceProjectRoot, "deck");
  return {
    ...studio,
    deckRoot,
    configPath: path.join(deckRoot, "narration.config.json"),
  };
}

async function discoverAdapters() {
  const adapters = [];
  const days = await fs.readdir(FINETUNE_RUN_ROOT, { withFileTypes: true }).catch(() => []);
  for (const day of days.filter((item) => item.isDirectory())) {
    const dayRoot = path.join(FINETUNE_RUN_ROOT, day.name);
    const runs = await fs.readdir(dayRoot, { withFileTypes: true }).catch(() => []);
    for (const run of runs.filter((item) => item.isDirectory())) {
      const adapterPath = path.join(dayRoot, run.name, "adapters");
      if (await safeStat(path.join(adapterPath, "adapters.safetensors"))
          && await safeStat(path.join(adapterPath, "adapter_config.json"))) {
        adapters.push({
          id: `${day.name}/${run.name}`,
          label: run.name,
          path: adapterPath,
          date: day.name,
        });
      }
    }
  }
  return adapters.sort((a, b) => b.id.localeCompare(a.id));
}

async function readAppSettings() {
  const adapters = await discoverAdapters();
  const fallbackAdapter = adapters.find((item) => item.label === "jaeho-ko-r16-v1") || adapters[0] || null;
  const stored = await fs.readFile(APP_SETTINGS_PATH, "utf8").then(JSON.parse).catch(() => ({}));
  const selected = adapters.find((item) => item.id === stored.adapterId) || fallbackAdapter;
  const modelId = stored.modelId === "chatterbox-v3" ? "chatterbox-v3" : "qwen3-tts";
  return {
    modelId,
    adapterId: modelId === "qwen3-tts" && stored.adapterId !== "none" ? selected?.id || "none" : "none",
    adapterScale: Math.min(1, Math.max(0.1, Number(stored.adapterScale ?? 0.6))),
    voiceParallelism: Math.min(2, Math.max(1, Math.round(Number(stored.voiceParallelism ?? 2)))),
    paths: normalizeStudioPaths(stored.paths),
    adapters,
  };
}

async function saveAppSettings(raw = {}) {
  const current = await readAppSettings();
  const modelId = raw.modelId === "chatterbox-v3" ? "chatterbox-v3" : "qwen3-tts";
  const adapterId = raw.adapterId === "none" || current.adapters.some((item) => item.id === raw.adapterId)
    ? raw.adapterId
    : current.adapterId;
  const settings = {
    modelId,
    adapterId: modelId === "qwen3-tts" ? adapterId : "none",
    adapterScale: Math.min(1, Math.max(0.1, Number(raw.adapterScale ?? current.adapterScale))),
    voiceParallelism: Math.min(2, Math.max(1, Math.round(Number(raw.voiceParallelism ?? current.voiceParallelism)))),
    paths: normalizeStudioPaths(raw.paths || current.paths),
  };
  for (const key of ["voiceLibraryRoot", "outputRoot", "ttsOutputRoot", "voiceOutputRoot", "captionOutputRoot", "videoOutputRoot", "editOutputRoot"]) {
    await fs.mkdir(settings.paths[key], { recursive: true });
  }
  const studio = runtimePaths(settings.paths);
  for (const [label, requiredPath] of Object.entries({
    "참조 음성": studio.referenceAudioPath,
    "참조 전사문": studio.referenceTextPath,
  })) {
    if (!(await safeStat(requiredPath))) throw new Error(`${label} 경로를 찾지 못했습니다: ${requiredPath}`);
  }
  await fs.mkdir(path.dirname(APP_SETTINGS_PATH), { recursive: true });
  const storedSettings = {
    ...settings,
    paths: Object.fromEntries(["sourceProjectRoot", "voiceLibraryRoot", "outputRoot", "referenceAudioPath", "referenceTextPath"]
      .map((key) => [key, settings.paths[key]])),
  };
  await fs.writeFile(APP_SETTINGS_PATH, `${JSON.stringify(storedSettings, null, 2)}\n`, "utf8");
  catalogCache = null;
  catalogCacheRoot = null;
  return { ...settings, adapters: current.adapters };
}

function applyVoiceSettings(options, settings) {
  const adapter = settings.modelId === "qwen3-tts"
    ? settings.adapters.find((item) => item.id === settings.adapterId) || null
    : null;
  return {
    ...options,
    modelId: settings.modelId,
    voiceMode: adapter ? "finetuned" : "zero",
    adapterId: adapter?.id || "none",
    adapterLabel: adapter?.label || null,
    adapterPath: adapter?.path || null,
    adapterScale: settings.adapterScale,
    voiceParallelism: settings.voiceParallelism,
    paths: settings.paths,
  };
}

function dateFolder(now = new Date()) {
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
}

function senderIsLocal(event) {
  try {
    const source = fileURLToPath(event.senderFrame.url);
    return isInside(RENDERER_DIR, source);
  } catch {
    return false;
  }
}

function guard(event) {
  if (!senderIsLocal(event)) throw new Error("허용되지 않은 화면 요청입니다.");
}

function emit(payload) {
  if (payload.type === "log") {
    (payload.stream === "stderr" ? process.stderr : process.stdout).write(payload.text);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("studio:job-event", {
      jobKind: activeJob?.kind || "create",
      ...payload,
    });
  }
}

function jobSnapshot() {
  if (!activeJob) return null;
  return {
    id: activeJob.id,
    name: activeJob.options.name,
    state: activeJob.state,
    stage: activeJob.stage,
    startedAt: activeJob.startedAt,
    kind: activeJob.kind,
    error: activeJob.error || null,
  };
}

function requireRuntimeTool(key, label) {
  const executable = runtimeTools[key];
  if (!executable) throw new Error(`${label} 실행 도구를 찾지 못했습니다. 먼저 npm run doctor로 환경을 확인해 주세요.`);
  return executable;
}

async function assertRuntime(options, studio = runtimePaths(options.paths), requirements = {}) {
  const required = [
    ["음성 생성 Python", runtimeTools.trainPython],
    ["참조 음성", studio.referenceAudioPath],
    ["참조 전사문", studio.referenceTextPath],
  ];
  if (requirements.course !== false) {
    required.push(
      ["강의 도구 Python", runtimeTools.basePython],
      ["강의 설정", studio.configPath],
      ["강의 대본", path.join(studio.deckRoot, "script/course")],
      ["Whisper 자동 음성 검수 모델", path.join(ROOT, "artifacts/models/whisper-large-v3-turbo-asr-fp16/config.json")],
      ["Whisper 자동 음성 검수 가중치", path.join(ROOT, "artifacts/models/whisper-large-v3-turbo-asr-fp16/model.safetensors")],
    );
  }
  if (requirements.node) required.push(["Node.js", runtimeTools.node]);
  if (requirements.productionInput) required.push(
    ["강의 입력 고정 도구", path.join(studio.deckRoot, "tools/production.mjs")],
    ["강의 제작 전 검사", path.join(studio.deckRoot, "tools/preflight.mjs")],
    ["강의 TypeScript 도구", path.join(studio.deckRoot, "node_modules/typescript/package.json")],
  );
  if (requirements.ffmpeg) required.push(["FFmpeg", runtimeTools.ffmpeg]);
  if (requirements.ffprobe !== false) required.push(["FFprobe", runtimeTools.ffprobe]);
  if (options.voiceMode === "finetuned") {
    const adapterPath = options.adapterPath || ADAPTER;
    required.push(
      ["음성 어댑터", path.join(adapterPath, "adapters.safetensors")],
      ["음성 어댑터 설정", path.join(adapterPath, "adapter_config.json")],
    );
  }
  for (const [label, file] of required) {
    if (!file) throw new Error(`${label}을(를) 찾지 못했습니다. 먼저 npm run doctor로 환경을 확인해 주세요.`);
    try {
      await fs.access(file);
    } catch {
      throw new Error(`${label}을(를) 찾지 못했습니다: ${file}`);
    }
  }
}

// course_pilot prints "[자동 음성 검수 3/38] ..." as it works through a lesson.
// That line is the only place the run says how far along it is, and the wait is
// long enough that "언제 끝나는지" is a real question. Read it here, once, so
// the renderer gets a number instead of parsing log text.
const VOICE_PROGRESS_PATTERN = /\[자동 음성 검수 (\d+)\/(\d+)\]/g;

function runProcess(stage, executable, args, { cwd = ROOT, capture = false } = {}) {
  const job = activeJob;
  return runJobProcess(job, stage, executable, args, {
    cwd, capture,
    env: { ...process.env, PYTHONPATH: path.join(ROOT, "src"), PYTHONUNBUFFERED: "1" },
    emit: payload => {
      if (activeJob !== job) return;
      emit(payload);
      if (payload.type !== "log" || payload.stream !== "stdout") return;
      let match = null;
      let last = null;
      VOICE_PROGRESS_PATTERN.lastIndex = 0;
      while ((match = VOICE_PROGRESS_PATTERN.exec(payload.text))) last = match;
      if (last) emit({ type: "voice-progress", done: Number(last[1]), total: Number(last[2]) });
    },
  });
}

function runUtility(executable, args, { cwd = ROOT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: { ...process.env, PYTHONPATH: path.join(ROOT, "src") },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `도구 실행 실패 (${code})`));
    });
  });
}

async function loadCatalog(studio, { tracked = false } = {}) {
  if (catalogCache && catalogCacheRoot === studio.sourceProjectRoot) return catalogCache;
  const execute = tracked
    ? (executable, args) => runProcess("snapshot", executable, args, { capture: true })
    : runUtility;
  const raw = await execute(requireRuntimeTool("basePython", "강의 도구 Python"), [
    "-m", "local_tts_engine.course_catalog",
    "--source-project", studio.sourceProjectRoot,
  ]);
  catalogCache = JSON.parse(raw);
  const deckConfig = await fs.readFile(studio.configPath, "utf8").then(JSON.parse).catch(() => ({}));
  catalogCache.lessons = combineLessonCatalogs(
    catalogCache.lessons,
    lessonCatalogFromPresets(catalogCache.pages, deckConfig.presets),
  );
  catalogCacheRoot = studio.sourceProjectRoot;
  return catalogCache;
}

async function writeDeckContract(manifest, options, providerName, studio) {
  const raw = await fs.readFile(studio.configPath, "utf8");
  const config = JSON.parse(raw);
  const provider = providerForOptions(options, {
    repository: manifest.model,
    revision: manifest.modelRevision,
  });
  config.presets ||= {};
  config.providers ||= {};
  const previous = {
    preset: Object.hasOwn(config.presets, options.name) ? config.presets[options.name] : null,
    provider: Object.hasOwn(config.providers, providerName) ? config.providers[providerName] : null,
    outputRoot: config.outputRoot,
  };
  config.presets[options.name] = presetFromManifest(manifest, options);
  config.providers[providerName] = provider;
  config.outputRoot = path.relative(studio.deckRoot, studio.captionOutputRoot) || ".";

  const temporary = `${studio.configPath}.studio-${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await fs.rename(temporary, studio.configPath);
  emit({ type: "log", stream: "stdout", text: "영상 범위를 실제 음성 길이에 맞췄습니다.\n" });
  return previous;
}

async function restoreDeckContract(options, providerName, previous, studio) {
  const config = JSON.parse(await fs.readFile(studio.configPath, "utf8"));
  if (previous.preset === null) delete config.presets[options.name];
  else config.presets[options.name] = previous.preset;
  if (previous.provider === null) delete config.providers[providerName];
  else config.providers[providerName] = previous.provider;
  config.outputRoot = previous.outputRoot;
  const temporary = `${studio.configPath}.studio-${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await fs.rename(temporary, studio.configPath);
}

async function ffprobe(file) {
  const output = await runProcess("verify", requireRuntimeTool("ffprobe", "FFprobe"), [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,codec_name,width,height",
    "-of", "json",
    file,
  ], { capture: true });
  return JSON.parse(output);
}

async function findVideo(renderDir, name) {
  const names = await fs.readdir(renderDir).catch(() => []);
  const preferred = `${name}-captioned.mp4`;
  if (names.includes(preferred)) return path.join(renderDir, preferred);
  const mp4s = names.filter((item) => item.toLowerCase().endsWith(".mp4"));
  if (!mp4s.length) return null;
  const dated = await Promise.all(mp4s.map(async (item) => ({
    item,
    at: (await safeStat(path.join(renderDir, item)))?.mtimeMs || 0,
  })));
  dated.sort((left, right) => left.at - right.at || left.item.localeCompare(right.item));
  return path.join(renderDir, dated.at(-1).item);
}

async function publishedVideoNames(root) {
  const names = [];
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".mp4")) names.push(entry.name);
    if (!entry.isDirectory()) continue;
    const children = await fs.readdir(path.join(root, entry.name), { withFileTypes: true }).catch(() => []);
    names.push(...children
      .filter((child) => child.isFile() && child.name.toLowerCase().endsWith(".mp4"))
      .map((child) => child.name));
  }
  return names;
}

async function publishVideo(source, studio, name, title, renderDir = null) {
  const outputDir = path.join(studio.videoOutputRoot, name);
  await fs.mkdir(outputDir, { recursive: true });
  const target = path.join(
    outputDir,
    nextDisplayVideoFileName(title, await publishedVideoNames(studio.videoOutputRoot)),
  );
  // The published video carries its own timeline, named after itself, so it
  // stays page-editable wherever the folder is moved and never borrows the
  // boundaries of another run that landed in the same folder.
  if (renderDir) {
    await fs.copyFile(
      path.join(renderDir, "timeline.json"),
      path.join(outputDir, videoTimelineFileName(target)),
    ).catch(() => {});
  }
  if (path.resolve(source) === path.resolve(target)) return target;
  try {
    await fs.rename(source, target);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await fs.copyFile(source, target);
    await fs.unlink(source);
  }
  return target;
}

async function validateResult({ sourceDir, renderDir, options, studio }) {
  const manifest = JSON.parse(await fs.readFile(path.join(sourceDir, "manifest.json"), "utf8"));
  const voiceQuality = manifest.quality?.enabled ? manifest.quality.summary : null;
  const voiceFindings = voiceQualityFindings(manifest);
  const audioProbe = await ffprobe(manifest.audioPath);
  const audioDurationMs = Math.round(Number(audioProbe.format?.duration || 0) * 1000);
  const checks = [
    { label: "음성 파일", ok: audioProbe.streams?.some((stream) => stream.codec_type === "audio") },
    { label: "음성 길이", ok: Math.abs(audioDurationMs - Number(manifest.durationMs)) <= 150 },
    { label: "타임라인", ok: Array.isArray(manifest.entries) && manifest.entries.length > 0 },
  ];
  let videoPath = null;

  if (options.deliverable !== "audio") {
    const timeline = JSON.parse(await fs.readFile(path.join(renderDir, "timeline.json"), "utf8"));
    const captions = JSON.parse(await fs.readFile(path.join(renderDir, "captions.json"), "utf8"));
    checks.push(
      { label: "자막 생성", ok: Array.isArray(captions) && captions.length > 0 },
      { label: "자막 범위", ok: Number(captions.at(-1)?.endMs || 0) <= Number(timeline.totalMs) + 50 },
      { label: "화면 타임라인", ok: Math.abs(Number(timeline.totalMs) - Number(manifest.durationMs)) <= 1 },
    );
  }

  if (options.deliverable === "video") {
    videoPath = await findVideo(renderDir, options.name);
    if (!videoPath) throw new Error("촬영은 끝났지만 MP4 파일을 찾지 못했습니다.");
    const videoProbe = await ffprobe(videoPath);
    const videoDurationMs = Math.round(Number(videoProbe.format?.duration || 0) * 1000);
    const videoStream = videoProbe.streams?.find((stream) => stream.codec_type === "video");
    checks.push(
      { label: "영상 파일", ok: Boolean(videoStream) },
      { label: "영상 크기", ok: Number(videoStream?.width) === 1920 && Number(videoStream?.height) === 1080 },
      { label: "영상 음성", ok: videoProbe.streams?.some((stream) => stream.codec_type === "audio") },
      { label: "영상 길이", ok: Math.abs(videoDurationMs - Number(manifest.durationMs)) <= 200 },
    );
  }

  const summary = summarizeChecks(checks);
  if (summary.ok && videoPath) {
    videoPath = await publishVideo(videoPath, studio, options.name, options.title, renderDir);
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    name: options.name,
    displayName: options.title,
    sourceContract: manifest.sourceContract || null,
    lessonReview: options.deliverable === "video"
      ? await fs.readFile(path.join(renderDir, "lesson-review.json"), "utf8").then(JSON.parse)
      : null,
    sourceDir,
    renderDir: options.deliverable === "audio" ? null : renderDir,
    audioPath: manifest.audioPath,
    videoPath,
    durationMs: Number(manifest.durationMs),
    naturalness: manifest.naturalness || null,
    voiceQuality,
    voiceFindings,
    needsReview: voiceQuality?.needsReview || [],
    listenSuggested: voiceQuality?.listenSuggested || [],
    target: options.deliverable === "audio"
      ? { root: "pilot", day: path.basename(path.dirname(sourceDir)), name: options.name }
      : { root: "render", name: options.name },
    checks,
    summary,
  };
  const reportDir = options.deliverable === "audio" ? sourceDir : renderDir;
  await fs.writeFile(path.join(reportDir, "validation-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (!summary.ok) throw new Error(`자동 검증 실패: ${summary.failed.join(", ")}`);
  return report;
}

async function runPipelineUnit(options, studio, captureSiteDir) {
  const job = activeJob;
  const sourceDir = path.join(studio.ttsOutputRoot, dateFolder(), options.name);
  const renderDir = path.join(studio.captionOutputRoot, options.name);
  const providerName = `${options.name}-provider`;
  const ttsArgs = [
    "-m", "local_tts_engine.course_pilot",
    "--source-project", studio.sourceProjectRoot,
    "--reference", studio.referenceAudioPath,
    "--reference-text", studio.referenceTextPath,
    "--output-dir", sourceDir,
    "--target-seconds", String(options.targetSeconds),
    "--start-page", String(options.startPage),
    "--model", options.modelId || "qwen3-tts",
    "--no-cache",
  ];
  if (options.endPage !== null) ttsArgs.push("--end-page", String(options.endPage));
  if (options.voiceMode === "finetuned") {
    ttsArgs.push("--adapter", options.adapterPath || ADAPTER, "--adapter-scale", String(options.adapterScale));
  }

  await runProcess("voice", requireRuntimeTool("trainPython", "음성 생성 Python"), ttsArgs);
  const manifest = JSON.parse(await fs.readFile(path.join(sourceDir, "manifest.json"), "utf8"));

  let previousContract = null;
  try {
    if (options.deliverable !== "audio") {
      previousContract = await writeDeckContract(manifest, options, providerName, studio);
      await runProcess("export", requireRuntimeTool("basePython", "강의 도구 Python"), [
        "-m", "local_tts_engine.export_udemy",
        "--source-dir", sourceDir,
        "--deck-root", studio.deckRoot,
        "--preset", options.name,
        "--provider", providerName,
      ]);
      await runProcess("captions", requireRuntimeTool("node", "Node.js"), [
        "tools/captions.mjs",
        "--preset", options.name,
        "--provider", providerName,
      ], { cwd: studio.deckRoot });
    }

    if (options.deliverable === "video") {
      const captureArgs = [
        "tools/capture.mjs",
        "--preset", options.name,
        "--provider", providerName,
        "--no-cache",
      ];
      if (captureSiteDir) captureArgs.push("--site-dir", captureSiteDir);
      if (options.burnCaptions) captureArgs.push("--burn-captions");
      try {
        await runProcess("capture", requireRuntimeTool("node", "Node.js"), captureArgs, { cwd: studio.deckRoot });
      } catch (error) {
        if (job.cancelled) throw error;
        emit({
          type: "log",
          stream: "stderr",
          text: "화면 촬영이 중간에 멈춰 같은 음성과 타임라인으로 한 번 다시 시도합니다.\n",
        });
        await runProcess("capture", requireRuntimeTool("node", "Node.js"), captureArgs, { cwd: studio.deckRoot });
      }
    }
  } finally {
    if (previousContract) await restoreDeckContract(options, providerName, previousContract, studio);
  }

  const report = await validateResult({ sourceDir, renderDir, options, studio });
  if (activeJob !== job) return;
  if (job.cancelled) throw new Error("사용자가 작업을 중지했습니다.");
  return report;
}

function chapterUnitName(base, suffix) {
  const tail = `-${suffix}`;
  const maxBaseLength = Math.max(1, 64 - tail.length);
  return `${base.slice(0, maxBaseLength)}${tail}`;
}

function chapterUnits(options, catalog) {
  if (options.mode !== "chapter" || options.chapterMode !== "lesson") return [options];
  const lessons = (catalog.lessons || [])
    .filter((lesson) => lesson.chapter === options.startChapter || lesson.chapter === options.chapter)
    .sort((left, right) => Number(left.startPage) - Number(right.startPage));
  if (!lessons.length) return [options];
  return lessons.map((lesson) => ({
    ...options,
    name: chapterUnitName(options.name, lesson.id),
    title: lesson.title,
    mode: "lesson",
    chapterMode: "single",
    startPage: Number(lesson.startPage),
    endPage: Number(lesson.endPage),
  }));
}

function combineChapterReports(options, reports) {
  const checks = reports.flatMap((report) => report.checks || []);
  const summary = summarizeChecks(checks);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    name: options.name,
    displayName: options.title,
    mode: options.mode,
    chapterMode: options.chapterMode,
    durationMs: reports.reduce((total, report) => total + Number(report.durationMs || 0), 0),
    videoPath: reports.length === 1 ? reports[0].videoPath : null,
    audioPath: reports.length === 1 ? reports[0].audioPath : null,
    target: reports[0]?.target || null,
    voiceQuality: reports.length === 1 ? reports[0].voiceQuality : null,
    voiceFindings: reports.length === 1 ? reports[0].voiceFindings || [] : [],
    checks,
    summary,
    units: reports.map((report) => ({
      name: report.name,
      displayName: report.displayName,
      durationMs: report.durationMs,
      videoPath: report.videoPath || null,
      audioPath: report.audioPath || null,
      target: report.target,
      summary: report.summary,
      voiceFindings: report.voiceFindings || [],
    })),
  };
}

async function runPipeline(options) {
  const job = activeJob;
  const originalStudio = runtimePaths(options.paths);
  // 한 챕터를 여러 편으로 만들 때도 모든 편이 같은 입력을 사용한다.
  // 작업 트리의 대본·장표와 narration.config를 제작 중 다시 읽거나 고치지 않는다.
  const project = path.join(originalStudio.captionOutputRoot, options.name, ".production-input");
  // Own the directory before starting, including cancellation during the copy.
  // A pre-existing directory belongs to a previous run and must not be removed.
  const resuming = Boolean(options.resumeFrom);
  const snapshotExists = Boolean(await safeStat(project));
  // 이어하는 중이라면 이 폴더는 지난 실행이 얼려 둔 바로 그 입력이다. 다시
  // 만들면 '모든 편이 같은 입력을 쓴다'는 보장이 깨지므로 그대로 쓴다.
  if (snapshotExists && !resuming) throw new Error(`제작 입력 폴더가 이미 있습니다: ${project}`);
  job.productionInputDir = project;
  if (snapshotExists && resuming) {
    emit({ type: "log", stream: "stdout",
      text: "지난 실행이 얼려 둔 제작 입력을 그대로 이어서 사용합니다.\n" });
  } else await runProcess("snapshot", requireRuntimeTool("node", "Node.js"), [
    path.join(ROOT, "scripts/prepare-production-input.mjs"),
    JSON.stringify({ root: originalStudio.deckRoot, destination: project,
      from: options.startPage, to: options.endPage ?? undefined,
      expectedStartId: options.inputStartId, expectedEndId: options.inputEndId,
      build: options.deliverable === "video", node: requireRuntimeTool("node", "Node.js") }),
  ]);
  const input = { project, deck: path.join(project, "deck"),
    site: options.deliverable === "video" ? path.join(project, "site") : null };
  const studio = { ...originalStudio, sourceProjectRoot: input.project, deckRoot: input.deck,
    configPath: path.join(input.deck, "narration.config.json") };
  emit({ type: "log", stream: "stdout",
    text: "화면·대본·장표 순서를 함께 고정하고 제작 전 검사를 마쳤습니다. 이번 제작은 이 입력을 사용합니다.\n" });
  const catalog = options.mode === "chapter" && options.chapterMode === "lesson"
    ? await loadCatalog(studio, { tracked: true })
    : null;
  const units = chapterUnits(options, catalog);
  // 챕터 전체 남은 시간은 페이지 수로만 낼 수 있다. 편마다 분량이 크게 달라
  // 편 개수로 세면 남은 편이 가벼운지 무거운지를 놓친다. 여러 편으로 나눌
  // 때에만 보내고, 한 편짜리에는 두 번째 시계가 필요 없다.
  if (units.length > 1) {
    emit({
      type: "plan",
      units: units.map((unit) => ({
        title: unit.title,
        pages: Math.max(1, Number(unit.endPage) - Number(unit.startPage) + 1),
      })),
    });
  }
  const finished = units.length > 1 ? await finishedUnitNames(units, studio) : [];
  const remaining = pendingUnits(units, finished);
  if (finished.length) {
    emit({ type: "log", stream: "stdout",
      text: `이미 완성된 ${finished.length}편은 건너뜁니다. ${remaining.length}편을 이어서 만듭니다.\n` });
  }
  const reports = [];
  await writeActiveJob({
    schemaVersion: 1, id: job.id, startedAt: job.startedAt, options,
    unitNames: units.map((unit) => unit.name), completed: [...finished],
  });
  for (const [index, unit] of units.entries()) {
    if (job.cancelled) throw new Error("사용자가 작업을 중지했습니다.");
    if (finished.includes(unit.name)) continue;
    // 일시정지는 편 사이에서 확정된다. 앱이 꺼져도 이어할 수 있는 지점이 곧
    // 여기이므로, 멈추는 자리와 이어붙이는 자리를 같게 둔다.
    while (job.pauseRequested && !job.cancelled) {
      if (job.state !== "paused") { job.state = "paused"; emit({ type: "paused" }); }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (job.cancelled) throw new Error("사용자가 작업을 중지했습니다.");
    if (job.state === "paused") { job.state = "running"; emit({ type: "resumed" }); }
    if (units.length > 1) {
      emit({ type: "unit", index: index + 1, total: units.length, title: unit.title });
      emit({
        type: "log",
        stream: "stdout",
        text: `챕터 레슨 단위 ${index + 1}/${units.length}: ${unit.title}를 제작합니다.\n`,
      });
    }
    const report = await runPipelineUnit(unit, studio, input.site);
    if (!report) return;
    if (units.length > 1) {
      finished.push(unit.name);
      await writeActiveJob({
        schemaVersion: 1, id: job.id, startedAt: job.startedAt, options,
        unitNames: units.map((item) => item.name), completed: [...finished],
      }).catch(() => {});
    }
    reports.push(report);
  }
  if (activeJob !== job) return;
  if (job.cancelled) throw new Error("사용자가 작업을 중지했습니다.");
  const report = units.length > 1 ? combineChapterReports(options, reports) : reports[0];
  await cleanupCaptureSite(job);
  if (job.cancelled) throw new Error("사용자가 작업을 중지했습니다.");
  job.state = "done";
  job.stage = "done";
  await clearActiveJob();
  emit({ type: "complete", report });
}

function launchPipeline(options) {
  activeJob = {
    id: crypto.randomUUID(),
    kind: "create",
    options,
    state: "running",
    stage: "starting",
    child: null,
    children: new Set(),
    cancelled: false,
    startedAt: new Date().toISOString(),
  };
  const snapshot = jobSnapshot();
  emit({ type: "started", job: snapshot, options });
  const job = activeJob;
  runPipeline(options).catch(async (error) => {
    await cleanupCaptureSite(job);
    if (activeJob !== job) return;
    job.state = job.cancelled ? "cancelled" : "failed";
    job.error = error.message;
    // 중지는 그만두겠다는 뜻이므로 이어할 기록을 지운다. 실패는 다르다. 원인을
    // 고치고 이어서 만들 수 있어야 두 시간이 날아가지 않는다.
    if (job.cancelled) await clearActiveJob();
    emit({ type: "failed", cancelled: job.cancelled, message: error.message });
  }).finally(() => cleanupCaptureSite(job));
  return snapshot;
}

async function cleanupCaptureSite(job) {
  for (const key of ["captureSiteDir", "productionInputDir"]) {
    const directory = job?.[key];
    if (!directory) continue;
    job[key] = null;
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function inspectMedia(file) {
  const raw = await runUtility(requireRuntimeTool("ffprobe", "FFprobe"), [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,sample_rate,channels",
    "-of", "json",
    file,
  ]);
  return JSON.parse(raw);
}

function chosenRecord(token, kind) {
  const selected = selectedFiles.get(String(token || ""));
  if (!selected || selected.kind !== kind) throw new Error("선택한 로컬 파일을 다시 지정해 주세요.");
  return selected;
}

function chosenFile(token, kind) {
  return chosenRecord(token, kind).path;
}

async function findVideoTimeline(videoPath) {
  const settings = await readAppSettings().catch(() => null);
  const captionRoot = settings ? runtimePaths(settings.paths).captionOutputRoot : null;
  for (const candidate of videoTimelineCandidates(videoPath, captionRoot)) {
    if (await safeStat(candidate)) return candidate;
  }
  return null;
}

async function registerSelected(paths, kind, extras = []) {
  return Promise.all(paths.map(async (file, index) => {
    const token = crypto.randomUUID();
    const value = {
      token,
      kind,
      path: path.resolve(file),
      name: path.basename(file),
      timelinePath: null,
      pageRange: null,
      ...(extras[index] || {}),
    };
    if (kind === "video" && !value.timelinePath) {
      const timelinePath = await findVideoTimeline(value.path);
      const timeline = timelinePath
        ? await fs.readFile(timelinePath, "utf8").then(JSON.parse).catch(() => null)
        : null;
      const pageRange = pageRangeFromTimeline(timeline);
      if (pageRange) {
        value.timelinePath = timelinePath;
        value.pageRange = pageRange;
        value.pages = reviewPages(timeline);
      }
    }
    if (kind === "video") {
      const settings = await readAppSettings();
      const captionRoot = runtimePaths(settings.paths).captionOutputRoot;
      const reports = [path.join(path.dirname(value.path), "validation-report.json"),
        path.join(captionRoot, path.basename(path.dirname(value.path)), "validation-report.json")];
      for (const reportPath of reports) {
        const report = await fs.readFile(reportPath, "utf8").then(JSON.parse).catch(() => null);
        if (report?.videoPath && path.resolve(report.videoPath) === value.path) {
          value.voiceFindings = report.voiceFindings || [];
          // 확인 완료 표시는 결과에 적혀 있다. 다시 열어도 그대로 남아야 한다.
          value.clearedFindings = clearedFindingKeys(report);
          value.reviewTarget = report.target || null;
          break;
        }
      }
    }
    selectedFiles.set(token, value);
    return { token, kind, name: value.name, path: value.path, pageRange: value.pageRange, audioUrl: kind === "audio" ? pathToFileURL(value.path).href : null, pages: value.pages || [], voiceFindings: value.voiceFindings || [], clearedFindings: value.clearedFindings || [], reviewTarget: value.reviewTarget || null, videoUrl: kind === "video" ? pathToFileURL(value.path).href : null };
  }));
}

async function normalizeMergeSegment(input, output, { startSeconds = 0, durationSeconds = null } = {}) {
  const probe = await inspectMedia(input);
  const whole = Number(probe.format?.duration || 0);
  if (!whole) throw new Error(`영상 길이를 읽지 못했습니다: ${path.basename(input)}`);
  const duration = durationSeconds == null ? whole : durationSeconds;
  const hasAudio = probe.streams?.some((stream) => stream.codec_type === "audio");
  // -ss before -i seeks by keyframe; placing it after decodes from the start and
  // cuts on the exact frame, which is what a cut the user positioned deserves.
  const args = ["-y", "-hide_banner", "-nostats", "-i", input];
  if (startSeconds > 0) args.push("-ss", startSeconds.toFixed(3));
  if (!hasAudio) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono");
  args.push(
    "-map", "0:v:0",
    "-map", hasAudio ? "0:a:0" : "1:a:0",
    "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=25,format=yuv420p",
    "-af", "aresample=48000,apad",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-t", duration.toFixed(3), "-movflags", "+faststart", output,
  );
  await runProcess("edit", requireRuntimeTool("ffmpeg", "FFmpeg"), args);
}

async function validateEditVideo(outputPath, operation, inputs, outputDir) {
  const probe = await ffprobe(outputPath);
  const durationMs = Math.round(Number(probe.format?.duration || 0) * 1000);
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const checks = [
    { label: "영상 파일", ok: Boolean(video) },
    { label: "영상 길이", ok: durationMs > 0 },
    { label: "음성 트랙", ok: probe.streams?.some((stream) => stream.codec_type === "audio") },
  ];
  const summary = summarizeChecks(checks);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    name: path.basename(outputDir),
    operation,
    inputs,
    videoPath: outputPath,
    durationMs,
    checks,
    summary,
    target: { root: "edit", day: path.basename(path.dirname(outputDir)), name: path.basename(outputDir) },
  };
  await fs.writeFile(path.join(outputDir, "validation-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (!summary.ok) throw new Error(`자동 검증 실패: ${summary.failed.join(", ")}`);
  return report;
}

// The app's own lectures already come out at the target spec, so re-encoding
// them to concatenate costs an hour of x264 to change nothing. Only inputs that
// actually differ are normalized.
function mergeSegmentMatchesTarget(probe) {
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  if (!video || !audio) return false;
  const [num, den] = String(video.r_frame_rate || "").split("/").map(Number);
  return video.codec_name === "h264"
    && Number(video.width) === 1920 && Number(video.height) === 1080
    && video.pix_fmt === "yuv420p"
    && den > 0 && Math.abs(num / den - 25) < 0.01
    && audio.codec_name === "aac" && Number(audio.sample_rate) === 48000;
}

/**
 * Render one edit list: any number of clips, each with its own in and out.
 *
 * This is the only video assembly path. Trimming is a single clip with a range,
 * merging is several clips without one, and the mixture the two old tabs could
 * not express costs nothing extra here.
 *
 * Cut precision is decided per clip rather than per job. A clip that spans its
 * whole source and already matches the target spec is carried through
 * untouched; only a clip with a real cut is re-encoded, and then only that
 * clip. Joining sixteen finished lessons therefore copies rather than spending
 * an hour of x264 to change nothing.
 */
async function runComposeEdit(options, outputDir) {
  const records = (options.clips || []).map((clip) => chosenRecord(clip.videoToken, "video"));
  const probes = await Promise.all(records.map((record) => inspectMedia(record.path)));
  const durations = probes.map((probe) => Math.round(Number(probe.format?.duration || 0) * 1000));
  const segments = normalizeComposeClips(options.clips, durations);

  const workDir = path.join(outputDir, "work");
  await fs.mkdir(workDir, { recursive: true });

  const prepared = [];
  for (const segment of segments) {
    const record = records[segment.index];
    const carry = !segment.trimmed && mergeSegmentMatchesTarget(probes[segment.index]);
    if (carry) { prepared.push(record.path); continue; }
    const output = path.join(workDir, `${String(segment.index + 1).padStart(3, "0")}.mp4`);
    await normalizeMergeSegment(record.path, output, {
      startSeconds: segment.inMs / 1000,
      durationSeconds: segment.lengthMs / 1000,
    });
    prepared.push(output);
  }

  const reencoded = prepared.filter((file, index) => file !== records[segments[index].index].path).length;
  emit({ type: "log", stream: "stdout",
    text: reencoded === 0
      ? `클립 ${segments.length}개를 모두 다시 굽지 않고 그대로 이어 붙입니다.\n`
      : `클립 ${segments.length}개 중 ${reencoded}개만 다시 굽습니다. 나머지는 원본을 그대로 씁니다.\n` });

  const output = path.join(outputDir, `${options.name}.mp4`);
  if (prepared.length === 1) {
    await fs.copyFile(prepared[0], output);
  } else {
    const concatPath = path.join(workDir, "concat.txt");
    await fs.writeFile(
      concatPath,
      `${prepared.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n")}\n`,
      "utf8",
    );
    await runProcess("edit", requireRuntimeTool("ffmpeg", "FFmpeg"), [
      "-y", "-hide_banner", "-nostats",
      "-f", "concat", "-safe", "0", "-i", concatPath,
      "-c", "copy", "-movflags", "+faststart", output,
    ]);
  }

  const report = await validateEditVideo(output, "compose", records.map((record) => record.path), outputDir);

  // Each clip's page boundaries are cut to its own range and then joined, so a
  // composed video stays something the app can still repair page by page.
  const parts = await Promise.all(segments.map(async (segment) => {
    const record = records[segment.index];
    const source = record.timelinePath
      ? await fs.readFile(record.timelinePath, "utf8").then(JSON.parse).catch(() => null)
      : null;
    return {
      durationMs: segment.lengthMs,
      timeline: source && (segment.trimmed ? clipTimeline(source, segment.inMs, segment.outMs) : source),
    };
  }));
  const timeline = concatTimelines(parts);
  if (timeline) {
    const timelinePath = path.join(outputDir, "timeline.json");
    await fs.writeFile(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`, "utf8");
    report.timelinePath = timelinePath;
  } else {
    emit({ type: "log", stream: "stdout",
      text: "편집 결과에 페이지 타임라인이 없습니다. 이 영상은 페이지 단위로 다듬을 수 없습니다.\n" });
  }
  report.clips = segments.map((segment) => ({
    name: records[segment.index].name,
    inMs: segment.inMs, outMs: segment.outMs, lengthMs: segment.lengthMs,
  }));
  report.plannedMs = composeTotalMs(segments);
  report.videoReencoded = reencoded > 0;
  await fs.writeFile(path.join(outputDir, "validation-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}



async function generateReplacementVoice(options, outputDir) {
  const studio = runtimePaths(options.paths);
  const voiceDir = path.join(outputDir, "generated-voice");
  const args = [
    "-m", "local_tts_engine.course_pilot",
    "--source-project", studio.sourceProjectRoot,
    "--reference", studio.referenceAudioPath,
    "--reference-text", studio.referenceTextPath,
    "--output-dir", voiceDir,
    "--target-seconds", "30",
    "--start-page", String(options.startPage),
    "--end-page", String(options.endPage),
    "--model", options.modelId || "qwen3-tts",
    "--no-cache",
    "--quality-attempts", String(options.qualityAttempts || DEFAULT_QUALITY_ATTEMPTS),
  ];
  if (options.seed) args.push("--seed", String(options.seed));
  if (options.voiceMode !== "zero") {
    args.push("--adapter", options.adapterPath || ADAPTER, "--adapter-scale", String(options.adapterScale));
  }
  await runProcess("voice", requireRuntimeTool("trainPython", "음성 생성 Python"), args);
  const manifest = JSON.parse(await fs.readFile(path.join(voiceDir, "manifest.json"), "utf8"));
  const firstChunk = manifest.chunks?.[0];
  const lastChunk = manifest.chunks?.at(-1);
  if (!firstChunk || !lastChunk) throw new Error("생성된 목소리의 음성 구간을 찾지 못했습니다.");
  return {
    audioPath: manifest.audioPath,
    voiceFindings: voiceQualityFindings(manifest),
    generatedVoice: {
      manifestPath: path.join(voiceDir, "manifest.json"),
      sourceStartMs: Number(firstChunk.startMs),
      sourceEndMs: Number(lastChunk.endMs),
      startPage: Number(options.startPage),
      endPage: Number(options.endPage),
    },
  };
}

async function runVoiceCandidates(options, outputDir) {
  assertPageReplaceable(chosenRecord(options.videoToken, "video"), options);
  const count = Math.min(8, Math.max(2, Math.round(Number(options.candidateCount ?? 3))));
  const digest = crypto.createHash("sha256").update(options.name).digest();
  const baseSeed = digest.readUInt32BE(0);
  const candidates = [];
  for (let index = 0; index < count; index += 1) {
    const candidateName = `candidate-${String(index + 1).padStart(2, "0")}`;
    const candidateDir = path.join(outputDir, "candidates", candidateName);
    await fs.mkdir(candidateDir, { recursive: true });
    const seed = (baseSeed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
    // One take per candidate: the point of candidates is a spread of readings
    // to choose between, not one reading retried until it scores well. They run
    // one at a time because each run holds the generator and the reader at once.
    const generated = await generateReplacementVoice({ ...options, seed, qualityAttempts: 1 }, candidateDir);
    candidates.push({ index: index + 1, seed, ...generated });
    emit({ type: "voice-item-complete", completed: candidates.length, total: count, name: `후보 ${index + 1}` });
  }
  const registered = await registerSelected(
    candidates.map((item) => item.audioPath),
    "audio",
    candidates.map((item) => ({ generatedVoice: item.generatedVoice })),
  );
  return candidates.map((item, index) => ({
    ...item,
    token: registered[index].token,
    name: `목소리 후보 ${item.index}`,
    audioUrl: pathToFileURL(item.audioPath).href,
  }));
}

async function runTextVoiceCandidates(options) {
  const job = activeJob;
  const studio = runtimePaths(options.paths);
  const outputDir = path.join(studio.voiceOutputRoot, dateFolder(), options.name);
  const candidatesDir = path.join(outputDir, "candidates");
  const inputPath = path.join(outputDir, "input.txt");
  await fs.mkdir(candidatesDir, { recursive: true });
  await fs.writeFile(inputPath, `${options.text}\n`, "utf8");
  await fs.unlink(path.join(outputDir, "selected.wav")).catch(() => {});
  await fs.unlink(path.join(outputDir, "validation-report.json")).catch(() => {});

  const digest = crypto.createHash("sha256").update(`${options.name}\n${options.text}`).digest();
  const baseSeed = digest.readUInt32BE(0);
  let completed = 0;
  const candidates = await mapWithConcurrency(
    Array.from({ length: options.candidateCount }, (_, index) => index),
    options.voiceParallelism || 2,
    async (index) => {
      const number = String(index + 1).padStart(2, "0");
      const audioPath = path.join(candidatesDir, `candidate-${number}.wav`);
      const metadataPath = path.join(candidatesDir, `candidate-${number}.json`);
      const seed = (baseSeed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
      const args = [
        "-m", "local_tts_engine.text_candidate",
        "--model", options.modelId,
        "--text-file", inputPath,
        "--reference", studio.referenceAudioPath,
        "--reference-text", studio.referenceTextPath,
        "--output", audioPath,
        "--metadata", metadataPath,
        "--seed", String(seed),
      ];
      if (options.voiceMode === "finetuned") {
        args.push("--adapter", options.adapterPath || ADAPTER, "--adapter-scale", String(options.adapterScale));
      }
      await runProcess("voice", requireRuntimeTool("trainPython", "음성 생성 Python"), args);
      const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
      completed += 1;
      emit({ type: "voice-item-complete", completed, total: options.candidateCount, name: `후보 ${index + 1}` });
      return { index: index + 1, seed, audioPath, metadata };
    },
  );
  if (activeJob !== job) return;

  const registered = await registerSelected(candidates.map((item) => item.audioPath), "audio");
  const values = candidates.map((item, index) => ({
    index: item.index,
    seed: item.seed,
    token: registered[index].token,
    name: `목소리 후보 ${item.index}`,
    durationMs: item.metadata.durationMs,
    audioUrl: pathToFileURL(item.audioPath).href,
  }));
  await fs.writeFile(path.join(outputDir, "index.json"), `${JSON.stringify({
    schemaVersion: 1,
    cachePolicy: "disabled",
    text: options.text,
    modelId: options.modelId,
    candidateCount: options.candidateCount,
    parallelism: options.voiceParallelism,
    candidates: values.map(({ audioUrl: _audioUrl, token: _token, ...item }) => item),
  }, null, 2)}\n`, "utf8");
  job.state = "done";
  job.stage = "awaiting-selection";
  job.outputDir = outputDir;
  job.candidateTokens = new Set(values.map((item) => item.token));
  emit({ type: "text-voices-ready", candidates: values, options });
}

async function selectTextVoice(token) {
  if (!activeJob || activeJob.kind !== "text-voice" || activeJob.stage !== "awaiting-selection") {
    throw new Error("선택할 목소리 후보 작업이 없습니다.");
  }
  if (!activeJob.candidateTokens?.has(token)) throw new Error("이 작업의 목소리 후보가 아닙니다.");
  const selected = chosenRecord(token, "audio");
  const outputPath = path.join(activeJob.outputDir, "selected.wav");
  await fs.copyFile(selected.path, outputPath);
  const probe = await inspectMedia(outputPath);
  const durationMs = Math.round(Number(probe.format?.duration || 0) * 1000);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    name: activeJob.options.name,
    operation: "text-voice",
    cachePolicy: "disabled",
    audioPath: outputPath,
    selectedSource: selected.path,
    durationMs,
    summary: { ok: durationMs > 0, passed: durationMs > 0 ? 1 : 0, total: 1, failed: durationMs > 0 ? [] : ["음성 길이"] },
    target: {
      root: "voice",
      day: path.basename(path.dirname(activeJob.outputDir)),
      name: activeJob.options.name,
    },
  };
  await fs.writeFile(path.join(activeJob.outputDir, "validation-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  activeJob.state = "done";
  activeJob.stage = "done";
  emit({ type: "text-voice-selected", report });
  return report;
}

async function runPageVoicePatch(videoRecord, audioRecord, options, outputDir) {
  const timeline = JSON.parse(await fs.readFile(videoRecord.timelinePath, "utf8"));
  const target = timeRangeForPages(timeline.entries, Number(options.startPage), Number(options.endPage));
  const targetStart = target.start;
  const targetEnd = target.end;
  const generated = audioRecord.generatedVoice;
  if (
    Number(generated.startPage) !== Number(options.startPage)
    || Number(generated.endPage) !== Number(options.endPage)
  ) {
    throw new Error("생성한 목소리와 교체할 페이지 범위가 다릅니다. 후보를 다시 만들어 주세요.");
  }
  const sourceStart = Number(generated.sourceStartMs) / 1000;
  const sourceEnd = Number(generated.sourceEndMs) / 1000;

  const videoProbe = await inspectMedia(videoRecord.path);
  const videoDuration = Number(videoProbe.format?.duration || 0);
  if (!videoDuration || !videoProbe.streams?.some((stream) => stream.codec_type === "audio")) {
    throw new Error("페이지 음성 교체에는 기존 음성 트랙과 타임라인이 필요합니다.");
  }
  const matchAudio = options.durationPolicy === "match-audio";
  const patchPlan = pageVoicePatchPlan({
    videoDuration,
    targetStart,
    targetEnd,
    sourceStart,
    sourceEnd,
    matchAudio,
  });

  const output = path.join(outputDir, `${options.name}.mp4`);
  await runProcess("edit", requireRuntimeTool("ffmpeg", "FFmpeg"), [
    "-y", "-hide_banner", "-nostats", "-i", videoRecord.path, "-i", audioRecord.path,
    "-filter_complex", patchPlan.filter,
    "-map", patchPlan.videoOutput, "-map", patchPlan.audioOutput,
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", output,
  ]);

  const replacementDurationMs = Math.round(patchPlan.replacementDuration * 1000);
  const nextTimeline = patchedTimeline(
    timeline,
    Math.round(targetStart * 1000),
    Math.round(targetEnd * 1000),
    replacementDurationMs,
  );
  const timelinePath = path.join(outputDir, "timeline.json");
  await fs.writeFile(timelinePath, `${JSON.stringify(nextTimeline, null, 2)}\n`, "utf8");
  const report = await validateEditVideo(
    output,
    "voice-page",
    [videoRecord.path, audioRecord.path],
    outputDir,
  );
  report.timelinePath = timelinePath;
  report.pageRange = { start: Number(options.startPage), end: Number(options.endPage) };
  await fs.writeFile(path.join(outputDir, "validation-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

async function runVoiceEdit(options, outputDir) {
  const videoRecord = chosenRecord(options.videoToken, "video");
  const audioRecord = options.audioSource === "generate"
    ? await generateReplacementVoice(options, outputDir).then((value) => ({ path: value.audioPath, generatedVoice: value.generatedVoice }))
    : chosenRecord(options.audioToken, "audio");
  if (audioRecord.generatedVoice) {
    assertPageReplaceable(videoRecord, audioRecord.generatedVoice);
    return runPageVoicePatch(videoRecord, audioRecord, options, outputDir);
  }
  const video = videoRecord.path;
  const audio = audioRecord.path;
  const [videoProbe, audioProbe] = await Promise.all([inspectMedia(video), inspectMedia(audio)]);
  const videoDuration = Number(videoProbe.format?.duration || 0);
  const audioDuration = Number(audioProbe.format?.duration || 0);
  if (!videoDuration || !audioDuration) throw new Error("영상 또는 음성 길이를 읽지 못했습니다.");
  const output = path.join(outputDir, `${options.name}.mp4`);
  if (options.durationPolicy === "match-audio") {
    const factor = audioDuration / videoDuration;
    await runProcess("edit", requireRuntimeTool("ffmpeg", "FFmpeg"), [
      "-y", "-hide_banner", "-nostats", "-i", video, "-i", audio,
      "-map", "0:v:0", "-map", "1:a:0",
      "-vf", `setpts=${factor.toFixed(8)}*PTS,fps=25,format=yuv420p`,
      "-c:v", "libx264", "-preset", "medium", "-crf", "18",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-t", audioDuration.toFixed(3), "-movflags", "+faststart", output,
    ]);
  } else {
    await runProcess("edit", requireRuntimeTool("ffmpeg", "FFmpeg"), [
      "-y", "-hide_banner", "-nostats", "-i", video, "-i", audio,
      "-filter_complex", `[1:a]apad=whole_dur=${videoDuration.toFixed(3)}[voice]`,
      "-map", "0:v:0", "-map", "[voice]",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-t", videoDuration.toFixed(3), "-movflags", "+faststart", output,
    ]);
  }
  return validateEditVideo(output, "voice", [video, audio], outputDir);
}

/**
 * Apply every approved page replacement to a lecture in one pass.
 *
 * Applying them one at a time re-encoded the whole lecture per fix and left a
 * file behind each time, so four flagged pages in a seventeen-minute lecture
 * cost four full 1080p encodes and produced four videos to keep track of. One
 * pass produces one video, and when no replacement changes a page's length the
 * picture is stream-copied rather than re-encoded at all.
 */
async function runPageVoicePatchBatch(options, outputDir) {
  const videoRecord = chosenRecord(options.videoToken, "video");
  if (!videoRecord.timelinePath) {
    throw new Error("페이지 음성 교체에는 기존 음성 트랙과 타임라인이 필요합니다.");
  }
  const requested = Array.isArray(options.patches) ? options.patches : [];
  if (requested.length === 0) throw new Error("교체할 페이지를 선택해 주세요.");
  if (requested.length > 40) throw new Error("한 번에 최대 40개 페이지까지 교체할 수 있습니다.");

  const timeline = JSON.parse(await fs.readFile(videoRecord.timelinePath, "utf8"));
  const videoProbe = await inspectMedia(videoRecord.path);
  const videoDuration = Number(videoProbe.format?.duration || 0);
  if (!videoDuration || !videoProbe.streams?.some((stream) => stream.codec_type === "audio")) {
    throw new Error("페이지 음성 교체에는 기존 음성 트랙과 타임라인이 필요합니다.");
  }

  // ffmpeg addresses replacement audio by input position, so the position is
  // fixed here and travels with each patch through the plan's own sorting.
  const inputPaths = [];
  const inputIndexFor = (file) => {
    const existing = inputPaths.indexOf(file);
    if (existing !== -1) return existing + 1;
    inputPaths.push(file);
    return inputPaths.length;
  };

  const entries = requested.map((patch) => {
    const startPage = Number(patch.startPage);
    const endPage = Number(patch.endPage ?? patch.startPage);
    assertPageReplaceable(videoRecord, { startPage, endPage });
    const audioRecord = chosenRecord(patch.audioToken, "audio");
    const generated = audioRecord.generatedVoice;
    if (!generated) throw new Error("선택한 목소리에 페이지 정보가 없습니다. 후보를 다시 만들어 주세요.");
    if (Number(generated.startPage) !== startPage || Number(generated.endPage) !== endPage) {
      throw new Error("생성한 목소리와 교체할 페이지 범위가 다릅니다. 후보를 다시 만들어 주세요.");
    }
    const target = timeRangeForPages(timeline.entries, startPage, endPage);
    return {
      startPage,
      endPage,
      targetStart: target.start,
      targetEnd: target.end,
      sourceStart: Number(generated.sourceStartMs) / 1000,
      sourceEnd: Number(generated.sourceEndMs) / 1000,
      input: inputIndexFor(audioRecord.path),
    };
  });

  const matchAudio = options.durationPolicy === "match-audio";
  const plan = pageVoicePatchesPlan({ videoDuration, matchAudio, patches: entries });

  const output = path.join(outputDir, `${options.name}.mp4`);
  await runProcess("edit", requireRuntimeTool("ffmpeg", "FFmpeg"), [
    "-y", "-hide_banner", "-nostats",
    "-i", videoRecord.path,
    ...inputPaths.flatMap((file) => ["-i", file]),
    "-filter_complex", plan.filter,
    "-map", plan.videoOutput, "-map", plan.audioOutput,
    ...(plan.videoUnchanged
      ? ["-c:v", "copy"]
      : ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"]),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", output,
  ]);

  // Each patch shifts everything after it, so folding them back-to-front keeps
  // the earlier patches' original timeline coordinates valid.
  let nextTimeline = timeline;
  for (const patch of [...plan.patches].reverse()) {
    nextTimeline = patchedTimeline(
      nextTimeline,
      Math.round(patch.targetStart * 1000),
      Math.round(patch.targetEnd * 1000),
      Math.round(patch.replacementDuration * 1000),
    );
  }
  const timelinePath = path.join(outputDir, "timeline.json");
  await fs.writeFile(timelinePath, `${JSON.stringify(nextTimeline, null, 2)}\n`, "utf8");

  const report = await validateEditVideo(
    output,
    "voice-pages",
    [videoRecord.path, ...inputPaths],
    outputDir,
  );
  report.timelinePath = timelinePath;
  report.videoReencoded = !plan.videoUnchanged;
  report.pages = entries
    .map((entry) => ({ startPage: entry.startPage, endPage: entry.endPage }))
    .sort((left, right) => left.startPage - right.startPage);
  await fs.writeFile(path.join(outputDir, "validation-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

async function runVoiceBatchEdit(options, outputDir) {
  const items = Array.isArray(options.videoItems) && options.videoItems.length
    ? options.videoItems
    : [{ videoToken: options.videoToken, startPage: options.startPage, endPage: options.endPage }];
  if (items.length > 20) throw new Error("목소리 교체는 한 번에 최대 20개까지 실행할 수 있습니다.");
  const concurrency = options.audioSource === "generate"
    ? 1
    : Math.min(Number(options.voiceParallelism || 2), items.length);
  let completed = 0;
  const results = await mapWithConcurrency(items, concurrency, async (item, index) => {
      const selected = chosenRecord(item.videoToken, "video");
      const stem = path.parse(selected.name).name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `item-${index + 1}`;
      const itemName = `${String(index + 1).padStart(2, "0")}-${stem}`.slice(0, 64).replace(/-$/, "");
      const itemDir = path.join(outputDir, "items", itemName);
      await fs.mkdir(itemDir, { recursive: true });
      const result = await runVoiceEdit({
        ...options,
        ...item,
        videoToken: item.videoToken,
        startPage: Number(item.startPage),
        endPage: Number(item.endPage),
        name: itemName,
      }, itemDir);
      completed += 1;
      emit({ type: "voice-item-complete", completed, total: items.length, name: selected.name });
      return result;
  });
  const summary = {
    ok: results.every((item) => item.summary.ok),
    passed: results.reduce((total, item) => total + item.summary.passed, 0),
    total: results.reduce((total, item) => total + item.summary.total, 0),
    failed: results.flatMap((item) => item.summary.failed),
  };
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    name: options.name,
    operation: "voice-batch",
    parallelism: concurrency,
    durationMs: results.reduce((total, item) => total + item.durationMs, 0),
    videoPath: results[0].videoPath,
    outputs: results.map((item) => item.videoPath),
    summary,
    target: { root: "edit", day: path.basename(path.dirname(outputDir)), name: options.name },
  };
  await fs.writeFile(path.join(outputDir, "validation-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

async function runMuteEdit(options, outputDir) {
  const record = chosenRecord(options.videoToken, "video");
  const probe = await inspectMedia(record.path);
  if (!probe.streams?.some(stream => stream.codec_type === "audio")) throw new Error("음성 트랙이 없는 영상입니다.");
  const start = Number(options.muteStart), end = Number(options.muteEnd);
  const filter = muteRegionFilter(start, end, Number(probe.format?.duration));
  const output = path.join(outputDir, `${options.name}.mp4`);
  await runProcess("edit", requireRuntimeTool("ffmpeg", "FFmpeg"), [
    "-n", "-hide_banner", "-nostats", "-i", record.path, "-map", "0:v:0", "-map", "0:a:0",
    "-c:v", "copy", "-af", filter, "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output,
  ]);
  if (record.timelinePath) {
    await fs.copyFile(record.timelinePath, path.join(outputDir, "timeline.json"));
    await fs.copyFile(record.timelinePath, path.join(outputDir, videoTimelineFileName(output)));
  }
  const report = await validateEditVideo(output, "mute-region", [record.path], outputDir);
  report.repair = { startMs: Math.round(start * 1000), endMs: Math.round(end * 1000), fadeMs: 5 };
  report.review = { status: "pending" };
  await fs.writeFile(path.join(outputDir, "validation-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function runRegionReplaceEdit(options, outputDir) {
  const video = chosenRecord(options.videoToken, "video");
  const audio = chosenRecord(options.audioToken, "audio");
  const [videoProbe, audioProbe] = await Promise.all([inspectMedia(video.path), inspectMedia(audio.path)]);
  if (!videoProbe.streams?.some(s => s.codec_type === "audio") || !audioProbe.streams?.some(s => s.codec_type === "audio")) throw new Error("영상과 교체 파일에 음성 트랙이 필요합니다.");
  const start = Number(options.muteStart), end = Number(options.muteEnd);
  const filter = replaceRegionPlan(start, end, Number(videoProbe.format?.duration), Number(audioProbe.format?.duration));
  const output = path.join(outputDir, `${options.name}.mp4`);
  await runProcess("edit", requireRuntimeTool("ffmpeg", "FFmpeg"), [
    "-n", "-hide_banner", "-nostats", "-i", video.path, "-i", audio.path,
    "-filter_complex", filter, "-map", "0:v:0", "-map", "[outa]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output,
  ]);
  if (video.timelinePath) {
    await fs.copyFile(video.timelinePath, path.join(outputDir, "timeline.json"));
    await fs.copyFile(video.timelinePath, path.join(outputDir, videoTimelineFileName(output)));
  }
  const report = await validateEditVideo(output, "replace-region", [video.path, audio.path], outputDir);
  report.repair = { startMs:Math.round(start*1000), endMs:Math.round(end*1000), audioDurationMs:Math.round(Number(audioProbe.format.duration)*1000), fadeMs:5 };
  report.review = { status:"pending" };
  await fs.writeFile(path.join(outputDir, "validation-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function runVideoEdit(options) {
  const job = activeJob;
  const studio = runtimePaths(options.paths);
  const outputDir = path.join(studio.editOutputRoot, dateFolder(), options.name);
  await fs.mkdir(outputDir, { recursive: true });
  if (options.operation === "voice-candidates") {
    const candidates = await runVoiceCandidates(options, outputDir);
    if (activeJob !== job) return;
    job.state = "done";
    job.stage = "awaiting-selection";
    emit({ type: "voice-candidates-ready", candidates, options });
    return;
  }
  let report;
  if (options.operation === "mute-region") report = await runMuteEdit(options, outputDir);
  else if (options.operation === "replace-region") report = await runRegionReplaceEdit(options, outputDir);
  else if (options.operation === "voice") report = await runVoiceBatchEdit(options, outputDir);
  else if (options.operation === "voice-pages") report = await runPageVoicePatchBatch(options, outputDir);
  else if (options.operation === "compose") report = await runComposeEdit(options, outputDir);
  else throw new Error("지원하지 않는 편집 작업입니다.");
  if (activeJob !== job) return;
  job.state = "done";
  job.stage = "done";
  emit({ type: "edit-complete", report });
}

async function runFineTune(options) {
  const studio = runtimePaths(options.paths);
  const outputDir = path.join(FINETUNE_RUN_ROOT, dateFolder(), options.name);
  await fs.mkdir(outputDir, { recursive: true });
  await runProcess("training", requireRuntimeTool("trainPython", "음성 생성 Python"), [
    "-m", "local_tts_engine.finetune_mlx",
    "--train-jsonl", FINETUNE_TRAIN_JSONL,
    "--output-dir", outputDir,
    "--max-steps", String(options.maxSteps),
    "--rank", "16",
    "--alpha", "16",
    "--gradient-accumulation", "4",
    "--learning-rate", "0.00002",
    "--eval-output", path.join(outputDir, "eval-after.wav"),
    "--reference", studio.referenceAudioPath,
    "--reference-text", studio.referenceTextPath,
  ]);
  const result = JSON.parse(await fs.readFile(path.join(outputDir, "training-result.json"), "utf8"));
  const settings = await readAppSettings();
  const adapter = settings.adapters.find((item) => item.path === result.adapterDir)
    || settings.adapters.find((item) => item.label === options.name)
    || null;
  const updatedSettings = adapter
    ? await saveAppSettings({ ...settings, modelId: "qwen3-tts", adapterId: adapter.id })
    : settings;
  activeJob.state = "done";
  activeJob.stage = "done";
  emit({ type: "training-complete", result, adapter, settings: updatedSettings });
}

async function safeStat(file) {
  try { return await fs.stat(file); } catch { return null; }
}

async function listDirectories(root) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((item) => item.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(item.name));
}

async function resolveOutputFile(target) {
  const settings = await readAppSettings();
  const studio = runtimePaths(settings.paths);
  const store = outputStoreForTarget(target, studio);
  const directory = resolveOutputTarget(target, studio);
  let file = target.root === "render"
    ? await findVideo(path.join(store.videoOutputRoot, target.name), target.name) || await findVideo(directory, target.name)
    : target.root === "edit"
      ? path.join(directory, `${target.name}.mp4`)
      : target.root === "voice"
        ? path.join(directory, "selected.wav")
        : path.join(directory, `${target.name}.m4a`);
  if (["render", "edit", "voice"].includes(target.root)) {
    const report = await fs.readFile(path.join(directory, "validation-report.json"), "utf8").then(JSON.parse).catch(() => null);
    file = await safeStat(file) ? file : report?.videoPath || report?.audioPath || file;
  }
  return { directory, file: await safeStat(file) ? file : null };
}

async function listOutputs(studio, { includeLegacy = true, storeId = "current" } = {}) {
  const result = [];
  for (const entry of await listDirectories(studio.captionOutputRoot)) {
    const dir = path.join(studio.captionOutputRoot, entry.name);
    const stat = await safeStat(dir);
    const reportPath = path.join(dir, "validation-report.json");
    const report = await fs.readFile(reportPath, "utf8").then(JSON.parse).catch(() => null);
    const videoPath = await findVideo(path.join(studio.videoOutputRoot, entry.name), entry.name)
      || report?.videoPath
      || await findVideo(dir, entry.name);
    if (!videoPath && !report) continue;
    result.push({
      key: `${storeId}:render:${entry.name}`,
      store: storeId,
      root: "render",
      name: entry.name,
      displayName: report?.displayName || entry.name,
      updatedAt: stat?.mtime.toISOString(),
      durationMs: report?.durationMs || null,
      video: Boolean(videoPath),
      ok: report?.summary?.ok ?? null,
      passed: report?.summary?.passed ?? null,
      total: report?.summary?.total ?? null,
      needsReview: report?.needsReview || [],
      listenSuggested: report?.listenSuggested || [],
      voiceFindings: report?.voiceFindings || [],
      review: report?.review || null,
      path: videoPath || dir,
    });
  }
  const dayEntries = await fs.readdir(studio.ttsOutputRoot, { withFileTypes: true }).catch(() => []);
  for (const dayEntry of dayEntries.filter((item) => item.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(item.name))) {
    const dayRoot = path.join(studio.ttsOutputRoot, dayEntry.name);
    for (const entry of await listDirectories(dayRoot)) {
      const dir = path.join(dayRoot, entry.name);
      const report = await fs.readFile(path.join(dir, "validation-report.json"), "utf8").then(JSON.parse).catch(() => null);
      if (!report || report.renderDir) continue;
      const stat = await safeStat(dir);
      result.push({
        key: `${storeId}:pilot:${dayEntry.name}:${entry.name}`,
        store: storeId,
        root: "pilot",
        day: dayEntry.name,
        name: entry.name,
        updatedAt: stat?.mtime.toISOString(),
        durationMs: report.durationMs || null,
        video: false,
        ok: report.summary?.ok ?? null,
        passed: report.summary?.passed ?? null,
        total: report.summary?.total ?? null,
        needsReview: report.needsReview || [],
        listenSuggested: report.listenSuggested || [],
        voiceFindings: report.voiceFindings || [],
        review: report.review || null,
        path: report.audioPath || dir,
      });
    }
  }
  const voiceDays = await fs.readdir(studio.voiceOutputRoot, { withFileTypes: true }).catch(() => []);
  for (const dayEntry of voiceDays.filter((item) => item.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(item.name))) {
    const dayRoot = path.join(studio.voiceOutputRoot, dayEntry.name);
    for (const entry of await listDirectories(dayRoot)) {
      const dir = path.join(dayRoot, entry.name);
      const report = await fs.readFile(path.join(dir, "validation-report.json"), "utf8").then(JSON.parse).catch(() => null);
      if (!report?.audioPath) continue;
      const stat = await safeStat(dir);
      result.push({
        key: `${storeId}:voice:${dayEntry.name}:${entry.name}`,
        store: storeId,
        root: "voice",
        day: dayEntry.name,
        name: entry.name,
        operation: "text-voice",
        updatedAt: stat?.mtime.toISOString(),
        durationMs: report.durationMs || null,
        video: false,
        ok: report.summary?.ok ?? null,
        passed: report.summary?.passed ?? null,
        total: report.summary?.total ?? null,
        review: report.review || null,
        path: report.audioPath,
      });
    }
  }
  const editDays = await fs.readdir(studio.editOutputRoot, { withFileTypes: true }).catch(() => []);
  for (const dayEntry of editDays.filter((item) => item.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(item.name))) {
    const dayRoot = path.join(studio.editOutputRoot, dayEntry.name);
    for (const entry of await listDirectories(dayRoot)) {
      const dir = path.join(dayRoot, entry.name);
      const report = await fs.readFile(path.join(dir, "validation-report.json"), "utf8").then(JSON.parse).catch(() => null);
      if (!report) continue;
      const stat = await safeStat(dir);
      result.push({
        key: `${storeId}:edit:${dayEntry.name}:${entry.name}`,
        store: storeId,
        root: "edit",
        day: dayEntry.name,
        name: entry.name,
        operation: report.operation,
        updatedAt: stat?.mtime.toISOString(),
        durationMs: report.durationMs || null,
        video: true,
        ok: report.summary?.ok ?? null,
        passed: report.summary?.passed ?? null,
        total: report.summary?.total ?? null,
        review: report.review || null,
        path: report.videoPath || dir,
      });
    }
  }
  if (includeLegacy) {
    const currentKey = [studio.ttsOutputRoot, studio.voiceOutputRoot, studio.captionOutputRoot, studio.videoOutputRoot, studio.editOutputRoot].join("\n");
    const legacyKey = Object.values(LEGACY_OUTPUT_PATHS).join("\n");
    if (currentKey !== legacyKey) {
      result.push(...await listOutputs({ ...studio, ...LEGACY_OUTPUT_PATHS }, { includeLegacy: false, storeId: "legacy" }));
    }
  }
  return result.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 30);
}

function outputStoreForTarget(target, studio) {
  return target?.store === "legacy" ? { ...studio, ...LEGACY_OUTPUT_PATHS } : studio;
}

function resolveOutputTarget(target, studio) {
  if (!target || !["render", "pilot", "edit", "voice"].includes(target.root) || !/^[a-z0-9][a-z0-9-]*$/.test(target.name || "")) {
    throw new Error("열 수 없는 결과입니다.");
  }
  const store = outputStoreForTarget(target, studio);
  let root = store.captionOutputRoot;
  let directory = path.join(root, target.name);
  if (target.root === "pilot") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(target.day || "")) throw new Error("결과 날짜가 올바르지 않습니다.");
    root = path.join(store.ttsOutputRoot, target.day);
    directory = path.join(root, target.name);
  } else if (target.root === "edit") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(target.day || "")) throw new Error("결과 날짜가 올바르지 않습니다.");
    root = path.join(store.editOutputRoot, target.day);
    directory = path.join(root, target.name);
  } else if (target.root === "voice") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(target.day || "")) throw new Error("결과 날짜가 올바르지 않습니다.");
    root = path.join(store.voiceOutputRoot, target.day);
    directory = path.join(root, target.name);
  }
  if (!isInside(root, directory)) throw new Error("결과 경로가 올바르지 않습니다.");
  return directory;
}

async function setOutputReview(target, status, studio) {
  const directory = resolveOutputTarget(target, studio);
  const reportPath = path.join(directory, "validation-report.json");
  const report = await fs.readFile(reportPath, "utf8").then(JSON.parse).catch(() => null);
  if (!report) throw new Error("자동 검증 기록이 있는 결과만 청취 승인할 수 있습니다.");
  const reviewed = withOutputReview(report, status);
  const temporary = `${reportPath}.review-${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(reviewed, null, 2)}\n`, "utf8");
  await fs.rename(temporary, reportPath);
  return reviewed.review;
}

async function setClearedFindings(target, keys, studio) {
  const directory = resolveOutputTarget(target, studio);
  const reportPath = path.join(directory, "validation-report.json");
  const report = await fs.readFile(reportPath, "utf8").then(JSON.parse).catch(() => null);
  if (!report) throw new Error("자동 검증 기록이 있는 결과만 확인 표시를 남길 수 있습니다.");
  const saved = withClearedFindings(report, keys);
  const temporary = `${reportPath}.cleared-${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, "utf8");
  await fs.rename(temporary, reportPath);
  return clearedFindingKeys(saved);
}

function registerIpc() {
  ipcMain.handle("studio:get-status", async (event) => {
    guard(event);
    const settings = await readAppSettings();
    const studio = runtimePaths(settings.paths);
    const selectedAdapter = settings.adapters.find((item) => item.id === settings.adapterId) || null;
    const runtime = {
      basePython: Boolean(runtimeTools.basePython),
      trainPython: Boolean(runtimeTools.trainPython),
      node: Boolean(runtimeTools.node),
      ffmpeg: Boolean(runtimeTools.ffmpeg),
      ffprobe: Boolean(runtimeTools.ffprobe),
      voice: Boolean(await safeStat(studio.referenceAudioPath)),
      voiceLibrary: Boolean(await safeStat(studio.voiceLibraryRoot)),
      adapter: settings.adapterId === "none" || Boolean(await safeStat(selectedAdapter?.path)),
      qualityModel: Boolean(
        await safeStat(path.join(ROOT, "artifacts/models/whisper-large-v3-turbo-asr-fp16/config.json"))
        && await safeStat(path.join(ROOT, "artifacts/models/whisper-large-v3-turbo-asr-fp16/model.safetensors")),
      ),
      deck: Boolean(await safeStat(studio.configPath))
        && Boolean(await safeStat(path.join(studio.deckRoot, "script/course"))),
    };
    const capabilities = {
      textVoice: runtime.trainPython && runtime.ffprobe && runtime.voice && runtime.adapter,
      editing: runtime.ffmpeg && runtime.ffprobe,
      course: runtime.trainPython && runtime.basePython && runtime.node && runtime.ffmpeg
        && runtime.ffprobe && runtime.voice && runtime.adapter && runtime.qualityModel && runtime.deck,
    };
    const setupIssues = [];
    let catalog = { pages: [], lessons: [], totalPages: 0 };
    if (runtime.basePython && runtime.deck) {
      try {
        catalog = await loadCatalog(studio);
      } catch (error) {
        setupIssues.push(`강의 목록: ${error.message}`);
      }
    } else {
      setupIssues.push("강의 소스가 없어 강의 영상 제작 기능은 아직 준비되지 않았습니다.");
    }
    return {
      activeJob: jobSnapshot(),
      runtime,
      capabilities,
      setupIssues,
      catalog,
      defaults: { adapterScale: 0.6, mode: "lesson", targetSeconds: 0 },
    };
  });

  ipcMain.handle("studio:get-settings", async (event) => {
    guard(event);
    return readAppSettings();
  });

  ipcMain.handle("studio:save-settings", async (event, settings) => {
    guard(event);
    return saveAppSettings(settings);
  });

  ipcMain.handle("studio:list-outputs", async (event) => {
    guard(event);
    const settings = await readAppSettings();
    return listOutputs(runtimePaths(settings.paths));
  });

  ipcMain.handle("studio:set-cleared-findings", async (event, target, keys) => {
    guard(event);
    const settings = await readAppSettings();
    return setClearedFindings(target, Array.isArray(keys) ? keys : [], runtimePaths(settings.paths));
  });

  ipcMain.handle("studio:set-output-review", async (event, target, status) => {
    guard(event);
    const settings = await readAppSettings();
    return setOutputReview(target, status, runtimePaths(settings.paths));
  });

  ipcMain.handle("studio:pick-location", async (event, key) => {
    guard(event);
    const directoryKeys = new Set([
      "sourceProjectRoot",
      "voiceLibraryRoot",
      "outputRoot",
    ]);
    const fileOptions = {
      referenceAudioPath: { title: "참조 음성 선택", extensions: ["wav", "m4a", "flac"] },
      referenceTextPath: { title: "참조 전사문 선택", extensions: ["txt", "md"] },
    };
    const directoryTitles = {
      sourceProjectRoot: "강의 소스 선택",
      voiceLibraryRoot: "내 목소리 원본 선택",
      outputRoot: "결과물 폴더 선택",
    };
    if (!directoryKeys.has(key) && !fileOptions[key]) throw new Error("지원하지 않는 경로 설정입니다.");
    const result = await dialog.showOpenDialog(mainWindow, directoryKeys.has(key)
      ? { title: directoryTitles[key] || "폴더 선택", properties: ["openDirectory", "createDirectory"] }
      : {
          title: fileOptions[key].title,
          properties: ["openFile"],
          filters: [{ name: "지원 파일", extensions: fileOptions[key].extensions }],
        });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("studio:pick-videos", async (event, multiple = false) => {
    guard(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: multiple ? "편집할 영상 선택" : "원본 영상 선택",
      properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
      filters: [{ name: "영상", extensions: ["mp4", "mov", "mkv", "webm", "m4v"] }],
    });
    return result.canceled ? [] : registerSelected(result.filePaths, "video");
  });

  ipcMain.handle("studio:register-dropped-files", async (event, paths = [], kind) => {
    guard(event);
    const allowed = {
      video: new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v"]),
      audio: new Set([".wav", ".m4a", ".mp3", ".flac", ".aac"]),
    };
    if (!allowed[kind]) throw new Error("지원하지 않는 파일 종류입니다.");
    const accepted = [];
    for (const candidate of paths.slice(0, 100)) {
      const resolved = path.resolve(String(candidate));
      if (!allowed[kind].has(path.extname(resolved).toLowerCase())) continue;
      if (!(await safeStat(resolved))?.isFile()) continue;
      accepted.push(resolved);
    }
    if (!accepted.length) throw new Error(kind === "video" ? "지원하는 영상 파일을 놓아 주세요." : "지원하는 음성 파일을 놓아 주세요.");
    return registerSelected(accepted, kind);
  });

  ipcMain.handle("studio:pick-audio", async (event) => {
    guard(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "교체할 음성 선택",
      properties: ["openFile"],
      filters: [{ name: "음성", extensions: ["wav", "m4a", "mp3", "flac", "aac"] }],
    });
    return result.canceled ? [] : registerSelected(result.filePaths, "audio");
  });

  ipcMain.handle("studio:start-edit", async (event, rawOptions = {}) => {
    guard(event);
    if (activeJob && ["running", "cancelling"].includes(activeJob.state)) {
      throw new Error("이미 실행 중인 작업이 있습니다.");
    }
    requireRuntimeTool("ffmpeg", "FFmpeg");
    const operation = ["compose", "voice", "voice-pages", "voice-candidates", "mute-region", "replace-region"].includes(rawOptions.operation)
      ? rawOptions.operation
      : null;
    if (!operation) throw new Error("편집 종류를 선택해 주세요.");
    const settings = await readAppSettings();
    const studio = runtimePaths(settings.paths);
    let options = {
      ...rawOptions,
      operation,
      name: normalizeEditName(rawOptions.name),
      durationPolicy: rawOptions.durationPolicy === "match-audio" ? "match-audio" : "keep-video",
      audioSource: rawOptions.audioSource === "generate" ? "generate" : "file",
      voiceMode: rawOptions.voiceMode === "zero" ? "zero" : "finetuned",
      adapterScale: Number(rawOptions.adapterScale ?? 0.6),
      startPage: Number(rawOptions.startPage ?? 1),
      endPage: Number(rawOptions.endPage ?? rawOptions.startPage ?? 1),
    };
    options = applyVoiceSettings(options, settings);
    if (["voice", "voice-candidates"].includes(operation) && options.audioSource === "generate") {
      const catalog = await loadCatalog(studio);
      const ranges = Array.isArray(options.videoItems) && options.videoItems.length
        ? options.videoItems.map((item) => [Number(item.startPage), Number(item.endPage)])
        : [[options.startPage, options.endPage]];
      if (ranges.some(([start, end]) => !Number.isInteger(start) || !Number.isInteger(end)
          || start < 1 || end < start || end > catalog.totalPages)) {
        throw new Error(`음성 생성 페이지는 1~${catalog.totalPages} 범위로 입력해 주세요.`);
      }
      if (options.voiceMode === "finetuned" && (!(options.adapterScale > 0) || options.adapterScale > 1)) {
        throw new Error("파인튜닝 강도는 0보다 크고 1 이하여야 합니다.");
      }
      await assertRuntime(options, studio);
    }
    activeJob = {
      id: crypto.randomUUID(),
      kind: "edit",
      options,
      state: "running",
      stage: "starting",
      child: null,
      children: new Set(),
      cancelled: false,
      startedAt: new Date().toISOString(),
    };
    const snapshot = jobSnapshot();
    emit({ type: "edit-started", job: snapshot, options });
    runVideoEdit(options).catch((error) => {
      if (!activeJob) return;
      activeJob.state = activeJob.cancelled ? "cancelled" : "failed";
      emit({ type: "edit-failed", cancelled: activeJob.cancelled, message: error.message });
    });
    return snapshot;
  });

  ipcMain.handle("studio:start-text-voices", async (event, rawOptions = {}) => {
    guard(event);
    if (activeJob && ["running", "cancelling"].includes(activeJob.state)) {
      throw new Error("이미 실행 중인 작업이 있습니다.");
    }
    const text = normalizeVoiceText(rawOptions.text);
    if (!text) throw new Error("목소리로 만들 텍스트를 입력해 주세요.");
    if (text.length > 2_000) throw new Error("텍스트는 한 번에 2,000자까지 입력할 수 있습니다.");
    const settings = await readAppSettings();
    const candidateCount = Math.min(8, Math.max(2, Math.round(Number(rawOptions.candidateCount ?? 3))));
    const options = applyVoiceSettings({
      name: normalizeEditName(rawOptions.name),
      text,
      candidateCount,
    }, settings);
    await assertRuntime(options, runtimePaths(settings.paths), { course: false });
    activeJob = {
      id: crypto.randomUUID(),
      kind: "text-voice",
      options,
      state: "running",
      stage: "voice",
      children: new Set(),
      cancelled: false,
      startedAt: new Date().toISOString(),
    };
    const snapshot = jobSnapshot();
    emit({ type: "text-voice-started", job: snapshot, options });
    runTextVoiceCandidates(options).catch((error) => {
      if (!activeJob) return;
      activeJob.state = activeJob.cancelled ? "cancelled" : "failed";
      emit({ type: "text-voice-failed", cancelled: activeJob.cancelled, message: error.message });
    });
    return snapshot;
  });

  ipcMain.handle("studio:select-text-voice", async (event, token) => {
    guard(event);
    return selectTextVoice(String(token || ""));
  });

  ipcMain.handle("studio:start-finetune", async (event, rawOptions = {}) => {
    guard(event);
    if (activeJob && ["running", "cancelling"].includes(activeJob.state)) {
      throw new Error("이미 실행 중인 작업이 있습니다.");
    }
    await fs.access(FINETUNE_TRAIN_JSONL);
    const settings = await readAppSettings();
    const options = {
      name: normalizeEditName(rawOptions.name),
      maxSteps: Math.min(500, Math.max(10, Math.round(Number(rawOptions.maxSteps ?? 60)))),
      paths: settings.paths,
    };
    activeJob = {
      id: crypto.randomUUID(),
      kind: "training",
      options,
      state: "running",
      stage: "training",
      child: null,
      children: new Set(),
      cancelled: false,
      startedAt: new Date().toISOString(),
    };
    emit({ type: "training-started", options });
    runFineTune(options).catch((error) => {
      if (!activeJob) return;
      activeJob.state = activeJob.cancelled ? "cancelled" : "failed";
      emit({ type: "training-failed", cancelled: activeJob.cancelled, message: error.message });
    });
    return jobSnapshot();
  });

  ipcMain.handle("studio:start", async (event, rawOptions) => {
    guard(event);
    if (activeJob && ["running", "cancelling"].includes(activeJob.state)) {
      throw new Error("이미 실행 중인 작업이 있습니다.");
    }
    const settings = await readAppSettings();
    const options = applyVoiceSettings(normalizeOptions(rawOptions), settings);
    const studio = runtimePaths(settings.paths);
    await assertRuntime(options, studio, {
      node: true,
      productionInput: true,
      ffmpeg: options.deliverable === "video",
    });
    const catalog = await loadCatalog(studio);
    if (options.startPage > catalog.totalPages || (options.endPage && options.endPage > catalog.totalPages)) {
      throw new Error(`페이지는 1~${catalog.totalPages} 사이에서 선택해 주세요.`);
    }
    // UI가 본 카탈로그의 ID를 보존한다. 스냅샷 때 번호가 다른 ID를 가리키면
    // 엉뚱한 레슨을 만드는 대신 목록 새로고침을 요청한다.
    options.inputStartId = catalog.pages.find((p) => p.page === options.startPage)?.slideId;
    options.inputEndId = catalog.pages.find((p) => p.page === options.endPage)?.slideId;
    return launchPipeline(options);
  });

  ipcMain.handle("studio:resume-job", async (event) => {
    guard(event);
    if (activeJob && ["running", "cancelling"].includes(activeJob.state)) {
      throw new Error("이미 실행 중인 작업이 있습니다.");
    }
    const record = await readActiveJob();
    if (!record?.options?.name) throw new Error("이어서 만들 작업이 없습니다.");
    const settings = await readAppSettings();
    const studio = runtimePaths(settings.paths);
    // 지난 실행에서 이미 정규화하고 카탈로그로 확인한 옵션이다. 그때 얼려 둔
    // 입력을 그대로 쓰므로 페이지를 다시 풀지 않는다. 도구만 다시 확인한다.
    const options = { ...record.options, resumeFrom: record.completed || [] };
    await assertRuntime(options, studio, {
      node: true,
      productionInput: true,
      ffmpeg: options.deliverable === "video",
    });
    return launchPipeline(options);
  });

  ipcMain.handle("studio:pause", async (event) => {
    guard(event);
    if (!activeJob || activeJob.kind !== "create" || activeJob.state !== "running") return false;
    activeJob.pauseRequested = true;
    // 지금 이 Mac 을 쓰려고 멈추는 것이므로, 다음 편을 기다리지 않고 돌고 있는
    // 프로세스를 바로 재운다. 편 경계에서의 확정은 루프가 따로 처리한다.
    const stopped = pauseJobProcesses(activeJob);
    emit({ type: "paused", immediate: stopped });
    const record = await readActiveJob();
    if (record) await writeActiveJob({ ...record, paused: true }).catch(() => {});
    return true;
  });

  ipcMain.handle("studio:resume", async (event) => {
    guard(event);
    if (!activeJob || activeJob.kind !== "create" || !activeJob.pauseRequested) return false;
    activeJob.pauseRequested = false;
    resumeJobProcesses(activeJob);
    if (activeJob.state === "paused") activeJob.state = "running";
    emit({ type: "resumed" });
    const record = await readActiveJob();
    if (record) await writeActiveJob({ ...record, paused: false }).catch(() => {});
    return true;
  });

  // 앱이 꺼졌다 켜지면 여기서 남은 일을 알려 준다. 실행 중인 작업이 있으면
  // 이어할 것이 없다.
  ipcMain.handle("studio:get-resumable", async (event) => {
    guard(event);
    if (activeJob && ["running", "cancelling"].includes(activeJob.state)) return null;
    const record = await readActiveJob();
    if (!record?.options?.name) return null;
    const settings = await readAppSettings();
    const studio = runtimePaths(settings.paths);
    const units = (record.unitNames || []).map((name) => ({ name }));
    const finished = units.length ? await finishedUnitNames(units, studio) : [];
    const remaining = units.length ? pendingUnits(units, finished).length : 1;
    if (units.length && remaining === 0) { await clearActiveJob(); return null; }
    return {
      name: record.options.name,
      title: record.options.title || record.options.name,
      startedAt: record.startedAt,
      total: units.length,
      done: finished.length,
      remaining,
      paused: Boolean(record.paused),
    };
  });

  ipcMain.handle("studio:discard-resumable", async (event) => {
    guard(event);
    await clearActiveJob();
    return true;
  });

  ipcMain.handle("studio:cancel", async (event) => {
    guard(event);
    if (!activeJob || !["running", "cancelling"].includes(activeJob.state)) return false;
    if (activeJob.state === "cancelling") return true;
    const job = activeJob;
    const accepted = cancelJobProcesses(job, {
      onForce: () => emit({ type: "log", stream: "stderr", text: "중지되지 않은 작업을 강제로 종료했습니다.\n" }),
    });
    if (accepted) emit({ type: "cancelling" });
    return accepted;
  });

  ipcMain.handle("studio:reveal", async (event, target) => {
    guard(event);
    const { file, directory } = await resolveOutputFile(target);
    shell.showItemInFolder(file || directory);
    return true;
  });

  ipcMain.handle("studio:open", async (event, target) => {
    guard(event);
    const { file, directory } = await resolveOutputFile(target);
    const error = await shell.openPath(file || directory);
    if (error) throw new Error(error);
    return true;
  });

  // Opening the editor from a flagged segment must not ask the user to find the
  // video they were just looking at, so the result adopts itself as the input.
  ipcMain.handle("studio:adopt-result-video", async (event, target) => {
    guard(event);
    const { file, directory } = await resolveOutputFile(target);
    if (!file || !/\.mp4$/i.test(file)) throw new Error("이 결과에는 편집할 영상이 없습니다.");
    const [registered] = await registerSelected([file], "video");
    const report = await fs.readFile(path.join(directory, "validation-report.json"), "utf8").then(JSON.parse).catch(() => null);
    return { ...registered, voiceFindings: report?.voiceFindings || [] };
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    // 검수 목록이 옆에 서면서 영상이 좁아졌다. 목록을 줄이는 대신 창을 넓힌다.
    // 14인치(1512x982)에도 들어가는 크기다.
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#10120f",
    show: false,
    webPreferences: {
      preload: path.join(APP_DIR, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
  });
  const initialView = process.env.TTS_STUDIO_SCREENSHOT_VIEW;
  mainWindow.loadFile(
    path.join(RENDERER_DIR, "index.html"),
    initialView ? { query: { view: initialView } } : undefined,
  );
  mainWindow.once("ready-to-show", () => mainWindow.show());
  const screenshotPath = process.env.TTS_STUDIO_SCREENSHOT;
  if (screenshotPath) {
    mainWindow.webContents.once("did-finish-load", async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      const image = await mainWindow.webContents.capturePage();
      await fs.writeFile(screenshotPath, image.toPNG());
      app.quit();
    });
  }
}

app.whenReady().then(async () => {
  runtimeTools = await resolveRuntimeTools(ROOT);
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => stopActiveProcess());
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
