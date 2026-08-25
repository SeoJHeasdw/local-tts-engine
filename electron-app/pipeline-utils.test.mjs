import test from "node:test";
import assert from "node:assert/strict";

import {
  isInside,
  makeJobName,
  mapWithConcurrency,
  normalizeOptions,
  parseTimecode,
  presetFromManifest,
  summarizeChecks,
  timeRangeForPages,
} from "./pipeline-utils.mjs";

test("기본 작업은 파인튜닝 A 0.6과 30초 미리보기다", () => {
  const options = normalizeOptions({ name: "lecture-a" });
  assert.equal(options.voiceMode, "finetuned");
  assert.equal(options.adapterScale, 0.6);
  assert.equal(options.mode, "preview");
  assert.equal(options.targetSeconds, 30);
  assert.equal(options.startPage, 1);
  assert.equal(options.deliverable, "video");
});

test("페이지 묶음은 시작과 끝 범위를 보존한다", () => {
  const options = normalizeOptions({ name: "bundle-a", mode: "bundle", startPage: 25, endPage: 81 });
  assert.equal(options.startPage, 25);
  assert.equal(options.endPage, 81);
  assert.throws(() => normalizeOptions({ name: "bad", mode: "bundle", startPage: 81, endPage: 25 }));
});

test("manifest의 실제 마지막 스텝으로 preset 범위를 만든다", () => {
  const preset = presetFromManifest({ entries: [
    { chapter: "ch00", slide_id: "open", step: 1 },
    { chapter: "ch01", slide_id: "proof", step: 3 },
  ] }, { title: "테스트" });
  assert.deepEqual(preset, {
    title: "테스트",
    startChapter: "ch00",
    startSlide: "open",
    endChapter: "ch01",
    endSlide: "proof",
    endStep: 3,
  });
});

test("작업 이름과 경로를 제한한다", () => {
  assert.throws(() => normalizeOptions({ name: "../escape" }));
  assert.equal(isInside("/tmp/root", "/tmp/root/item"), true);
  assert.equal(isInside("/tmp/root", "/tmp/other"), false);
});

test("작업 이름과 검증 요약을 결정적으로 만든다", () => {
  assert.equal(makeJobName(new Date(2026, 7, 25, 9, 8, 7), 30), "studio-20260825-090807-30s");
  assert.deepEqual(summarizeChecks([
    { label: "audio", ok: true },
    { label: "video", ok: false },
  ]), { ok: false, passed: 1, total: 2, failed: ["video"] });
});

test("초와 시:분:초 타임코드를 해석한다", () => {
  assert.equal(parseTimecode("75.5"), 75.5);
  assert.equal(parseTimecode("01:15.5"), 75.5);
  assert.equal(parseTimecode("01:02:03"), 3723);
  assert.throws(() => parseTimecode("1분"));
});

test("페이지 타임라인의 첫 시작부터 마지막 끝까지 자른다", () => {
  const range = timeRangeForPages([
    { slideNumber: 24, startMs: 0, endMs: 900 },
    { slideNumber: 25, startMs: 900, endMs: 1800 },
    { slideNumber: 25, startMs: 1800, endMs: 2500 },
    { slideNumber: 26, startMs: 2500, endMs: 4000 },
  ], 25, 25);
  assert.deepEqual(range, { start: 0.9, end: 2.5 });
  assert.throws(() => timeRangeForPages([], 25, 81));
});

test("목소리 작업을 최대 2개씩 병렬 처리하고 결과 순서를 지킨다", async () => {
  let running = 0;
  let peak = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 2));
    running -= 1;
    return value * 10;
  });
  assert.equal(peak, 2);
  assert.deepEqual(results, [10, 20, 30, 40]);
});
