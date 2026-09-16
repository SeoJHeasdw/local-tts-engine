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

const DEFAULT_STUDIO_PATHS = Object.freeze(defaultStudioPaths(ROOT));

export const LEGACY_OUTPUT_PATHS = Object.freeze({
  ttsOutputRoot: path.join(ROOT, "artifacts/course-pilots"),
  voiceOutputRoot: path.join(ROOT, "artifacts/voice-candidates"),
  captionOutputRoot: path.join(ROOT, "artifacts/production/captions"),
  videoOutputRoot: path.join(ROOT, "artifacts/production/videos"),
  editOutputRoot: path.join(ROOT, "artifacts/video-edits"),
});

// sourceProjectRoot는 프로젝트 바깥(예: 형제 폴더의 강의 저장소)을 가리키는 값이라
// 우리 프로젝트가 옮겨졌다고 같이 옮겨졌다고 볼 근거가 없다. 나머지 네 개는 전부
// 프로젝트 폴더 자신의 하위 경로가 기본값이라, 프로젝트째로 옮겨지면 같이 옮겨진
// 것으로 봐도 된다.
const OWN_PROJECT_PATH_KEYS = ["voiceLibraryRoot", "outputRoot", "referenceAudioPath", "referenceTextPath"];

// 설정을 저장할 때 그 시점의 프로젝트 루트를 savedRoot로 같이 적어 둔다. 다음 실행에서
// 프로젝트 루트가 달라져 있으면(폴더째로 옮겨진 것) 그때 각 값이 "저장 당시 루트 기준
// 기본값 그대로"였는지를 본다. 손대지 않은 기본값이었다면 지금 루트 기준으로 다시
// 따라가게 하고, 사용자가 직접 다른 곳으로 바꿔 둔 값이라면 root가 바뀌어도 그대로
// 존중한다 — 그 값이 지금 당장 디스크에 있는지 여부로 판단하지 않는다 (예: 잠깐
// 마운트가 빠진 외장 드라이브 경로를 실수로 기본값으로 되돌리지 않기 위해).
export function normalizeStudioPaths(raw = {}) {
  const savedRoot = typeof raw?.savedRoot === "string" && raw.savedRoot ? raw.savedRoot : ROOT;
  const priorDefaults = savedRoot === ROOT ? DEFAULT_STUDIO_PATHS : defaultStudioPaths(savedRoot);
  const inputs = Object.fromEntries(
    Object.entries(DEFAULT_STUDIO_PATHS).map(([key, fallback]) => {
      const value = String(raw?.[key] || "").trim();
      if (!value) return [key, fallback];
      const resolved = path.resolve(value);
      const isUntouchedDefault = OWN_PROJECT_PATH_KEYS.includes(key) && resolved === priorDefaults[key];
      return [key, isUntouchedDefault ? fallback : resolved];
    }),
  );
  return { ...inputs, savedRoot: ROOT, ...outputPathsForRoot(inputs.outputRoot) };
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
