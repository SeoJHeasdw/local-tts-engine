import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

import { etaLabel, unitLabel, completionFindings, completionSummary } from "../../electron-app/renderer/view-utils.mjs";
import { createJobPace } from "../../electron-app/renderer/job-pace.mjs";

const source = await fs.readFile(new URL("../../electron-app/renderer/app.js", import.meta.url), "utf8");
function fixture(cancel = async () => false) {
  const nodes = new Map();
  const element = () => {
    const classes = new Set();
    return { textContent: "", disabled: false, open: false, dataset: {}, children: [],
      classList: { add: v => classes.add(v), remove: v => classes.delete(v), contains: v => classes.has(v),
        toggle: (v, enabled) => enabled ? classes.add(v) : classes.delete(v) },
      append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; },
      setAttribute() {}, removeAttribute() {}, querySelectorAll: () => [], closest() { return this; } };
  };
  const $ = selector => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); };
  let calls = 0;
  const ctx = vm.createContext({ $, $$: () => [], api: { cancel: async () => { calls++; return cancel(); } },
    showToast() {}, setJobState: text => { $("#job-state").textContent = text; }, showJobView() {},
    appendLog: text => { $("#job-log").textContent += text; }, outputs: { loadOutputs() {} }, review: { renderCompleteVoiceFindings() {} },
    refreshResumable() {},
    formatDuration: ms => `${ms}ms`, suggestedName: () => 'next', updateProductionBrief() {},
    updateStages: stage => { $("#current-stage").textContent = stage; },
    createJobPace, etaLabel, unitLabel, completionFindings, completionSummary, setInterval: () => 0, Date,
    document: { createElement: element },
  });
  vm.runInContext('let creationState="idle", latestTarget=null;\n'
    + source.slice(source.indexOf("function setBusy("), source.indexOf("function setJobState("))
    + source.slice(source.indexOf("function renderJobEvent("), source.indexOf("async function initialize("))
    + ';globalThis.jobUi={renderJobEvent,requestJobCancellation,state:()=>creationState,pace:()=>pace};', ctx);
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

test("레슨으로 나눠 만들 때 전체 중 몇 번째인지 보여 준다", () => {
  const { $, ui } = fixture();
  ui.renderJobEvent({ type: "started", options: { name: "ch02" } });
  assert.equal($("#job-unit").textContent, "", "한 편짜리에는 표시할 것이 없다");

  ui.renderJobEvent({ type: "unit", index: 3, total: 9, title: "CH02 L03" });

  assert.equal($("#job-unit").textContent, "레슨 3/9");
});

test("남은 시간은 관측을 시작한 지점부터 재고, 편이 바뀌면 다시 잰다", () => {
  const { $, ui } = fixture();
  ui.renderJobEvent({ type: "started", options: { name: "ch02" } });

  ui.renderJobEvent({ type: "voice-progress", done: 4, total: 24 });
  assert.equal(ui.pace().snapshot().voice.baseline, 4, "화면을 늦게 열었어도 그 지점부터 센다");
  assert.equal($("#job-eta").textContent, "남은 시간 계산 중", "아직 잰 구간이 없으면 계산 중임을 알린다");

  ui.renderJobEvent({ type: "voice-progress", done: 8, total: 24 });
  assert.equal(ui.pace().snapshot().voice.done, 8);

  // 편이 바뀌면 앞 편의 관측을 물려주지 않는다. 레슨마다 분량이 달라 그대로
  // 재면 남은 시간이 크게 어긋난다.
  ui.renderJobEvent({ type: "unit", index: 4, total: 9, title: "CH02 L04" });
  assert.equal(ui.pace().snapshot().voice, null);
  assert.equal($("#job-eta").textContent, "이 편 남은 시간 계산 중");
});

test("작업을 새로 시작하면 이전 작업의 진행 표시가 남지 않는다", () => {
  const { $, ui } = fixture();
  ui.renderJobEvent({ type: "started", options: { name: "ch02" } });
  ui.renderJobEvent({ type: "unit", index: 3, total: 9, title: "CH02 L03" });
  ui.renderJobEvent({ type: "voice-progress", done: 8, total: 24 });

  ui.renderJobEvent({ type: "started", options: { name: "ch03" } });

  assert.equal(ui.pace().currentUnit, null);
  assert.equal(ui.pace().snapshot().voice, null);
  assert.equal($("#job-unit").textContent, "");
  assert.equal($("#job-eta").textContent, "남은 시간 계산 중");
});

