import test from "node:test";
import assert from "node:assert/strict";

import { createJobPace } from "../../electron-app/renderer/job-pace.mjs";

// 시계를 손으로 돌린다. 실제 제작은 한 편에 수십 분이라 실시간으로 검사할 수 없다.
function fakeClock(start = 1_700_000_000_000) {
  let value = start;
  return { now: () => value, advance(ms) { value += ms; return value; } };
}

const CHAPTER = { mode: "chapter", chapterMode: "lesson", deliverable: "video", startPage: 1, endPage: 100 };
const minutes = (count) => count * 60_000;

// 한 편을 통째로 지나가게 한다. 실제 순서와 같은 이벤트만 쓴다.
function runUnit(pace, clock, { index, total, voiceMs, durationMs, captureMs, tailMs = 5_000 }) {
  pace.startUnit({ index, total });
  pace.stage("voice", "running");
  pace.voiceProgress({ done: 0, total: 10 });
  clock.advance(voiceMs);
  pace.voiceProgress({ done: 10, total: 10 });
  pace.stage("voice", "done");
  pace.unitDuration(durationMs);
  for (const stage of ["export", "captions"]) {
    pace.stage(stage, "running");
    clock.advance(tailMs / 2);
    pace.stage(stage, "done");
  }
  pace.stage("capture", "running");
  clock.advance(captureMs);
  pace.stage("capture", "done");
  clock.advance(tailMs);
}

test("촬영 중에도 이 편의 남은 시간을 말한다", () => {
  // 예전에는 목소리 단계에만 진행 숫자가 있어, 촬영으로 넘어가는 순간 시계가
  // 꺼지고 '계산 중'만 남았다. 촬영이 제일 긴 단계인데 거기서 답이 없었다.
  const clock = fakeClock();
  const pace = createJobPace({ now: clock.now });
  pace.start(CHAPTER);
  pace.plan([{ title: "L01", pages: 20 }, { title: "L02", pages: 20 }]);
  pace.startUnit({ index: 1, total: 2 });
  pace.stage("voice", "running");
  clock.advance(minutes(5));
  pace.stage("voice", "done");
  pace.unitDuration(minutes(18));
  pace.stage("capture", "running");
  clock.advance(minutes(3));

  const { unit, unitBusy } = pace.labels({ running: true });

  assert.equal(unitBusy, false, "촬영 길이는 음성 길이로 알 수 있다");
  assert.equal(unit, "이 편 약 15분");
});

test("남은 시간은 남은 단계를 모두 더한다", () => {
  const clock = fakeClock();
  const pace = createJobPace({ now: clock.now });
  pace.start(CHAPTER);
  pace.plan([{ title: "L01", pages: 20 }, { title: "L02", pages: 20 }]);
  runUnit(pace, clock, { index: 1, total: 2, voiceMs: minutes(10), durationMs: minutes(18), captureMs: minutes(20) });

  // 두 번째 편은 목소리 절반을 지났다. 남은 목소리 5분에 촬영 20분이 더 붙는다.
  pace.startUnit({ index: 2, total: 2 });
  pace.stage("voice", "running");
  pace.voiceProgress({ done: 0, total: 10 });
  clock.advance(minutes(5));
  pace.voiceProgress({ done: 5, total: 10 });

  const remaining = pace.snapshot().unitRemainingMs;

  assert.ok(remaining > minutes(24) && remaining < minutes(27), `${remaining / 60_000}분`);
});

test("앞 편이 끝나면 남은 편들의 몫을 페이지로 잰다", () => {
  const clock = fakeClock();
  const pace = createJobPace({ now: clock.now });
  pace.start(CHAPTER);
  pace.plan([{ title: "L01", pages: 10 }, { title: "L02", pages: 10 }, { title: "L03", pages: 100 }]);
  // 10페이지를 35분에 끝냈다. 남은 110페이지는 편 개수가 아니라 분량으로 센다.
  // 편 개수로 세면 두 편 남았으니 70분이 나올 자리다.
  runUnit(pace, clock, { index: 1, total: 3, voiceMs: minutes(15), durationMs: minutes(20), captureMs: minutes(20) });
  pace.startUnit({ index: 2, total: 3 });
  pace.stage("voice", "running");

  const { total } = pace.labels({ running: true });

  assert.match(total, /^전체 약 6시간/, total);
});

