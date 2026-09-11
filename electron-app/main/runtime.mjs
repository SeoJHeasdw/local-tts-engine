import nativeFs from "node:fs/promises";
import path from "node:path";
import { ADAPTER, ROOT, runtimePaths } from "./paths.mjs";
import { runJobProcess } from "./job-process.mjs";
import { spawn } from "node:child_process";

export function createRuntimeService({
  fs = nativeFs,
  state,
  // 모든 작업 사건이 지나는 길목이다. 잠 막기·완료 알림이 여기에 붙는다.
  onEvent = () => {},
}) {
  function emit(payload) {
    onEvent(payload);
    if (payload.type === "log") {
      (payload.stream === "stderr" ? process.stderr : process.stdout).write(payload.text);
    }
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send("studio:job-event", {
        jobKind: state.activeJob?.kind || "create",
        ...payload,
      });
    }
  }

  function jobSnapshot() {
    if (!state.activeJob) return null;
    return {
      id: state.activeJob.id,
      name: state.activeJob.options.name,
      state: state.activeJob.state,
      stage: state.activeJob.stage,
      startedAt: state.activeJob.startedAt,
      kind: state.activeJob.kind,
      error: state.activeJob.error || null,
    };
  }

  function requireRuntimeTool(key, label) {
    const executable = state.runtimeTools[key];
    if (!executable) throw new Error(`${label} 실행 도구를 찾지 못했습니다. 먼저 npm run doctor로 환경을 확인해 주세요.`);
    return executable;
  }

  async function assertRuntime(options, studio = runtimePaths(options.paths), requirements = {}) {
    const required = [
      ["음성 생성 Python", state.runtimeTools.trainPython],
      ["참조 음성", studio.referenceAudioPath],
      ["참조 전사문", studio.referenceTextPath],
    ];
    if (requirements.course !== false) {
      required.push(
        ["강의 도구 Python", state.runtimeTools.basePython],
        ["강의 설정", studio.configPath],
        ["강의 대본", path.join(studio.deckRoot, "script/course")],
        ["Whisper 자동 음성 검수 모델", path.join(ROOT, "artifacts/models/whisper-large-v3-turbo-asr-fp16/config.json")],
        ["Whisper 자동 음성 검수 가중치", path.join(ROOT, "artifacts/models/whisper-large-v3-turbo-asr-fp16/model.safetensors")],
      );
    }
    if (requirements.node) required.push(["Node.js", state.runtimeTools.node]);
    if (requirements.productionInput) required.push(
      ["강의 입력 고정 도구", path.join(studio.deckRoot, "tools/production.mjs")],
      ["강의 제작 전 검사", path.join(studio.deckRoot, "tools/preflight.mjs")],
      ["강의 TypeScript 도구", path.join(studio.deckRoot, "node_modules/typescript/package.json")],
    );
    if (requirements.ffmpeg) required.push(["FFmpeg", state.runtimeTools.ffmpeg]);
    if (requirements.ffprobe !== false) required.push(["FFprobe", state.runtimeTools.ffprobe]);
    if (options.voiceMode === "finetuned") {
      const adapterPath = options.adapterPath || ADAPTER;
      required.push(
        ["음성 어댑터", path.join(adapterPath, "adapters.safetensors")],
        ["음성 어댑터 설정", path.join(adapterPath, "adapter_config.json")],
      );
    }
    for (const [label, file] of required) {
      if (!file) throw new Error(`${label}을(를) 찾지 못했습니다. 먼저 npm run doctor로 환경을 확인해 주세요.`);
      try {
        await fs.access(file);
      } catch {
        throw new Error(`${label}을(를) 찾지 못했습니다: ${file}`);
      }
    }
  }

  // course_pilot prints "[자동 음성 검수 3/38] ..." as it works through a lesson.
  // That line is the only place the run says how far along it is, and the wait is
  // long enough that "언제 끝나는지" is a real question. Read it here, once, so
  // the renderer gets a number instead of parsing log text.
  const VOICE_PROGRESS_PATTERN = /\[자동 음성 검수 (\d+)\/(\d+)\]/g;

  function runProcess(stage, executable, args, { cwd = ROOT, capture = false } = {}) {
    const job = state.activeJob;
    return runJobProcess(job, stage, executable, args, {
      cwd, capture,
      env: { ...process.env, PYTHONPATH: path.join(ROOT, "src"), PYTHONUNBUFFERED: "1" },
      emit: payload => {
        if (state.activeJob !== job) return;
        emit(payload);
        if (payload.type !== "log" || payload.stream !== "stdout") return;
        let match = null;
        let last = null;
        VOICE_PROGRESS_PATTERN.lastIndex = 0;
        while ((match = VOICE_PROGRESS_PATTERN.exec(payload.text))) last = match;
        if (last) emit({ type: "voice-progress", done: Number(last[1]), total: Number(last[2]) });
      },
    });
  }

  function runUtility(executable, args, { cwd = ROOT } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd,
        env: { ...process.env, PYTHONPATH: path.join(ROOT, "src") },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim() || `도구 실행 실패 (${code})`));
      });
    });
  }

  return { emit, jobSnapshot, requireRuntimeTool, assertRuntime, runProcess, runUtility };
}
