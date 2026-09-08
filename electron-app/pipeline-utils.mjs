import path from "node:path";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function makeJobName(now = new Date(), seconds = null) {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  const length = Number.isFinite(seconds)
    ? seconds >= 60 ? `${Math.round(seconds / 60)}m` : `${seconds}s`
    : "course";
  return `studio-${stamp}-${length}`;
}

export function displayVideoFileStem(value) {
  const replacements = {
    "<": "＜",
    ">": "＞",
    ":": "：",
    '"': "＂",
    "/": "／",
    "\\": "＼",
    "|": "｜",
    "?": "？",
    "*": "＊",
  };
  const stem = String(value || "완성 영상")
    .normalize("NFC")
    .replace(/\.mp4$/i, "")
    .replace(/[<>:"/\\|?*]/g, (character) => replacements[character])
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 180);
  return stem || "완성 영상";
}

export function nextDisplayVideoFileName(title, existingNames = []) {
  const stem = displayVideoFileStem(title);
  const normalized = new Set(Array.from(existingNames, (name) => (
    String(name).normalize("NFC").toLocaleLowerCase("ko-KR")
  )));
  const available = (name) => !normalized.has(name.normalize("NFC").toLocaleLowerCase("ko-KR"));
  const first = `${stem}.mp4`;
  if (available(first)) return first;
  for (let sequence = 2; sequence < 10_000; sequence += 1) {
    const candidate = `${stem} (${sequence}).mp4`;
    if (available(candidate)) return candidate;
  }
  throw new Error("같은 이름의 영상이 너무 많아 새 파일명을 정하지 못했습니다.");
}

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

export function lessonCatalogFromPresets(pages = [], presets = {}) {
  const findPage = (chapter, slideId) => pages.find((page) => (
    String(page?.slideId || "") === String(slideId || "")
    && (!chapter || String(page?.chapter || "") === String(chapter))
  ));
  return Object.entries(presets || {})
    .filter(([id]) => /^ch\d{2}(?:-l\d{2}(?:-end)?)?$/.test(id))
    .map(([id, preset]) => {
      const start = findPage(preset.startChapter, preset.startSlide);
      const end = findPage(preset.endChapter || preset.startChapter, preset.endSlide || preset.startSlide);
      if (!start || !end || Number(end.page) < Number(start.page)) return null;
      const selected = pages.filter((page) => Number(page.page) >= Number(start.page) && Number(page.page) <= Number(end.page));
      return {
        id,
        title: String(preset.title || id),
        chapter: String(start.chapter || ""),
        startPage: Number(start.page),
        endPage: Number(end.page),
        pageCount: selected.length,
        stepCount: selected.reduce((total, page) => total + Math.max(0, Number(page.stepCount || 0)), 0),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.startPage - b.startPage || a.endPage - b.endPage);
}

/**
 * deck 레슨 파일에서 뽑아낸 레슨 목록을 정본으로 쓰고, 아직 레슨으로
 * 쪼개지 않은 챕터만 narration.config.json 의 preset 으로 채운다.
 * 한 챕터를 두 곳에서 동시에 정의하면 목록에 같은 구간이 두 번 나온다.
 */
export function combineLessonCatalogs(deckLessons = [], presetLessons = []) {
  const covered = new Set(deckLessons.map((lesson) => lesson.chapter));
  return [...deckLessons, ...presetLessons.filter((lesson) => !covered.has(lesson.chapter))]
    .sort((a, b) => a.startPage - b.startPage || a.endPage - b.endPage);
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

export function voiceFindingSeverity(chunk = {}) {
  const recorded = String(chunk.severity || "");
  if (recorded) return recorded;
  // Manifests written before severity existed only knew pass and fail, and a
  // failure then meant the page had to be made again.
  return chunk.selected?.passed === false ? "failed" : "ok";
}

export function voiceQualityFindings(manifest = {}) {
  const timings = new Map(
    (manifest.chunks || []).map((chunk) => [String(chunk.key || ""), chunk]),
  );
  return (manifest.quality?.chunks || [])
    .map((chunk) => ({ chunk, severity: voiceFindingSeverity(chunk) }))
    .filter(({ severity }) => severity === "failed" || severity === "warning")
    .map(({ chunk, severity }) => {
      const timing = timings.get(String(chunk.chunkKey || "")) || {};
      const selected = chunk.selected || {};
      const reasons = [...(selected.failures || []), ...(selected.warnings || [])].map(String);
      const pauses = [...(selected.prosody?.checks || []), ...(selected.restarts?.checks || [])];
      const onlyPauses = pauses.length > 0 && reasons.every((reason) => ["단어 내부 끊김 확인 필요", "짧은 발음 반복 확인 필요"].includes(reason));
      const clipStart = Number(timing.startMs || 0);
      return {
        chapter: String(chunk.chapter || ""),
        slideId: String(chunk.slideId || ""),
        slideNumber: Number(chunk.slideNumber || 0),
        startMs: onlyPauses ? clipStart + Math.min(...pauses.map((check) => check.startMs)) : clipStart,
        endMs: onlyPauses ? clipStart + Math.max(...pauses.map((check) => check.endMs)) : Number(timing.endMs || timing.startMs || 0),
        severity,
        reasons: reasons.length ? reasons : ["자동 음성 검수 점수 미달"],
        terms: [...(selected.pronunciationChecks || []), ...pauses]
          .filter((check) => check?.status && check.status !== "ok")
          .map((check) => ({ term: String(check.term || ""), status: String(check.status) })),
        expectedText: String(selected.expectedText || ""),
        recognizedText: String(selected.recognizedText || ""),
        selectedAttempt: Number(selected.attempt || 1),
        attempts: Array.isArray(chunk.candidates) ? chunk.candidates.length : 1,
      };
    })
    .sort((left, right) => left.startMs - right.startMs || left.slideNumber - right.slideNumber);
}

export function videoTimelineFileName(videoPath) {
  return `${path.basename(String(videoPath || ""), path.extname(String(videoPath || "")))}.timeline.json`;
}

// A finished video is published away from the project folder that produced it,
// and a folder can hold several runs of the same job. The timeline named after
// this exact video wins; the shared names are fallbacks for videos published
// before per-video timelines existed.
export function videoTimelineCandidates(videoPath, captionOutputRoot) {
  const directory = path.dirname(String(videoPath || ""));
  const candidates = [
    path.join(directory, videoTimelineFileName(videoPath)),
    path.join(directory, "timeline.json"),
  ];
  if (captionOutputRoot) {
    candidates.push(path.join(String(captionOutputRoot), path.basename(directory), "timeline.json"));
  }
  return [...new Set(candidates)];
}

export function pageRangeFromTimeline(timeline) {
  const pages = (timeline?.entries || [])
    .map((entry) => Number(entry?.slideNumber))
    .filter(Number.isFinite);
  if (!pages.length) return null;
  return { start: Math.min(...pages), end: Math.max(...pages) };
}

// Replacing one page's voice needs the page boundaries. Without them the only
// thing ffmpeg can do is overwrite the whole soundtrack, which is a far worse
// outcome than being told why it cannot proceed.
export function assertPageReplaceable(videoRecord = {}, range = {}) {
  const start = Number(range.startPage);
  const end = Number(range.endPage);
  if (!videoRecord.timelinePath || !videoRecord.pageRange) {
    throw new Error(
      "이 영상에는 페이지 타임라인이 없어 일부 페이지만 교체할 수 없습니다. "
      + "앱에서 만든 강의 영상을 선택하거나, 교체할 음성 파일을 직접 고르세요.",
    );
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
    throw new Error("교체할 시작·끝 페이지를 확인해 주세요.");
  }
  if (start < videoRecord.pageRange.start || end > videoRecord.pageRange.end) {
    throw new Error(
      `이 영상은 ${videoRecord.pageRange.start}~${videoRecord.pageRange.end}페이지만 담고 있습니다.`,
    );
  }
  return true;
}

export function withOutputReview(report, status, now = new Date()) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("청취 검수 기록을 저장할 결과가 없습니다.");
  }
  if (!["approved", "pending"].includes(status)) {
    throw new Error("지원하지 않는 청취 검수 상태입니다.");
  }
  return {
    ...report,
    review: {
      status,
      updatedAt: now.toISOString(),
    },
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

export function remapPatchedTimestamp(value, startMs, endMs, factor, deltaMs) {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  if (number <= startMs) return Math.round(number);
  if (number >= endMs) return Math.round(number + deltaMs);
  return Math.round(startMs + (number - startMs) * factor);
}

export function patchedTimeline(timeline, startMs, endMs, replacementDurationMs, now = new Date()) {
  const originalDurationMs = endMs - startMs;
  if (!(originalDurationMs > 0) || !(replacementDurationMs > 0)) {
    throw new Error("교체할 페이지 음성 구간이 올바르지 않습니다.");
  }
  const factor = replacementDurationMs / originalDurationMs;
  const deltaMs = replacementDurationMs - originalDurationMs;
  const entries = timeline.entries.map((entry) => {
    const mapped = { ...entry };
    for (const field of ["startMs", "endMs", "transitionAtMs", "speechStartMs", "speechEndMs"]) {
      mapped[field] = remapPatchedTimestamp(entry[field], startMs, endMs, factor, deltaMs);
    }
    mapped.audio = { ...(entry.audio || {}), durationMs: mapped.endMs - mapped.startMs };
    if (entry.alignment?.words) {
      mapped.alignment = {
        ...entry.alignment,
        words: entry.alignment.words.map((word) => ({
          ...word,
          startMs: remapPatchedTimestamp(word.startMs, startMs, endMs, factor, deltaMs),
          endMs: remapPatchedTimestamp(word.endMs, startMs, endMs, factor, deltaMs),
        })),
      };
    }
    mapped.forcedPauses = (entry.forcedPauses || []).map((pause) => ({
      ...pause,
      nextSpeechStartMs: remapPatchedTimestamp(
        pause.nextSpeechStartMs,
        startMs,
        endMs,
        factor,
        deltaMs,
      ),
    }));
    return mapped;
  });
  for (const [index, entry] of entries.entries()) {
    const nextStart = index + 1 < entries.length
      ? Number(entries[index + 1].startMs)
      : Number(timeline.totalMs) + deltaMs;
    entry.gapAfterMs = Math.max(0, Math.round(nextStart - Number(entry.endMs)));
  }
  return {
    ...timeline,
    generatedAt: now.toISOString(),
    totalMs: Math.round(Number(timeline.totalMs) + deltaMs),
    entries,
    voicePatch: { startMs, endMs, replacementDurationMs, deltaMs },
  };
}

export function pageVoicePatchPlan({
  videoDuration,
  targetStart,
  targetEnd,
  sourceStart,
  sourceEnd,
  matchAudio = true,
}) {
  const targetDuration = Number(targetEnd) - Number(targetStart);
  const generatedDuration = Number(sourceEnd) - Number(sourceStart);
  if (!(videoDuration > 0) || !(targetDuration > 0) || !(generatedDuration > 0)) {
    throw new Error("교체할 페이지 음성 구간이 올바르지 않습니다.");
  }
  const replacementDuration = matchAudio ? generatedDuration : targetDuration;
  const videoFactor = replacementDuration / targetDuration;
  const filters = [];
  const videoParts = [];
  const audioParts = [];
  const addOriginalPart = (label, start, end) => {
    const endOption = end == null ? "" : `:end=${end.toFixed(6)}`;
    filters.push(`[0:v]trim=start=${start.toFixed(6)}${endOption},setpts=PTS-STARTPTS[v${label}]`);
    filters.push(`[0:a]atrim=start=${start.toFixed(6)}${endOption},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono[a${label}]`);
    videoParts.push(`[v${label}]`);
    audioParts.push(`[a${label}]`);
  };
  if (targetStart > 0.001) addOriginalPart("pre", 0, targetStart);
  filters.push(`[0:v]trim=start=${targetStart.toFixed(6)}:end=${targetEnd.toFixed(6)},setpts=${videoFactor.toFixed(9)}*(PTS-STARTPTS)[vmid]`);
  filters.push(`[1:a]atrim=start=${sourceStart.toFixed(6)}:end=${sourceEnd.toFixed(6)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono,apad=whole_dur=${replacementDuration.toFixed(6)},atrim=duration=${replacementDuration.toFixed(6)}[amid]`);
  videoParts.push("[vmid]");
  audioParts.push("[amid]");
  if (targetEnd < videoDuration - 0.001) addOriginalPart("post", targetEnd, null);
  if (videoParts.length > 1) {
    filters.push(`${videoParts.join("")}concat=n=${videoParts.length}:v=1:a=0[vout]`);
    filters.push(`${audioParts.join("")}concat=n=${audioParts.length}:v=0:a=1[aout]`);
  } else {
    filters.push("[vmid]null[vout]");
    filters.push("[amid]anull[aout]");
  }
  return {
    filter: filters.join(";"),
    replacementDuration,
    videoFactor,
    videoOutput: "[vout]",
    audioOutput: "[aout]",
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

export function reviewPages(timeline) {
  const pages = [];
  for (const entry of timeline?.entries || []) {
    const number = Number(entry.slideNumber), startMs = Number(entry.startMs), endMs = Number(entry.endMs);
    if (!Number.isInteger(number) || number < 1 || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) continue;
    let page = pages.at(-1);
    if (!page || page.number !== number || page.slideId !== entry.slideId) {
      page = { number, slideId: String(entry.slideId || ''), startMs, endMs, text: '' };
      pages.push(page);
    }
    page.endMs = Math.max(page.endMs, endMs);
    page.text += `${page.text ? '\n' : ''}${String(entry.sourceText || '')}`;
  }
  return pages;
}

export function muteRegionFilter(start, end, duration, maxSeconds = 2) {
  if (![start, end, duration].every(Number.isFinite) || start < 0 || end > duration || end - start < .05 || end - start > maxSeconds) {
    throw new Error('영상 안에서 0.05~2초의 제거 구간을 선택해 주세요.');
  }
  const a = start.toFixed(6), b = end.toFixed(6), innerA = (start + .005).toFixed(6), innerB = (end - .005).toFixed(6);
  return `aeval='val(ch)*if(lt(t,${a}),1,if(lt(t,${innerA}),(${innerA}-t)/0.005,if(lt(t,${innerB}),0,if(lt(t,${b}),(t-${innerB})/0.005,1))))':c=same`;
}

export function replaceRegionPlan(start, end, videoDuration, audioDuration) {
  if (![start, end, videoDuration, audioDuration].every(Number.isFinite) || start < 0 || end > videoDuration || end - start < .05 || end - start > 10 || audioDuration < .01) {
    throw new Error('영상 안에서 0.05~10초의 교체 구간과 유효한 음성을 선택해 주세요.');
  }
  if (audioDuration > end - start + .001) throw new Error(`교체 음성(${audioDuration.toFixed(2)}초)이 선택 구간(${(end-start).toFixed(2)}초)보다 깁니다. 구간을 늘리거나 더 짧은 음성을 선택해 주세요.`);
  const base = muteRegionFilter(start, end, videoDuration, 10);
  const span = (end-start).toFixed(6), fadeStart = Math.max(0,audioDuration-.005).toFixed(6);
  return `[0:a]${base}[base];[1:a]atrim=duration=${audioDuration.toFixed(6)},asetpts=PTS-STARTPTS,afade=t=in:d=0.005,afade=t=out:st=${fadeStart}:d=0.005,apad=whole_dur=${span},atrim=duration=${span},adelay=${(start*1000).toFixed(3)}:all=1[patch];[base][patch]amix=inputs=2:duration=first:normalize=0[outa]`;
}
