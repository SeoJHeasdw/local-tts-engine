import nativeFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ROOT } from "./paths.mjs";
import { voiceInputIdentity, voiceInputMatches } from './voice-profile.mjs';

const MODEL_REPOSITORIES = Object.freeze({
  "qwen3-tts": "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16",
  "chatterbox-v3": "mlx-community/chatterbox-multilingual-v3",
  chatterboxTokenizer: "mlx-community/S3TokenizerV2",
  quality: "mlx-community/whisper-large-v3-turbo-asr-fp16",
  aligner: "mlx-community/Qwen3-ForcedAligner-0.6B-8bit",
});

// These are resources the installed mlx-audio loaders read after loading the
// main weights. A cache with only config.json and model.safetensors can still
// fail at the first token, or trigger a tokenizer download.
const MODEL_SUPPORT_FILES = Object.freeze({
  [MODEL_REPOSITORIES["qwen3-tts"]]: [
    "tokenizer_config.json", "speech_tokenizer/config.json", "speech_tokenizer/model.safetensors",
  ],
  [MODEL_REPOSITORIES["chatterbox-v3"]]: ["tokenizer.json", "Cangjie5_TC.json"],
  [MODEL_REPOSITORIES.quality]: ["tokenizer_config.json", "preprocessor_config.json"],
  [MODEL_REPOSITORIES.aligner]: ["tokenizer_config.json", "preprocessor_config.json"],
});

function absent(error) { return error?.code === "ENOENT"; }

async function fileState(fs, file) {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() && stat.size > 0 ? "ready" : "incomplete";
  } catch (error) { return absent(error) ? "missing" : "unknown"; }
}

async function weightState(fs, directory) {
  const single = await fileState(fs, path.join(directory, "model.safetensors"));
  const indexPath = path.join(directory, "model.safetensors.index.json");
  const index = await fileState(fs, indexPath);
  if (index === "missing") return single === "ready" ? "ready" : single === "unknown" ? "unknown" : "incomplete";
  if (index !== "ready") return index === "unknown" ? "unknown" : "incomplete";
  try {
    const parsed = JSON.parse(await fs.readFile(indexPath, "utf8"));
    const shards = [...new Set(Object.values(parsed.weight_map || {}))];
    if (!shards.length || shards.some((name) => typeof name !== "string" || path.basename(name) !== name)) return "incomplete";
    const states = await Promise.all(shards.map((name) => fileState(fs, path.join(directory, name))));
    return states.every((state) => state === "ready") ? "ready"
      : states.includes("unknown") ? "unknown" : "incomplete";
  } catch { return "unknown"; }
}

function combinedState(states) {
  return states.every((state) => state === "ready") ? "ready"
    : states.includes("unknown") ? "unknown" : "incomplete";
}

async function textTokenizerState(fs, directory) {
  const tokenizerJson = await fileState(fs, path.join(directory, "tokenizer.json"));
  if (tokenizerJson === "ready") return "ready";
  const pair = combinedState(await Promise.all(["vocab.json", "merges.txt"]
    .map((file) => fileState(fs, path.join(directory, file)))));
  return pair === "ready" ? "ready" : combinedState([tokenizerJson, pair]);
}

async function snapshotState(fs, directory, repository) {
  const config = await fileState(fs, path.join(directory, "config.json"));
  const weights = await weightState(fs, directory);
  const support = await Promise.all((MODEL_SUPPORT_FILES[repository] || [])
    .map((file) => fileState(fs, path.join(directory, file))));
  if ([MODEL_REPOSITORIES["qwen3-tts"], MODEL_REPOSITORIES.quality, MODEL_REPOSITORIES.aligner].includes(repository)) {
    support.push(await textTokenizerState(fs, directory));
  }
  return combinedState([config, weights, ...support]);
}

function hubRoot(env, home) {
  return path.resolve(env.HF_HUB_CACHE || path.join(env.HF_HOME || path.join(home, ".cache/huggingface"), "hub"));
}

