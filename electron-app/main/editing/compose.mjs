import nativeFs from "node:fs/promises";
import path from "node:path";
import { clipTimeline, composeTotalMs, concatTimelines, mapWithConcurrency, normalizeComposeClips, summarizeChecks } from "../../shared/index.mjs";

export function createEditingComposeService({
  chosenRecord,
  emit,
  ffprobe,
  fs = nativeFs,
  inspectMedia,
  requireRuntimeTool,
  runProcess,
}) {
  async function normalizeMergeSegment(input, output, { startSeconds = 0, durationSeconds = null, probe: suppliedProbe = null } = {}) {
    const probe = suppliedProbe || await inspectMedia(input);
    const whole = Number(probe.format?.duration || 0);
    if (!whole) throw new Error(`영상 길이를 읽지 못했습니다: ${path.basename(input)}`);
    const duration = durationSeconds == null ? whole : durationSeconds;
    const hasAudio = probe.streams?.some((stream) => stream.codec_type === "audio");
    // -ss before -i seeks by keyframe; placing it after decodes from the start and
    // cuts on the exact frame, which is what a cut the user positioned deserves.
    const args = ["-y", "-hide_banner", "-nostats", "-i", input];
    if (!hasAudio) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono");
    // Keep the cut after every input; otherwise -ss seeks only the added silence.
    if (startSeconds > 0) args.push("-ss", startSeconds.toFixed(3));
    args.push(
      "-map", "0:v:0",
      "-map", hasAudio ? "0:a:0" : "1:a:0",
      "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=25,format=yuv420p",
      "-af", "aresample=48000,apad",
      "-c:v", "libx264", "-preset", "medium", "-crf", "18",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-t", duration.toFixed(3), "-movflags", "+faststart", output,
    );
    await runProcess("edit", requireRuntimeTool("ffmpeg", "FFmpeg"), args);
  }

  async function validateEditVideo(outputPath, operation, inputs, outputDir) {
    const probe = await ffprobe(outputPath);
    const durationMs = Math.round(Number(probe.format?.duration || 0) * 1000);
    const video = probe.streams?.find((stream) => stream.codec_type === "video");
    const checks = [
      { label: "영상 파일", ok: Boolean(video) },
      { label: "영상 길이", ok: durationMs > 0 },
      { label: "음성 트랙", ok: probe.streams?.some((stream) => stream.codec_type === "audio") },
    ];
    const summary = summarizeChecks(checks);
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      name: path.basename(outputDir),
      operation,
      inputs,
      videoPath: outputPath,
      durationMs,
      checks,
      summary,
      target: { root: "edit", day: path.basename(path.dirname(outputDir)), name: path.basename(outputDir) },
    };
    await fs.writeFile(path.join(outputDir, "validation-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    if (!summary.ok) throw new Error(`자동 검증 실패: ${summary.failed.join(", ")}`);
    return report;
  }

  // The app's own lectures already come out at the target spec, so re-encoding
  // them to concatenate costs an hour of x264 to change nothing. Only inputs that
  // actually differ are normalized.
  function mergeSegmentMatchesTarget(probe) {
    const video = probe.streams?.find((stream) => stream.codec_type === "video");
    const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
    if (!video || !audio) return false;
    const [num, den] = String(video.r_frame_rate || "").split("/").map(Number);
    return video.codec_name === "h264"
      && Number(video.width) === 1920 && Number(video.height) === 1080
      && video.pix_fmt === "yuv420p"
      && den > 0 && Math.abs(num / den - 25) < 0.01
      && audio.codec_name === "aac" && Number(audio.sample_rate) === 48000;
  }

  /**
   * Render one edit list: any number of clips, each with its own in and out.
   *
   * This is the only video assembly path. Trimming is a single clip with a range,
   * merging is several clips without one, and the mixture the two old tabs could
   * not express costs nothing extra here.
   *
   * Cut precision is decided per clip rather than per job. A clip that spans its
   * whole source and already matches the target spec is carried through
   * untouched; only a clip with a real cut is re-encoded, and then only that
   * clip. Joining sixteen finished lessons therefore copies rather than spending
   * an hour of x264 to change nothing.
   */
  async function runComposeEdit(options, outputDir) {
    const records = (options.clips || []).map((clip) => chosenRecord(clip.videoToken, "video"));
    const probes = await mapWithConcurrency(records, 4, record => inspectMedia(record.path));
    const durations = probes.map((probe) => Math.round(Number(probe.format?.duration || 0) * 1000));
    const segments = normalizeComposeClips(options.clips, durations);

    const workDir = path.join(outputDir, "work");
    await fs.mkdir(workDir, { recursive: true });

    const prepared = [];
    for (const segment of segments) {
      const record = records[segment.index];
      const carry = !segment.trimmed && mergeSegmentMatchesTarget(probes[segment.index]);
      if (carry) { prepared.push(record.path); continue; }
      const output = path.join(workDir, `${String(segment.index + 1).padStart(3, "0")}.mp4`);
      await normalizeMergeSegment(record.path, output, {
        startSeconds: segment.inMs / 1000,
        durationSeconds: segment.lengthMs / 1000,
        probe: probes[segment.index],
      });
      prepared.push(output);
    }

    const reencoded = prepared.filter((file, index) => file !== records[segments[index].index].path).length;
    emit({ type: "log", stream: "stdout",
      text: reencoded === 0
        ? `클립 ${segments.length}개를 모두 다시 굽지 않고 그대로 이어 붙입니다.\n`
        : `클립 ${segments.length}개 중 ${reencoded}개만 다시 굽습니다. 나머지는 원본을 그대로 씁니다.\n` });

    const output = path.join(outputDir, `${options.name}.mp4`);
    if (prepared.length === 1) {
      await fs.copyFile(prepared[0], output);
    } else {
      const concatPath = path.join(workDir, "concat.txt");
      await fs.writeFile(
        concatPath,
        `${prepared.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n")}\n`,
        "utf8",
      );
      await runProcess("edit", requireRuntimeTool("ffmpeg", "FFmpeg"), [
        "-y", "-hide_banner", "-nostats",
        "-f", "concat", "-safe", "0", "-i", concatPath,
        "-c", "copy", "-movflags", "+faststart", output,
      ]);
    }

    const report = await validateEditVideo(output, "compose", records.map((record) => record.path), outputDir);

    // Each clip's page boundaries are cut to its own range and then joined, so a
    // composed video stays something the app can still repair page by page.
    const parts = await Promise.all(segments.map(async (segment) => {
      const record = records[segment.index];
      const source = record.timelinePath
        ? await fs.readFile(record.timelinePath, "utf8").then(JSON.parse).catch(() => null)
        : null;
      return {
        durationMs: segment.lengthMs,
        timeline: source && (segment.trimmed ? clipTimeline(source, segment.inMs, segment.outMs) : source),
      };
    }));
    const timeline = concatTimelines(parts);
    if (timeline) {
      const timelinePath = path.join(outputDir, "timeline.json");
      await fs.writeFile(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`, "utf8");
      report.timelinePath = timelinePath;
    } else {
      emit({ type: "log", stream: "stdout",
        text: "편집 결과에 페이지 타임라인이 없습니다. 이 영상은 페이지 단위로 다듬을 수 없습니다.\n" });
    }
    report.clips = segments.map((segment) => ({
      name: records[segment.index].name,
      inMs: segment.inMs, outMs: segment.outMs, lengthMs: segment.lengthMs,
    }));
    report.plannedMs = composeTotalMs(segments);
    report.videoReencoded = reencoded > 0;
    await fs.writeFile(path.join(outputDir, "validation-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  }

  return { normalizeMergeSegment, validateEditVideo, mergeSegmentMatchesTarget, runComposeEdit };
}
