import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const source = await fs.readFile(new URL("./renderer/app.js", import.meta.url), "utf8");
function fixture(cancel = async () => false) {
  const nodes = new Map();
  const element = () => {
    const classes = new Set();
    return { textContent: "", disabled: false, open: false,
      classList: { add: v => classes.add(v), remove: v => classes.delete(v), contains: v => classes.has(v),
        toggle: (v, enabled) => enabled ? classes.add(v) : classes.delete(v) },
      setAttribute() {}, removeAttribute() {}, querySelectorAll: () => [], closest() { return this; } };
  };
  const $ = selector => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); };
  let calls = 0;
  const ctx = vm.createContext({ $, $$: () => [], api: { cancel: async () => { calls++; return cancel(); } },
    showToast() {}, setJobState: text => { $("#job-state").textContent = text; }, showJobView() {},
    appendLog: text => { $("#job-log").textContent += text; }, loadOutputs() {}, renderCompleteVoiceFindings() {},
    updateStages: stage => { $("#current-stage").textContent = stage; },
  });
  vm.runInContext('let creationState="idle", latestTarget=null;\n'
    + source.slice(source.indexOf("function setBusy("), source.indexOf("function setJobState("))
    + source.slice(source.indexOf("function renderJobEvent("), source.indexOf("async function initialize("))
    + ';globalThis.jobUi={renderJobEvent,requestJobCancellation,state:()=>creationState};', ctx);
  return { $, ui: ctx.jobUi, calls: () => calls };
}

test("실패하면 실제 원인과 기록을 펼치고 중지 버튼과 진행 표시를 숨긴다", async () => {
  const { $, ui, calls } = fixture();
  ui.renderJobEvent({ type: "started", options: { name: "ch01" } });
  ui.renderJobEvent({ type: "failed", message: "ValueError: ch01 19페이지 입력 오류" });
  assert.equal($("#current-stage").textContent, "ValueError: ch01 19페이지 입력 오류");
  assert.equal($("#job-log").open, true);
  assert.equal($("#start-button").disabled, false);
  assert.equal($("#cancel-button").classList.contains("hidden"), true);
  assert.equal($("#active-progress .spinner").classList.contains("hidden"), true);
  await ui.requestJobCancellation($("#cancel-button"), "create");
  assert.equal(calls(), 0);
  assert.equal(ui.state(), "failed");
});

test("이미 끝난 작업의 중지 응답은 중지 중 화면을 남기지 않는다", async () => {
  const { $, ui } = fixture();
  ui.renderJobEvent({ type: "started", options: { name: "ch01" } });
  await ui.requestJobCancellation($("#cancel-button"), "create");
  assert.equal(ui.state(), "idle");
  assert.equal($("#start-button").disabled, false);
  assert.equal($("#job-state").textContent, "종료됨");
});

test("중지 중에 늦게 온 단계 이벤트가 다시 실행 중으로 돌리지 않는다", async () => {
  const { $, ui } = fixture(async () => true);
  ui.renderJobEvent({ type: "started", options: { name: "ch01" } });
  await ui.requestJobCancellation($("#cancel-button"), "create");
  ui.renderJobEvent({ type: "stage", stage: "voice" });
  assert.equal(ui.state(), "cancelling");
  assert.equal($("#current-stage").textContent, "실행 중인 작업을 종료하고 있습니다.");
  ui.renderJobEvent({ type: "failed", cancelled: true, message: "사용자가 작업을 중지했습니다." });
  assert.equal(ui.state(), "cancelled");
  assert.equal($("#start-button").disabled, false);
  ui.renderJobEvent({ type: "started", options: { name: "next-ch01" } });
  assert.equal(ui.state(), "running");
  assert.equal($("#cancel-button").classList.contains("hidden"), false);
});

test("중지 통신이 실패하면 실행 상태와 재시도 버튼을 복구한다", async () => {
  const { $, ui } = fixture(async () => { throw new Error("IPC 연결 오류"); });
  ui.renderJobEvent({ type: "started", options: { name: "ch01" } });
  ui.renderJobEvent({ type: "stage", stage: "voice" });
  await ui.requestJobCancellation($("#cancel-button"), "create");
  assert.equal(ui.state(), "running");
  assert.equal($("#current-stage").textContent, "voice");
  assert.equal($("#cancel-button").disabled, false);
});
