import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultStudioPaths } from "./runtime-config.mjs";
import { outputPathsForRoot } from "../shared/index.mjs";

export const APP_DIR = fileURLToPath(new URL("../", import.meta.url));

export const ROOT = path.dirname(APP_DIR);

export const RENDERER_DIR = path.join(APP_DIR, "renderer");

export const APP_SETTINGS_PATH = path.join(ROOT, "artifacts/app-settings.json");

// 한 챕터를 만드는 데 두 시간 반이 걸린다. 앱이 꺼지면 그 시간이 통째로 사라지는
// 것을 막으려면 진행이 프로세스가 아니라 디스크에 남아 있어야 한다. 끝난 편의
// 이름만 적어 두면 되는데, 끝난 편은 검증까지 마친 영상이라 다시 만들 이유가
// 없기 때문이다.
export const ACTIVE_JOB_PATH = path.join(ROOT, "artifacts/active-job.json");

export const FINETUNE_RUN_ROOT = path.join(ROOT, "artifacts/finetune-runs");

export const FINETUNE_TRAIN_JSONL = path.join(ROOT, "artifacts/finetune-datasets/jaeho-ko-v1/official/train.jsonl");

export const ADAPTER = path.join(ROOT, "artifacts/finetune-runs/2026-08-25/jaeho-ko-r16-v1/adapters");

// How many different seeds a chunk may spend before a page is handed to a
// person. Mirrors MAX_AUTOMATIC_ATTEMPTS in speech_quality.py.
export const DEFAULT_QUALITY_ATTEMPTS = 4;

export const DEFAULT_STUDIO_PATHS = Object.freeze(defaultStudioPaths(ROOT));

export const LEGACY_OUTPUT_PATHS = Object.freeze({
  ttsOutputRoot: path.join(ROOT, "artifacts/course-pilots"),
  voiceOutputRoot: path.join(ROOT, "artifacts/voice-candidates"),
  captionOutputRoot: path.join(ROOT, "artifacts/production/captions"),
  videoOutputRoot: path.join(ROOT, "artifacts/production/videos"),
  editOutputRoot: path.join(ROOT, "artifacts/video-edits"),
});

export function normalizeStudioPaths(raw = {}) {
  const inputs = Object.fromEntries(
    Object.entries(DEFAULT_STUDIO_PATHS).map(([key, fallback]) => {
      const value = String(raw?.[key] || fallback).trim();
      return [key, path.resolve(value || fallback)];
    }),
  );
  return { ...inputs, ...outputPathsForRoot(inputs.outputRoot) };
}

export function runtimePaths(raw = {}) {
  const studio = normalizeStudioPaths(raw);
  const deckRoot = path.join(studio.sourceProjectRoot, "deck");
  return {
    ...studio,
    deckRoot,
    configPath: path.join(deckRoot, "narration.config.json"),
  };
}

export function dateFolder(now = new Date()) {
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
}
