import { spawn } from "node:child_process";

// Playwright 호출 자체가 signal을 받지 않아도 호출자는 즉시 멈춘다. 호출 대상인
// 앱·서버는 launchDemoApp의 수명 관리가 함께 닫아 진행 중 조작도 끝낸다.
export async function abortable(promise, signal) {
  if (!signal) return promise;
  let onAbort;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function demoDelay(ms, signal) {
  signal?.throwIfAborted();
  let timer;
  try { await abortable(new Promise(resolve => { timer = setTimeout(resolve, ms); }), signal); }
  finally { clearTimeout(timer); }
}

// 준비 명령과 서버는 자식까지 소유한다. 서버가 별도 그룹이므로 작업자에 온
// 중지 신호만 믿지 않고 여기서 그 그룹을 거둔다.
export function startDemoCommand(command, { cwd, env, label }) {
  const [file, ...args] = command;
  const child = spawn(file, args, { cwd, env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "", closed = false, stopping = null;
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8192); });
  const exited = new Promise((resolve, reject) => {
    child.once("error", error => reject(new Error(`${label} 실행 실패: ${error.message}`, { cause: error })));
    child.once("close", code => {
      closed = true;
      resolve({ code, message: `${label} 종료 (${code})${stderr.trim() ? `\n${stderr.trim()}` : ""}` });
    });
  });
  exited.catch(() => {});
  const kill = signal => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
  };
  return {
    exited,
    stop() {
      stopping ||= (async () => {
        kill("SIGTERM");
        // 부모만 끝나고 서버 자식이 남는 경우에도 그룹을 마지막으로 확인한다.
        let timer;
        try {
          if (!closed) await Promise.race([exited.catch(() => {}), new Promise(resolve => {
            timer = setTimeout(resolve, 700);
          })]);
        } finally { clearTimeout(timer); }
        kill("SIGKILL");
        await exited.catch(() => {});
      })();
      return stopping;
    },
  };
}