test("한 편짜리 작업에는 두 번째 시계를 띄우지 않는다", () => {
  // 레슨 하나, 페이지 직접 선택, 챕터를 한 영상으로 만들기는 모두 한 편이다.
  // '이 작업이 언제 끝나는지'가 곧 전부라 전체 시계가 따로 있을 자리가 없다.
  const { $, ui } = fixture();
  ui.renderJobEvent({ type: "started", options: { name: "lesson" } });
  ui.renderJobEvent({ type: "voice-progress", done: 4, total: 20 });
  ui.renderJobEvent({ type: "voice-progress", done: 12, total: 20 });

  assert.equal(ui.pace().snapshot().units.length, 0, "plan 이 오지 않으면 전체 시계는 존재하지 않는다");
  assert.equal($("#job-total-eta").textContent, "");
  assert.equal($("#job-unit").textContent, "");
});

test("레슨으로 나눠 만들 때만 편별 분량으로 전체 시계를 낸다", () => {
  const { $, ui } = fixture();
  ui.renderJobEvent({ type: "started", options: { name: "ch02" } });
  ui.renderJobEvent({ type: "plan", units: [
    { title: "L01", pages: 10 }, { title: "L02", pages: 10 },
    { title: "L03", pages: 10 }, { title: "L04", pages: 30 },
  ] });

  ui.renderJobEvent({ type: "unit", index: 1, total: 4, title: "L01" });
  assert.equal($("#job-total-eta").textContent, "전체 남은 시간 계산 중", "첫 편이 끝나기 전에도 계산 상태를 보여 준다");

  ui.renderJobEvent({ type: "unit", index: 2, total: 4, title: "L02" });

  assert.equal(ui.pace().snapshot().unitPages, 10, "이 편의 분량이 속도의 단위가 된다");
  assert.equal($("#job-unit").textContent, "레슨 2/4");
});

test("작업을 새로 시작하면 전체 시계도 지워진다", () => {
  const { $, ui } = fixture();
  ui.renderJobEvent({ type: "started", options: { name: "ch02" } });
  ui.renderJobEvent({ type: "plan", units: [{ title: "L01", pages: 10 }, { title: "L02", pages: 10 }] });
  ui.renderJobEvent({ type: "unit", index: 2, total: 2, title: "L02" });

  ui.renderJobEvent({ type: "started", options: { name: "next" } });

  assert.equal(ui.pace().snapshot().units.length, 0);
  assert.equal($("#job-total-eta").textContent, "");
});

test("일시정지하면 상태와 버튼이 바뀌고, 이어하면 되돌아온다", () => {
  const { $, ui } = fixture();
  ui.renderJobEvent({ type: "started", options: { name: "ch02" } });
  assert.equal($("#pause-button").textContent, "일시정지");

  ui.renderJobEvent({ type: "paused", immediate: true });
  assert.equal($("#job-state").textContent, "일시정지");
  assert.equal($("#pause-button").textContent, "이어하기");
  assert.equal($("#current-stage").textContent, "일시정지됨");

  ui.renderJobEvent({ type: "resumed" });
  assert.equal($("#job-state").textContent, "실행 중");
  assert.equal($("#pause-button").textContent, "일시정지");
});

test("촬영 중이라 바로 못 멈추면 언제 멈추는지 말해 준다", () => {
  const { $, ui } = fixture();
  ui.renderJobEvent({ type: "started", options: { name: "ch02" } });
  ui.renderJobEvent({ type: "paused", immediate: false });
  assert.equal($("#current-stage").textContent, "이번 편을 마치고 멈춥니다");
});

test("멈춰 있던 시간은 남은 시간 계산에서 빠진다", () => {
  // 그러지 않으면 점심 먹고 온 만큼 남은 시간이 부풀어, 다시 켰을 때 화면이
  // 엉뚱한 값을 말한다.
  const { $, ui } = fixture();
  ui.renderJobEvent({ type: "started", options: { name: "ch02" } });
  ui.renderJobEvent({ type: "voice-progress", done: 4, total: 24 });
  const before = ui.pace().snapshot().voice.startedAt;

  ui.renderJobEvent({ type: "paused", immediate: true });
  assert.equal($("#job-eta").textContent, "일시정지");
  ui.renderJobEvent({ type: "resumed" });

  assert.ok(ui.pace().snapshot().voice.startedAt >= before, "멈춘 만큼 관측 시작 시각이 밀려야 한다");
});

