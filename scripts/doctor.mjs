#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ffmpegBuildProfile,
  resolveRuntimeTools,
} from "../electron-app/main/runtime-config.mjs";
import { createSettingsService } from "../electron-app/main/settings.mjs";
import { inspectVoiceReadiness } from "../electron-app/main/voice-readiness.mjs";
import { listCaptureDevices, probeDisplay, screenDevices } from "../electron-app/main/capture/displays.mjs";


const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// playwright가 설치돼 있어도 브라우저 본체를 내려받지 않으면 촬영은 실행 순간에야
// 실패한다. 제작을 시작하기 전에 알 수 있도록 여기서 확인한다.
async function hasCaptureBrowser() {
  try {
    const { chromium } = await import("playwright");
    return await fs.access(chromium.executablePath()).then(() => true, () => false);
  } catch {
    return false;
  }
}
// 화면 기록 권한은 Electron이 아니라 앱을 띄운 터미널 앱이 받는다. Electron의 권한
// 조회는 그 차이를 모르므로, ffmpeg로 첫 화면을 한 프레임 찍어 되는지로 판정한다.
async function canRecordScreen(ffmpeg) {
  if (!ffmpeg || process.platform !== "darwin") return false;
  try {
    const [screen] = screenDevices(await listCaptureDevices(ffmpeg));
    if (!screen) return false;
    await probeDisplay(ffmpeg, screen.index);
    return true;
  } catch {
    return false;
  }
}
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
  return createSettingsService({ state: {} }).readAppSettings();
}


async function buildReport() {
  const [settings, tools] = await Promise.all([
    readSettings(),
    resolveRuntimeTools(PROJECT_ROOT),
  ]);
  const studio = settings.paths;
  const deckRoot = path.join(studio.sourceProjectRoot, "deck");
  const adapterPath = settings.adapters.find((item) => item.id === settings.adapterId)?.path || null;
  const readiness = await inspectVoiceReadiness({
    ...settings,
    modelId: settings.modelId === "chatterbox-v3" ? "chatterbox-v3" : "qwen3-tts",
    adapterId: settings.adapterId,
    adapters: settings.adapters,
  }, studio);
  const ready = (item) => item?.state === "ready";
  const selectedModel = settings.modelId === "chatterbox-v3" ? "chatterbox-v3" : "qwen3-tts";
  const checks = {
    appleSilicon: process.platform === "darwin" && process.arch === "arm64",
    basePython: Boolean(tools.basePython),
    trainPython: Boolean(tools.trainPython),
    node: Boolean(tools.node),
    ffmpeg: Boolean(tools.ffmpeg),
    ffprobe: Boolean(tools.ffprobe),
    referenceAudio: ready(readiness.referenceAudio),
    referenceText: ready(readiness.referenceText),
    adapter: settings.adapterId === "none" || ready(readiness.adapter),
    voiceModel: ready(readiness.models[selectedModel]),
    qualityModel: ready(readiness.quality),
    aligner: ready(readiness.aligner),
    courseConfig: await exists(path.join(deckRoot, "narration.config.json")),
    courseScripts: await exists(path.join(deckRoot, "script/course")),
    // 자막과 촬영은 이 저장소가 소유한다. 촬영에는 실제 브라우저가 필요하다.
    captionRunner: await exists(path.join(PROJECT_ROOT, "electron-app/main/workers/captions.mjs")),
    captureRunner: await exists(path.join(PROJECT_ROOT, "electron-app/main/workers/capture.mjs")),
    captureBrowser: await hasCaptureBrowser(),
    recordRunner: await exists(path.join(PROJECT_ROOT, "electron-app/main/workers/record-display.mjs")),
    screenCapture: await canRecordScreen(tools.ffmpeg),
    productionRunner: await exists(path.join(deckRoot, "tools/production.mjs"))
      && await exists(path.join(deckRoot, "tools/preflight.mjs")),
    sourceCompiler: await exists(path.join(deckRoot, "node_modules/typescript/package.json")),
  };
  const capabilities = {
    textVoice: checks.appleSilicon && checks.trainPython && checks.ffprobe
      && checks.referenceAudio && checks.referenceText && checks.adapter && checks.voiceModel && checks.qualityModel,
    editing: checks.ffmpeg && checks.ffprobe,
    screenRecording: checks.node && checks.ffmpeg && checks.ffprobe && checks.recordRunner && checks.screenCapture,
    courseVideo: checks.appleSilicon && checks.basePython && checks.trainPython
      && checks.node && checks.ffmpeg && checks.ffprobe && checks.referenceAudio
      && checks.referenceText && checks.adapter && checks.voiceModel && checks.courseConfig
      && checks.qualityModel && checks.aligner && checks.courseScripts && checks.captionRunner && checks.captureRunner
      && checks.productionRunner && checks.sourceCompiler,
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
  const paths = flags.has("--verbose") ? { ...tools, ...studio, adapterPath,
    voiceModelPath: readiness.models[selectedModel].path || null,
    qualityModelPath: readiness.quality.path || null,
    alignerPath: readiness.aligner.path || null } : undefined;
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
    screenRecording: "화면 녹화",
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
    voiceModel: "선택한 음성 모델 로컬 파일",
    qualityModel: "Whisper 자동 음성 검수 모델",
    aligner: "단어 시각 정렬 모델",
    courseConfig: "강의 설정",
    courseScripts: "강의 대본",
    captionRunner: "자막 자동화 도구",
    captureRunner: "영상 촬영 도구",
    captureBrowser: "촬영용 브라우저",
    recordRunner: "화면 녹화 도구",
    screenCapture: "화면 기록 권한 (한 프레임 촬영)",
    productionRunner: "강의 입력 고정·검사 도구",
    sourceCompiler: "강의 소스 분석 도구",
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
