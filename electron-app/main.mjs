import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  combineLessonCatalogs,
  isInside,
  lessonCatalogFromPresets,
  mapWithConcurrency,
  nextDisplayVideoFileName,
  normalizeEditName,
  normalizeOptions,
  normalizeVoiceText,
  outputPathsForRoot,
  parseTimecode,
  presetFromManifest,
  providerForOptions,
  summarizeChecks,
  timeRangeForPages,
  withOutputReview,
} from "./pipeline-utils.mjs";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(APP_DIR);
const RENDERER_DIR = path.join(APP_DIR, "renderer");
const APP_SETTINGS_PATH = path.join(ROOT, "artifacts/app-settings.json");
const FINETUNE_RUN_ROOT = path.join(ROOT, "artifacts/finetune-runs");
const FINETUNE_TRAIN_JSONL = path.join(ROOT, "artifacts/finetune-datasets/jaeho-ko-v1/official/train.jsonl");
const ADAPTER = path.join(ROOT, "artifacts/finetune-runs/2026-08-25/jaeho-ko-r16-v1/adapters");
const TRAIN_PYTHON = path.join(ROOT, ".venv-train/bin/python");
const BASE_PYTHON = path.join(ROOT, ".venv/bin/python");
const NODE = "/opt/homebrew/bin/node";
const FFPROBE = "/opt/homebrew/bin/ffprobe";
const FFMPEG = "/opt/homebrew/bin/ffmpeg";
const DEFAULT_STUDIO_PATHS = Object.freeze({
  sourceProjectRoot: "/Users/jaehoseo/Desktop/vswrk/edu/udemy-agent",
  voiceLibraryRoot: path.join(ROOT, "data/private/voice"),
  outputRoot: path.join(ROOT, "output"),
  referenceAudioPath: path.join(ROOT, "artifacts/benchmarks/2026-08-23/reference.wav"),
  referenceTextPath: path.join(ROOT, "artifacts/benchmarks/2026-08-23/reference.txt"),
});
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
    "강의 설정": studio.configPath,
    "강의 대본": path.join(studio.deckRoot, "script/course"),
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
  };
}

async function assertRuntime(options, studio = runtimePaths(options.paths)) {
  const required = [
    TRAIN_PYTHON,
    BASE_PYTHON,
    NODE,
    FFPROBE,
    studio.referenceAudioPath,
    studio.referenceTextPath,
    studio.configPath,
  ];
  if (options.voiceMode === "finetuned") {
    const adapterPath = options.adapterPath || ADAPTER;
    required.push(path.join(adapterPath, "adapters.safetensors"), path.join(adapterPath, "adapter_config.json"));
  }
  for (const file of required) {
    try {
      await fs.access(file);
    } catch {
      throw new Error(`필요한 로컬 파일을 찾지 못했습니다: ${file}`);
    }
  }
}

function stopActiveProcess(signal = "SIGTERM") {
  const children = activeJob?.children || new Set(activeJob?.child ? [activeJob.child] : []);
  let signalled = 0;
  for (const child of children) {
    if (!child?.pid) continue;
    try {
      process.kill(-child.pid, signal);
      signalled += 1;
    } catch {
      try {
        if (child.kill(signal)) signalled += 1;
      } catch { /* already finished */ }
    }
  }
  return signalled;
}

function forceStopIfNeeded(job) {
  const timer = setTimeout(() => {
    if (activeJob !== job || job.state !== "cancelling") return;
    const signalled = stopActiveProcess("SIGKILL");
    if (signalled > 0) {
      emit({ type: "log", stream: "stderr", text: "중지되지 않은 작업을 강제로 종료했습니다.\n" });
    }
  }, 3_000);
  timer.unref?.();
}

