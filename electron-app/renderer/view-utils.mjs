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

export function createViewHistory(initial = 'new') {
  let items = [initial], index = 0;
  return {
    get current() { return items[index]; },
    get canBack() { return index > 0; },
    get canForward() { return index < items.length - 1; },
    visit(view) {
      if (view === items[index]) return view;
      items = [...items.slice(0, index + 1), view].slice(-100);
      index = items.length - 1;
      return view;
    },
    back() { if (index > 0) index--; return items[index]; },
    forward() { if (index < items.length - 1) index++; return items[index]; },
  };
}

// 남은 시간은 지금까지의 속도로만 낸다. 청크마다 재시도 횟수가 달라 실제
// 소요가 들쭉날쭉하므로, 앞으로를 예측하지 않고 여태 걸린 만큼이 이어진다고
// 본다. 그래서 '약'이라고 적고 분 단위로만 말한다.
export function formatRemaining(ms) {
  const seconds = Math.round(Number(ms) / 1000);
  if (!(seconds > 0)) return "";
  if (seconds < 60) return "1분 미만";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}시간 ${rest}분` : `${hours}시간`;
}

// scope "unit" 은 옆에 전체 시계가 함께 설 때 쓴다. 둘 다 "남음"으로 끝나면
// 어느 쪽이 무엇의 남은 시간인지 읽는 데 한 박자가 더 든다.
export function etaLabel({ done, total, elapsedMs, baseline = 0, scope = "job" } = {}) {
  const completed = Number(done) - Number(baseline);
  const remaining = Number(total) - Number(done);
  if (!(Number(total) > 0) || !(completed > 0) || !(Number(elapsedMs) > 0)) return "";
  if (remaining <= 0) return scope === "unit" ? "이 편 곧 완료" : "곧 완료";
  const label = formatRemaining((Number(elapsedMs) / completed) * remaining);
  if (!label) return "";
  return scope === "unit" ? `이 편 약 ${label}` : `약 ${label} 남음`;
}

// 챕터를 레슨으로 나눠 만들 때, 전체 중 몇 번째인지가 남은 시간보다 먼저
// 궁금하다. 한 편짜리 작업에서는 표시할 것이 없다.
export function unitLabel({ index, total } = {}) {
  if (!(Number(total) > 1)) return "";
  return `레슨 ${Number(index)}/${Number(total)}`;
}

// 챕터를 레슨으로 나눠 만들 때만 필요한 두 번째 시계. 편 개수로 나누면
// 남은 편들이 가벼운지 무거운지를 반영하지 못한다. CH02 실측에서 편 평균으로는
// 90분, 페이지 가중으로는 54분이 나왔고 실제는 뒤쪽이었다. 그래서 페이지를
// 단위로 잡는다.
export function chapterEtaLabel({
  completedPages,
  completedMs,
  currentPages = 0,
  currentElapsedMs = 0,
  pendingPages = 0,
} = {}) {
  if (!(Number(completedPages) > 0) || !(Number(completedMs) > 0)) return "";
  const perPage = Number(completedMs) / Number(completedPages);
  // 진행 중인 편은 예상치에서 이미 지난 만큼을 뺀다. 예상보다 오래 걸리는
  // 중이면 0으로 바닥을 치고, 남은 편들의 몫만 남는다.
  const currentRemaining = Math.max(0, perPage * Number(currentPages) - Number(currentElapsedMs));
  const label = formatRemaining(currentRemaining + perPage * Number(pendingPages));
  return label ? `전체 약 ${label} 남음` : "";
}

// 확인 완료로 내린 항목은 다듬기에서만이 아니라 최근 결과에서도 사라져야 한다.
// 한 화면에서는 처리했는데 다른 화면에는 그대로 남으면, 그 버튼이 무엇을 한
// 것인지 알 수 없다.
export function findingKeyOf(finding = {}) {
  return `${finding.slideNumber ?? ""}:${finding.startMs ?? ""}`;
}

export function visibleVoiceFindings(findings = [], clearedKeys = []) {
  if (!clearedKeys?.length) return findings || [];
  const cleared = new Set(clearedKeys.map(String));
  return (findings || []).filter((finding) => !cleared.has(findingKeyOf(finding)));
}

// 한 챕터를 레슨으로 나눠 만들면 결과가 열여섯 줄로 평평하게 늘어선다. 그중
// 어디에 아직 할 일이 남았는지는 열여섯 줄을 눈으로 세어야 알 수 있었다.
// 이름이 이미 소속을 담고 있으므로(<작업>-ch02-l03) 그것으로 묶는다.
const LESSON_UNIT_PATTERN = /^(.+)-(ch\d+-l\d+)$/;

export function outputGroupKey(item = {}) {
  const match = LESSON_UNIT_PATTERN.exec(String(item.name || ""));
  return match ? match[1] : null;
}

export function outputUnitLabel(item = {}) {
  const match = LESSON_UNIT_PATTERN.exec(String(item.name || ""));
  return match ? match[2].split("-").at(-1).toUpperCase() : null;
}

/**
 * State a result in one word, so a list can be read rather than decoded.
 *
 * Three separate badges — file check, voice findings, listening approval — meant
 * holding all three in your head to know whether anything was left to do. They
 * are not independent: a failed file check makes the rest moot, and something
 * still flagged is work regardless of whether it was listened to.
 */
export function outputState(item = {}, findings = []) {
  if (item.ok === false) return { key: "failed", label: "검증 실패", tone: "failed" };
  if (findings.length) {
    return { key: "attention", label: `확인 ${findings.length}곳`, tone: "attention" };
  }
  if (item.review?.status === "approved") return { key: "approved", label: "청취 승인", tone: "approved" };
  return { key: "ready", label: "확인할 곳 없음", tone: "ready" };
}

export function groupOutputs(items = [], findingsOf = () => []) {
  const groups = new Map();
  const rows = [];
  for (const item of items) {
    const key = outputGroupKey(item);
    if (!key) { rows.push({ type: "single", item }); continue; }
    if (!groups.has(key)) {
      const group = { type: "group", key, items: [], updatedAt: item.updatedAt };
      groups.set(key, group);
      rows.push(group);
    }
    const group = groups.get(key);
    group.items.push(item);
    if (String(item.updatedAt || "") > String(group.updatedAt || "")) group.updatedAt = item.updatedAt;
  }
  for (const group of groups.values()) {
    group.items.sort((left, right) => String(left.name).localeCompare(String(right.name)));
    group.attention = group.items.filter((item) => outputState(item, findingsOf(item)).key !== "ready"
      && outputState(item, findingsOf(item)).key !== "approved").length;
    group.findings = group.items.reduce((total, item) => total + findingsOf(item).length, 0);
  }
  return rows;
}

// displayName 은 이미 "CH02 L04 · 그래서 어떻게 만들라는 건가" 처럼 스스로를
// 다 말한다. 묶음 머리가 챕터를 적고 나면 행에서 챕터는 되풀이일 뿐이고, 편
// 표시를 앞에 덧붙이면 L04 가 두 번 나온다. 한 번만 나누고 필요한 조각만 쓴다.
export function splitOutputTitle(displayName = "", unitLabel = "") {
  const text = String(displayName || "").trim();
  const unit = String(unitLabel || "");
  const index = unit ? text.indexOf(unit) : -1;
  if (index === -1) return { scope: "", unit: "", title: text };
  return {
    scope: text.slice(0, index).trim(),
    unit,
    title: text.slice(index + unit.length).replace(/^\s*·\s*/, "").trim(),
  };
}

export function compactOutputLabel(item = {}) {
  const unit = outputUnitLabel(item);
  const { unit: found, title } = splitOutputTitle(item.displayName, unit);
  if (!found) return item.displayName || item.name || "";
  return title ? `${found} · ${title}` : found;
}

export function outputGroupTitle(group = {}) {
  const first = group.items?.[0];
  const { scope } = splitOutputTitle(first?.displayName, outputUnitLabel(first || {}));
  return scope || group.key || "";
}