test("전체 남은 시간은 같은 속도에서 줄기만 한다", () => {
  // 시계가 뒤로 갈 때마다 화면을 믿을 수 없게 된다. 속도가 그대로면 5분 뒤의
  // 답은 반드시 5분 짧아야 한다.
  const clock = fakeClock();
  const pace = createJobPace({ now: clock.now });
  pace.start(CHAPTER);
  pace.plan([{ title: "L01", pages: 20 }, { title: "L02", pages: 20 }, { title: "L03", pages: 20 }]);
  runUnit(pace, clock, { index: 1, total: 3, voiceMs: minutes(10), durationMs: minutes(18), captureMs: minutes(19) });
  pace.startUnit({ index: 2, total: 3 });
  pace.stage("voice", "running");
  pace.voiceProgress({ done: 0, total: 10 });
  clock.advance(minutes(2));
  pace.voiceProgress({ done: 2, total: 10 });

  const first = pace.snapshot().chapterRemainingMs;
  clock.advance(minutes(5));
  pace.voiceProgress({ done: 7, total: 10 });
  const later = pace.snapshot().chapterRemainingMs;

  assert.ok(later < first, `${first / 60_000}분 → ${later / 60_000}분`);
  assert.ok(first - later >= minutes(4), "지난 5분만큼은 줄어야 한다");
});

test("촬영이 예상보다 길어져도 남은 편들의 몫이 함께 늘지 않는다", () => {
  const clock = fakeClock();
  const pace = createJobPace({ now: clock.now });
  pace.start(CHAPTER);
  pace.plan([{ title: "L01", pages: 20 }, { title: "L02", pages: 20 }]);
  runUnit(pace, clock, { index: 1, total: 2, voiceMs: minutes(10), durationMs: minutes(18), captureMs: minutes(19) });
  pace.startUnit({ index: 2, total: 2 });
  pace.stage("voice", "running");
  const planned = pace.snapshot().chapterRemainingMs;

  clock.advance(minutes(90));

  const stalled = pace.snapshot().chapterRemainingMs;
  assert.ok(stalled <= planned, "오래 걸린 만큼 남은 시간이 도로 늘지 않는다");
});

test("맥이 잠든 시간은 속도에서 빠진다", () => {
  // 자고 일어난 만큼을 경과로 세면, 그 속도가 남은 편들의 몫까지 부풀린다.
  const clock = fakeClock();
  const awake = createJobPace({ now: clock.now });
  awake.start(CHAPTER);
  awake.plan([{ title: "L01", pages: 20 }, { title: "L02", pages: 20 }]);
  awake.startUnit({ index: 1, total: 2 });
  awake.stage("voice", "running");
  awake.voiceProgress({ done: 0, total: 10 });
  clock.advance(minutes(4));
  awake.voiceProgress({ done: 4, total: 10 });
  const expected = awake.snapshot().unitRemainingMs;

  const slept = createJobPace({ now: clock.now });
  slept.start(CHAPTER);
  slept.plan([{ title: "L01", pages: 20 }, { title: "L02", pages: 20 }]);
  slept.startUnit({ index: 1, total: 2 });
  slept.stage("voice", "running");
  slept.voiceProgress({ done: 0, total: 10 });
  clock.advance(minutes(60));
  slept.slept(minutes(60));
  clock.advance(minutes(4));
  slept.voiceProgress({ done: 4, total: 10 });

  assert.equal(Math.round(slept.snapshot().unitRemainingMs), Math.round(expected));
});

test("멈춰 있는 동안은 남은 시간이 늘지 않는다", () => {
  const clock = fakeClock();
  const pace = createJobPace({ now: clock.now });
  pace.start(CHAPTER);
  pace.plan([{ title: "L01", pages: 20 }, { title: "L02", pages: 20 }]);
  pace.startUnit({ index: 1, total: 2 });
  pace.stage("voice", "running");
  pace.voiceProgress({ done: 0, total: 10 });
  clock.advance(minutes(4));
  pace.voiceProgress({ done: 4, total: 10 });
  const before = pace.snapshot().unitRemainingMs;

  pace.pause();
  assert.equal(pace.labels({ running: true }).unit, "일시정지");
  clock.advance(minutes(30));
  pace.resume();

  assert.equal(Math.round(pace.snapshot().unitRemainingMs), Math.round(before));
});

