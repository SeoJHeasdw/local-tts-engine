export function buildChapterRanges(pages = []) {
  const chapters = new Map();
  for (const page of pages) {
    const id = String(page?.chapter || "").toLowerCase();
    const pageNumber = Number(page?.page);
    if (!id || !Number.isInteger(pageNumber)) continue;
    const current = chapters.get(id) || {
      id,
      start: pageNumber,
      end: pageNumber,
      pageCount: 0,
      stepCount: 0,
    };
    current.start = Math.min(current.start, pageNumber);
    current.end = Math.max(current.end, pageNumber);
    current.pageCount += 1;
    current.stepCount += Math.max(0, Number(page?.stepCount || 0));
    chapters.set(id, current);
  }
  return [...chapters.values()].sort((a, b) => a.start - b.start);
}

export function summarizePageRange(pages = [], startPage = 1, endPage = startPage) {
  const start = Math.max(1, Math.round(Number(startPage) || 1));
  const end = Math.max(start, Math.round(Number(endPage) || start));
  const selected = pages.filter((page) => Number(page?.page) >= start && Number(page?.page) <= end);
  const chapters = [...new Set(selected.map((page) => String(page.chapter || "").toUpperCase()).filter(Boolean))];
  return {
    start,
    end,
    pageCount: selected.length,
    stepCount: selected.reduce((total, page) => total + Math.max(0, Number(page.stepCount || 0)), 0),
    chapterLabel: chapters.length === 0
      ? "범위 확인"
      : chapters.length === 1
        ? chapters[0]
        : `${chapters[0]}–${chapters.at(-1)}`,
  };
}

export function outputKind(item = {}) {
  if (item.root === "edit") return "edit";
  if (item.root === "voice") return "voice";
  return "lecture";
}

export function filterOutputItems(items = [], query = "", filter = "all") {
  const needle = String(query || "").trim().toLocaleLowerCase("ko-KR");
  return items.filter((item) => {
    const matchesQuery = !needle || [item.displayName, item.name, item.operation, item.root]
      .some((value) => String(value || "").toLocaleLowerCase("ko-KR").includes(needle));
    if (!matchesQuery) return false;
    if (filter === "pending") return item.review?.status !== "approved";
    if (["lecture", "voice", "edit"].includes(filter)) return outputKind(item) === filter;
    return true;
  });
}
