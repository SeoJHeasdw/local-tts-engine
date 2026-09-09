import nativeFs from "node:fs/promises";
import path from "node:path";
import { assertPageReplaceable, mapWithConcurrency, pageVoicePatchPlan, pageVoicePatchesPlan, patchedTimeline, timeRangeForPages } from "../../shared/index.mjs";
import { captionText, editedReviewContext, retimeCaptions } from "./review-media.mjs";

export function createEditingPagesService({
  chosenRecord,
  emit,
  fs = nativeFs,
  generateReplacementVoice,
  inspectMedia,
  requireRuntimeTool,
  runProcess,
  validateEditVideo,
}) {
  async function preservePagePatchContext(report, videoRecord, patches, outputDir) {
    const original = videoRecord.reportPath
      ? JSON.parse(await fs.readFile(videoRecord.reportPath, "utf8"))
      : null;
    const captionDir = path.dirname(videoRecord.reportPath || videoRecord.timelinePath || videoRecord.path);
    let captions = await fs.readFile(path.join(captionDir, "captions.json"), "utf8")
      .then(JSON.parse).catch(() => null);
    let context = original;
    // The spans are in the source video's coordinates, just like the timeline.
    // Apply later edits first so earlier edits shift their findings and captions.
    const ordered = [...patches].sort((left, right) => right.targetStart - left.targetStart);
    for (const patch of ordered) {
      const startMs = Math.round(patch.targetStart * 1000);
      const endMs = Math.round(patch.targetEnd * 1000);
      const replacementMs = Math.round(patch.replacementDuration * 1000);
      context = editedReviewContext(context, startMs, endMs, replacementMs, "voice-page");
      if (captions) captions = retimeCaptions(captions, startMs, endMs, replacementMs);
    }
    Object.assign(report, context);
    if (captions) {
      await fs.writeFile(path.join(outputDir, "captions.json"), `${JSON.stringify(captions, null, 2)}\n`, "utf8");
      await fs.writeFile(path.join(outputDir, "captions.srt"), captionText(captions), "utf8");
      await fs.writeFile(path.join(outputDir, "captions.vtt"), captionText(captions, true), "utf8");
    }
  }

  async function runPageVoicePatch(videoRecord, audioRecord, options, outputDir) {
    const timeline = JSON.parse(await fs.readFile(videoRecord.timelinePath, "utf8"));
    const target = timeRangeForPages(timeline.entries, Number(options.startPage), Number(options.endPage));
    const targetStart = target.start;
    const targetEnd = target.end;
    const generated = audioRecord.generatedVoice;
    if (
      Number(generated.startPage) !== Number(options.startPage)
      || Number(generated.endPage) !== Number(options.endPage)
    ) {
      throw new Error("생성한 목소리와 교체할 페이지 범위가 다릅니다. 후보를 다시 만들어 주세요.");
    }
    const sourceStart = Number(generated.sourceStartMs) / 1000;
    const sourceEnd = Number(generated.sourceEndMs) / 1000;

    const videoProbe = await inspectMedia(videoRecord.path);
    const videoDuration = Number(videoProbe.format?.duration || 0);
    if (!videoDuration || !videoProbe.streams?.some((stream) => stream.codec_type === "audio")) {
      throw new Error("페이지 음성 교체에는 기존 음성 트랙과 타임라인이 필요합니다.");
    }
    const matchAudio = options.durationPolicy === "match-audio";
    const patchPlan = pageVoicePatchPlan({
      videoDuration,
      targetStart,
      targetEnd,
      sourceStart,
      sourceEnd,
      matchAudio,
    });

    const output = path.join(outputDir, `${options.name}.mp4`);
    await runProcess("edit", requireRuntimeTool("ffmpeg", "FFmpeg"), [
      "-y", "-hide_banner", "-nostats", "-i", videoRecord.path, "-i", audioRecord.path,
      "-filter_complex", patchPlan.filter,
      "-map", patchPlan.videoOutput, "-map", patchPlan.audioOutput,
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", output,
    ]);

    const replacementDurationMs = Math.round(patchPlan.replacementDuration * 1000);
    const nextTimeline = patchedTimeline(
      timeline,
      Math.round(targetStart * 1000),
      Math.round(targetEnd * 1000),
      replacementDurationMs,
    );
    const timelinePath = path.join(outputDir, "timeline.json");
    await fs.writeFile(timelinePath, `${JSON.stringify(nextTimeline, null, 2)}\n`, "utf8");
    const report = await validateEditVideo(
      output,
      "voice-page",
      [videoRecord.path, audioRecord.path],
      outputDir,
    );
    report.timelinePath = timelinePath;
    report.pageRange = { start: Number(options.startPage), end: Number(options.endPage) };
    await preservePagePatchContext(report, videoRecord, [{
      targetStart, targetEnd, replacementDuration: patchPlan.replacementDuration,
    }], outputDir);
    await fs.writeFile(path.join(outputDir, "validation-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  }

  async function runVoiceEdit(options, outputDir) {
    const videoRecord = chosenRecord(options.videoToken, "video");
    const audioRecord = options.audioSource === "generate"
      ? await generateReplacementVoice(options, outputDir).then((value) => ({ path: value.audioPath, generatedVoice: value.generatedVoice }))
      : chosenRecord(options.audioToken, "audio");
    if (audioRecord.generatedVoice) {
      assertPageReplaceable(videoRecord, audioRecord.generatedVoice);
      return runPageVoicePatch(videoRecord, audioRecord, options, outputDir);
    }
    const video = videoRecord.path;
    const audio = audioRecord.path;
    const [videoProbe, audioProbe] = await Promise.all([inspectMedia(video), inspectMedia(audio)]);
    const videoDuration = Number(videoProbe.format?.duration || 0);
    const audioDuration = Number(audioProbe.format?.duration || 0);
    if (!videoDuration || !audioDuration) throw new Error("영상 또는 음성 길이를 읽지 못했습니다.");
    const output = path.join(outputDir, `${options.name}.mp4`);
    if (options.durationPolicy === "match-audio") {
      const factor = audioDuration / videoDuration;
      await runProcess("edit", requireRuntimeTool("ffmpeg", "FFmpeg"), [
        "-y", "-hide_banner", "-nostats", "-i", video, "-i", audio,
        "-map", "0:v:0", "-map", "1:a:0",
        "-vf", `setpts=${factor.toFixed(8)}*PTS,fps=25,format=yuv420p`,
        "-c:v", "libx264", "-preset", "medium", "-crf", "18",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-t", audioDuration.toFixed(3), "-movflags", "+faststart", output,
      ]);
    } else {
      await runProcess("edit", requireRuntimeTool("ffmpeg", "FFmpeg"), [
        "-y", "-hide_banner", "-nostats", "-i", video, "-i", audio,
        "-filter_complex", `[1:a]apad=whole_dur=${videoDuration.toFixed(3)}[voice]`,
        "-map", "0:v:0", "-map", "[voice]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-t", videoDuration.toFixed(3), "-movflags", "+faststart", output,
      ]);
    }
    return validateEditVideo(output, "voice", [video, audio], outputDir);
  }

  /**
   * Apply every approved page replacement to a lecture in one pass.
   *
   * Applying them one at a time re-encoded the whole lecture per fix and left a
   * file behind each time, so four flagged pages in a seventeen-minute lecture
   * cost four full 1080p encodes and produced four videos to keep track of. One
   * pass produces one video, and when no replacement changes a page's length the
   * picture is stream-copied rather than re-encoded at all.
   */
  async function runPageVoicePatchBatch(options, outputDir) {
    const videoRecord = chosenRecord(options.videoToken, "video");
    if (!videoRecord.timelinePath) {
      throw new Error("페이지 음성 교체에는 기존 음성 트랙과 타임라인이 필요합니다.");
    }
    const requested = Array.isArray(options.patches) ? options.patches : [];
    if (requested.length === 0) throw new Error("교체할 페이지를 선택해 주세요.");
    if (requested.length > 40) throw new Error("한 번에 최대 40개 페이지까지 교체할 수 있습니다.");

    const timeline = JSON.parse(await fs.readFile(videoRecord.timelinePath, "utf8"));
    const videoProbe = await inspectMedia(videoRecord.path);
    const videoDuration = Number(videoProbe.format?.duration || 0);
    if (!videoDuration || !videoProbe.streams?.some((stream) => stream.codec_type === "audio")) {
      throw new Error("페이지 음성 교체에는 기존 음성 트랙과 타임라인이 필요합니다.");
    }

    // ffmpeg addresses replacement audio by input position, so the position is
    // fixed here and travels with each patch through the plan's own sorting.
    const inputPaths = [];
    const inputIndexFor = (file) => {
      const existing = inputPaths.indexOf(file);
      if (existing !== -1) return existing + 1;
      inputPaths.push(file);
      return inputPaths.length;
    };

    const entries = requested.map((patch) => {
      const startPage = Number(patch.startPage);
      const endPage = Number(patch.endPage ?? patch.startPage);
      assertPageReplaceable(videoRecord, { startPage, endPage });
      const audioRecord = chosenRecord(patch.audioToken, "audio");
      const generated = audioRecord.generatedVoice;
      if (!generated) throw new Error("선택한 목소리에 페이지 정보가 없습니다. 후보를 다시 만들어 주세요.");
      if (Number(generated.startPage) !== startPage || Number(generated.endPage) !== endPage) {
        throw new Error("생성한 목소리와 교체할 페이지 범위가 다릅니다. 후보를 다시 만들어 주세요.");
      }
      const target = timeRangeForPages(timeline.entries, startPage, endPage);
      return {
        startPage,
        endPage,
        targetStart: target.start,
        targetEnd: target.end,
        sourceStart: Number(generated.sourceStartMs) / 1000,
        sourceEnd: Number(generated.sourceEndMs) / 1000,
        input: inputIndexFor(audioRecord.path),
      };
    });

    const matchAudio = options.durationPolicy === "match-audio";
    const plan = pageVoicePatchesPlan({ videoDuration, matchAudio, patches: entries });

    const output = path.join(outputDir, `${options.name}.mp4`);
    await runProcess("edit", requireRuntimeTool("ffmpeg", "FFmpeg"), [
      "-y", "-hide_banner", "-nostats",
      "-i", videoRecord.path,
      ...inputPaths.flatMap((file) => ["-i", file]),
      "-filter_complex", plan.filter,
      "-map", plan.videoOutput, "-map", plan.audioOutput,
      ...(plan.videoUnchanged
        ? ["-c:v", "copy"]
        : ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"]),
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", output,
    ]);

    // Each patch shifts everything after it, so folding them back-to-front keeps
    // the earlier patches' original timeline coordinates valid.
    let nextTimeline = timeline;
    for (const patch of [...plan.patches].reverse()) {
      nextTimeline = patchedTimeline(
        nextTimeline,
        Math.round(patch.targetStart * 1000),
        Math.round(patch.targetEnd * 1000),
        Math.round(patch.replacementDuration * 1000),
      );
    }
    const timelinePath = path.join(outputDir, "timeline.json");
    await fs.writeFile(timelinePath, `${JSON.stringify(nextTimeline, null, 2)}\n`, "utf8");

    const report = await validateEditVideo(
      output,
      "voice-pages",
      [videoRecord.path, ...inputPaths],
      outputDir,
    );
    report.timelinePath = timelinePath;
    report.videoReencoded = !plan.videoUnchanged;
    report.pages = entries
      .map((entry) => ({ startPage: entry.startPage, endPage: entry.endPage }))
      .sort((left, right) => left.startPage - right.startPage);
    await preservePagePatchContext(report, videoRecord, plan.patches, outputDir);
    await fs.writeFile(path.join(outputDir, "validation-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  }

  async function runVoiceBatchEdit(options, outputDir) {
    const items = Array.isArray(options.videoItems) && options.videoItems.length
      ? options.videoItems
      : [{ videoToken: options.videoToken, startPage: options.startPage, endPage: options.endPage }];
    if (items.length > 20) throw new Error("목소리 교체는 한 번에 최대 20개까지 실행할 수 있습니다.");
    const concurrency = options.audioSource === "generate"
      ? 1
      : Math.min(Number(options.voiceParallelism || 2), items.length);
    let completed = 0;
    const results = await mapWithConcurrency(items, concurrency, async (item, index) => {
        const selected = chosenRecord(item.videoToken, "video");
        const stem = path.parse(selected.name).name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `item-${index + 1}`;
        const itemName = `${String(index + 1).padStart(2, "0")}-${stem}`.slice(0, 64).replace(/-$/, "");
        const itemDir = path.join(outputDir, "items", itemName);
        await fs.mkdir(itemDir, { recursive: true });
        const result = await runVoiceEdit({
          ...options,
          ...item,
          videoToken: item.videoToken,
          startPage: Number(item.startPage),
          endPage: Number(item.endPage),
          name: itemName,
        }, itemDir);
        completed += 1;
        emit({ type: "voice-item-complete", completed, total: items.length, name: selected.name });
        return result;
    });
    const summary = {
      ok: results.every((item) => item.summary.ok),
      passed: results.reduce((total, item) => total + item.summary.passed, 0),
      total: results.reduce((total, item) => total + item.summary.total, 0),
      failed: results.flatMap((item) => item.summary.failed),
    };
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      name: options.name,
      operation: "voice-batch",
      parallelism: concurrency,
      durationMs: results.reduce((total, item) => total + item.durationMs, 0),
      videoPath: results[0].videoPath,
      outputs: results.map((item) => item.videoPath),
      summary,
      target: { root: "edit", day: path.basename(path.dirname(outputDir)), name: options.name },
    };
    await fs.writeFile(path.join(outputDir, "validation-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  }

  return { preservePagePatchContext, runPageVoicePatch, runVoiceEdit, runPageVoicePatchBatch, runVoiceBatchEdit };
}
