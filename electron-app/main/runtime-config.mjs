import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";


const COMMON_EXECUTABLE_DIRS = Object.freeze([
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
]);


export function defaultSourceProjectRoot(projectRoot, env = process.env) {
  const configured = String(env.TTS_STUDIO_SOURCE_PROJECT || "").trim();
  return path.resolve(configured || path.join(projectRoot, "..", "udemy-agent"));
}


export function defaultStudioPaths(projectRoot, env = process.env) {
  return {
    sourceProjectRoot: defaultSourceProjectRoot(projectRoot, env),
    voiceLibraryRoot: path.join(projectRoot, "data/private/voice"),
    outputRoot: path.join(projectRoot, "output"),
    referenceAudioPath: path.join(projectRoot, "artifacts/benchmarks/2026-08-23/reference.wav"),
    referenceTextPath: path.join(projectRoot, "artifacts/benchmarks/2026-08-23/reference.txt"),
  };
}


export function executableCandidates(command, env = process.env) {
  const pathDirectories = String(env.PATH || "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set([...pathDirectories, ...COMMON_EXECUTABLE_DIRS])]
    .map((directory) => path.join(directory, command));
}


export async function firstExecutable(candidates, access = fs.access) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      await access(candidate, fsConstants.X_OK);
      return path.resolve(candidate);
    } catch {
      // 다음 후보를 확인한다.
    }
  }
  return null;
}


export async function resolveRuntimeTools(projectRoot, env = process.env, access = fs.access) {
  const configured = (key, fallback) => {
    const value = String(env[key] || "").trim();
    return path.resolve(value || fallback);
  };
  const command = (key, name) => {
    const value = String(env[key] || "").trim();
    return value ? [path.resolve(value)] : executableCandidates(name, env);
  };

  const [basePython, trainPython, node, ffmpeg, ffprobe] = await Promise.all([
    firstExecutable([
      configured("TTS_STUDIO_BASE_PYTHON", path.join(projectRoot, ".venv/bin/python")),
    ], access),
    firstExecutable([
      configured("TTS_STUDIO_TRAIN_PYTHON", path.join(projectRoot, ".venv-train/bin/python")),
    ], access),
    firstExecutable(command("TTS_STUDIO_NODE", "node"), access),
    firstExecutable(command("TTS_STUDIO_FFMPEG", "ffmpeg"), access),
    firstExecutable(command("TTS_STUDIO_FFPROBE", "ffprobe"), access),
  ]);

  return { basePython, trainPython, node, ffmpeg, ffprobe };
}


export function ffmpegBuildProfile(versionOutput) {
  const value = String(versionOutput || "");
  return {
    gplEnabled: value.includes("--enable-gpl"),
    nonfreeEnabled: value.includes("--enable-nonfree"),
    libx264Enabled: value.includes("--enable-libx264"),
  };
}
