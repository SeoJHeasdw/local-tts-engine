import test from "node:test";
import assert from "node:assert/strict";

import {
  outputIcon,
  OUTPUT_KINDS,
  buildChapterRanges,
  findingExcerpt,
  findingSeek,
  outputRowTitle,
  outputGroupTitle,
  splitOutputTitle,
  groupOutputs,
  outputGroupKey,
  outputVersionLinks,
  outputState,
  outputUnitLabel,
  etaLabel,
  formatCountdown,
  shortPath,
  formatRemaining,
  unitLabel,
  filterOutputItems,
  outputKind,
  formatVoiceTimestamp,
  shouldOpenMenuUpward,
  summarizePageRange,
  summarizeVoiceFindings,
  voiceFindingLabel,
  voiceFindingReason,
  voiceFindingSummaryLine,
} from "../../electron-app/renderer/view-utils.mjs";

const pages = [
  { page: 1, chapter: "ch00", stepCount: 2 },
  { page: 2, chapter: "ch00", stepCount: 3 },
  { page: 3, chapter: "ch01", stepCount: 4 },
];

test("강의 카탈로그를 챕터 이동 범위로 묶는다", () => {
  assert.deepEqual(buildChapterRanges(pages), [
    { id: "ch00", start: 1, end: 2, pageCount: 2, stepCount: 5 },
    { id: "ch01", start: 3, end: 3, pageCount: 1, stepCount: 4 },
  ]);
});

test("선택한 페이지 범위의 페이지와 스텝 수를 요약한다", () => {
  assert.deepEqual(summarizePageRange(pages, 2, 3), {
    start: 2,
    end: 3,
    pageCount: 2,
    stepCount: 7,
    chapterLabel: "CH00–CH01",
  });
});

test("최근 결과를 종류와 청취 승인 상태로 거른다", () => {
  const items = [
    { name: "lesson-one", root: "render", review: { status: "approved" } },
    { name: "voice-one", root: "voice" },
    { name: "edit-one", root: "edit" },
  ];
  assert.equal(outputKind(items[0]), "lecture");
  assert.deepEqual(filterOutputItems(items, "one", "pending").map((item) => item.name), ["voice-one", "edit-one"]);
  assert.deepEqual(filterOutputItems(items, "voice", "voice").map((item) => item.name), ["voice-one"]);
});

test("최근 결과는 내부 작업명뿐 아니라 레슨 제목으로도 검색한다", () => {
  const items = [{ name: "studio-20260827-120000-ch01-l00", displayName: "CH01 L00 챕터 프레임", root: "render" }];
  assert.deepEqual(filterOutputItems(items, "챕터 프레임").map((item) => item.name), [items[0].name]);
});

test("화면 아래 공간이 부족하면 결과 메뉴를 위로 연다", () => {
  assert.equal(shouldOpenMenuUpward(80, 120), true);
  assert.equal(shouldOpenMenuUpward(140, 120), false);
});


const FINDINGS = [
  {
    slideNumber: 148,
    startMs: 134_000,
    endMs: 141_000,
    severity: "failed",
    reasons: ["지정 발음 불일치"],
    terms: [{ term: "래그", status: "failed" }],
  },
  {
    slideNumber: 150,
    startMs: 3_701_000,
    endMs: 3_705_500,
    severity: "warning",
    reasons: ["지정 발음 확인 필요"],
    terms: [{ term: "런타임", status: "warning" }],
  },
];

test("확인 구간을 영상에서 찾아갈 수 있는 시간으로 적는다", () => {
  assert.equal(formatVoiceTimestamp(0), "0:00");
  assert.equal(formatVoiceTimestamp(134_000), "2:14");
  assert.equal(formatVoiceTimestamp(-5), "0:00");
  // Past an hour the label grows a field rather than counting to 61 minutes.
  assert.equal(formatVoiceTimestamp(3_701_000), "1:01:41");
  assert.equal(voiceFindingLabel(FINDINGS[0]), "2:14–2:21");
});

