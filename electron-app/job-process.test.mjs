import test from "node:test";
import assert from "node:assert/strict";
import {
  cancelJobProcesses,
  pauseJobProcesses,
  resumeJobProcesses,
  runJobProcess,
  stopJobProcesses,
} from "./job-process.mjs";

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

test("일시정지는 실제로 일을 멈추고, 이어하면 다시 진행한다", { timeout: 10_000 }, async (t) => {
  const task = job();
  t.after(() => stopJobProcesses(task, "SIGKILL"));
  // 자식은 100ms 마다 한 줄씩 찍는다. 멈춘 동안 줄이 늘지 않아야 진짜로 멈춘 것이다.
  const script = 'let n=0; setInterval(()=>{ console.log(++n); }, 100);';
  let lines = 0;
  const running = runJobProcess(task, "voice", process.execPath, ["-e", script], {
    emit: (event) => { if (event.type === "log" && event.stream === "stdout") lines += event.text.trim().split("\n").length; },
  });
  running.catch(() => {});

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await wait(400);
  assert.ok(lines > 0, "멈추기 전에는 진행하고 있어야 한다");

  assert.equal(pauseJobProcesses(task), true);
  assert.equal(task.paused, true);
  const atPause = lines;
  await wait(600);
  assert.equal(lines, atPause, `멈춘 동안 진행했다 (${atPause} → ${lines})`);

  assert.equal(resumeJobProcesses(task), true);
  assert.equal(task.paused, false);
  await wait(400);
  assert.ok(lines > atPause, "이어했는데 진행하지 않았다");
  // 멈춰 있던 시간은 따로 센다. 그래야 남은 시간 계산이 어긋나지 않는다.
  assert.ok(task.pausedMs >= 500, `멈춘 시간을 세지 않았다 (${task.pausedMs})`);
});

test("멈춘 작업도 중지하면 깨워서 정리한다", { timeout: 10_000 }, async (t) => {
  const task = job();
  t.after(() => stopJobProcesses(task, "SIGKILL"));
  const running = runJobProcess(task, "voice", process.execPath, ["-e", "setInterval(()=>{},1000)"]);
  const settled = running.then(() => "done", (error) => error.message);
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(pauseJobProcesses(task), true);
  cancelJobProcesses(task, { forceAfterMs: 500 });

  assert.equal(task.paused, false, "중지하면서 깨워야 SIGTERM 이 닿는다");
  assert.match(await settled, /중지했습니다/);
  assert.equal(task.children.size, 0);
});

test("실행 중이 아니거나 이미 끝난 작업은 멈추지 않는다", () => {
  assert.equal(pauseJobProcesses({ state: "done", children: new Set() }), false);
  assert.equal(pauseJobProcesses({ state: "running", cancelled: true, children: new Set() }), false);
  // 신호가 닿을 자식이 없으면 멈춘 척하지 않는다.
  assert.equal(pauseJobProcesses({ state: "running", children: new Set() }), false);
  assert.equal(resumeJobProcesses({ paused: false }), false);
});
