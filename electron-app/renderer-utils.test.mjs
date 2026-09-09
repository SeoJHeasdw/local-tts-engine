import test from "node:test";
import assert from "node:assert/strict";

import {
  buildChapterRanges,
  findingExcerpt,
  findingSeek,
  compactOutputLabel,
  outputGroupTitle,
  splitOutputTitle,
  groupOutputs,
  outputGroupKey,
  outputState,
  outputUnitLabel,
  chapterEtaLabel,
  etaLabel,
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
} from "./renderer/view-utils.mjs";

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
  const {createViewHistory} = await import('./renderer/view-utils.mjs');
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

test("레슨 단위 진행은 여러 편일 때만 표시한다", () => {
  assert.equal(unitLabel({ index: 3, total: 9 }), "레슨 3/9");
  assert.equal(unitLabel({ index: 1, total: 1 }), "");
  assert.equal(unitLabel({}), "");
});

test("챕터 남은 시간은 편 개수가 아니라 페이지로 잰다", () => {
  // 실측 CH02: 103페이지를 91분에 처리했고 남은 분량은 66페이지였다.
  // 편 개수로 나누면(8편 91분 → 11.4분/편 × 8편) 90분이 나와 크게 빗나간다.
  const label = chapterEtaLabel({
    completedPages: 103,
    completedMs: 91 * 60_000,
    currentPages: 11,
    currentElapsedMs: 4 * 60_000,
    pendingPages: 55,
  });
  assert.equal(label, "전체 약 54분 남음");
});

test("진행 중인 편이 예상보다 길어져도 남은 시간이 음수로 돌지 않는다", () => {
  const label = chapterEtaLabel({
    completedPages: 100,
    completedMs: 100 * 60_000,
    currentPages: 5,
    currentElapsedMs: 60 * 60_000,
    pendingPages: 10,
  });
  assert.equal(label, "전체 약 10분 남음");
});

test("아직 한 편도 못 끝냈으면 챕터 남은 시간을 지어내지 않는다", () => {
  assert.equal(chapterEtaLabel({ completedPages: 0, completedMs: 0, currentPages: 8, pendingPages: 60 }), "");
  assert.equal(chapterEtaLabel({}), "");
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
});

test("레슨 편 이름을 짧은 표로 읽는다", () => {
  assert.equal(outputUnitLabel({ name: "studio-1-ch02-lessons-ch02-l07" }), "L07");
  assert.equal(outputUnitLabel({ name: "studio-2-ch01-full" }), null);
  assert.equal(outputGroupKey({ name: "studio-1-ch02-lessons-ch02-l07" }), "studio-1-ch02-lessons");
});

test("묶음 안의 행은 챕터를 되풀이하지 않고 편만 적는다", () => {
  // displayName 이 이미 "CH02 L04 · 제목"이라, 편 표시를 앞에 덧붙이면
  // "L04 CH02 L04 · 제목"이 된다.
  const item = { name: "studio-1-ch02-lessons-ch02-l04", displayName: "CH02 L04 · 그래서 어떻게 만들라는 건가" };
  assert.equal(compactOutputLabel(item), "L04 · 그래서 어떻게 만들라는 건가");
});

test("묶음 제목은 챕터까지만 적는다", () => {
  const group = {
    key: "studio-1-ch02-lessons",
    items: [{ name: "studio-1-ch02-lessons-ch02-l01", displayName: "CH02 L01 · Agent Loop" }],
  };
  assert.equal(outputGroupTitle(group), "CH02");
});

test("편에 속하지 않는 결과는 이름을 그대로 쓴다", () => {
  const single = { name: "studio-2-ch01-full", displayName: "CH01 전체" };
  assert.equal(compactOutputLabel(single), "CH01 전체");
  assert.deepEqual(splitOutputTitle("CH01 전체", ""), { scope: "", unit: "", title: "CH01 전체" });
  // 제목 없이 편 표시만 있는 경우도 깨지지 않는다.
  assert.equal(compactOutputLabel({ name: "j-ch02-lessons-ch02-l07", displayName: "CH02 L07" }), "L07");
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
