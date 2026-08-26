import path from "node:path";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function makeJobName(now = new Date(), seconds = 30) {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  const length = seconds >= 60 ? `${Math.round(seconds / 60)}m` : `${seconds}s`;
  return `studio-${stamp}-${length}`;
}

export function normalizeOptions(raw = {}) {
  const mode = raw.mode === "bundle" ? "bundle" : "preview";
  const targetSeconds = 30;
  const startPage = Number(raw.startPage ?? 1);
  const endPage = mode === "bundle" ? Number(raw.endPage ?? startPage) : null;
  const adapterScale = Number(raw.adapterScale ?? 0.6);
  const voiceMode = raw.voiceMode === "zero" ? "zero" : "finetuned";
  const deliverable = ["audio", "captions", "video"].includes(raw.deliverable)
    ? raw.deliverable
    : "video";
  const title = String(raw.title ?? "로컬 강의 영상").trim().slice(0, 100);
  const name = String(raw.name || makeJobName(new Date(), targetSeconds)).trim();

  if (!SLUG_PATTERN.test(name)) {
    throw new Error("결과 이름은 영문 소문자, 숫자, 하이픈만 사용할 수 있습니다.");
  }
  if (!Number.isInteger(startPage) || startPage < 1) {
    throw new Error("시작 페이지는 1 이상의 정수여야 합니다.");
  }
  if (mode === "bundle" && (!Number.isInteger(endPage) || endPage < startPage)) {
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
    adapterScale,
    voiceMode,
    deliverable,
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

export function summarizeChecks(checks) {
  const failed = checks.filter((item) => !item.ok);
  return {
    ok: failed.length === 0,
    passed: checks.length - failed.length,
    total: checks.length,
    failed: failed.map((item) => item.label),
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

export function normalizeEditName(value) {
  const name = String(value ?? "").trim();
  if (!SLUG_PATTERN.test(name)) {
    throw new Error("결과 이름은 영문 소문자, 숫자, 하이픈만 사용할 수 있습니다.");
  }
  return name;
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

export function timeRangeForPages(entries, startPage, endPage) {
  if (!Number.isInteger(startPage) || !Number.isInteger(endPage) || startPage < 1 || endPage < startPage) {
    throw new Error("자를 시작·끝 페이지를 확인해 주세요.");
  }
  const selected = (entries || []).filter((entry) => {
    const page = Number(entry.slideNumber);
    return page >= startPage && page <= endPage;
  });
  if (!selected.length) throw new Error("선택한 페이지가 이 영상의 타임라인에 없습니다.");
  return {
    start: Number(selected[0].startMs) / 1000,
    end: Number(selected.at(-1).endMs) / 1000,
  };
}

export async function mapWithConcurrency(items, limit, worker) {
  const values = Array.from(items || []);
  const results = new Array(values.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await worker(values[index], index);
    }
  };
  const concurrency = Math.max(1, Math.min(Math.floor(limit) || 1, values.length || 1));
  await Promise.all(Array.from({ length: concurrency }, () => run()));
  return results;
}
