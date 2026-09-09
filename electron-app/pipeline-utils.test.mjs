import test from "node:test";
import assert from "node:assert/strict";

import {
  assertPageReplaceable,
  combineLessonCatalogs,
  isInside,
  lessonCatalogFromPresets,
  makeJobName,
  mapWithConcurrency,
  nextDisplayVideoFileName,
  normalizeVoiceText,
  normalizeOptions,
  outputPathsForRoot,
  pageRangeFromTimeline,
  pageVoicePatchPlan,
  patchedTimeline,
  parseTimecode,
  presetFromManifest,
  summarizeChecks,
  timeRangeForPages,
  videoTimelineCandidates,
  videoTimelineFileName,
  withOutputReview,
  voiceFindingSeverity,
  voiceQualityFindings,
  composeTotalMs,
  normalizeComposeClips,
  pendingUnits,
} from "./pipeline-utils.mjs";

test("기본 작업은 제작 LoRA v1 0.6과 레슨 전체 제작이다", () => {
  const options = normalizeOptions({ name: "lecture-a" });
  assert.equal(options.voiceMode, "finetuned");
  assert.equal(options.adapterScale, 0.6);
  assert.equal(options.mode, "lesson");
  assert.equal(options.targetSeconds, 0);
  assert.equal(options.startPage, 1);
  assert.equal(options.endPage, 1);
  assert.equal(options.chapterMode, "single");
  assert.equal(options.deliverable, "video");
});

test("페이지 직접 선택은 시작과 끝 범위를 보존한다", () => {
  const options = normalizeOptions({ name: "bundle-a", mode: "page", startPage: 25, endPage: 81 });
  assert.equal(options.mode, "page");
  assert.equal(options.startPage, 25);
  assert.equal(options.endPage, 81);
  assert.throws(() => normalizeOptions({ name: "bad", mode: "page", startPage: 81, endPage: 25 }));
});

