import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  isInside,
  mapWithConcurrency,
  normalizeEditName,
  normalizeOptions,
  parseTimecode,
  presetFromManifest,
  providerForOptions,
  summarizeChecks,
  timeRangeForPages,
} from "./pipeline-utils.mjs";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(APP_DIR);
const RENDERER_DIR = path.join(APP_DIR, "renderer");
const DECK_ROOT = "/Users/jaehoseo/Desktop/vswrk/edu/udemy-agent/deck";
const PILOT_ROOT = path.join(ROOT, "artifacts/course-pilots");
const RENDER_ROOT = path.join(DECK_ROOT, "render/narration");
const EDIT_ROOT = path.join(ROOT, "artifacts/video-edits");
const APP_SETTINGS_PATH = path.join(ROOT, "artifacts/app-settings.json");
const FINETUNE_RUN_ROOT = path.join(ROOT, "artifacts/finetune-runs");
const FINETUNE_TRAIN_JSONL = path.join(ROOT, "artifacts/finetune-datasets/jaeho-ko-v1/official/train.jsonl");
const REFERENCE = path.join(ROOT, "artifacts/benchmarks/2026-08-23/reference.wav");
const REFERENCE_TEXT = path.join(ROOT, "artifacts/benchmarks/2026-08-23/reference.txt");
const ADAPTER = path.join(ROOT, "artifacts/finetune-runs/2026-08-25/jaeho-ko-r16-v1/adapters");
const TRAIN_PYTHON = path.join(ROOT, ".venv-train/bin/python");
const BASE_PYTHON = path.join(ROOT, ".venv/bin/python");
const CONFIG_PATH = path.join(DECK_ROOT, "narration.config.json");
const NODE = "/opt/homebrew/bin/node";
const FFPROBE = "/opt/homebrew/bin/ffprobe";
const FFMPEG = "/opt/homebrew/bin/ffmpeg";