test("작업을 새로 시작하면 일시정지 버튼도 원래대로 돌아온다", () => {
  const { $, ui } = fixture();
  ui.renderJobEvent({ type: "started", options: { name: "ch02" } });
  ui.renderJobEvent({ type: "paused", immediate: true });
  assert.equal($("#pause-button").textContent, "이어하기");

  ui.renderJobEvent({ type: "started", options: { name: "ch03" } });
  assert.equal($("#pause-button").textContent, "일시정지");
});

test('챕터 완료 이벤트에서 두 번째 레슨의 누락도 완료 안내에 남는다', () => {
  const { $, ui }=fixture();
  ui.renderJobEvent({type:'started',options:{name:'chapter'}});
  ui.renderJobEvent({type:'complete',report:{durationMs:3000,summary:{ok:true,passed:2},target:{name:'first'},
    voiceFindings:[],units:[{name:'first',voiceFindings:[]},{name:'second',target:{name:'second'},
      voiceFindings:[{slideNumber:196,startMs:281475,endMs:309085,severity:'failed'}]}]}});
  assert.match($('#complete-summary').textContent,/재생성 필요 1곳/);
  assert.doesNotMatch($('#complete-summary').textContent,/모든 결과 검증 통과/);
  assert.equal($('#job-state').textContent,'제작 완료 · 확인 필요');
});

test('촬영 정지 예약을 실제 정지로 표시하거나 경과 시간에서 빼지 않는다', () => {
  const { $, ui } = fixture();
  ui.renderJobEvent({ type: 'started', options: { name: 'lecture' } });
  ui.renderJobEvent({ type: 'voice-progress', done: 1, total: 3 });
  const startedAt = ui.pace().snapshot().voice.startedAt;
  ui.renderJobEvent({ type: 'paused', immediate: false });
  assert.equal($('#job-state').textContent, '일시정지 대기');
  assert.equal($('#pause-button').textContent, '정지 예약 취소');
  ui.renderJobEvent({ type: 'resumed' });
  assert.equal(ui.pace().snapshot().voice.startedAt, startedAt);
});

test('챕터를 나눠 만들면 어느 편이 끝났고 어느 편이 실패했는지 줄로 남는다', () => {
  // 세 시간짜리 작업에서 '레슨 7/11'만으로는 무엇이 남았는지 알 수 없다.
  const { $, ui } = fixture();
  ui.renderJobEvent({ type: 'started', options: { name: 'ch03', mode: 'chapter', chapterMode: 'lesson' } });
  assert.equal($('#job-units').classList.contains('hidden'), true, '한 편짜리에는 목록이 없다');

  ui.renderJobEvent({ type: 'plan', units: [
    { title: 'L01', pages: 10, completed: true }, { title: 'L02', pages: 10 }, { title: 'L03', pages: 10 },
  ] });
  ui.renderJobEvent({ type: 'unit', index: 2, total: 3, title: 'L02' });

  assert.equal($('#job-units').classList.contains('hidden'), false);
  assert.deepEqual($('#job-units-list').children.map(row => row.dataset.state), ['skipped', 'running', 'pending']);
  assert.match($('#job-units-detail').textContent, /3편 중 1편 완료 · 2편 남음/);

  ui.renderJobEvent({ type: 'unit-failed', index: 2, title: 'L02', failedCount: 1 });
  ui.renderJobEvent({ type: 'unit', index: 3, total: 3, title: 'L03' });

  assert.deepEqual($('#job-units-list').children.map(row => row.dataset.state), ['skipped', 'failed', 'running']);
  assert.match($('#job-units-detail').textContent, /1편 실패/);

  ui.renderJobEvent({ type: 'complete', report: { durationMs: 1000, summary: { ok: true }, target: { name: 'ch03' }, units: [], voiceFindings: [] } });
  assert.deepEqual($('#job-units-list').children.map(row => row.dataset.state), ['skipped', 'failed', 'done']);
});