test("챕터 전체는 한 영상 또는 레슨 단위 제작을 구분한다", () => {
  const options = normalizeOptions({
    name: "chapter-a",
    mode: "chapter",
    chapter: "ch01",
    chapterMode: "lesson",
    startPage: 12,
    endPage: 128,
  });
  assert.equal(options.mode, "chapter");
  assert.equal(options.chapter, "ch01");
  assert.equal(options.chapterMode, "lesson");
  assert.equal(options.startPage, 12);
  assert.equal(options.endPage, 128);
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

const REVIEW_MANIFEST = {
  chunks: [
    { key: "chunk-a", startMs: 12_300, endMs: 18_900 },
    { key: "chunk-b", startMs: 19_100, endMs: 24_000 },
    { key: "chunk-c", startMs: 24_200, endMs: 31_000 },
  ],
  quality: { chunks: [
    {
      chunkKey: "chunk-b",
      chapter: "ch02",
      slideId: "toolpick-model",
      slideNumber: 149,
      severity: "ok",
      selected: { passed: true },
    },
    {
      chunkKey: "chunk-a",
      chapter: "ch02",
      slideId: "toolpick-model",
      slideNumber: 148,
      severity: "failed",
      candidates: [{}, {}, {}, {}],
      selected: {
        attempt: 4,
        failures: ["지정 발음 불일치"],
        warnings: [],
        pronunciationChecks: [
          { term: "래그", status: "failed", distance: 0.5 },
          { term: "오십 개", status: "ok", distance: 0 },
        ],
        expectedText: "래그를 씁니다",
        recognizedText: "알에이지를 씁니다",
      },
    },
    {
      chunkKey: "chunk-c",
      chapter: "ch02",
      slideId: "toolpick-scale",
      slideNumber: 150,
      severity: "warning",
      candidates: [{}, {}],
      selected: {
        attempt: 2,
        failures: [],
        warnings: ["지정 발음 확인 필요"],
        pronunciationChecks: [{ term: "런타임", status: "warning", distance: 0.25 }],
        expectedText: "런타임을 봅니다",
        recognizedText: "런팀을 봅니다",
      },
    },
  ] },
};

test("검수에 걸린 청크를 영상 시간대와 페이지로 연결한다", () => {
  const findings = voiceQualityFindings(REVIEW_MANIFEST);

  assert.equal(findings.length, 2);
  assert.deepEqual(findings[0], {
    chapter: "ch02",
    slideId: "toolpick-model",
    slideNumber: 148,
    startMs: 12_300,
    endMs: 18_900,
    severity: "failed",
    reasons: ["지정 발음 불일치"],
    terms: [{ term: "래그", status: "failed" }],
    expectedText: "래그를 씁니다",
    recognizedText: "알에이지를 씁니다",
    selectedAttempt: 4,
    attempts: 4,
  });
  // Findings are ordered by where they occur, so the list reads like the video.
  assert.deepEqual(findings.map((finding) => finding.startMs), [12_300, 24_200]);
});

test("통과한 청크는 확인 목록에 올리지 않는다", () => {
  const findings = voiceQualityFindings({
    chunks: [{ key: "chunk-a", startMs: 0, endMs: 1_000 }],
    quality: { chunks: [{ chunkKey: "chunk-a", severity: "ok", selected: { passed: true } }] },
  });
  assert.deepEqual(findings, []);
});

test("재생성 권장과 확인 권장을 구분해 기록한다", () => {
  const findings = voiceQualityFindings(REVIEW_MANIFEST);
  assert.deepEqual(findings.map((finding) => finding.severity), ["failed", "warning"]);
  assert.deepEqual(findings[1].reasons, ["지정 발음 확인 필요"]);
});

test("검수 기록이 없는 매니페스트는 조용히 빈 목록을 낸다", () => {
  assert.deepEqual(voiceQualityFindings({}), []);
  assert.deepEqual(voiceQualityFindings({ quality: { chunks: [] } }), []);
});

test("끊어읽기만 남으면 청크 대신 해당 단어의 영상 시각을 표시한다", () => {
  const manifest = {
    chunks: [{ key: "a", startMs: 12_300, endMs: 25_000 }],
    quality: { chunks: [{ chunkKey: "a", slideNumber: 148, severity: "warning", selected: {
      passed: false, failures: [], warnings: ["단어 내부 끊김 확인 필요"],
      prosody: { checks: [{ term: "똑똑한", status: "warning", startMs: 2000, endMs: 3500 }] },
    } }] },
  };
  const [finding] = voiceQualityFindings(manifest);
  assert.equal(finding.startMs, 14_300);
  assert.equal(finding.endMs, 15_800);
  assert.deepEqual(finding.terms, [{ term: "똑똑한", status: "warning" }]);
  // A pronunciation failure elsewhere in the chunk still needs the whole clip.
  manifest.quality.chunks[0].selected.failures.push("받아쓰기 불일치");
  assert.equal(voiceQualityFindings(manifest)[0].startMs, 12_300);
});

test("합격·불합격만 알던 예전 기록도 읽는다", () => {
  // Older manifests had no severity, and a failure then meant "make it again".
  assert.equal(voiceFindingSeverity({ selected: { passed: false } }), "failed");
  assert.equal(voiceFindingSeverity({ selected: { passed: true } }), "ok");
  assert.equal(voiceFindingSeverity({ severity: "warning", selected: { passed: false } }), "warning");
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


test("완성 영상은 프로젝트 폴더로 옮겨져도 타임라인을 다시 찾는다", () => {
  // publishVideo moves the mp4 into output/videos/<job>/ and leaves the project
  // folder behind; without the later candidates a published video looked like a
  // plain file and page replacement silently became whole-video replacement.
  assert.equal(videoTimelineFileName("/out/videos/job-a/CH02 L11.mp4"), "CH02 L11.timeline.json");
  assert.deepEqual(
    videoTimelineCandidates("/out/videos/job-a/CH02 L11.mp4", "/out/projects"),
    [
      "/out/videos/job-a/CH02 L11.timeline.json",
      "/out/videos/job-a/timeline.json",
      "/out/projects/job-a/timeline.json",
    ],
  );
  assert.deepEqual(
    videoTimelineCandidates("/elsewhere/clip.mp4", null),
    ["/elsewhere/clip.timeline.json", "/elsewhere/timeline.json"],
  );
});

test("같은 폴더의 다른 회차 영상과 타임라인이 섞이지 않는다", () => {
  // Re-running a job name adds "CH02 L11 (2).mp4" beside the first render. A
  // single shared timeline.json would describe whichever ran last while reveal
  // opened a different file, and the wrong span of audio would be replaced.
  const first = videoTimelineCandidates("/out/videos/job-a/CH02 L11.mp4", null)[0];
  const second = videoTimelineCandidates("/out/videos/job-a/CH02 L11 (2).mp4", null)[0];
  assert.notEqual(first, second);
});

test("타임라인에서 이 영상이 담은 페이지 범위를 읽는다", () => {
  assert.deepEqual(pageRangeFromTimeline({ entries: [
    { slideNumber: 150 }, { slideNumber: 148 }, { slideNumber: 149 },
  ] }), { start: 148, end: 150 });
  assert.equal(pageRangeFromTimeline({ entries: [{}] }), null);
  assert.equal(pageRangeFromTimeline(null), null);
});

test("페이지 타임라인이 없으면 전체 음성을 덮지 않고 이유를 밝힌다", () => {
  const withTimeline = { timelinePath: "/t.json", pageRange: { start: 140, end: 160 } };
  assert.equal(assertPageReplaceable(withTimeline, { startPage: 148, endPage: 148 }), true);
  assert.equal(assertPageReplaceable(withTimeline, { startPage: 140, endPage: 160 }), true);

  assert.throws(
    () => assertPageReplaceable({}, { startPage: 148, endPage: 148 }),
    /페이지 타임라인이 없어/,
  );
  assert.throws(
    () => assertPageReplaceable(withTimeline, { startPage: 148, endPage: 200 }),
    /140~160페이지만 담고 있습니다/,
  );
  assert.throws(
    () => assertPageReplaceable(withTimeline, { startPage: 150, endPage: 149 }),
    /시작·끝 페이지를 확인/,
  );
  assert.throws(
    () => assertPageReplaceable(withTimeline, {}),
    /시작·끝 페이지를 확인/,
  );
});

test("짧은 반복 경고는 영상의 해당 단어 시각과 함께 표시한다", () => {
  const [finding] = voiceQualityFindings({
    chunks: [{key: "a", startMs: 1300, endMs: 33660}],
    quality: {chunks: [{chunkKey: "a", slideNumber: 1, severity: "warning", selected: {
      warnings: ["짧은 발음 반복 확인 필요"],
      restarts: {checks: [{term: "초안", status: "warning", startMs: 19210, endMs: 19650}]},
    }}]},
  });
  assert.equal(finding.startMs, 20510);
  assert.equal(finding.endMs, 20950);
  assert.deepEqual(finding.terms, [{term: "초안", status: "warning"}]);
});


test("검수 페이지는 연속 스텝의 원문과 시각을 합친다", async () => {
  const { reviewPages } = await import('./pipeline-utils.mjs');
  assert.deepEqual(reviewPages({entries:[
    {slideNumber:10,slideId:'a',startMs:100,endMs:800,sourceText:'첫 문장'},
    {slideNumber:10,slideId:'a',startMs:800,endMs:1800,sourceText:'다음 문장'},
    {slideNumber:11,slideId:'b',startMs:2000,endMs:3000,sourceText:'둘째 페이지'},
  ]}), [
    {number:10,slideId:'a',startMs:100,endMs:1800,text:'첫 문장\n다음 문장'},
    {number:11,slideId:'b',startMs:2000,endMs:3000,text:'둘째 페이지'},
  ]);
  assert.deepEqual(reviewPages(null), []);
});

test("구간 무음은 유효한 짧은 범위만 허용한다", async () => {
  const { muteRegionFilter } = await import('./pipeline-utils.mjs');
  for (const [start,end,duration] of [[-1,1,10],[0,3,10],[3,2,10],[9,11,10],[0,NaN,10],[0,.01,10]]) assert.throws(() => muteRegionFilter(start,end,duration));
  assert.match(muteRegionFilter(20.495,20.640,297.58), /val\(ch\)/);
});


test('짧은 교체 음성이 선택 구간보다 길면 잘라내지 않고 거절한다', async () => {
  const {replaceRegionPlan}=await import('./pipeline-utils.mjs');
  assert.throws(()=>replaceRegionPlan(1,2,5,1.1), /보다 깁니다/);
  assert.throws(()=>replaceRegionPlan(1,12,15,1));
  assert.throws(()=>replaceRegionPlan(1,2,5,NaN));
  assert.match(replaceRegionPlan(1,2,5,.5), /duration=first:normalize=0/);
});

test("편집 목록은 자르기와 합치기를 한 모델로 푼다", () => {
  // 클립 하나에 구간을 주면 자르기, 여럿을 구간 없이 담으면 합치기,
  // 섞으면 예전 두 탭으로는 표현할 수 없던 편집이 된다.
  const trim = normalizeComposeClips([{ inMs: 0, outMs: 60_000 }], [600_000]);
  assert.equal(trim[0].lengthMs, 60_000);
  assert.equal(trim[0].trimmed, true);

  const merge = normalizeComposeClips([{}, {}], [10_000, 20_000]);
  assert.deepEqual(merge.map((clip) => clip.trimmed), [false, false]);
  assert.equal(composeTotalMs(merge), 30_000);

  const mixed = normalizeComposeClips([{ inMs: 5_000 }, {}], [20_000, 10_000]);
  assert.deepEqual(mixed.map((clip) => [clip.inMs, clip.outMs, clip.trimmed]), [
    [5_000, 20_000, true], [0, 10_000, false],
  ]);
  assert.equal(composeTotalMs(mixed), 25_000);
});

test("끝 지점을 비우면 그 영상 끝까지, 넘겨 적으면 끝에서 멈춘다", () => {
  const clips = normalizeComposeClips([{ inMs: 1_000 }, { inMs: 0, outMs: 999_000 }], [5_000, 8_000]);
  assert.deepEqual(clips.map((clip) => clip.outMs), [5_000, 8_000]);
});

test("빈 목록과 뒤집힌 구간은 렌더 전에 거절한다", () => {
  assert.throws(() => normalizeComposeClips([], []), /하나 이상/);
  assert.throws(() => normalizeComposeClips([{ inMs: 5_000, outMs: 2_000 }], [10_000]), /끝 지점/);
  assert.throws(() => normalizeComposeClips([{}], [0]), /길이를 읽지 못했습니다/);
});

test("이어하기는 이미 끝난 편만 건너뛴다", () => {
  const units = [{ name: "ch02-l01" }, { name: "ch02-l02" }, { name: "ch02-l03" }];
  assert.deepEqual(pendingUnits(units, ["ch02-l01"]).map((unit) => unit.name), ["ch02-l02", "ch02-l03"]);
  // 순서가 섞여 들어와도 남은 편의 순서는 원래대로 지킨다.
  assert.deepEqual(pendingUnits(units, ["ch02-l03", "ch02-l01"]).map((unit) => unit.name), ["ch02-l02"]);
  assert.deepEqual(pendingUnits(units, []).length, 3);
  assert.deepEqual(pendingUnits(units, ["ch02-l01", "ch02-l02", "ch02-l03"]).length, 0);
});