test("한 편짜리 작업에는 두 번째 시계를 띄우지 않는다", () => {
  const clock = fakeClock();
  const pace = createJobPace({ now: clock.now });
  pace.start({ mode: "lesson", deliverable: "video", startPage: 10, endPage: 30 });
  pace.stage("voice", "running");
  pace.voiceProgress({ done: 0, total: 10 });
  clock.advance(minutes(2));
  pace.voiceProgress({ done: 5, total: 10 });

  const { unit, total } = pace.labels({ running: true });

  assert.equal(total, "", "전체 시계가 설 자리가 없다");
  // 촬영 몫을 아직 모르는 동안에는 무엇을 기다리는지라도 말한다.
  assert.equal(unit, "목소리 생성 약 2분");
});

test("한 편짜리도 촬영에 들어가면 작업 전체의 남은 시간을 말한다", () => {
  const clock = fakeClock();
  const pace = createJobPace({ now: clock.now });
  pace.start({ mode: "lesson", deliverable: "video", startPage: 10, endPage: 30 });
  pace.stage("voice", "running");
  clock.advance(minutes(6));
  pace.stage("voice", "done");
  pace.unitDuration(minutes(12));
  pace.stage("capture", "running");
  clock.advance(minutes(2));

  assert.equal(pace.labels({ running: true }).unit, "약 10분 남음");
});

test("작업이 끝나면 시계를 지운다", () => {
  const clock = fakeClock();
  const pace = createJobPace({ now: clock.now });
  pace.start(CHAPTER);
  pace.plan([{ title: "L01", pages: 20 }, { title: "L02", pages: 20 }]);
  pace.startUnit({ index: 1, total: 2 });
  pace.stage("capture", "running");

  const { unit, total } = pace.labels({ running: false });

  assert.equal(unit, "");
  assert.equal(total, "");
});

test("이어하기로 건너뛴 편은 남은 분량에서 빠진다", () => {
  const clock = fakeClock();
  const pace = createJobPace({ now: clock.now });
  pace.start(CHAPTER);
  pace.plan([
    { title: "L01", pages: 20, completed: true },
    { title: "L02", pages: 20 },
    { title: "L03", pages: 20, completed: true },
    { title: "L04", pages: 20 },
  ]);
  runUnit(pace, clock, { index: 2, total: 4, voiceMs: minutes(10), durationMs: minutes(18), captureMs: minutes(19) });
  pace.startUnit({ index: 4, total: 4 });
  pace.stage("voice", "running");

  // 남은 편은 4편 하나뿐이다. 3편은 이미 완성돼 있어 세지 않는다.
  const remaining = pace.snapshot().chapterRemainingMs;
  const perUnit = pace.snapshot().msPerPage * 20;
  assert.ok(Math.abs(remaining - perUnit) < minutes(1), `${remaining / 60_000}분 vs ${perUnit / 60_000}분`);
});

test("실패한 편의 소요는 남은 편의 속도로 쓰지 않는다", () => {
  const clock = fakeClock();
  const pace = createJobPace({ now: clock.now });
  pace.start(CHAPTER);
  pace.plan([{ title: "L01", pages: 20 }, { title: "L02", pages: 20 }, { title: "L03", pages: 20 }]);
  runUnit(pace, clock, { index: 1, total: 3, voiceMs: minutes(10), durationMs: minutes(18), captureMs: minutes(19) });
  pace.startUnit({ index: 2, total: 3 });
  const healthy = pace.snapshot().msPerPage;

  pace.stage("voice", "running");
  clock.advance(minutes(2));
  pace.unitFailed();
  pace.startUnit({ index: 3, total: 3 });

  assert.equal(pace.snapshot().msPerPage, healthy, "2분 만에 끝난 실패가 속도를 흔들지 않는다");
});