test("확인 사유에 실제로 걸린 용어를 함께 적는다", () => {
  assert.equal(voiceFindingReason(FINDINGS[0]), "지정 발음 불일치 · 래그");
  assert.equal(voiceFindingReason({}), "자동 음성 검수 점수 미달");
  assert.equal(voiceFindingReason({ reasons: ["과도한 무음"] }), "과도한 무음");
});

test("재생성 권장과 확인 권장을 나눠 세고 더 급한 쪽 색을 쓴다", () => {
  assert.deepEqual(summarizeVoiceFindings(FINDINGS), {
    total: 2,
    failed: 1,
    warned: 1,
    title: "재생성 필요 1곳 · 확인 권장 1곳",
    tone: "failed",
  });
  assert.equal(summarizeVoiceFindings([FINDINGS[1]]).tone, "warning");
  assert.equal(summarizeVoiceFindings([FINDINGS[1]]).title, "확인 권장 1곳");
  assert.equal(summarizeVoiceFindings([]).total, 0);
});

test("최근 결과 한 줄에는 첫 구간과 나머지 개수만 적는다", () => {
  assert.equal(voiceFindingSummaryLine(FINDINGS), "2:14–2:21 · 148페이지 외 1곳");
  assert.equal(voiceFindingSummaryLine([FINDINGS[0]]), "2:14–2:21 · 148페이지");
  assert.equal(voiceFindingSummaryLine([]), "");
});


test('뒤로·앞으로 이동과 이동 후 새 화면 선택은 브라우저처럼 동작한다', async () => {
  const {createViewHistory} = await import('../../electron-app/renderer/view-utils.mjs');
  const history=createViewHistory();
  assert.equal(history.canBack,false);
  history.visit('results'); history.visit('review'); history.visit('review');
  assert.equal(history.back(),'results'); assert.equal(history.canForward,true);
  assert.equal(history.forward(),'review');
  history.back(); history.visit('edit');
  assert.equal(history.canForward,false);
  assert.equal(history.back(),'results'); assert.equal(history.back(),'new');
  assert.equal(history.back(),'new'); assert.equal(history.canBack,false);
});

test("남은 시간은 여태 걸린 속도로만 내고 분 단위로 말한다", () => {
  // 30개 중 10개를 5분에 했으면 남은 20개는 약 10분.
  assert.equal(etaLabel({ done: 10, total: 30, elapsedMs: 5 * 60_000 }), "약 10분 남음");
  assert.equal(etaLabel({ done: 29, total: 30, elapsedMs: 29 * 1_000 }), "약 1분 미만 남음");
  assert.equal(etaLabel({ done: 30, total: 30, elapsedMs: 60_000 }), "곧 완료");
});

test("측정할 것이 없으면 남은 시간을 지어내지 않는다", () => {
  assert.equal(etaLabel({ done: 0, total: 30, elapsedMs: 0 }), "");
  assert.equal(etaLabel({ done: 5, total: 0, elapsedMs: 60_000 }), "");
  assert.equal(etaLabel({}), "");
});

test("이어받은 진행은 관측을 시작한 지점부터 센다", () => {
  // 화면을 늦게 열어 12번째부터 봤다면, 그 뒤로 4개를 2분에 한 속도로 낸다.
  assert.equal(
    etaLabel({ done: 16, total: 24, elapsedMs: 2 * 60_000, baseline: 12 }),
    "약 4분 남음",
  );
});

test("한 시간을 넘으면 시간과 분으로 끊어 읽는다", () => {
  assert.equal(formatRemaining(90 * 60_000), "1시간 30분");
  assert.equal(formatRemaining(120 * 60_000), "2시간");
  assert.equal(formatRemaining(0), "");
});

// 1초마다 한 자리씩 줄어드는 시계라야 줄어드는 것으로 보인다. 초를 올림하면
// 첫 1초 동안 값이 그대로여서 멈춘 것처럼 읽힌다.
test("남은 시간 시계는 초를 내림해 세고 한 시간을 넘으면 자리를 늘린다", () => {
  assert.equal(formatCountdown(15 * 60_000), "15:00");
  assert.equal(formatCountdown(15 * 60_000 - 1), "14:59");
  assert.equal(formatCountdown(90 * 60_000 + 30_000), "1:30:30");
  assert.equal(formatCountdown(9_500), "0:09");
  assert.equal(formatCountdown(0), "0:00");
  assert.equal(formatCountdown(-5_000), "0:00");
});

