import path from "node:path";
import { makeJobName, SLUG_PATTERN } from "./names.mjs";
import { videoQuality } from "./video-quality.mjs";

export function normalizeOptions(raw = {}) {
  const mode = raw.mode === "bundle" || raw.mode === "page"
    ? "page"
    : ["lesson", "chapter"].includes(raw.mode)
      ? raw.mode
      : "lesson";
  const targetSeconds = Number(raw.targetSeconds ?? 0);
  const startPage = Number(raw.startPage ?? 1);
  const endPage = Number(raw.endPage ?? startPage);
  const chapterMode = raw.chapterMode === "lesson" ? "lesson" : "single";
  const adapterScale = Number(raw.adapterScale ?? 0.6);
  const voiceMode = raw.voiceMode === "zero" ? "zero" : "finetuned";
  const deliverable = ["audio", "captions", "video"].includes(raw.deliverable)
    ? raw.deliverable
    : "video";
  const title = String(raw.title ?? "로컬 강의 영상").trim().slice(0, 100);
  const name = String(raw.name || makeJobName()).trim();

  if (!SLUG_PATTERN.test(name)) {
    throw new Error("결과 이름은 영문 소문자, 숫자, 하이픈만 사용할 수 있습니다.");
  }
  if (!Number.isInteger(startPage) || startPage < 1) {
    throw new Error("시작 페이지는 1 이상의 정수여야 합니다.");
  }
  if (!Number.isFinite(targetSeconds) || targetSeconds < 0) {
    throw new Error("목표 길이는 0초 이상의 숫자여야 합니다.");
  }
  if (!Number.isInteger(endPage) || endPage < startPage) {
    throw new Error("끝 페이지는 시작 페이지보다 같거나 커야 합니다.");
  }
  if (voiceMode === "finetuned" && (!Number.isFinite(adapterScale) || adapterScale <= 0 || adapterScale > 1)) {
    throw new Error("파인튜닝 강도는 0보다 크고 1 이하여야 합니다.");
  }

  return {
    name,
    title: title || "로컬 강의 영상",
    mode,
    targetSeconds,
    startPage,
    endPage,
    chapter: String(raw.chapter || "").trim().toLowerCase() || null,
    chapterMode,
    adapterScale,
    voiceMode,
    deliverable,
    videoQuality: videoQuality(raw.videoQuality).id,
    burnCaptions: raw.burnCaptions !== false,
  };
}

export function presetFromManifest(manifest, options) {
  const entries = manifest?.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("생성된 음성에 타임라인 항목이 없습니다.");
  }
  const first = entries[0];
  const last = entries.at(-1);
  return {
    title: options.title,
    startChapter: first.chapter,
    startSlide: first.slide_id,
    endChapter: last.chapter,
    endSlide: last.slide_id,
    endStep: Number(last.step),
  };
}

export function providerForOptions(options, model = {}) {
  const provider = {
    modelId: (typeof model === "string" ? model : model.repository)
      || "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16",
    modelRevision: (typeof model === "object" ? model.revision : null) || "local-cache",
    outputFormat: "wav_48000_pcm24",
  };
  if (options.voiceMode === "finetuned") {
    provider.adapter = options.adapterLabel || "jaeho-ko-r16-v1";
    provider.adapterScale = options.adapterScale;
  }
  return provider;
}

export function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export function outputPathsForRoot(outputRoot) {
  const root = path.resolve(String(outputRoot || "output"));
  return {
    outputRoot: root,
    ttsOutputRoot: path.join(root, "tts"),
    voiceOutputRoot: path.join(root, "voices"),
    captionOutputRoot: path.join(root, "projects"),
    videoOutputRoot: path.join(root, "videos"),
    editOutputRoot: path.join(root, "edits"),
  };
}

export function parseTimecode(value) {
  const raw = String(value ?? "").trim();
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  const parts = raw.split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) {
    throw new Error("시간은 75.5 또는 00:01:15.5 형식으로 입력해 주세요.");
  }
  const seconds = parts.reverse().reduce((total, part, index) => total + Number(part) * (60 ** index), 0);
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("시간 값이 올바르지 않습니다.");
  return seconds;
}

export function normalizeVoiceText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}
