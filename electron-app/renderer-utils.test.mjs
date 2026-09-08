import test from "node:test";
import assert from "node:assert/strict";

import {
  buildChapterRanges,
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
    title: "재생성 권장 1곳 · 확인 권장 1곳",
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