// 설정의 경로 칸은 좁다. 앞에서 자르면 참조 음성과 참조 전사문이 같은 글자로
// 보여, 어느 칸을 고치는 중인지 알 수 없다.
test("경로는 끝에서부터 줄여 파일 이름을 먼저 지킨다", () => {
  assert.equal(shortPath("/a/b/artifacts/benchmarks/2026-08-23/reference.wav"), "…/2026-08-23/reference.wav");
  assert.equal(shortPath("/a/b/artifacts/benchmarks/2026-08-23/reference.txt"), "…/2026-08-23/reference.txt");
  assert.notEqual(
    shortPath("/x/y/benchmarks/2026-08-23/reference.wav"),
    shortPath("/x/y/benchmarks/2026-08-23/reference.txt"),
  );
  // 다 들어가면 그대로 둔다. 줄이지 않은 것을 줄인 것처럼 보이면 안 된다.
  assert.equal(shortPath("output"), "output");
  assert.equal(shortPath(""), "");
  assert.match(shortPath("/Users/me/Desktop/vswrk/edu/local-tts-engine/output"), /^…\/.*\/output$/);
});

test("레슨 단위 진행은 여러 편일 때만 표시한다", () => {
  assert.equal(unitLabel({ index: 3, total: 9 }), "레슨 3/9");
  assert.equal(unitLabel({ index: 1, total: 1 }), "");
  assert.equal(unitLabel({}), "");
});

test("전체 시계가 함께 설 때는 편 시계를 '이 편'으로 읽는다", () => {
  const both = { done: 10, total: 30, elapsedMs: 5 * 60_000 };
  assert.equal(etaLabel(both), "약 10분 남음");
  assert.equal(etaLabel({ ...both, scope: "unit" }), "이 편 약 10분");
  assert.equal(etaLabel({ done: 30, total: 30, elapsedMs: 60_000, scope: "unit" }), "이 편 곧 완료");
});

test("레슨으로 나눠 만든 결과는 챕터 작업 하나로 묶인다", () => {
  const items = [
    { name: "studio-1-ch02-lessons-ch02-l02", updatedAt: "2026-09-09T15:00:00Z", ok: true },
    { name: "studio-1-ch02-lessons-ch02-l01", updatedAt: "2026-09-09T14:00:00Z", ok: true },
    { name: "studio-2-ch01-full", updatedAt: "2026-09-09T12:00:00Z", ok: true },
  ];
  const rows = groupOutputs(items, () => []);

  assert.equal(rows.length, 2, "열여섯 줄이 아니라 작업 수만큼 보여야 한다");
  assert.equal(rows[0].type, "group");
  assert.deepEqual(rows[0].items.map((item) => item.name).map((name) => name.split("-").at(-1)), ["l01", "l02"]);
  assert.equal(rows[0].updatedAt, "2026-09-09T15:00:00Z", "묶음의 시각은 가장 최근 편을 따른다");
  assert.equal(rows[1].type, "single");
});

test("묶음은 아직 할 일이 남은 편이 몇인지 앞세운다", () => {
  const items = [
    { name: "j-ch02-lessons-ch02-l01", ok: true, review: { status: "approved" } },
    { name: "j-ch02-lessons-ch02-l02", ok: true },
    { name: "j-ch02-lessons-ch02-l03", ok: true },
  ];
  const findings = { "j-ch02-lessons-ch02-l03": [{ slideNumber: 5 }, { slideNumber: 9 }] };
  const [group] = groupOutputs(items, (item) => findings[item.name] || []);

  assert.equal(group.attention, 1, "확인이 남은 편만 센다");
  assert.equal(group.findings, 2);
});

