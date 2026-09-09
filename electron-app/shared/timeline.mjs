import path from "node:path";

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

export function reviewPages(timeline) {
  const pages = [];
  for (const entry of timeline?.entries || []) {
    const number = Number(entry.slideNumber), startMs = Number(entry.startMs), endMs = Number(entry.endMs);
    if (!Number.isInteger(number) || number < 1 || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) continue;
    let page = pages.at(-1);
    if (!page || page.number !== number || page.slideId !== entry.slideId) {
      page = { number, slideId: String(entry.slideId || ''), startMs, endMs, text: '', words: [] };
      pages.push(page);
    }
    page.endMs = Math.max(page.endMs, endMs);
    page.text += `${page.text ? '\n' : ''}${String(entry.sourceText || '')}`;
    // 낱말별 시각이 있어야 걸린 단어로 정확히 옮겨 갈 수 있다. 없으면 페이지
    // 처음으로 보내는 수밖에 없고, 그러면 어디가 문제인지 다시 찾아야 한다.
    for (const word of entry.alignment?.words || []) {
      const wordStart = Number(word.startMs), wordEnd = Number(word.endMs);
      if (!Number.isFinite(wordStart) || !Number.isFinite(wordEnd)) continue;
      page.words.push({ text: String(word.text || ''), startMs: wordStart, endMs: wordEnd });
    }
  }
  return pages;
}

export const SHIFTED_ENTRY_FIELDS = ["startMs", "endMs", "transitionAtMs", "speechStartMs", "speechEndMs"];

export function shiftTimelineEntry(entry, offsetMs) {
  const moved = { ...entry };
  for (const field of SHIFTED_ENTRY_FIELDS) {
    if (Number.isFinite(Number(entry[field]))) moved[field] = Math.round(Number(entry[field]) + offsetMs);
  }
  if (entry.alignment?.words) {
    moved.alignment = {
      ...entry.alignment,
      words: entry.alignment.words.map((word) => ({
        ...word,
        startMs: Math.round(Number(word.startMs) + offsetMs),
        endMs: Math.round(Number(word.endMs) + offsetMs),
      })),
    };
  }
  if (entry.forcedPauses) {
    moved.forcedPauses = entry.forcedPauses.map((pause) => ({
      ...pause,
      nextSpeechStartMs: Number.isFinite(Number(pause.nextSpeechStartMs))
        ? Math.round(Number(pause.nextSpeechStartMs) + offsetMs)
        : pause.nextSpeechStartMs,
    }));
  }
  return moved;
}

/**
 * Join the timelines of videos being concatenated into one.
 *
 * Without this a merged chapter is a video the app can no longer repair: page
 * replacement needs page boundaries, and joining the files threw them away. The
 * offset for each part is the summed duration of the parts before it, measured
 * from the files rather than from the timelines, because the encoder's output
 * length is what the merged video actually plays.
 */
export function concatTimelines(parts = [], now = new Date()) {
  const usable = parts.filter((part) => part?.timeline?.entries?.length);
  if (!usable.length) return null;
  const entries = [];
  let offsetMs = 0;
  for (const part of parts) {
    const durationMs = Math.round(Number(part?.durationMs) || 0);
    if (part?.timeline?.entries?.length) {
      for (const entry of part.timeline.entries) entries.push(shiftTimelineEntry(entry, offsetMs));
    }
    offsetMs += durationMs;
  }
  for (const [index, entry] of entries.entries()) {
    const nextStart = index + 1 < entries.length ? Number(entries[index + 1].startMs) : offsetMs;
    entry.gapAfterMs = Math.max(0, Math.round(nextStart - Number(entry.endMs)));
  }
  return { ...usable[0].timeline, generatedAt: now.toISOString(), totalMs: offsetMs, entries };
}

/**
 * Keep only the part of a timeline that survives a trim, moved back to zero.
 *
 * A page is kept when it overlaps the kept span at all; its own bounds are then
 * clamped, so a page cut in half still names the range the trimmed video plays
 * rather than pointing outside it.
 */
export function clipTimeline(timeline, startMs, endMs, now = new Date()) {
  const from = Math.round(Number(startMs));
  const to = Math.round(Number(endMs));
  if (!timeline?.entries?.length || !(to > from)) return null;
  const entries = timeline.entries
    .filter((entry) => Number(entry.endMs) > from && Number(entry.startMs) < to)
    .map((entry) => {
      const moved = shiftTimelineEntry(entry, -from);
      moved.startMs = Math.max(0, Number(moved.startMs));
      moved.endMs = Math.min(to - from, Number(moved.endMs));
      moved.audio = { ...(entry.audio || {}), durationMs: moved.endMs - moved.startMs };
      return moved;
    });
  if (!entries.length) return null;
  for (const [index, entry] of entries.entries()) {
    const nextStart = index + 1 < entries.length ? Number(entries[index + 1].startMs) : to - from;
    entry.gapAfterMs = Math.max(0, Math.round(nextStart - Number(entry.endMs)));
  }
  return { ...timeline, generatedAt: now.toISOString(), totalMs: to - from, entries };
}
