import test from "node:test";
import assert from "node:assert/strict";
import { cancelJobProcesses, runJobProcess, stopJobProcesses } from "./job-process.mjs";

const job = () => ({ state: "running", cancelled: false, children: new Set() });

test("Python 실패의 실제 원인을 전달하고 프로세스를 정리한다", async () => {
  const task = job();
  await assert.rejects(runJobProcess(task, "voice", process.execPath, ["-e",
    'process.stderr.write("Traceback:\\nValueError: ch01 19페이지 대기 오류\\n"); process.exitCode=1;']),
  /목소리 생성.*종료 1\)\nValueError: ch01 19페이지 대기 오류/);
  assert.equal(task.children.size, 0);
});

test("실행 파일이 없어도 작업에 죽은 프로세스를 남기지 않는다", async () => {
  const task = job();
  await assert.rejects(runJobProcess(task, "voice", "/nonexistent/tts-studio-python", []), /ENOENT/);
  assert.equal(task.children.size, 0);
});

test("stdout 캡처에 stderr 로그가 섞이지 않는다", async () => {
  const output = await runJobProcess(job(), "verify", process.execPath, ["-e",
    'console.error("진단"); console.log(JSON.stringify({ok:true}));'], { capture: true });
  assert.equal(JSON.parse(output).ok, true);
});

test("중지 요청은 하위 프로세스까지 종료하고 다음 단계를 차단한다", { timeout: 5000 }, async t => {
  const task = job();
  t.after(() => stopJobProcesses(task, "SIGKILL"));
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  let forced = false;
  // Parent and grandchild both ignore SIGTERM. Their shared process group
  // must be killed, or inherited stdout keeps 'close' from ever firing.
  const script = `const {spawn}=require('node:child_process');
    process.on('SIGTERM',()=>{});
    spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"],{stdio:'inherit'});
    setInterval(()=>{},1000);`;
  const running = runJobProcess(task, "snapshot", process.execPath, ["-e", script], {
    emit: event => { if (event.type === "log" && event.text.includes("ready")) ready(); },
  });
  const stopped = assert.rejects(running, /사용자가 작업을 중지/);
  await started;
  assert.equal(cancelJobProcesses(task, { forceAfterMs: 80, onForce: () => { forced = true; } }), true);
  await stopped;
  assert.equal(forced, true);
  assert.equal(task.children.size, 0);
  assert.throws(() => runJobProcess(task, "voice", process.execPath, ["-e", "process.exit(0)"]), /중지/);
});

test("실패하거나 완료된 작업에는 중지를 접수하지 않는다", () => {
  for (const state of ["failed", "done", "cancelled"]) {
    assert.equal(cancelJobProcesses({ ...job(), state }), false);
  }
});