test("결과 상태는 세 배지가 아니라 한 마디로 읽힌다", () => {
  // 파일 검증이 실패했으면 나머지는 따질 것이 없다.
  assert.equal(outputState({ ok: false, review: { status: "approved" } }, [{}]).key, "failed");
  // 아직 걸린 곳이 있으면 들었든 아니든 남은 일이다.
  assert.deepEqual(
    outputState({ ok: true, review: { status: "approved" } }, [{}, {}]),
    { key: "attention", label: "확인 2곳", tone: "attention" },
  );
  assert.equal(outputState({ ok: true, review: { status: "approved" } }, []).key, "approved");
  assert.equal(outputState({ ok: true }, []).key, "ready");
  // 프레임이 빠진 녹화는 완료이지만 확인할 곳 없음이라고 적지 않는다. 들어 보고
  // 승인했다면 그 판단을 따른다.
  assert.deepEqual(outputState({ ok: true, warnings: ["프레임 복제 3 · 누락 0"] }, []),
    { key: "attention", label: "경고 1건", tone: "attention" });
  assert.equal(outputState({ ok: true, warnings: ["x"], review: { status: "approved" } }, []).key, "approved");
});

test("레슨 편 이름을 짧은 표로 읽는다", () => {
  assert.equal(outputUnitLabel({ name: "studio-1-ch02-lessons-ch02-l07" }), "L07");
  assert.equal(outputUnitLabel({ name: "studio-2-ch01-full" }), null);
  assert.equal(outputGroupKey({ name: "studio-1-ch02-lessons-ch02-l07" }), "studio-1-ch02-lessons");
});

test("사이에 끼워 넣은 편도 같은 챕터 묶음에 든다", () => {
  // 덱에서 L01.5 로 부르는 편은 폴더 이름에 `ch03-l01-5` 로 적힌다. 정수만
  // 받으면 그 편만 묶음에서 떨어져 나와 홀로 선다.
  const half = { name: "studio-20260911-161338-ch03-lessons-ch03-l01-5" };
  assert.equal(outputGroupKey(half), "studio-20260911-161338-ch03-lessons");
  assert.equal(outputUnitLabel(half), "L01.5");

  const rows = groupOutputs([
    { name: "studio-20260911-161338-ch03-lessons-ch03-l02", ok: true },
    { name: "studio-20260911-161338-ch03-lessons-ch03-l01-5", ok: true },
    { name: "studio-20260911-161338-ch03-lessons-ch03-l01", ok: true },
  ], () => []);

  assert.equal(rows.length, 1, "열두 편이 한 묶음으로 선다");
  assert.deepEqual(rows[0].items.map((item) => outputUnitLabel(item)), ["L01", "L01.5", "L02"]);
});

test("묶음 제목은 챕터까지만 적는다", () => {
  const group = {
    key: "studio-1-ch02-lessons",
    items: [{ name: "studio-1-ch02-lessons-ch02-l01", displayName: "CH02 L01 · Agent Loop" }],
  };
  assert.equal(outputGroupTitle(group), "CH02");
});

test("최근 결과는 묶음 안에서도 Finder 파일 이름을 그대로 적는다", () => {
  // 제목에서 되짚어 만든 이름은 실제 파일과 어긋난다. 같은 이름이 이미 있으면
  // 발행이 "(2)"를 붙이므로, 목록이 부르는 이름과 Finder 이름이 달라진다.
  const item = {
    name: "studio-1-ch03-lessons-ch03-l02",
    displayName: "CH03 L02 · OpenAI",
    fileName: "CH03 L02 · OpenAI (2).mp4",
  };
  assert.equal(outputRowTitle(item), "CH03 L02 · OpenAI (2).mp4");
});

test("파일을 찾지 못한 결과도 이름 없이 남지 않는다", () => {
  const item = { name: "studio-2-ch01-full", displayName: "CH01 전체" };
  assert.equal(outputRowTitle(item), "CH01 전체");
});

test("파일 이름으로도 결과를 찾는다", () => {
  const items = [{ name: "studio-1", displayName: "CH02 L04", fileName: "CH02 L04 - 영어 보정.mp4" }];
  assert.equal(filterOutputItems(items, "영어 보정").length, 1);
  assert.equal(filterOutputItems(items, "없는말").length, 0);
});