test("지난 실행에서 잰 속도로 첫 편부터 남은 시간을 말한다", () => {
  // 실행마다 첫 편은 잴 것이 없어 시계가 늦게 섰다. 같은 기기·같은 화질이면
  // 페이지당 음성 길이도 촬영 비율도 크게 다르지 않으니 시작값으로 쓴다.
  const clock = fakeClock();
  const saved = {};
  const store = { read: () => saved.value ?? {}, write: (value) => { saved.value = value; } };
  const first = createJobPace({ now: clock.now, store });
  first.start({ ...CHAPTER, videoQuality: "high" });
  first.plan([{ title: "L01", pages: 20 }, { title: "L02", pages: 20 }]);
  runUnit(first, clock, { index: 1, total: 2, voiceMs: minutes(10), durationMs: minutes(18), captureMs: minutes(19) });
  first.startUnit({ index: 2, total: 2 });

  assert.ok(saved.value?.high, "화질별로 남긴다");

  // 같은 화질로 새 작업을 시작하면 첫 편의 촬영 몫을 바로 잡는다.
  const next = createJobPace({ now: clock.now, store });
  next.start({ ...CHAPTER, videoQuality: "high" });
  next.plan([{ title: "L01", pages: 20 }, { title: "L02", pages: 20 }]);
  next.startUnit({ index: 1, total: 2 });
  next.stage("voice", "running");

  const remaining = next.snapshot().chapterRemainingMs;
  assert.ok(remaining > minutes(45) && remaining < minutes(75), `${remaining / 60_000}분`);

  // 다른 화질의 기록을 끌어다 쓰지 않는다. 촬영 비용이 다르다.
  const ultra = createJobPace({ now: clock.now, store });
  ultra.start({ ...CHAPTER, videoQuality: "ultra" });
  ultra.plan([{ title: "L01", pages: 20 }, { title: "L02", pages: 20 }]);
  ultra.startUnit({ index: 1, total: 2 });
  ultra.stage("voice", "running");
  assert.equal(ultra.snapshot().chapterRemainingMs, null);
});

test("이번 실행의 실측이 지난 기록보다 무겁다", () => {
  // 시작값은 어디까지나 시작값이다. 오늘 기기가 느리면 오늘 잰 값이 이겨야 한다.
  const clock = fakeClock();
  const saved = { value: { standard: { stages: {}, capture: { ms: minutes(10), durationMs: minutes(10) },
    audio: { durationMs: minutes(200), pages: 20 }, units: { ms: minutes(20), pages: 20 } } } };
  const store = { read: () => saved.value, write: (value) => { saved.value = value; } };
  const pace = createJobPace({ now: clock.now, store });
  pace.start({ ...CHAPTER, videoQuality: "standard" });
  pace.plan([{ title: "L01", pages: 20 }, { title: "L02", pages: 20 }]);
  runUnit(pace, clock, { index: 1, total: 2, voiceMs: minutes(10), durationMs: minutes(18), captureMs: minutes(19) });
  pace.startUnit({ index: 2, total: 2 });
  pace.stage("voice", "running");

  const perPage = pace.snapshot().msPerPage;
  // 실제로 20페이지를 35분에 끝냈다. 기록의 20분짜리 값에 끌려가지 않는다.
  assert.ok(perPage > minutes(1.2), `${perPage / 60_000}분/페이지`);
});

test("한 편짜리 작업의 실측도 다음 실행에 남는다", () => {
  // 한 편짜리는 편 이벤트가 없어 닫히는 자리가 없었다. 그러면 가장 흔한
  // 작업에서 아무것도 배우지 못한다.
  const clock = fakeClock();
  const saved = {};
  const store = { read: () => saved.value ?? {}, write: (value) => { saved.value = value; } };
  const pace = createJobPace({ now: clock.now, store });
  pace.start({ mode: "lesson", deliverable: "video", startPage: 1, endPage: 20, videoQuality: "high" });
  pace.stage("voice", "running");
  clock.advance(minutes(8));
  pace.stage("voice", "done");
  pace.unitDuration(minutes(16));
  pace.stage("capture", "running");
  clock.advance(minutes(17));
  pace.stage("capture", "done");
  clock.advance(minutes(1));

  pace.finish();

  assert.ok(saved.value?.high?.units?.pages > 0, "편 전체 속도가 남는다");
  const ratio = saved.value.high.capture.ms / saved.value.high.capture.durationMs;
  assert.ok(ratio > 1 && ratio < 1.2, `촬영 비율 ${ratio}`);
});