let mainWindow = null;
let activeJob = null;
let catalogCache = null;
const selectedFiles = new Map();

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
  };
  await fs.mkdir(path.dirname(APP_SETTINGS_PATH), { recursive: true });
  await fs.writeFile(APP_SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
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

async function assertRuntime(options) {
  const required = [TRAIN_PYTHON, BASE_PYTHON, NODE, FFPROBE, REFERENCE, REFERENCE_TEXT, CONFIG_PATH];
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

function stopActiveProcess() {
  const children = activeJob?.children || new Set(activeJob?.child ? [activeJob.child] : []);
  for (const child of children) {
    if (!child?.pid) continue;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try { child.kill("SIGTERM"); } catch { /* already finished */ }
    }
  }
}

function runProcess(stage, executable, args, { cwd = ROOT, capture = false } = {}) {
  if (!activeJob) throw new Error("실행 중인 작업이 없습니다.");
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

async function loadCatalog() {
  if (catalogCache) return catalogCache;
  const raw = await runUtility(BASE_PYTHON, [
    "-m", "local_tts_engine.course_catalog",
    "--source-project", path.dirname(DECK_ROOT),
  ]);
  catalogCache = JSON.parse(raw);
  return catalogCache;
}

async function writeDeckContract(manifest, options, providerName) {
  const raw = await fs.readFile(CONFIG_PATH, "utf8");
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
  };
  config.presets[options.name] = presetFromManifest(manifest, options);
  config.providers[providerName] = provider;

  const temporary = `${CONFIG_PATH}.studio-${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await fs.rename(temporary, CONFIG_PATH);
  emit({ type: "log", stream: "stdout", text: "영상 범위를 실제 음성 길이에 맞췄습니다.\n" });
  return previous;
}

async function restoreDeckContract(options, providerName, previous) {
  const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
  if (previous.preset === null) delete config.presets[options.name];
  else config.presets[options.name] = previous.preset;
  if (previous.provider === null) delete config.providers[providerName];
  else config.providers[providerName] = previous.provider;
  const temporary = `${CONFIG_PATH}.studio-${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await fs.rename(temporary, CONFIG_PATH);
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

async function validateResult({ sourceDir, renderDir, options }) {
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
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    name: options.name,
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
  const sourceDir = path.join(PILOT_ROOT, dateFolder(), options.name);
  const renderDir = path.join(RENDER_ROOT, options.name);
  const providerName = `${options.name}-provider`;
  const ttsArgs = [
    "-m", "local_tts_engine.course_pilot",
    "--reference", REFERENCE,
    "--reference-text", REFERENCE_TEXT,
    "--output-dir", sourceDir,
    "--target-seconds", String(options.targetSeconds),
    "--start-page", String(options.startPage),
    "--model", options.modelId || "qwen3-tts",
  ];
  if (options.mode === "bundle") ttsArgs.push("--end-page", String(options.endPage));
  if (options.voiceMode === "finetuned") {
    ttsArgs.push("--adapter", options.adapterPath || ADAPTER, "--adapter-scale", String(options.adapterScale));
  }

  await runProcess("voice", TRAIN_PYTHON, ttsArgs);
  const manifest = JSON.parse(await fs.readFile(path.join(sourceDir, "manifest.json"), "utf8"));

  let previousContract = null;
  try {
    if (options.deliverable !== "audio") {
      previousContract = await writeDeckContract(manifest, options, providerName);
      await runProcess("export", BASE_PYTHON, [
        "-m", "local_tts_engine.export_udemy",
        "--source-dir", sourceDir,
        "--deck-root", DECK_ROOT,
        "--preset", options.name,
        "--provider", providerName,
      ]);
      await runProcess("captions", NODE, [
        "tools/narration.mjs", "captions",
        "--preset", options.name,
        "--provider", providerName,
      ], { cwd: DECK_ROOT });
    }

    if (options.deliverable === "video") {
      const captureArgs = [
        "tools/narration.mjs", "capture",
        "--preset", options.name,
        "--provider", providerName,
      ];
      if (options.burnCaptions) captureArgs.push("--burn-captions");
      await runProcess("capture", NODE, captureArgs, { cwd: DECK_ROOT });
    }
  } finally {
    if (previousContract) await restoreDeckContract(options, providerName, previousContract);
  }

  const report = await validateResult({ sourceDir, renderDir, options });
  if (activeJob !== job) return;
  job.state = "done";
  job.stage = "done";
  emit({ type: "complete", report });
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
  const voiceDir = path.join(outputDir, "generated-voice");
  const args = [
    "-m", "local_tts_engine.course_pilot",
    "--reference", REFERENCE,
    "--reference-text", REFERENCE_TEXT,
    "--output-dir", voiceDir,
    "--target-seconds", "30",
    "--start-page", String(options.startPage),
    "--end-page", String(options.endPage),
    "--model", options.modelId || "qwen3-tts",
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
  const outputDir = path.join(EDIT_ROOT, dateFolder(), options.name);
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
    "--reference", REFERENCE,
    "--reference-text", REFERENCE_TEXT,
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

async function listOutputs() {
  const result = [];
  for (const entry of await listDirectories(RENDER_ROOT)) {
    const dir = path.join(RENDER_ROOT, entry.name);
    const stat = await safeStat(dir);
    const reportPath = path.join(dir, "validation-report.json");
    const report = await fs.readFile(reportPath, "utf8").then(JSON.parse).catch(() => null);
    const videoPath = report?.videoPath || await findVideo(dir, entry.name);
    if (!videoPath && !report) continue;
    result.push({
      key: `render:${entry.name}`,
      root: "render",
      name: entry.name,
      updatedAt: stat?.mtime.toISOString(),
      durationMs: report?.durationMs || null,
      video: Boolean(videoPath),
      ok: report?.summary?.ok ?? null,
      path: videoPath || dir,
    });
  }
  const dayEntries = await fs.readdir(PILOT_ROOT, { withFileTypes: true }).catch(() => []);
  for (const dayEntry of dayEntries.filter((item) => item.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(item.name))) {
    const dayRoot = path.join(PILOT_ROOT, dayEntry.name);
    for (const entry of await listDirectories(dayRoot)) {
      const dir = path.join(dayRoot, entry.name);
      const report = await fs.readFile(path.join(dir, "validation-report.json"), "utf8").then(JSON.parse).catch(() => null);
      if (!report || report.renderDir) continue;
      const stat = await safeStat(dir);
      result.push({
        key: `pilot:${dayEntry.name}:${entry.name}`,
        root: "pilot",
        day: dayEntry.name,
        name: entry.name,
        updatedAt: stat?.mtime.toISOString(),
        durationMs: report.durationMs || null,
        video: false,
        ok: report.summary?.ok ?? null,
        path: report.audioPath || dir,
      });
    }
  }
  const editDays = await fs.readdir(EDIT_ROOT, { withFileTypes: true }).catch(() => []);
  for (const dayEntry of editDays.filter((item) => item.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(item.name))) {
    const dayRoot = path.join(EDIT_ROOT, dayEntry.name);
    for (const entry of await listDirectories(dayRoot)) {
      const dir = path.join(dayRoot, entry.name);
      const report = await fs.readFile(path.join(dir, "validation-report.json"), "utf8").then(JSON.parse).catch(() => null);
      if (!report) continue;
      const stat = await safeStat(dir);
      result.push({
        key: `edit:${dayEntry.name}:${entry.name}`,
        root: "edit",
        day: dayEntry.name,
        name: entry.name,
        operation: report.operation,
        updatedAt: stat?.mtime.toISOString(),
        durationMs: report.durationMs || null,
        video: true,
        ok: report.summary?.ok ?? null,
        path: report.videoPath || dir,
      });
    }
  }
  return result.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 30);
}

function resolveOutputTarget(target) {
  if (!target || !["render", "pilot", "edit"].includes(target.root) || !/^[a-z0-9][a-z0-9-]*$/.test(target.name || "")) {
    throw new Error("열 수 없는 결과입니다.");
  }
  let root = RENDER_ROOT;
  let directory = path.join(root, target.name);
  if (target.root === "pilot") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(target.day || "")) throw new Error("결과 날짜가 올바르지 않습니다.");
    root = path.join(PILOT_ROOT, target.day);
    directory = path.join(root, target.name);
  } else if (target.root === "edit") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(target.day || "")) throw new Error("결과 날짜가 올바르지 않습니다.");
    root = path.join(EDIT_ROOT, target.day);
    directory = path.join(root, target.name);
  }
  if (!isInside(root, directory)) throw new Error("결과 경로가 올바르지 않습니다.");
  return directory;
}