// Python resolve_model_path가 찾는 저장소와 같은 로컬 캐시만 본다. 실행·다운로드는 하지 않는다.
export async function inspectCachedModel(repository, { fs = nativeFs, env = process.env, home = os.homedir(),
  localPath = null, requireMainRef = false } = {}) {
  if (localPath) {
    const localConfig = await fileState(fs, path.join(localPath, "config.json"));
    if (localConfig !== "missing") {
      const localState = await snapshotState(fs, localPath, repository);
      return { state: localState, ...(localState === "ready" ? { path: localPath } : {}) };
    }
  }
  const cache = path.join(hubRoot(env, home), `models--${repository.replaceAll("/", "--")}`);
  const snapshotsRoot = path.join(cache, "snapshots");
  let names;
  try { names = await fs.readdir(snapshotsRoot); }
  catch (error) {
    return { state: absent(error) ? "missing" : "unknown" };
  }
  const preferred = await fs.readFile(path.join(cache, "refs/main"), "utf8")
    .then((value) => value.trim(), () => "");
  if (preferred && names.includes(preferred)) {
    const directory = path.join(snapshotsRoot, preferred);
    const state = await snapshotState(fs, directory, repository);
    return { state, ...(state === "ready" ? { path: directory } : {}) };
  }
  // Chatterbox's installed loader calls snapshot_download(".../S3TokenizerV2")
  // without a revision. In offline mode that call needs a cached refs/main;
  // a loose snapshot alone is not enough even though the weights exist.
  if (requireMainRef) return { state: "incomplete" };
  // resolve_model_path는 main이 없으면 가장 최근 snapshot 하나를 고른다.
  const ordered = await Promise.all(names.map(async (name) => ({ name,
    modified: await fs.stat(path.join(snapshotsRoot, name)).then((stat) => stat.mtimeMs, () => -1),
  })));
  ordered.sort((left, right) => right.modified - left.modified);
  const chosen = ordered.find((item) => item.modified >= 0 && item.name !== '.' && item.name !== '..');
  if (!chosen) return { state: names.length ? "unknown" : "missing" };
  const directory = path.join(snapshotsRoot, chosen.name);
  const state = await snapshotState(fs, directory, repository);
  return { state, ...(state === "ready" ? { path: directory } : {}) };
}

async function referenceTextState(fs, file) {
  const state = await fileState(fs, file);
  if (state !== "ready") return { state };
  try { return { state: (await fs.readFile(file, "utf8")).trim() ? "ready" : "incomplete" }; }
  catch { return { state: "unknown" }; }
}

export async function inspectVoiceReadiness(settings, studio, { fs = nativeFs, env = process.env, home = os.homedir(), root = ROOT } = {}) {
  const checkModel = (repository, localPath = null, requireMainRef = false) =>
    inspectCachedModel(repository, { fs, env, home, localPath, requireMainRef });
  const selectedAdapter = settings.adapters?.find((item) => item.id === settings.adapterId);
  const [qwen, chatterboxModel, chatterboxTokenizer, quality, aligner, referenceAudio, referenceText,
    adapterWeights, adapterConfig] = await Promise.all([
    checkModel(MODEL_REPOSITORIES["qwen3-tts"]),
    checkModel(MODEL_REPOSITORIES["chatterbox-v3"]),
    checkModel(MODEL_REPOSITORIES.chatterboxTokenizer, null, true),
    checkModel(MODEL_REPOSITORIES.quality, path.join(root, "artifacts/models/whisper-large-v3-turbo-asr-fp16")),
    checkModel(MODEL_REPOSITORIES.aligner),
    fileState(fs, studio.referenceAudioPath).then((state) => ({ state })),
    referenceTextState(fs, studio.referenceTextPath),
    settings.adapterId === "none" ? Promise.resolve("ready")
      : selectedAdapter ? fileState(fs, path.join(selectedAdapter.path, "adapters.safetensors")) : Promise.resolve("missing"),
    settings.adapterId === "none" ? Promise.resolve("ready")
      : selectedAdapter ? fileState(fs, path.join(selectedAdapter.path, "adapter_config.json")) : Promise.resolve("missing"),
  ]);
  const combined = (...items) => ({ state: items.every((item) => item === "ready") ? "ready"
    : items.includes("unknown") ? "unknown" : items.includes("incomplete") ? "incomplete" : "missing" });
  const chatterbox = combined(chatterboxModel.state, chatterboxTokenizer.state);
  let approvalError = selectedAdapter?.approvalError;
  if (selectedAdapter?.voiceInputIdentity) {
    try {
      const current = await voiceInputIdentity(selectedAdapter.path, studio, { fs });
      if (!voiceInputMatches(selectedAdapter.voiceInputIdentity, current)) approvalError = '청취 확인 뒤 목소리 파일·대표 녹음·전사가 바뀌었습니다. 다시 듣고 확인해 주세요.';
    } catch { approvalError = '청취 확인한 목소리 파일·대표 녹음·전사를 읽지 못했습니다.'; }
  }
  if (chatterboxModel.state === "ready" && chatterboxTokenizer.state !== "ready") {
    chatterbox.detail = "S3TokenizerV2 부속 모델 파일을 확인해 주세요";
  }
  return {
    models: {
      "qwen3-tts": qwen,
      "chatterbox-v3": chatterbox,
    },
    referenceAudio,
    referenceText,
    adapter: settings.adapterId === "none" ? { state: "unused" }
      : selectedAdapter?.profileError || approvalError ? { state: "incomplete", detail: selectedAdapter.profileError || approvalError }
      : combined(adapterWeights, adapterConfig),
    quality,
    aligner,
  };
}

