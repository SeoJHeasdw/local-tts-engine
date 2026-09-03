import test from "node:test";
import assert from "node:assert/strict";

import {
  combineLessonCatalogs,
  isInside,
  lessonCatalogFromPresets,
  makeJobName,
  mapWithConcurrency,
  nextDisplayVideoFileName,
  normalizeVoiceText,
  normalizeOptions,
  outputPathsForRoot,
  pageVoicePatchPlan,
  patchedTimeline,
  parseTimecode,
  presetFromManifest,
  summarizeChecks,
  timeRangeForPages,
  withOutputReview,
  voiceQualityFindings,
} from "./pipeline-utils.mjs";

test("기본 작업은 제작 LoRA v1 0.6과 30초 미리보기다", () => {
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

test("결과물 폴더 하나에서 내부 출력 경로를 만든다", () => {
  assert.deepEqual(outputPathsForRoot("/tmp/studio-output"), {
    outputRoot: "/tmp/studio-output",
    ttsOutputRoot: "/tmp/studio-output/tts",
    voiceOutputRoot: "/tmp/studio-output/voices",
    captionOutputRoot: "/tmp/studio-output/projects",
    videoOutputRoot: "/tmp/studio-output/videos",
    editOutputRoot: "/tmp/studio-output/edits",
  });
});

test("기술용 preset을 제외하고 사용자용 레슨 범위를 만든다", () => {
  const pages = [
    { page: 1, chapter: "ch00", slideId: "open", stepCount: 2 },
    { page: 2, chapter: "ch00", slideId: "close", stepCount: 3 },
  ];
  const lessons = lessonCatalogFromPresets(pages, {
    ch00: { title: "오리엔테이션", startChapter: "ch00", startSlide: "open", endChapter: "ch00", endSlide: "close" },
    "ch00-preview": { title: "개발 미리보기", startChapter: "ch00", startSlide: "open", endChapter: "ch00", endSlide: "open" },
  });
  assert.deepEqual(lessons, [{
    id: "ch00",
    title: "오리엔테이션",
    chapter: "ch00",
    startPage: 1,
    endPage: 2,
    pageCount: 2,
    stepCount: 5,
  }]);
});

test("deck 레슨 목록을 정본으로 쓰고 안 쪼갠 챕터만 preset으로 채운다", () => {
  const deckLessons = [
    { id: "ch01-l01", chapter: "ch01", title: "CH01 L01", startPage: 12, endPage: 30 },
    { id: "ch02-l01", chapter: "ch02", title: "CH02 L01", startPage: 129, endPage: 136 },
  ];
  const presetLessons = [
    { id: "ch00", chapter: "ch00", title: "CH00", startPage: 1, endPage: 11 },
    { id: "ch01-l05", chapter: "ch01", title: "묵은 preset", startPage: 75, endPage: 77 },
  ];
  assert.deepEqual(combineLessonCatalogs(deckLessons, presetLessons).map((lesson) => lesson.id), [
    "ch00",
    "ch01-l01",
    "ch02-l01",
  ]);
});

test("작업 이름과 검증 요약을 결정적으로 만든다", () => {
  assert.equal(makeJobName(new Date(2026, 7, 25, 9, 8, 7), 30), "studio-20260825-090807-30s");
  assert.deepEqual(summarizeChecks([
    { label: "audio", ok: true },
    { label: "video", ok: false },
  ]), { ok: false, passed: 1, total: 2, failed: ["video"] });
});

test("Whisper 실패 청크를 영상 시간대와 페이지로 연결한다", () => {
  const findings = voiceQualityFindings({
    chunks: [
      { key: "chunk-a", startMs: 12_300, endMs: 18_900 },
      { key: "chunk-b", startMs: 19_100, endMs: 24_000 },
    ],
    quality: { chunks: [
      { chunkKey: "chunk-b", chapter: "ch02", slideId: "toolpick-model", slideNumber: 148, selected: { passed: true } },
      { chunkKey: "chunk-a", chapter: "ch02", slideId: "toolpick-model", slideNumber: 148, selected: {
        passed: false,
        failures: ["지정 발음 불일치"],
        expectedText: "큐웬삼점육 이십칠비",
        recognizedText: "큐웬 삼십육 마이너스 이십칠 비",
        attempt: 3,
      } },
    ] },
  });

  assert.deepEqual(findings, [{
    chapter: "ch02",
    slideId: "toolpick-model",
    slideNumber: 148,
    startMs: 12_300,
    endMs: 18_900,
    reasons: ["지정 발음 불일치"],
    expectedText: "큐웬삼점육 이십칠비",
    recognizedText: "큐웬 삼십육 마이너스 이십칠 비",
    selectedAttempt: 3,
  }]);
});

test("레슨 제목으로 완성 영상 이름을 만들고 기존 파일은 번호를 붙여 보존한다", () => {
  assert.equal(nextDisplayVideoFileName("CH01 L00 챕터 프레임", []), "CH01 L00 챕터 프레임.mp4");
  assert.equal(nextDisplayVideoFileName("CH01 L00 챕터 프레임", [
    "CH01 L00 챕터 프레임.mp4",
    "CH01 L00 챕터 프레임 (2).mp4",
  ]), "CH01 L00 챕터 프레임 (3).mp4");
  assert.equal(nextDisplayVideoFileName("CH01 / 오프닝", []), "CH01 ／ 오프닝.mp4");
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

test("한 페이지만 새 음성 길이에 맞추고 뒤 타임라인을 이동한다", () => {
  const timeline = {
    totalMs: 4_000,
    entries: [
      { slideNumber: 1, startMs: 0, endMs: 1_000, transitionAtMs: 1_000, speechStartMs: 100, speechEndMs: 900, audio: {}, alignment: { words: [{ startMs: 100, endMs: 900 }] } },
      { slideNumber: 2, startMs: 1_000, endMs: 2_500, transitionAtMs: 2_500, speechStartMs: 1_100, speechEndMs: 2_400, audio: {}, alignment: { words: [{ startMs: 1_100, endMs: 2_400 }] } },
      { slideNumber: 3, startMs: 2_500, endMs: 4_000, transitionAtMs: 4_000, speechStartMs: 2_600, speechEndMs: 3_900, audio: {}, alignment: { words: [{ startMs: 2_600, endMs: 3_900 }] } },
    ],
  };

  const patched = patchedTimeline(
    timeline,
    1_000,
    2_500,
    2_000,
    new Date("2026-09-03T00:00:00.000Z"),
  );

  assert.equal(patched.totalMs, 4_500);
  assert.deepEqual(
    patched.entries.map((entry) => [entry.startMs, entry.endMs]),
    [[0, 1_000], [1_000, 3_000], [3_000, 4_500]],
  );
  assert.deepEqual(patched.voicePatch, {
    startMs: 1_000,
    endMs: 2_500,
    replacementDurationMs: 2_000,
    deltaMs: 500,
  });
});

test("페이지 목소리 교체 필터는 앞·교체·뒤 구간만 다시 잇는다", () => {
  const plan = pageVoicePatchPlan({
    videoDuration: 10,
    targetStart: 2,
    targetEnd: 5,
    sourceStart: 1.3,
    sourceEnd: 5.3,
    matchAudio: true,
  });

  assert.equal(plan.replacementDuration, 4);
  assert.equal(plan.videoFactor, 4 / 3);
  assert.match(plan.filter, /concat=n=3:v=1:a=0\[vout]/);
  assert.match(plan.filter, /atrim=start=1\.300000:end=5\.300000/);
  assert.match(plan.filter, /setpts=1\.333333333\*\(PTS-STARTPTS\)\[vmid]/);
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

test("텍스트 목소리는 줄바꿈 호흡을 보존하고 줄 안의 공백만 정리한다", () => {
  assert.equal(
    normalizeVoiceText("  첫 문장  입니다.\r\n\r\n 둘째 문장입니다.  "),
    "첫 문장 입니다.\n둘째 문장입니다.",
  );
});

test("자동 검증과 별도로 사람 청취 승인 상태를 기록한다", () => {
  const now = new Date("2026-08-27T01:02:03.000Z");
  const reviewed = withOutputReview({ name: "lesson-a", summary: { ok: true } }, "approved", now);
  assert.deepEqual(reviewed.review, { status: "approved", updatedAt: "2026-08-27T01:02:03.000Z" });
  assert.equal(reviewed.summary.ok, true);
  assert.throws(() => withOutputReview({}, "rejected", now));
});
