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
    const existing = await fs.readFile(path.join(outputDir, 'validation-report.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (existing?.summary?.ok || await fs.stat(path.join(outputDir, `${options.name}.mp4`)).catch(() => null)) {
      throw new Error('같은 이름의 편집 결과가 있습니다. 기존 영상을 보존하도록 새 결과 이름을 사용해 주세요.');
    }
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
