import { spawn } from "node:child_process";

const CANCELLED = "사용자가 작업을 중지했습니다.";
const stageLabels = { voice: "목소리 생성", snapshot: "제작 입력 준비", export: "영상 자료 연결",
  captions: "자막 생성", capture: "화면 촬영", record: "화면 녹화", verify: "결과 검증", edit: "영상 편집", training: "학습" };

export function stopJobProcesses(job, signal = "SIGTERM") {
  let signalled = 0;
  for (const child of job?.children || []) {
    if (!child.pid) continue;
    try {
      process.kill(-child.pid, signal);
      signalled++;
    } catch {
      try { if (child.kill(signal)) signalled++; } catch { /* already finished */ }
    }
  }
  return signalled;
}

// 지금 이 Mac 을 잠깐 쓰려고 멈추는 것과, 앱을 껐다 켠 뒤 이어하는 것은 서로
// 다른 일이다. 여기는 앞쪽만 맡는다. SIGSTOP 은 프로세스를 스케줄에서 빼므로
// CPU 와 GPU 가 즉시 풀리고, 열린 파일과 진행 상태는 그대로 남는다. 대신 앱이
// 종료되면 자식도 함께 사라지므로, 재시작을 넘기는 일은 디스크에 남긴 진행
// 기록이 맡는다.
export function pauseJobProcesses(job) {
  if (!job || job.state !== "running" || job.cancelled) return false;
  if (job.paused) return true;
  // Recording uses a wall-clock timeline. SIGSTOP would make the elapsed pause
  // appear as frozen frames and rush the remaining slide transitions on resume.
  // The existing pauseRequested loop stops safely at the lesson boundary instead.
  // A manual recording has no such boundary; a frozen recorder is a gap in the video.
  if (["capture", "record"].includes(job.stage)) return false;
  // 멈춘 뒤에 되살릴 수 없으면 멈추지 않느니만 못하다. 하나라도 신호가 닿아야
  // 일시정지로 친다.
  if (!stopJobProcesses(job, "SIGSTOP")) return false;
  job.paused = true;
  job.pausedAt = Date.now();
  return true;
}

export function resumeJobProcesses(job) {
  if (!job || !job.paused) return false;
  stopJobProcesses(job, "SIGCONT");
  job.paused = false;
  job.pausedMs = Number(job.pausedMs || 0) + (Date.now() - Number(job.pausedAt || Date.now()));
  job.pausedAt = null;
  return true;
}

// 녹화의 정지는 취소가 아니라 정상 완료다. 작업자에게만 알리고 마무리를 맡긴다.
// 그룹에 보내면 ffmpeg가 SIGUSR1로 죽어 파일을 닫지 못한다. 마무리는 검증까지
// 이어지므로 강제 종료 시계를 두지 않고, 결과를 버리는 취소 표시도 하지 않는다.
export function finishJobProcesses(job, signal = "SIGUSR1") {
  if (!job || job.state !== "running" || job.cancelled) return false;
  let signalled = 0;
  for (const child of job.children || []) {
    if (!child.pid) continue;
    try {
      process.kill(child.pid, signal);
      signalled++;
    } catch { /* already finished */ }
  }
  return signalled > 0;
}

export function cancelJobProcesses(job, { forceAfterMs = 3000, onForce = () => {} } = {}) {
  if (!job || !["running", "cancelling"].includes(job.state)) return false;
  if (job.cancelled) return true;
  job.cancelled = true;
  job.state = "cancelling";
  // 멈춰 있는 프로세스는 SIGTERM 을 처리할 기회를 얻지 못한다. 먼저 깨운다.
  if (job.paused) resumeJobProcesses(job);
  stopJobProcesses(job);
  job.stopTimer = setTimeout(() => {
    if (stopJobProcesses(job, "SIGKILL")) onForce();
  }, forceAfterMs);
  job.stopTimer.unref?.();
  return true;
}

export function runJobProcess(job, stage, executable, args, { cwd, env, capture = false, emit = () => {} } = {}) {
  if (!job) throw new Error("실행 중인 작업이 없습니다.");
  if (job.cancelled) throw new Error(CANCELLED);
  job.stage = stage;
  emit({ type: "stage", stage, state: "running" });
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, detached: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    job.children ||= new Set();
    job.children.add(child);
    let stdout = "", stderr = "", spawnError = null;
    child.stdout.on("data", chunk => {
      const text = chunk.toString();
      if (capture) stdout += text;
      emit({ type: "log", stream: "stdout", text });
    });
    child.stderr.on("data", chunk => {
      const text = chunk.toString();
      stderr = (stderr + text).slice(-16_384);
      emit({ type: "log", stream: "stderr", text });
    });
    // 'close' follows 'error' too, after the streams have closed. Settle once,
    // and always remove this child from the job that actually owns it.
    child.once("error", error => { spawnError = error; });
    child.once("close", (code, signal) => {
      job.children.delete(child);
      if (!job.children.size) clearTimeout(job.stopTimer);
      if (job.cancelled) return reject(new Error(CANCELLED));
      if (code === 0 && !spawnError) {
        emit({ type: "stage", stage, state: "done" });
        return resolve(stdout);
      }
      const detail = spawnError?.message || stderr.trim().split(/\r?\n/).filter(Boolean).at(-1) || "";
      reject(new Error(`${stageLabels[stage] || stage} 단계가 실패했습니다. (종료 ${signal || code})${detail ? `\n${detail.slice(-1200)}` : ""}`));
    });
  });
}
