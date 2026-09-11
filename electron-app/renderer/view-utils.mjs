import { omissionEvidence, textWords } from "../shared/transcript-evidence.mjs";
export { findingStatus } from '../shared/transcript-evidence.mjs';

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
    const matchesQuery = !needle || [item.fileName, item.displayName, item.name, item.operation, item.root]
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
  const omissions = omissionEvidence(finding);
  if (omissions.length) return `받아쓰기에서 구절 누락: ${omissions.map(check => `“${check.text}”`).join(', ')}`;
  // 지정한 발음과 다르게 들린 항목은 무엇으로 들렸는지가 확인의 전부다.
  const terms = (finding.terms || [])
    .map((item) => (item.heard ? `${item.term} → ${item.heard}로 들림` : item.term))
    .filter(Boolean);
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
  if (failed.length) parts.push(`재생성 필요 ${failed.length}곳`);
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

export function completionFindings(report = {}) {
  if (report.units?.length > 1) return report.units.flatMap(unit => (unit.voiceFindings || []).map(finding => ({
    ...finding, target: unit.target, displayName: unit.displayName || unit.name,
  })));
  return report.voiceFindings || [];
}

export function completionSummary(report, durationLabel) {
  const units = report.units?.length || 1;
  const failed = report.failedUnits?.length || 0;
  if (failed && !report.units?.length) return `${failed}개 레슨 제작 실패 · 완성된 영상 없음`;
  const count = summarizeVoiceFindings(completionFindings(report));
  const files = failed ? '완성 영상 파일 검사 통과' : report.summary?.ok ? '파일 검사 통과' : '파일 검사 실패';
  const voice = count.total ? count.title
    : report.voiceQuality?.clean === true ? '목소리 검수 통과'
      : report.voiceQuality ? '목소리 검수 결과 확인 필요' : '목소리 검수 기록 없음';
  const prefix = failed ? `${report.totalUnits || units + failed}개 레슨 중 ${units}개 완료 · ${failed}개 실패 · `
    : units > 1 ? `${units}개 영상 · ` : '';
  return `${prefix}${durationLabel}${units > 1 ? ' 합계' : ''} · ${files} · ${voice}`;
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
// 5초마다 '약 12분'이 '약 11분'으로 바뀌는 시계는 멈춰 있는 것처럼 보인다.
// 1초마다 한 자리씩 줄어드는 시계라야 얼마나 남았는지가 눈으로 읽히고, 자리를
// 떠도 되는지 판단이 선다. 값 자체는 여전히 추정이라 초를 올림하지 않고
// 내림해 둔다 — 12:00에서 11:59로 내려가야 줄어드는 것으로 보인다.
export function formatCountdown(ms) {
  const seconds = Math.max(0, Math.floor(Number(ms) / 1000));
  if (!Number.isFinite(seconds)) return "";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`;
}

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
// 레슨 번호는 정수만이 아니다. 사이에 끼워 넣은 편은 덱에서 L01.5 로 불리고
// 폴더 이름에는 `ch03-l01-5` 로 적힌다. 정수만 받으면 그 편만 챕터 묶음에서
// 떨어져 나와 홀로 선다.
const LESSON_UNIT_PATTERN = /^(.+)-(ch\d+)-(l\d+(?:-\d+)*)$/;

export function outputGroupKey(item = {}) {
  const match = LESSON_UNIT_PATTERN.exec(String(item.name || ""));
  return match ? match[1] : null;
}

export function outputUnitLabel(item = {}) {
  const match = LESSON_UNIT_PATTERN.exec(String(item.name || ""));
  return match ? match[3].replace(/-/g, ".").toUpperCase() : null;
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

// 한 레슨의 결과가 원본 하나로 끝나지 않는다. 고친 판이 쌓이면 어느 파일이
// 지금 쓸 것인지는 이름만 봐서는 알 수 없어, 사람이 따로 목록을 적어 두게 된다.
// 수정본은 자기가 어느 영상에서 나왔는지 적고 있으므로 그 줄기를 읽어 준다.
export function outputVersionLinks(items = []) {
  const byPath = new Map(items.filter((item) => item.path).map((item) => [String(item.path), item]));
  const links = new Map();
  for (const item of items) {
    for (const source of item.sources || []) {
      const origin = byPath.get(String(source));
      if (!origin || origin === item) continue;
      const list = links.get(origin.key) || [];
      list.push(item);
      links.set(origin.key, list);
    }
  }
  for (const list of links.values()) {
    list.sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
  }
  return links;
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
  // 한 편만 남은 묶음은 묶음이 아니다. 머리글과 상태 배지를 두 줄 더 쓰면서
  // 말하는 것이 그 한 줄과 같다.
  for (const [index, row] of rows.entries()) {
    if (row.type === "group" && row.items.length === 1) rows[index] = { type: "single", item: row.items[0] };
  }
  for (const group of groups.values()) {
    group.items.sort((left, right) => String(left.name).localeCompare(String(right.name)));
    group.attention = group.items.filter((item) => outputState(item, findingsOf(item)).key !== "ready"
      && outputState(item, findingsOf(item)).key !== "approved").length;
    group.findings = group.items.reduce((total, item) => total + findingsOf(item).length, 0);
  }
  return rows;
}

// 묶음 머리글에는 챕터만 적는다. displayName 이 "CH02 L04 · 제목"처럼 스스로를
// 다 말하므로 편 표시 앞까지가 곧 챕터다.
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

// 목록에 적히는 이름은 Finder 에서 보게 될 이름과 같아야 한다. 같은 이름이 이미
// 있으면 발행이 "(2)"를 붙이므로 제목에서 되짚어 만든 이름은 실제 파일과 어긋난다.
// 묶음 안이라고 앞부분을 덜어 내지도 않는다. 그 줄에서 바로 고쳐 쓸 이름이자
// Finder 에서 찾을 이름이므로 확장자까지 그대로 적는다.
export function outputRowTitle(item = {}) {
  return String(item.fileName || item.displayName || item.name || "");
}

export function outputGroupTitle(group = {}) {
  const first = group.items?.[0];
  const { scope } = splitOutputTitle(first?.displayName, outputUnitLabel(first || {}));
  return scope || group.key || "";
}

// 확인 항목이 알려 줘야 하는 것은 대본 전체가 아니라 어느 낱말을 귀 기울여
// 들어야 하는지다. 걸린 낱말만 뽑고, 그 낱말이 놓인 자리를 짧게 보여 준다.
function findingTerms(finding = {}) {
  return (finding.terms || []).map((item) => String(item?.term || "")).filter(Boolean);
}

export function findingExcerpt(finding = {}, radius = 16) {
  const text = String(finding.expectedText || "");
  const omission = omissionEvidence(finding)[0];
  const term = omission?.text || findingTerms(finding)[0];
  if (!text) return null;
  const index = omission ? omission.expectedStart : term ? text.indexOf(term) : -1;
  if (index === -1) {
    return { before: "", term: "", after: text.length > radius * 3 ? `${text.slice(0, radius * 3)}…` : text };
  }
  const from = Math.max(0, index - radius);
  const to = Math.min(text.length, index + term.length + radius);
  return {
    before: `${from > 0 ? "…" : ""}${text.slice(from, index)}`,
    term,
    after: `${text.slice(index + term.length, to)}${to < text.length ? "…" : ""}`,
  };
}

/**
 * Where to move the playhead for a finding.
 *
 * The finding's own span is the whole chunk, so seeking to it lands at the top
 * of a paragraph and leaves the listener hunting for the word again. When the
 * page carries word timings, the flagged word's own time is used, with a short
 * run-up so the word arrives in context rather than mid-syllable.
 */
export function findingSeek(finding = {}, page = null, leadInMs = 700, tailMs = 500) {
  const fallback = { startMs: Number(finding.startMs) || 0, endMs: Number(finding.endMs) || 0 };
  const words = (page?.words || []).filter(w => Number(w.startMs) >= fallback.startMs && Number(w.endMs) <= fallback.endMs);
  const omission = omissionEvidence(finding)[0];
  if (omission && words.length) {
    // The absent words can have zero-duration forced alignments. Locate the
    // containing sentence in script order and play its context, never pretend
    // those forced timestamps prove the missing words were spoken.
    const text = String(finding.expectedText);
    const stops = [0, ...[...text.matchAll(/[.!?。！？]\s+/g)].map(m => m.index + m[0].length), text.length];
    const start = Math.max(...stops.filter(p => p <= omission.expectedStart));
    const end = Math.min(...stops.filter(p => p >= omission.expectedEnd));
    const needle = textWords(text.slice(start, end));
    const hay = words.flatMap(word => textWords(word.text).map(token => ({...token, word})));
    const hits = [];
    for (let i = 0; i + needle.length <= hay.length; i++)
      if (needle.length && needle.every((token, n) => token.key === hay[i+n].key)) hits.push(i);
    if (hits.length !== 1) return fallback;
    const from = hay[hits[0]].word, to = hay[hits[0] + needle.length - 1].word;
    if (!(Number(to.endMs) > Number(from.startMs))) return fallback;
    return {startMs: Math.max(fallback.startMs, Number(from.startMs) - leadInMs),
      endMs: Math.min(fallback.endMs, Number(to.endMs) + tailMs), word: omission.text, basis: 'sentence-context'};
  }
  const terms = findingTerms(finding);
  if (!words.length || !terms.length) return fallback;
  const hits = words.filter((word) => terms.some((term) => term && String(word.text || "").includes(term)));
  const alternatives = hits.length ? hits : words.filter((word) => terms.some((term) => term && term.includes(String(word.text || "")) && String(word.text || "").length > 1));
  const hit = alternatives.length === 1 ? alternatives[0] : null;
  if (!hit) return fallback;
  return {
    startMs: Math.max(Number(page.startMs) || 0, Number(hit.startMs) - leadInMs),
    endMs: Math.min(Number(page.endMs) || Number(hit.endMs) + tailMs, Number(hit.endMs) + tailMs),
    word: String(hit.text || ""),
  };
}
