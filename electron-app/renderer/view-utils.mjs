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

export function shouldOpenMenuUpward(availableBelow, popoverHeight, margin = 10) {
  return Number(availableBelow) < Number(popoverHeight) + Number(margin);
}

export function formatVoiceTimestamp(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

export function voiceFindingLabel(finding = {}) {
  return `${formatVoiceTimestamp(finding.startMs)}–${formatVoiceTimestamp(finding.endMs)}`;
}

export function voiceFindingReason(finding = {}) {
  const terms = (finding.terms || []).map((item) => item.term).filter(Boolean);
  const reasons = (finding.reasons || []).filter(Boolean);
  const base = reasons.join(", ") || "자동 음성 검수 점수 미달";
  return terms.length ? `${base} · ${terms.join(", ")}` : base;
}

// A page that never read correctly across every seed is work for a person; a
// page read imperfectly once is a suggestion to listen. Saying which is which
// is the difference between a queue of chores and a glance.
export function summarizeVoiceFindings(findings = []) {
  const failed = findings.filter((finding) => finding.severity !== "warning");
  const warned = findings.filter((finding) => finding.severity === "warning");
  if (!findings.length) return { total: 0, failed: 0, warned: 0, title: "", tone: "ok" };
  const parts = [];
  if (failed.length) parts.push(`재생성 권장 ${failed.length}곳`);
  if (warned.length) parts.push(`확인 권장 ${warned.length}곳`);
  return {
    total: findings.length,
    failed: failed.length,
    warned: warned.length,
    title: parts.join(" · "),
    tone: failed.length ? "failed" : "warning",
  };
}

export function voiceFindingSummaryLine(findings = []) {
  const summary = summarizeVoiceFindings(findings);
  if (!summary.total) return "";
  const first = findings[0];
  return `${voiceFindingLabel(first)} · ${first.slideNumber}페이지${summary.total > 1 ? ` 외 ${summary.total - 1}곳` : ""}`;
}