// Run synthesis against the files preflight inspected. Hugging Face loaders
// otherwise may fetch a newer revision after the check. Clearing proxy settings
// avoids an httpx transport setup error in some offline-only environments.
export function localVoiceEnvironment(base = process.env) {
  const env = { ...base, HF_HUB_OFFLINE: "1" };
  for (const key of ["ALL_PROXY", "HTTPS_PROXY", "HTTP_PROXY", "all_proxy", "https_proxy", "http_proxy"]) {
    delete env[key];
  }
  return env;
}

const DOWNLOAD_ESTIMATE = Object.freeze({
  "qwen3-tts": "약 4 GB",
  "chatterbox-v3": "약 3.3 GB (부속 토크나이저 포함)",
  quality: "약 1.7 GB",
  aligner: "약 1.3 GB",
});

// Python 모델 로더는 캐시가 없으면 다운로드할 수 있다. 앱 제작 시작점에서 먼저
// 로컬 파일을 확인해 무고지 다운로드를 막는다. 파일 확인은 실제 합성 성공을 보증하지 않는다.
export async function assertVoiceAssetsReady(settings, studio, requirements = {}, dependencies = {}) {
  const readiness = await inspectVoiceReadiness(settings, studio, dependencies);
  const modelId = settings.modelId === "chatterbox-v3" ? "chatterbox-v3" : "qwen3-tts";
  const checks = [
    ["참조 음성", readiness.referenceAudio],
    ["참조 전사문", readiness.referenceText],
    ["목소리 어댑터", readiness.adapter?.state === "unused" ? { state: "ready" } : readiness.adapter],
    [modelId === "qwen3-tts" ? "Qwen3-TTS 음성 모델" : "Chatterbox 음성 모델과 부속 토크나이저",
      readiness.models[modelId], DOWNLOAD_ESTIMATE[modelId]],
  ];
  if (requirements.quality !== false) checks.push(["Whisper 자동 음성 검수 모델", readiness.quality, DOWNLOAD_ESTIMATE.quality]);
  if (requirements.aligner) checks.push(["단어 시각 정렬 모델", readiness.aligner, DOWNLOAD_ESTIMATE.aligner]);
  for (const [label, result, estimate] of checks) {
    if (result?.state === "ready") continue;
    const detail = result?.detail || (result?.state === "unknown" ? "상태를 읽을 수 없습니다"
      : result?.state === "incomplete" ? "파일이 불완전합니다" : "로컬 파일이 없습니다");
    const installation = estimate
      ? ` ${label}은(는) 목소리 제작에 필요하고 설치 예상 용량은 ${estimate}입니다. 자동 다운로드를 피하려고 시작을 중단했습니다.`
      : " 설정에서 경로와 파일을 확인해 주세요.";
    throw new Error(`${label}: ${detail}.${installation}`);
  }
  return readiness;
}
