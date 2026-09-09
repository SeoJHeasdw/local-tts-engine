import nativeFs from "node:fs/promises";
import path from "node:path";
import { dateFolder, runtimePaths } from "./paths.mjs";

export function createEditingService({
  emit,
  fs = nativeFs,
  runComposeEdit,
  runMuteEdit,
  runPageVoicePatchBatch,
  runRegionReplaceEdit,
  runVoiceBatchEdit,
  runVoiceCandidates,
  state,
}) {
  async function runVideoEdit(options) {
    const job = state.activeJob;
    const studio = runtimePaths(options.paths);
    const outputDir = path.join(studio.editOutputRoot, dateFolder(), options.name);
    await fs.mkdir(outputDir, { recursive: true });
    if (options.operation === "voice-candidates") {
      const candidates = await runVoiceCandidates(options, outputDir);
      if (state.activeJob !== job) return;
      job.state = "done";
      job.stage = "awaiting-selection";
      emit({ type: "voice-candidates-ready", candidates, options });
      return;
    }
    let report;
    if (options.operation === "mute-region") report = await runMuteEdit(options, outputDir);
    else if (options.operation === "replace-region") report = await runRegionReplaceEdit(options, outputDir);
    else if (options.operation === "voice") report = await runVoiceBatchEdit(options, outputDir);
    else if (options.operation === "voice-pages") report = await runPageVoicePatchBatch(options, outputDir);
    else if (options.operation === "compose") report = await runComposeEdit(options, outputDir);
    else throw new Error("지원하지 않는 편집 작업입니다.");
    if (state.activeJob !== job) return;
    job.state = "done";
    job.stage = "done";
    emit({ type: "edit-complete", report });
  }

  return { runVideoEdit };
}
