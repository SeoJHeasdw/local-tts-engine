#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultStudioPaths,
  ffmpegBuildProfile,
  resolveRuntimeTools,
} from "../electron-app/runtime-config.mjs";


const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SETTINGS_PATH = path.join(PROJECT_ROOT, "artifacts/app-settings.json");
const flags = new Set(process.argv.slice(2));


async function exists(candidate) {
  if (!candidate) return false;
  return fs.stat(candidate).then(() => true).catch(() => false);
}


function executableOutput(executable, args = ["--version"]) {
  if (!executable) return null;
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 5_000 });
  if (result.error) return null;
  return String(result.stdout || result.stderr || "").trim() || null;
}


function firstLine(value) {
  return String(value || "").split("\n")[0].trim() || null;
}


async function readSettings() {
  const stored = await fs.readFile(SETTINGS_PATH, "utf8").then(JSON.parse).catch(() => ({}));
  return {
    ...stored,
    paths: { ...defaultStudioPaths(PROJECT_ROOT), ...(stored.paths || {}) },
  };
}


async function buildReport() {
  const [settings, tools] = await Promise.all([
    readSettings(),
    resolveRuntimeTools(PROJECT_ROOT),
  ]);
  const studio = settings.paths;
  const deckRoot = path.join(studio.sourceProjectRoot, "deck");
  const adapterPath = settings.adapterId && settings.adapterId !== "none"
    ? path.join(PROJECT_ROOT, "artifacts/finetune-runs", settings.adapterId, "adapters")
    : null;
  const localQualityModel = path.join(PROJECT_ROOT, "artifacts/models/whisper-large-v3-turbo-asr-fp16");
  const sharedQualityModel = path.join(
    os.homedir(),
    ".cache/huggingface/hub/models--mlx-community--whisper-large-v3-turbo-asr-fp16",
  );
  const qualityModelPath = await exists(path.join(localQualityModel, "config.json"))
    && await exists(path.join(localQualityModel, "model.safetensors"))
    ? localQualityModel
    : await exists(sharedQualityModel) ? sharedQualityModel : null;
  const checks = {
    appleSilicon: process.platform === "darwin" && process.arch === "arm64",
    basePython: Boolean(tools.basePython),
    trainPython: Boolean(tools.trainPython),
    node: Boolean(tools.node),
    ffmpeg: Boolean(tools.ffmpeg),
    ffprobe: Boolean(tools.ffprobe),
    referenceAudio: await exists(studio.referenceAudioPath),
    referenceText: await exists(studio.referenceTextPath),
    adapter: !adapterPath || await exists(path.join(adapterPath, "adapters.safetensors")),
    qualityModel: Boolean(qualityModelPath),
    courseConfig: await exists(path.join(deckRoot, "narration.config.json")),
    courseScripts: await exists(path.join(deckRoot, "script/course")),
    captionRunner: await exists(path.join(deckRoot, "tools/captions.mjs")),
    captureRunner: await exists(path.join(deckRoot, "tools/capture.mjs")),
  };
  const capabilities = {
    textVoice: checks.appleSilicon && checks.trainPython && checks.ffprobe
      && checks.referenceAudio && checks.referenceText && checks.adapter,
    editing: checks.ffmpeg && checks.ffprobe,
    courseVideo: checks.appleSilicon && checks.basePython && checks.trainPython
      && checks.node && checks.ffmpeg && checks.ffprobe && checks.referenceAudio
      && checks.referenceText && checks.adapter && checks.courseConfig
      && checks.qualityModel && checks.courseScripts && checks.captionRunner && checks.captureRunner,
  };
  const basePythonOutput = executableOutput(tools.basePython);
  const trainPythonOutput = executableOutput(tools.trainPython);
  const externalNodeOutput = executableOutput(tools.node);
  const ffmpegOutput = executableOutput(tools.ffmpeg, ["-version"]);
  const versions = {
    appNode: process.version,
    externalNode: firstLine(externalNodeOutput),
    basePython: firstLine(basePythonOutput),
    trainPython: firstLine(trainPythonOutput),
    ffmpeg: firstLine(ffmpegOutput),
  };
  const paths = flags.has("--verbose") ? { ...tools, ...studio, adapterPath, qualityModelPath } : undefined;
  return {
    generatedAt: new Date().toISOString(),
    machine: `${os.platform()} ${os.arch()}`,
    capabilities,
    checks,
    versions,
    ffmpegBuild: ffmpegBuildProfile(ffmpegOutput),
    ...(paths ? { paths } : {}),
  };
}


function printReport(report) {
  const capabilityLabels = {
    textVoice: "텍스트 목소리",
    editing: "기존 영상 편집",
    courseVideo: "강의 영상 자동 제작",
  };
  const checkLabels = {
    appleSilicon: "Apple Silicon Mac",
    basePython: "기본 Python 환경",
    trainPython: "음성 생성 Python 환경",
    node: "Node.js",
    ffmpeg: "FFmpeg",
    ffprobe: "FFprobe",
    referenceAudio: "참조 음성",
    referenceText: "참조 전사문",
    adapter: "선택한 음성 어댑터",
    qualityModel: "Whisper 자동 음성 검수 모델",
    courseConfig: "강의 설정",
    courseScripts: "강의 대본",
    captionRunner: "자막 자동화 도구",
    captureRunner: "영상 촬영 도구",
  };
  console.log("Voice Studio 환경 진단");
  console.log(`기기: ${report.machine}`);
  console.log("");
  for (const [key, label] of Object.entries(capabilityLabels)) {
    console.log(`${report.capabilities[key] ? "✓" : "–"} ${label}`);
  }
  console.log("");
  for (const [key, label] of Object.entries(checkLabels)) {
    console.log(`${report.checks[key] ? "✓" : "✗"} ${label}`);
  }
  if (report.ffmpegBuild.gplEnabled || report.ffmpegBuild.nonfreeEnabled) {
    console.log("");
    console.log("! 현재 FFmpeg 빌드는 GPL/nonfree 기능을 포함합니다.");
    console.log("  개인 제작에는 그대로 쓰되 고객 앱 배포물에는 검토 없이 묶지 마세요.");
  }
  if (report.paths) {
    console.log("");
    console.log("상세 경로");
    for (const [key, value] of Object.entries(report.paths)) console.log(`- ${key}: ${value || "찾지 못함"}`);
  }
  console.log("");
  console.log("경로까지 확인하려면 npm run doctor -- --verbose 를 사용하세요.");
}


const report = await buildReport();
if (flags.has("--json")) console.log(JSON.stringify(report, null, 2));
else printReport(report);

const readyCount = Object.values(report.capabilities).filter(Boolean).length;
if (flags.has("--strict") && readyCount !== Object.keys(report.capabilities).length) process.exitCode = 1;
else if (readyCount === 0) process.exitCode = 1;