test("편에 속하지 않는 결과는 이름을 그대로 쓴다", () => {
  const single = { name: "studio-2-ch01-full", displayName: "CH01 전체" };
  assert.equal(outputRowTitle(single), "CH01 전체");
  assert.deepEqual(splitOutputTitle("CH01 전체", ""), { scope: "", unit: "", title: "CH01 전체" });
  // 제목 없이 편 표시만 있어도 묶음 머리글은 챕터까지만 적는다.
  assert.equal(outputGroupTitle({ key: "j-ch02-lessons",
    items: [{ name: "j-ch02-lessons-ch02-l07", displayName: "CH02 L07" }] }), "CH02");
});

// 실제 CH00 슬라이드 10. 대본 121자 중 걸린 낱말은 하나다.
const CH00_FINDING = {
  slideNumber: 10,
  startMs: 272_385,
  endMs: 290_000,
  severity: "warning",
  reasons: ["단어 일부 누락"],
  terms: [{ term: "셋뿐입니다", status: "warning" }],
  expectedText: "강의는 일곱 챕터인데, 따라가는 질문은 셋뿐입니다. 일 장은 왜 에이전트가 나왔는지 봅니다.",
};
const CH00_PAGE = {
  number: 10, startMs: 272_385, endMs: 290_000,
  words: [
    { text: "강의는", startMs: 272_385, endMs: 272_945 },
    { text: "일곱", startMs: 272_945, endMs: 273_265 },
    { text: "챕터인데", startMs: 273_585, endMs: 273_985 },
    { text: "따라가는", startMs: 274_305, endMs: 274_865 },
    { text: "질문은", startMs: 274_865, endMs: 275_425 },
    { text: "셋뿐입니다", startMs: 275_745, endMs: 276_145 },
  ],
};

test("확인 항목은 대본 전체가 아니라 걸린 낱말과 그 앞뒤만 보여 준다", () => {
  const excerpt = findingExcerpt(CH00_FINDING);
  assert.equal(excerpt.term, "셋뿐입니다");
  assert.ok(excerpt.before.endsWith("질문은 "), `앞이 잘못 잘렸다: ${excerpt.before}`);
  assert.ok(excerpt.before.startsWith("…"), "앞을 잘랐으면 잘랐다고 표시한다");
  assert.ok(excerpt.after.endsWith("…"), "뒤를 잘랐으면 잘랐다고 표시한다");
  const whole = excerpt.before + excerpt.term + excerpt.after;
  assert.ok(whole.length < CH00_FINDING.expectedText.length, "발췌가 원문보다 길면 발췌가 아니다");
});

test("걸린 낱말이 없으면 짧게 줄인 원문을 보여 준다", () => {
  const excerpt = findingExcerpt({ expectedText: "짧은 문장", terms: [] });
  assert.equal(excerpt.term, "");
  assert.equal(excerpt.after, "짧은 문장");
  assert.equal(findingExcerpt({}), null);
});

test("확인 항목을 누르면 청크 첫머리가 아니라 걸린 낱말로 옮겨 간다", () => {
  // 청크는 272.4초에서 시작하지만 문제의 낱말은 275.7초에 있다. 청크 첫머리로
  // 보내면 어디가 문제인지 다시 찾아야 한다.
  const at = findingSeek(CH00_FINDING, CH00_PAGE);
  assert.equal(at.word, "셋뿐입니다");
  assert.equal(at.startMs, 275_045, "낱말 앞 0.7초부터 들려주어야 맥락 속에서 들린다");
  assert.equal(at.endMs, 276_645);
  assert.ok(at.startMs > CH00_FINDING.startMs, "청크 첫머리보다 뒤여야 한다");
});

test("낱말 시각이 없으면 원래 구간으로 옮겨 간다", () => {
  assert.deepEqual(findingSeek(CH00_FINDING, { startMs: 0, endMs: 1, words: [] }), {
    startMs: 272_385, endMs: 290_000,
  });
  assert.deepEqual(findingSeek(CH00_FINDING, null), { startMs: 272_385, endMs: 290_000 });
});

test("낱말 앞 여유는 페이지 시작을 넘어가지 않는다", () => {
  const at = findingSeek(
    { ...CH00_FINDING, terms: [{ term: "강의는" }] },
    CH00_PAGE,
  );
  assert.equal(at.startMs, 272_385, "페이지보다 앞으로 되감지 않는다");
});