function runProcess(stage, executable, args, { cwd = ROOT, capture = false } = {}) {
  if (!activeJob) throw new Error("실행 중인 작업이 없습니다.");
  if (activeJob.cancelled) throw new Error("사용자가 작업을 중지했습니다.");
  activeJob.stage = stage;
  emit({ type: "stage", stage, state: "running" });

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: { ...process.env, PYTHONPATH: path.join(ROOT, "src"), PYTHONUNBUFFERED: "1" },
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeJob.children ||= new Set();
    activeJob.children.add(child);
    let output = "";
    const forward = (stream, chunk) => {
      const text = chunk.toString();
      if (capture) output += text;
      emit({ type: "log", stream, text });
    };
    child.stdout.on("data", (chunk) => forward("stdout", chunk));
    child.stderr.on("data", (chunk) => forward("stderr", chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (activeJob) activeJob.children?.delete(child);
      if (activeJob?.cancelled) {
        reject(new Error("사용자가 작업을 중지했습니다."));
      } else if (code === 0) {
        emit({ type: "stage", stage, state: "done" });
        resolve(output);
      } else {
        reject(new Error(`${stage} 단계가 실패했습니다. (종료 ${signal || code})`));
      }
    });
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

async function loadCatalog(studio) {
  if (catalogCache && catalogCacheRoot === studio.sourceProjectRoot) return catalogCache;
  const raw = await runUtility(BASE_PYTHON, [
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
  const output = await runProcess("verify", FFPROBE, [
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
  const mp4 = names.filter((item) => item.endsWith(".mp4")).sort().at(-1);
  return mp4 ? path.join(renderDir, mp4) : null;
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

async function publishVideo(source, studio, name, title) {
  const outputDir = path.join(studio.videoOutputRoot, name);
  await fs.mkdir(outputDir, { recursive: true });
  const target = path.join(
    outputDir,
    nextDisplayVideoFileName(title, await publishedVideoNames(studio.videoOutputRoot)),
  );
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
    videoPath = await publishVideo(videoPath, studio, options.name, options.title);
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    name: options.name,
    displayName: options.title,
    sourceDir,
    renderDir: options.deliverable === "audio" ? null : renderDir,
    audioPath: manifest.audioPath,
    videoPath,
    durationMs: Number(manifest.durationMs),
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

async function runPipeline(options) {
  const job = activeJob;
  const studio = runtimePaths(options.paths);
  const sourceDir = path.join(studio.ttsOutputRoot, dateFolder(), options.name);
  const renderDir = path.join(studio.captionOutputRoot, options.name);
  const captureSiteDir = options.deliverable === "video"
    ? path.join(renderDir, ".capture-site")
    : null;
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
  if (options.mode === "bundle") ttsArgs.push("--end-page", String(options.endPage));
  if (options.voiceMode === "finetuned") {
    ttsArgs.push("--adapter", options.adapterPath || ADAPTER, "--adapter-scale", String(options.adapterScale));
  }

  if (captureSiteDir) {
    await fs.mkdir(renderDir, { recursive: true });
    job.captureSiteDir = captureSiteDir;
    await runProcess("snapshot", NODE, [
      path.join(studio.deckRoot, "node_modules/vite/bin/vite.js"),
      "build",
      "--mode", "capture",
      "--outDir", captureSiteDir,
      "--emptyOutDir",
    ], { cwd: studio.deckRoot });
    emit({
      type: "log",
      stream: "stdout",
      text: "촬영 화면을 고정했습니다. 이제 강의 소스를 수정해도 이번 영상에는 반영되지 않습니다.\n",
    });
  }

  await runProcess("voice", TRAIN_PYTHON, ttsArgs);
  const manifest = JSON.parse(await fs.readFile(path.join(sourceDir, "manifest.json"), "utf8"));

  let previousContract = null;
  try {
    if (options.deliverable !== "audio") {
      previousContract = await writeDeckContract(manifest, options, providerName, studio);
      await runProcess("export", BASE_PYTHON, [
        "-m", "local_tts_engine.export_udemy",
        "--source-dir", sourceDir,
        "--deck-root", studio.deckRoot,
        "--preset", options.name,
        "--provider", providerName,
      ]);
      await runProcess("captions", NODE, [
        "tools/narration.mjs", "captions",
        "--preset", options.name,
        "--provider", providerName,
      ], { cwd: studio.deckRoot });
    }

    if (options.deliverable === "video") {
      const captureArgs = [
        "tools/narration.mjs", "capture",
        "--preset", options.name,
        "--provider", providerName,
        "--no-cache",
      ];
      if (captureSiteDir) captureArgs.push("--site-dir", captureSiteDir);
      if (options.burnCaptions) captureArgs.push("--burn-captions");
      try {
        await runProcess("capture", NODE, captureArgs, { cwd: studio.deckRoot });
      } catch (error) {
        if (job.cancelled) throw error;
        emit({
          type: "log",
          stream: "stderr",
          text: "화면 촬영이 중간에 멈춰 같은 음성과 타임라인으로 한 번 다시 시도합니다.\n",
        });
        await runProcess("capture", NODE, captureArgs, { cwd: studio.deckRoot });
      }
    }
  } finally {
    if (previousContract) await restoreDeckContract(options, providerName, previousContract, studio);
  }

  const report = await validateResult({ sourceDir, renderDir, options, studio });
  if (activeJob !== job) return;
  if (job.cancelled) throw new Error("사용자가 작업을 중지했습니다.");
  job.state = "done";
  job.stage = "done";
  emit({ type: "complete", report });
}

async function cleanupCaptureSite(job) {
  if (!job?.captureSiteDir) return;
  const directory = job.captureSiteDir;
  job.captureSiteDir = null;
  await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
}

async function inspectMedia(file) {
  const raw = await runUtility(FFPROBE, [
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

async function registerSelected(paths, kind) {
  return Promise.all(paths.map(async (file) => {
    const token = crypto.randomUUID();
    const value = { token, kind, path: path.resolve(file), name: path.basename(file), timelinePath: null, pageRange: null };
    if (kind === "video") {
      const timelinePath = path.join(path.dirname(value.path), "timeline.json");
      const timeline = await fs.readFile(timelinePath, "utf8").then(JSON.parse).catch(() => null);
      const pages = timeline?.entries?.map((entry) => Number(entry.slideNumber)).filter(Number.isFinite) || [];
      if (pages.length) {
        value.timelinePath = timelinePath;
        value.pageRange = { start: Math.min(...pages), end: Math.max(...pages) };
      }
    }
    selectedFiles.set(token, value);
    return { token, kind, name: value.name, path: value.path, pageRange: value.pageRange };
  }));
}

async function normalizeMergeSegment(input, output) {
  const probe = await inspectMedia(input);
  const duration = Number(probe.format?.duration || 0);
  if (!duration) throw new Error(`영상 길이를 읽지 못했습니다: ${path.basename(input)}`);
  const hasAudio = probe.streams?.some((stream) => stream.codec_type === "audio");
  const args = ["-y", "-hide_banner", "-nostats", "-i", input];
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
  await runProcess("edit", FFMPEG, args);
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

async function runMergeEdit(options, outputDir) {
  const inputs = options.videoTokens.map((token) => chosenFile(token, "video"));
  if (inputs.length < 2) throw new Error("합칠 영상은 2개 이상 선택해 주세요.");
  const segmentDir = path.join(outputDir, "work");
  await fs.mkdir(segmentDir, { recursive: true });
  const segments = [];
  for (const [index, input] of inputs.entries()) {
    const output = path.join(segmentDir, `${String(index + 1).padStart(3, "0")}.mp4`);
    await normalizeMergeSegment(input, output);
    segments.push(output);
  }
  const concatPath = path.join(segmentDir, "concat.txt");
  const concatText = segments.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n");
  await fs.writeFile(concatPath, `${concatText}\n`, "utf8");
  const output = path.join(outputDir, `${options.name}.mp4`);
  await runProcess("edit", FFMPEG, [
    "-y", "-hide_banner", "-nostats",
    "-f", "concat", "-safe", "0", "-i", concatPath,
    "-c", "copy", "-movflags", "+faststart", output,
  ]);
  return validateEditVideo(output, "merge", inputs, outputDir);
}

async function runTrimEdit(options, outputDir) {
  const selected = chosenRecord(options.videoToken, "video");
  const input = selected.path;
  const probe = await inspectMedia(input);
  const duration = Number(probe.format?.duration || 0);
  let start;
  let end;
  if (options.trimMode === "pages") {
    if (!selected.timelinePath) throw new Error("이 영상에는 페이지 타임라인이 없습니다. 시간으로 잘라 주세요.");
    const timeline = JSON.parse(await fs.readFile(selected.timelinePath, "utf8"));
    const range = timeRangeForPages(
      timeline.entries,
      Number(options.trimStartPage),
      Number(options.trimEndPage),
    );
    start = range.start;
    end = range.end;
  } else {
    start = parseTimecode(options.startTime);
    end = parseTimecode(options.endTime);
  }
  if (end <= start || end > duration + 0.05) {
    throw new Error(`끝 시간은 시작 이후이며 영상 길이 ${duration.toFixed(2)}초 이하여야 합니다.`);
  }
  const output = path.join(outputDir, `${options.name}.mp4`);
  await runProcess("edit", FFMPEG, [
    "-y", "-hide_banner", "-nostats",
    "-ss", start.toFixed(3), "-to", end.toFixed(3), "-i", input,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-movflags", "+faststart", output,
  ]);
  return validateEditVideo(output, "trim", [input], outputDir);
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
  ];
  if (options.seed) args.push("--seed", String(options.seed));
  if (options.voiceMode !== "zero") {
    args.push("--adapter", options.adapterPath || ADAPTER, "--adapter-scale", String(options.adapterScale));
  }
  await runProcess("voice", TRAIN_PYTHON, args);
  const manifest = JSON.parse(await fs.readFile(path.join(voiceDir, "manifest.json"), "utf8"));
  return manifest.audioPath;
}

async function runVoiceCandidates(options, outputDir) {
  chosenRecord(options.videoToken, "video");
  const count = Math.min(8, Math.max(2, Math.round(Number(options.candidateCount ?? 3))));
  const digest = crypto.createHash("sha256").update(options.name).digest();
  const baseSeed = digest.readUInt32BE(0);
  let completed = 0;
  const candidates = await mapWithConcurrency(
    Array.from({ length: count }, (_, index) => index),
    options.voiceParallelism || 2,
    async (index) => {
      const candidateName = `candidate-${String(index + 1).padStart(2, "0")}`;
      const candidateDir = path.join(outputDir, "candidates", candidateName);
      await fs.mkdir(candidateDir, { recursive: true });
      const seed = (baseSeed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
      const audioPath = await generateReplacementVoice({ ...options, seed }, candidateDir);
      completed += 1;
      emit({ type: "voice-item-complete", completed, total: count, name: `후보 ${index + 1}` });
      return { index: index + 1, seed, audioPath };
    },
  );
  const registered = await registerSelected(candidates.map((item) => item.audioPath), "audio");
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
      await runProcess("voice", TRAIN_PYTHON, args);
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

async function runVoiceEdit(options, outputDir) {
  const video = chosenFile(options.videoToken, "video");
  const audio = options.audioSource === "generate"
    ? await generateReplacementVoice(options, outputDir)
    : chosenFile(options.audioToken, "audio");
  const [videoProbe, audioProbe] = await Promise.all([inspectMedia(video), inspectMedia(audio)]);
  const videoDuration = Number(videoProbe.format?.duration || 0);
  const audioDuration = Number(audioProbe.format?.duration || 0);
  if (!videoDuration || !audioDuration) throw new Error("영상 또는 음성 길이를 읽지 못했습니다.");
  const output = path.join(outputDir, `${options.name}.mp4`);
  if (options.durationPolicy === "match-audio") {
    const factor = audioDuration / videoDuration;
    await runProcess("edit", FFMPEG, [
      "-y", "-hide_banner", "-nostats", "-i", video, "-i", audio,
      "-map", "0:v:0", "-map", "1:a:0",
      "-vf", `setpts=${factor.toFixed(8)}*PTS,fps=25,format=yuv420p`,
      "-c:v", "libx264", "-preset", "medium", "-crf", "18",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-t", audioDuration.toFixed(3), "-movflags", "+faststart", output,
    ]);
  } else {
    await runProcess("edit", FFMPEG, [
      "-y", "-hide_banner", "-nostats", "-i", video, "-i", audio,
      "-filter_complex", `[1:a]apad=whole_dur=${videoDuration.toFixed(3)}[voice]`,
      "-map", "0:v:0", "-map", "[voice]",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-t", videoDuration.toFixed(3), "-movflags", "+faststart", output,
    ]);
  }
  return validateEditVideo(output, "voice", [video, audio], outputDir);
}

async function runVoiceBatchEdit(options, outputDir) {
  const items = Array.isArray(options.videoItems) && options.videoItems.length
    ? options.videoItems
    : [{ videoToken: options.videoToken, startPage: options.startPage, endPage: options.endPage }];
  if (items.length > 20) throw new Error("목소리 교체는 한 번에 최대 20개까지 실행할 수 있습니다.");
  const concurrency = Math.min(Number(options.voiceParallelism || 2), items.length);
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
  if (options.operation === "merge") report = await runMergeEdit(options, outputDir);
  else if (options.operation === "trim") report = await runTrimEdit(options, outputDir);
  else if (options.operation === "voice") report = await runVoiceBatchEdit(options, outputDir);
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
  await runProcess("training", TRAIN_PYTHON, [
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

function registerIpc() {
  ipcMain.handle("studio:get-status", async (event) => {
    guard(event);
    const settings = await readAppSettings();
    const studio = runtimePaths(settings.paths);
    const runtime = {};
    for (const [key, file] of Object.entries({
      voice: studio.referenceAudioPath,
      voiceLibrary: studio.voiceLibraryRoot,
      adapter: ADAPTER,
      deck: studio.deckRoot,
      ffmpeg: FFMPEG,
    })) {
      runtime[key] = Boolean(await safeStat(file));
    }
    const catalog = await loadCatalog(studio);
    return {
      activeJob: jobSnapshot(),
      runtime,
      catalog,
      defaults: { adapterScale: 0.6, mode: "preview", targetSeconds: 30 },
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
    await fs.access(FFMPEG);
    const operation = ["merge", "trim", "voice", "voice-candidates"].includes(rawOptions.operation)
      ? rawOptions.operation
      : null;
    if (!operation) throw new Error("편집 종류를 선택해 주세요.");
    const settings = await readAppSettings();
    const studio = runtimePaths(settings.paths);
    let options = {
      ...rawOptions,
      operation,
      name: normalizeEditName(rawOptions.name),
      trimMode: rawOptions.trimMode === "pages" ? "pages" : "time",
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
    await assertRuntime(options, runtimePaths(settings.paths));
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
    await assertRuntime(options, studio);
    const catalog = await loadCatalog(studio);
    if (options.startPage > catalog.totalPages || (options.endPage && options.endPage > catalog.totalPages)) {
      throw new Error(`페이지는 1~${catalog.totalPages} 사이에서 선택해 주세요.`);
    }
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
    runPipeline(options).catch((error) => {
      if (activeJob !== job) return;
      job.state = job.cancelled ? "cancelled" : "failed";
      emit({ type: "failed", cancelled: job.cancelled, message: error.message });
    }).finally(() => cleanupCaptureSite(job));
    return snapshot;
  });

  ipcMain.handle("studio:cancel", async (event) => {
    guard(event);
    if (!activeJob || !["running", "cancelling"].includes(activeJob.state)) return false;
    if (activeJob.state === "cancelling") return true;
    const job = activeJob;
    activeJob.cancelled = true;
    activeJob.state = "cancelling";
    emit({ type: "cancelling" });
    stopActiveProcess("SIGTERM");
    forceStopIfNeeded(job);
    return true;
  });

  ipcMain.handle("studio:reveal", async (event, target) => {
    guard(event);
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
    shell.showItemInFolder(await safeStat(file) ? file : directory);
    return true;
  });

  ipcMain.handle("studio:open", async (event, target) => {
    guard(event);
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
    const error = await shell.openPath(await safeStat(file) ? file : directory);
    if (error) throw new Error(error);
    return true;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
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

app.whenReady().then(() => {
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
