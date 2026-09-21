import crypto from "node:crypto";
import nativeFs from "node:fs/promises";
import path from "node:path";
import { ROOT, dateFolder, runtimePaths } from "./paths.mjs";
import { finishJobProcesses } from "./job-process.mjs";
import { listDisplays } from "./capture/displays.mjs";
import { normalizeEditName } from "../shared/index.mjs";

// 디스플레이 수동 녹화. 결과는 편집 결과와 같은 자리·모양으로 남아 최근 결과와
// 다듬기가 그대로 받는다. 정지는 정상 완료라 여기서 따로 다루고, 취소는 다른
// 작업과 같은 중지 경로(cancelJobProcesses)를 쓴다.
//
// monitor는 무엇이 녹화되는지 보이게 하는 쪽이다(record-monitor.mjs). 녹화할 화면을
// 테두리로 감싸 세고, 다 센 뒤에 작업자를 띄운다. 테두리는 정지할 때까지 남으므로
// 작업자에게 그 폭을 넘겨 녹화에서 지우게 한다.
export function createRecordingService({
  emit,
  fs = nativeFs,
  jobSnapshot,
  monitor = null,
  readAppSettings,
  requireRuntimeTool,
  runProcess,
  state,
}) {
  const recording = () => state.activeJob?.kind === "record" && ["running", "cancelling"].includes(state.activeJob.state);
  // 목록에서 읽은 원본 크기. 녹화할 화면을 Electron 화면으로 옮길 때 순서를 확인한다.
  const sizes = new Map();

  function listRecordingSources() {
    // 목록을 얻으려면 화면마다 한 프레임씩 찍는다. 녹화 중에는 그럴 이유가 없다.
    if (recording()) throw new Error("녹화 중에는 화면을 다시 찾지 않습니다.");
    return listDisplays(requireRuntimeTool("ffmpeg", "FFmpeg")).then(listing => {
      for (const display of listing.displays) {
        if (!display.error) sizes.set(display.name, { width: display.width, height: display.height });
      }
      return monitor ? { ...listing, displays: monitor.describe(listing.displays) } : listing;
    });
  }

  function recordingOptions(raw = {}) {
    const display = typeof raw.display === "string" ? raw.display.trim() : "";
    if (!display) throw new Error("녹화할 화면을 골라 주세요.");
    const audioDevice = typeof raw.audioDevice === "string" && raw.audioDevice.trim() ? raw.audioDevice.trim() : null;
    return { name: normalizeEditName(raw.name), display, audioDevice };
  }

  async function startRecording(rawOptions) {
    if (state.activeJob && ["running", "cancelling"].includes(state.activeJob.state)) {
      throw new Error("이미 실행 중인 작업이 있습니다.");
    }
    const options = recordingOptions(rawOptions);
    const tools = {
      node: requireRuntimeTool("node", "Node.js"),
      ffmpeg: requireRuntimeTool("ffmpeg", "FFmpeg"),
      ffprobe: requireRuntimeTool("ffprobe", "FFprobe"),
    };
    const settings = await readAppSettings();
    const outputDir = path.join(runtimePaths(settings.paths).editOutputRoot, dateFolder(), options.name);
    // 취소하면 이 폴더를 통째로 버린다. 그래서 무엇이든 들어 있는 폴더에는 녹화하지 않는다.
    if ((await fs.readdir(outputDir).catch(() => []))?.length) {
      throw new Error("같은 이름의 결과가 있습니다. 새 결과 이름을 사용해 주세요.");
    }
    await fs.mkdir(outputDir, { recursive: true });
    state.activeJob = {
      id: crypto.randomUUID(),
      kind: "record",
      options,
      state: "running",
      stage: "starting",
      children: new Set(),
      cancelled: false,
      startedAt: new Date().toISOString(),
    };
    const job = state.activeJob;
    const snapshot = jobSnapshot();
    emit({ type: "record-started", job: snapshot, options });
    void runRecording(job, options, outputDir, tools);
    return snapshot;
  }

  async function runRecording(job, options, outputDir, tools) {
    const args = [
      path.join(ROOT, "electron-app/main/workers/record-display.mjs"),
      "--display", options.display, "--out-dir", outputDir, "--name", options.name,
      "--ffmpeg", tools.ffmpeg, "--ffprobe", tools.ffprobe,
    ];
    if (options.audioDevice) args.push("--audio", options.audioDevice);
    try {
      const shown = monitor
        ? await monitor.countdown(job, { display: options.display, size: sizes.get(options.display) || null })
        : { ready: true, edgeMask: 0 };
      // 세는 동안 취소하면 작업자를 띄우지 않는다.
      if (job.cancelled || !shown.ready) throw new Error("사용자가 녹화를 취소했습니다.");
      if (shown.edgeMask) args.push("--edge-mask", String(shown.edgeMask));
      await runProcess("record", tools.node, args);
      const report = JSON.parse(await fs.readFile(path.join(outputDir, "validation-report.json"), "utf8"));
      if (state.activeJob !== job) return;
      job.state = "done";
      job.stage = "done";
      emit({ type: "record-complete", report });
    } catch (error) {
      // 취소는 결과를 버린다. 작업자가 지우고도 남은 것이 있으면 폴더째 치운다.
      // 실패는 다르다. 검증에 걸린 녹화는 영상과 보고서를 남기고, 빈 폴더만 치운다.
      if (job.cancelled) await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
      else await fs.rmdir(outputDir).catch(() => {});
      if (state.activeJob !== job) return;
      job.state = job.cancelled ? "cancelled" : "failed";
      job.error = error.message;
      emit({ type: "record-failed", cancelled: job.cancelled, message: error.message });
    }
  }

  function finishRecording() {
    const job = state.activeJob;
    if (job?.kind !== "record" || job.state !== "running" || job.stage !== "record") return false;
    if (job.finishing) return true;
    if (!finishJobProcesses(job)) return false;
    job.finishing = true;
    emit({ type: "record-finishing" });
    return true;
  }

  return { listRecordingSources, startRecording, finishRecording };
}
