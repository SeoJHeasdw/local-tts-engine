import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertCurrentCourseManifest } from "../../electron-app/main/course-run-state.mjs";
import { createOutputsService } from "../../electron-app/main/outputs.mjs";
import { runtimePaths } from "../../electron-app/main/paths.mjs";
import { outputState } from "../../electron-app/renderer/view-utils.mjs";

test("a failed rerun does not let an older manifest pass app validation", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tts-run-state-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const manifest = { runId: "old" };
  await fs.writeFile(path.join(directory, "run-state.json"), JSON.stringify({ status: "complete", runId: "old" }));
  await assertCurrentCourseManifest(directory, manifest);
  await fs.writeFile(path.join(directory, "run-state.json"), JSON.stringify({ status: "failed", runId: "new" }));
  await assert.rejects(assertCurrentCourseManifest(directory, manifest), /완료되지 않았거나/);
  await fs.rm(path.join(directory, "run-state.json"));
  await assert.rejects(assertCurrentCourseManifest(directory, manifest), /상태 기록을 확인할 수 없습니다/);
  await assertCurrentCourseManifest(directory, { audioPath: "legacy.wav" });
});

test("a pilot result from before a failed retry is shown as needing verification", async (t) => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tts-stale-pilot-"));
  t.after(() => fs.rm(outputRoot, { recursive: true, force: true }));
  const studio = runtimePaths({ outputRoot });
  const directory = path.join(studio.ttsOutputRoot, "2026-09-27", "lesson-a");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "validation-report.json"), JSON.stringify({
    audioPath: path.join(directory, "lesson-a.wav"), voiceRunId: "old",
    summary: { ok: true, passed: 3, total: 3 },
  }));
  await fs.writeFile(path.join(directory, "run-state.json"), JSON.stringify({ status: "failed", runId: "new" }));
  const outputs = createOutputsService({ readAppSettings: async () => ({ paths: { outputRoot } }) });
  const item = (await outputs.listOutputs(studio, { includeLegacy: false })).find((entry) => entry.root === "pilot");
  assert.equal(item?.staleVoiceSource, true);
  assert.equal(outputState(item).label, "음성 판본 확인 필요");
  await assert.rejects(outputs.setOutputReview({ root: "pilot", day: "2026-09-27", name: "lesson-a" },
    "approved", studio), /이전 검수 기록을 승인할 수 없습니다/);
});
