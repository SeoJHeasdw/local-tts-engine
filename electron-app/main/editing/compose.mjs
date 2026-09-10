import { assertVideoReencodeSafe } from "./video-format.mjs";
import { videoFrameRate } from "../../shared/video-quality.mjs";
import nativeFs from "node:fs/promises";
import { constants } from "node:fs";
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
  async function normalizeMergeSegment(input, output, { startSeconds = 0, durationSeconds = null, probe: suppliedProbe = null, target = { width: 1920, height: 1080, fps: 25, channels: 1 } } = {}) {
    const probe = suppliedProbe || await inspectMedia(input);
    const whole = Number(probe.format?.duration || 0);
    if (!whole) throw new Error(`영상 길이를 읽지 못했습니다: ${path.basename(input)}`);
    const duration = durationSeconds == null ? whole : durationSeconds;
    const hasAudio = probe.streams?.some((stream) => stream.codec_type === "audio");
    const video = assertVideoReencodeSafe(probe);
    const matrix = ['bt709', 'bt470bg', 'smpte170m'].includes(video?.color_space) ? video.color_space : 'auto';
    const range = video?.color_range === 'pc' ? 'full' : 'limited';
    // -ss before -i seeks by keyframe; placing it after decodes from the start and
    // cuts on the exact frame, which is what a cut the user positioned deserves.
    const args = ["-y", "-hide_banner", "-nostats", "-i", input];
    if (!hasAudio) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono");
    // Keep the cut after every input; otherwise -ss seeks only the added silence.
    if (startSeconds > 0) args.push("-ss", startSeconds.toFixed(3));
    args.push(
      "-map", "0:v:0",
      "-map", hasAudio ? "0:a:0" : "1:a:0",
      "-vf", `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1:flags=lanczos:in_color_matrix=${matrix}:out_color_matrix=bt709:in_range=${range}:out_range=limited,pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${target.fps},format=yuv420p,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709`,
      "-af", "aresample=48000,apad",
      "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-video_track_timescale", "90000",
      "-colorspace", "bt709", "-color_range", "tv", "-color_primaries", "bt709", "-color_trc", "bt709",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", String(target.channels),
      "-t", duration.toFixed(3), "-movflags", "+faststart", output,
    );
    await runProcess("edit", requireRuntimeTool("ffmpeg", "FFmpeg"), args);
  }

  async function validateEditVideo(outputPath, operation, inputs, outputDir, expected = null) {
    const probe = await ffprobe(outputPath);
    const durationMs = Math.round(Number(probe.format?.duration || 0) * 1000);
    const video = probe.streams?.find((stream) => stream.codec_type === "video");
    const checks = [
      { label: "영상 파일", ok: Boolean(video) },
      { label: "영상 길이", ok: durationMs > 0 },
      { label: "음성 트랙", ok: probe.streams?.some((stream) => stream.codec_type === "audio") },
    ];
    if (expected) checks.push(
      { label: '편집 영상 크기', ok: Number(video?.width) === expected.width && Number(video?.height) === expected.height },
      { label: '편집 프레임률', ok: Math.abs(videoFrameRate(video) - expected.fps) < .01 },
      { label: '편집 예상 길이', ok: Math.abs(durationMs - expected.durationMs) <= 150 },
    );
    const summary = summarizeChecks(checks);
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      name: path.basename(outputDir),
      operation,
      inputs,
      videoPath: outputPath,
      durationMs,
      video: video || null,
      checks,
      summary,
      target: { root: "edit", day: path.basename(path.dirname(outputDir)), name: path.basename(outputDir) },
    };
    await fs.writeFile(path.join(outputDir, "validation-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    if (!summary.ok) throw new Error(`자동 검증 실패: ${summary.failed.join(", ")}`);
    return report;
  }

  // Whole inputs can be copied when the complete set shares the target spec.
  function mergeSegmentMatchesTarget(probe, target = { width: 1920, height: 1080, fps: 25 }) {
    const video = probe.streams?.find((stream) => stream.codec_type === "video");
    const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
    if (!video || !audio) return false;
    const [num, den] = String(video.r_frame_rate || "").split("/").map(Number);
    return video.codec_name === "h264"
      && Number(video.width) === target.width && Number(video.height) === target.height
      && video.pix_fmt === "yuv420p"
      && den > 0 && Math.abs(num / den - target.fps) < 0.01
      && audio.codec_name === "aac" && Number(audio.sample_rate) === 48000;
  }

  /**
   * Render one edit list: any number of clips, each with its own in and out.
   *
   * This is the only video assembly path. Trimming is a single clip with a range,
   * merging is several clips without one, and the mixture the two old tabs could
   * not express costs nothing extra here.
   *
   * Whole compatible inputs are copied. A cut or mixed input format requires
   * a common encode so frame boundaries, stream headers and timestamps agree.
   * The target retains the largest input dimensions instead of forcing 1080p.
   */
  async function runComposeEdit(options, outputDir) {
    const records = (options.clips || []).map((clip) => chosenRecord(clip.videoToken, "video"));
    const probes = await mapWithConcurrency(records, 4, record => inspectMedia(record.path));
    const durations = probes.map((probe) => Math.round(Number(probe.format?.duration || 0) * 1000));
    const segments = normalizeComposeClips(options.clips, durations);
    const videos = probes.map(probe => probe.streams?.find(stream => stream.codec_type === 'video'));
    let target = {
      width: Math.ceil(Math.max(1920, ...videos.map(video => Number(video?.width) || 0)) / 2) * 2,
      height: Math.ceil(Math.max(1080, ...videos.map(video => Number(video?.height) || 0)) / 2) * 2,
      fps: Math.max(...videos.map(video => videoFrameRate(video) || 25)),
      channels: Math.max(1, ...probes.map(probe => Number(probe.streams?.find(s => s.codec_type === 'audio')?.channels) || 1)),
    };
    // A concat copy needs compatible stream headers and time bases, not just size.
    // Mixed formats are normalized together so copied and encoded segments cannot
    // silently switch resolution, color matrices or audio layouts midway through.
    const streamSignature = probe => JSON.stringify(probe.streams?.map(stream => Object.fromEntries([
      'codec_type', 'codec_name', 'profile', 'level', 'width', 'height', 'pix_fmt', 'r_frame_rate',
      'time_base', 'sample_aspect_ratio', 'sample_rate', 'channels', 'channel_layout',
      'color_space', 'color_range', 'color_transfer', 'color_primaries', 'extradata_hash',
    ].map(key => [key, stream[key] ?? null]))));
    const compatible = probes.every(probe => streamSignature(probe) === streamSignature(probes[0]));
    const singleWholeMp4 = segments.length === 1 && !segments[0].trimmed
      && path.extname(records[0].path).toLowerCase() === '.mp4'
      && videos[0] && probes[0].streams?.some(stream => stream.codec_type === 'audio');
    const copyAll = singleWholeMp4 || (segments.every(segment => !segment.trimmed && mergeSegmentMatchesTarget(probes[segment.index], target)) && compatible);
    if (singleWholeMp4) target = { ...target, width: videos[0].width, height: videos[0].height, fps: videoFrameRate(videos[0]) };
    if (!copyAll) for (const probe of probes) assertVideoReencodeSafe(probe);
    const workDir = await fs.mkdtemp(path.join(outputDir, "work-"));

    const prepared = [];
    for (const segment of segments) {
      const record = records[segment.index];
      const carry = copyAll;
      if (carry) { prepared.push(record.path); continue; }
      const output = path.join(workDir, `${String(segment.index + 1).padStart(3, "0")}.mp4`);
      await normalizeMergeSegment(record.path, output, {
        startSeconds: segment.inMs / 1000,
        durationSeconds: segment.lengthMs / 1000,
        probe: probes[segment.index],
        target,
      });
      prepared.push(output);
    }

    const reencoded = prepared.filter((file, index) => file !== records[segments[index].index].path).length;
    emit({ type: "log", stream: "stdout",
      text: reencoded === 0
        ? `클립 ${segments.length}개를 모두 다시 굽지 않고 그대로 이어 붙입니다.\n`
        : `클립 ${segments.length}개를 ${target.width}×${target.height} 공통 규격으로 다시 만듭니다.\n` });

    const output = path.join(outputDir, `${options.name}.mp4`);
    if (prepared.length === 1 && path.extname(prepared[0]).toLowerCase() === '.mp4') {
      await fs.copyFile(prepared[0], output, constants.COPYFILE_EXCL);
    } else if (prepared.length === 1) {
      await runProcess('edit', requireRuntimeTool('ffmpeg', 'FFmpeg'), [
        '-n', '-hide_banner', '-nostats', '-i', prepared[0], '-map', '0', '-c', 'copy', '-movflags', '+faststart', output,
      ]);
    } else {
      const concatPath = path.join(workDir, "concat.txt");
      await fs.writeFile(
        concatPath,
        `${prepared.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n")}\n`,
        "utf8",
      );
      await runProcess("edit", requireRuntimeTool("ffmpeg", "FFmpeg"), [
        "-n", "-hide_banner", "-nostats",
        "-f", "concat", "-safe", "0", "-i", concatPath,
        "-c", "copy", "-movflags", "+faststart", output,
      ]);
    }

    const report = await validateEditVideo(output, "compose", records.map((record) => record.path), outputDir,
      { ...target, durationMs: composeTotalMs(segments) });

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
    report.videoTarget = target;
    report.intermediateBytes = (await Promise.all(prepared.filter(file => file.startsWith(workDir + path.sep))
      .map(file => fs.stat(file).then(stat => stat.size)))).reduce((sum, bytes) => sum + bytes, 0);
    await fs.writeFile(path.join(outputDir, "validation-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    // Only this successful run's reproducible intermediates; source media remain intact.
    await fs.rm(workDir, { recursive: true, force: true }).catch(error => {
      emit({ type: 'log', stream: 'stderr', text: `완성 영상은 정상입니다. 중간 파일 정리를 마치지 못했습니다: ${error.message}\n` });
    });
    return report;
  }

  return { normalizeMergeSegment, validateEditVideo, mergeSegmentMatchesTarget, runComposeEdit };
}