test("한 편만 남은 묶음은 묶음으로 세우지 않는다", () => {
  // 머리글과 상태 배지를 두 줄 더 쓰면서 말하는 것이 그 한 줄과 같다.
  const rows = groupOutputs([
    { name: "studio-1-ch03-lessons-ch03-l01", ok: true },
    { name: "studio-2-ch02-lessons-ch02-l01", ok: true },
    { name: "studio-2-ch02-lessons-ch02-l02", ok: true },
  ], () => []);

  assert.deepEqual(rows.map((row) => row.type), ["single", "group"]);
  assert.equal(rows[1].items.length, 2);
});

test("수정본이 나온 원본은 그 사실을 함께 적는다", () => {
  // 한 레슨의 결과가 원본 하나로 끝나지 않는다. 어느 파일이 지금 쓸 것인지
  // 이름만 봐서는 알 수 없어, 사람이 따로 최신 목록을 적어 두게 된다.
  const original = { key: "render:l04", path: "/videos/CH02 L04.mp4", updatedAt: "2026-09-09T05:00:00Z" };
  const repair = { key: "edit:repair", path: "/edits/CH02 L04 - 수정.mp4", fileName: "CH02 L04 - 수정.mp4",
    updatedAt: "2026-09-09T06:00:00Z", sources: ["/videos/CH02 L04.mp4"] };
  const latest = { key: "edit:v2", path: "/edits/CH02 L04 - 수정 v2.mp4", fileName: "CH02 L04 - 수정 v2.mp4",
    updatedAt: "2026-09-10T06:00:00Z", sources: ["/videos/CH02 L04.mp4"] };
  const other = { key: "render:l05", path: "/videos/CH02 L05.mp4", updatedAt: "2026-09-09T05:00:00Z" };

  const links = outputVersionLinks([original, repair, latest, other]);

  assert.equal(links.get("render:l04").length, 2);
  assert.equal(links.get("render:l04")[0].key, "edit:v2", "가장 최근 수정본이 앞에 선다");
  assert.equal(links.has("render:l05"), false);
  assert.equal(links.has("edit:v2"), false, "수정본 자신은 원본이 아니다");
});

// 앱 데모와 화면 녹화는 이어서 할 일이 달라 목록에서 갈라 보여야 한다.
test('결과 종류는 편집 안에서도 앱 데모·화면 녹화를 따로 센다', () => {
  assert.equal(outputKind({ root: 'edit', operation: 'app-demo' }), 'demo');
  assert.equal(outputKind({ root: 'edit', operation: 'record-display' }), 'record');
  assert.equal(outputKind({ root: 'edit', operation: 'merge' }), 'edit');
  assert.equal(outputKind({ root: 'voice' }), 'voice');
  assert.equal(outputKind({ root: 'render' }), 'lecture');
});

// 목록은 종류마다 아이콘·색·거르기 단추가 하나씩이다. 녹화와 앱 데모도 따로 거른다.
test('결과 종류마다 아이콘과 거르기가 있고, 녹화·앱 데모는 편집에 섞이지 않는다', () => {
  const items = [
    { name: 'bob', root: 'edit', operation: 'record-display' },
    { name: 'rice', root: 'edit', operation: 'app-demo' },
    { name: 'merged', root: 'edit', operation: 'merge' },
  ];
  assert.deepEqual(OUTPUT_KINDS, ['lecture', 'record', 'demo', 'voice', 'edit']);
  assert.deepEqual(filterOutputItems(items, '', 'record').map(item => item.name), ['bob']);
  assert.deepEqual(filterOutputItems(items, '', 'demo').map(item => item.name), ['rice']);
  assert.deepEqual(filterOutputItems(items, '', 'edit').map(item => item.name), ['merged']);
  const icons = OUTPUT_KINDS.map(kind => outputIcon(kind));
  assert.equal(new Set(icons).size, OUTPUT_KINDS.length, '종류마다 아이콘이 다르다');
  for (const icon of icons) assert.match(icon, /^<svg [^>]*aria-hidden="true"/);
  assert.equal(outputIcon('lecture', { video: false }), outputIcon('voice'), '영상 없는 강의 결과는 음성으로 그린다');
});