function registerIpc() {
  ipcMain.handle("studio:get-status", async (event) => {
    guard(event);
    const runtime = {};
    for (const [key, file] of Object.entries({ voice: REFERENCE, adapter: ADAPTER, deck: DECK_ROOT, ffmpeg: FFMPEG })) {
      runtime[key] = Boolean(await safeStat(file));
    }
    const catalog = await loadCatalog();
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
    return listOutputs();
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
    options = applyVoiceSettings(options, await readAppSettings());
    if (["voice", "voice-candidates"].includes(operation) && options.audioSource === "generate") {
      const catalog = await loadCatalog();
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
      await assertRuntime(options);
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

  ipcMain.handle("studio:start-finetune", async (event, rawOptions = {}) => {
    guard(event);
    if (activeJob && ["running", "cancelling"].includes(activeJob.state)) {
      throw new Error("이미 실행 중인 작업이 있습니다.");
    }
    await fs.access(FINETUNE_TRAIN_JSONL);
    const options = {
      name: normalizeEditName(rawOptions.name),
      maxSteps: Math.min(500, Math.max(10, Math.round(Number(rawOptions.maxSteps ?? 60)))),
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
    const options = applyVoiceSettings(normalizeOptions(rawOptions), await readAppSettings());
    await assertRuntime(options);
    const catalog = await loadCatalog();
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
    runPipeline(options).catch((error) => {
      if (!activeJob) return;
      activeJob.state = activeJob.cancelled ? "cancelled" : "failed";
      emit({ type: "failed", cancelled: activeJob.cancelled, message: error.message });
    });
    return snapshot;
  });

  ipcMain.handle("studio:cancel", async (event) => {
    guard(event);
    if (!activeJob || activeJob.state !== "running") return false;
    activeJob.cancelled = true;
    activeJob.state = "cancelling";
    stopActiveProcess();
    emit({ type: "cancelling" });
    return true;
  });

  ipcMain.handle("studio:reveal", async (event, target) => {
    guard(event);
    const directory = resolveOutputTarget(target);
    let file = target.root === "render"
      ? await findVideo(directory, target.name)
      : target.root === "edit"
        ? path.join(directory, `${target.name}.mp4`)
        : path.join(directory, `${target.name}.m4a`);
    if (target.root === "edit") {
      const report = await fs.readFile(path.join(directory, "validation-report.json"), "utf8").then(JSON.parse).catch(() => null);
      file = report?.videoPath || file;
    }
    shell.showItemInFolder(await safeStat(file) ? file : directory);
    return true;
  });

  ipcMain.handle("studio:open", async (event, target) => {
    guard(event);
    const directory = resolveOutputTarget(target);
    let file = target.root === "render"
      ? await findVideo(directory, target.name)
      : target.root === "edit"
        ? path.join(directory, `${target.name}.mp4`)
        : path.join(directory, `${target.name}.m4a`);
    if (target.root === "edit") {
      const report = await fs.readFile(path.join(directory, "validation-report.json"), "utf8").then(JSON.parse).catch(() => null);
      file = report?.videoPath || file;
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
