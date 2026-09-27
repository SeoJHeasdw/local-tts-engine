import nativeFs from "node:fs/promises";
import path from "node:path";

// Older completed runs have no marker. New runs bind their manifest to the
// latest attempt so an old success cannot masquerade as a failed retry.
export async function assertCurrentCourseManifest(sourceDir, manifest, fs = nativeFs) {
  let state;
  try {
    state = JSON.parse(await fs.readFile(path.join(sourceDir, "run-state.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && !manifest?.runId) return;
    throw new Error("강의 음성 실행 상태 기록을 확인할 수 없습니다.", { cause: error });
  }
  if (state?.status !== "complete" || !manifest?.runId || state.runId !== manifest.runId) {
    throw new Error("최근 강의 음성 제작이 완료되지 않았거나 결과 판본이 다릅니다.");
  }
}

export async function isCurrentCourseReport(report, fs = nativeFs) {
  if (!report?.sourceDir) return true;
  try {
    await assertCurrentCourseManifest(report.sourceDir, { runId: report.voiceRunId }, fs);
    return true;
  } catch { return false; }
}
