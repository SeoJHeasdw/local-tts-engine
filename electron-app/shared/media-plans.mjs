import path from "node:path";

const PATCH_EPSILON = 0.001;

/**
 * Build one filter graph that swaps the voice under any number of pages.
 *
 * Each patch names a span of the finished lecture and the replacement audio to
 * put under it, supplied as its own ffmpeg input.  Everything outside those
 * spans is carried through untouched, which is the property the whole feature
 * rests on: a mistake here does not lose one page, it overwrites a finished
 * lecture's soundtrack.
 *
 * Two things make batching worth the extra bookkeeping over calling the single
 * -patch plan repeatedly.  Fixing pages one at a time re-encodes the entire
 * video once per fix and leaves a file behind each time, so a lecture with four
 * flagged pages was paying for four full 1080p encodes to change about a minute
 * of audio.  And `videoUnchanged` reports the case where no patch alters
 * timing, which lets the caller stream-copy the video instead of re-encoding a
 * picture it is not changing at all.
 */
export function pageVoicePatchesPlan({ videoDuration, patches, matchAudio = true }) {
  const ordered = Array.from(patches || [])
    .map((patch) => ({
      targetStart: Number(patch.targetStart),
      targetEnd: Number(patch.targetEnd),
      sourceStart: Number(patch.sourceStart),
      sourceEnd: Number(patch.sourceEnd),
      // Input 0 is always the lecture; replacement audio starts at 1.
      input: Number.isFinite(Number(patch.input)) ? Number(patch.input) : 1,
    }))
    .sort((left, right) => left.targetStart - right.targetStart);

  if (!(videoDuration > 0) || ordered.length === 0) {
    throw new Error("교체할 페이지 음성 구간이 올바르지 않습니다.");
  }
  for (const [index, patch] of ordered.entries()) {
    const targetDuration = patch.targetEnd - patch.targetStart;
    const generatedDuration = patch.sourceEnd - patch.sourceStart;
    if (!(targetDuration > 0) || !(generatedDuration > 0)) {
      throw new Error("교체할 페이지 음성 구간이 올바르지 않습니다.");
    }
    if (!matchAudio && generatedDuration > targetDuration + .001) {
      throw new Error("새 음성이 기존 페이지보다 깁니다. 끝을 자르지 않도록 ‘새 음성 길이에 화면 맞춤’을 선택하세요.");
    }
    // Overlapping spans would make the concat order lie about where audio
    // lands, so they are refused rather than silently reordered.
    if (index > 0 && patch.targetStart < ordered[index - 1].targetEnd - PATCH_EPSILON) {
      throw new Error("교체할 페이지 구간이 서로 겹칩니다.");
    }
  }

  const replacements = ordered.map((patch) => {
    const targetDuration = patch.targetEnd - patch.targetStart;
    const replacementDuration = matchAudio ? patch.sourceEnd - patch.sourceStart : targetDuration;
    return { ...patch, targetDuration, replacementDuration, videoFactor: replacementDuration / targetDuration };
  });
  // A factor of exactly 1 means the picture is being cut apart and glued back
  // together unchanged. Re-encoding it would cost minutes and change nothing.
  const videoUnchanged = replacements.every((patch) => Math.abs(patch.videoFactor - 1) < 1e-9);

  const filters = [];
  const videoParts = [];
  const audioParts = [];
  const addOriginalPart = (label, start, end) => {
    const endOption = end == null ? "" : `:end=${end.toFixed(6)}`;
    if (!videoUnchanged) {
      filters.push(`[0:v]trim=start=${start.toFixed(6)}${endOption},setpts=PTS-STARTPTS[v${label}]`);
      videoParts.push(`[v${label}]`);
    }
    filters.push(`[0:a]atrim=start=${start.toFixed(6)}${endOption},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono[a${label}]`);
    audioParts.push(`[a${label}]`);
  };

  replacements.forEach((patch, index) => {
    const previousEnd = index === 0 ? 0 : replacements[index - 1].targetEnd;
    if (patch.targetStart > previousEnd + PATCH_EPSILON) {
      addOriginalPart(index === 0 ? "pre" : `gap${index}`, previousEnd, patch.targetStart);
    }
    // One patch keeps the original label so the emitted graph is byte-identical
    // to what the single-page path produced before batching existed.
    const label = replacements.length === 1 ? "mid" : `mid${index}`;
    if (!videoUnchanged) {
      filters.push(`[0:v]trim=start=${patch.targetStart.toFixed(6)}:end=${patch.targetEnd.toFixed(6)},setpts=${patch.videoFactor.toFixed(9)}*(PTS-STARTPTS)[v${label}]`);
      videoParts.push(`[v${label}]`);
    }
    filters.push(`[${patch.input}:a]atrim=start=${patch.sourceStart.toFixed(6)}:end=${patch.sourceEnd.toFixed(6)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono,apad=whole_dur=${patch.replacementDuration.toFixed(6)},atrim=duration=${patch.replacementDuration.toFixed(6)}[a${label}]`);
    audioParts.push(`[a${label}]`);
  });

  const lastEnd = replacements[replacements.length - 1].targetEnd;
  if (lastEnd < videoDuration - PATCH_EPSILON) addOriginalPart("post", lastEnd, null);

  if (!videoUnchanged) {
    if (videoParts.length > 1) {
      filters.push(`${videoParts.join("")}concat=n=${videoParts.length}:v=1:a=0[vout]`);
    } else {
      filters.push(`${videoParts[0]}null[vout]`);
    }
  }
  if (audioParts.length > 1) {
    filters.push(`${audioParts.join("")}concat=n=${audioParts.length}:v=0:a=1[aout]`);
  } else {
    filters.push(`${audioParts[0]}anull[aout]`);
  }

  return {
    filter: filters.join(";"),
    // When the picture is untouched the caller maps the source stream directly
    // and passes -c:v copy; there is no video branch in the graph to map.
    videoOutput: videoUnchanged ? "0:v:0" : "[vout]",
    audioOutput: "[aout]",
    videoUnchanged,
    patches: replacements.map((patch) => ({
      targetStart: patch.targetStart,
      targetEnd: patch.targetEnd,
      replacementDuration: patch.replacementDuration,
      videoFactor: patch.videoFactor,
    })),
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
  const plan = pageVoicePatchesPlan({
    videoDuration,
    matchAudio,
    patches: [{ targetStart, targetEnd, sourceStart, sourceEnd, input: 1 }],
  });
  return {
    filter: plan.filter,
    replacementDuration: plan.patches[0].replacementDuration,
    videoFactor: plan.patches[0].videoFactor,
    videoOutput: plan.videoOutput,
    audioOutput: plan.audioOutput,
    videoUnchanged: plan.videoUnchanged,
  };
}

export function muteRegionFilter(start, end, duration, maxSeconds = 2) {
  if (![start, end, duration].every(Number.isFinite) || start < 0 || end > duration + .001 || Math.round((end-start)*1000) < 50 || Math.round((end-start)*1000) > maxSeconds*1000) {
    throw new Error('영상 안에서 0.05~2초의 제거 구간을 선택해 주세요.');
  }
  end=Math.min(end,duration);
  const a = start.toFixed(6), b = end.toFixed(6), innerA = (start + .005).toFixed(6), innerB = (end - .005).toFixed(6);
  return `aeval='val(ch)*if(lt(t,${a}),1,if(lt(t,${innerA}),(${innerA}-t)/0.005,if(lt(t,${innerB}),0,if(lt(t,${b}),(t-${innerB})/0.005,1))))':c=same`;
}

export function replaceRegionPlan(start, end, videoDuration, audioDuration, maxSeconds = 10) {
  if (![start, end, videoDuration, audioDuration].every(Number.isFinite) || start < 0 || end > videoDuration + .001 || Math.round((end-start)*1000) < 50 || Math.round((end-start)*1000) > maxSeconds*1000 || audioDuration < .01) {
    throw new Error('영상 안에서 0.05~10초의 교체 구간과 유효한 음성을 선택해 주세요.');
  }
  if (audioDuration > end - start + .001) throw new Error(`교체 음성(${audioDuration.toFixed(2)}초)이 선택 구간(${(end-start).toFixed(2)}초)보다 깁니다. 구간을 늘리거나 더 짧은 음성을 선택해 주세요.`);
  const base = muteRegionFilter(start, end, videoDuration, maxSeconds);
  const span = (end-start).toFixed(6), fadeStart = Math.max(0,audioDuration-.005).toFixed(6);
  return `[0:a]${base}[base];[1:a]atrim=duration=${audioDuration.toFixed(6)},asetpts=PTS-STARTPTS,afade=t=in:d=0.005,afade=t=out:st=${fadeStart}:d=0.005,apad=whole_dur=${span},atrim=duration=${span},adelay=${(start*1000).toFixed(3)}:all=1[patch];[base][patch]amix=inputs=2:duration=first:normalize=0[outa]`;
}

/**
 * Resolve an edit list into the segments a render will actually produce.
 *
 * Merging and trimming are not two operations. A clip carries an in and an out;
 * one clip with a range is a trim, several clips without one is a merge, and
 * any mixture is what neither of the old two tabs could express. Everything
 * downstream — the ffmpeg plan, the joined timeline, the length shown before
 * rendering — reads this one list.
 */
export function normalizeComposeClips(clips = [], durationsMs = []) {
  if (!Array.isArray(clips) || clips.length === 0) {
    throw new Error("편집할 영상을 하나 이상 담아 주세요.");
  }
  return clips.map((clip, index) => {
    const durationMs = Math.round(Number(durationsMs[index]) || 0);
    if (!(durationMs > 0)) throw new Error(`${index + 1}번째 영상의 길이를 읽지 못했습니다.`);
    const inMs = Math.max(0, Math.round(Number(clip?.inMs) || 0));
    const rawOut = clip?.outMs == null || clip.outMs === "" ? durationMs : Math.round(Number(clip.outMs));
    const outMs = Math.min(durationMs, rawOut);
    if (!(outMs > inMs)) {
      throw new Error(`${index + 1}번째 영상의 끝 지점은 시작 이후여야 합니다.`);
    }
    // A clip that spans its whole source can be carried through untouched;
    // only a real cut forces the frame-accurate path.
    const trimmed = inMs > 0 || outMs < durationMs;
    return { index, inMs, outMs, durationMs, trimmed, lengthMs: outMs - inMs };
  });
}

export function composeTotalMs(segments = []) {
  return segments.reduce((total, segment) => total + Number(segment.lengthMs || 0), 0);
}
