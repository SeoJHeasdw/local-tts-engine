import test from "node:test";
import assert from "node:assert/strict";

import {
  buildChapterRanges,
  filterOutputItems,
  outputKind,
  summarizePageRange,
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
