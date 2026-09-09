import { animateLayout, transitionPage, dismissToast, appendFollowingLog } from "./motion.mjs";
import {
  buildChapterRanges,
  chapterEtaLabel,
  createViewHistory,
  findingKeyOf,
  groupOutputs,
  etaLabel,
  filterOutputItems,
  outputKind,
  shouldOpenMenuUpward,
  summarizePageRange,
  summarizeVoiceFindings,
  unitLabel,
  voiceFindingLabel,
  voiceFindingReason,
  compactOutputLabel,
  outputGroupTitle,
  outputState,
  visibleVoiceFindings,
  voiceFindingSummaryLine,
} from "./view-utils.mjs";

const api = window.ttsStudio;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const stageNames = {
  starting: "준비 중",
  snapshot: "촬영 화면 고정 중",
  voice: "목소리 생성 중",
  export: "영상 자료 연결 중",
  captions: "자막 생성 중",
  capture: "화면 촬영 중",
  verify: "최종 결과 검증 중",
};
const orderedStages = ["voice", "captions", "capture", "verify"];
let productionMode = "lesson";
let chapterMode = "single";
let catalogPages = [];
let catalogLessons = [];
let totalPages = 715;
let latestTarget = null;
let latestEditTarget = null;
let voiceVideo = null;
let appSettings = null;
let voiceCandidates = [];
let selectedCandidateToken = null;
let candidatePurpose = "edit";
let catalogChapters = [];
let outputItems = [];
let outputFilter = "all";
let creationState = "idle";

function showToast(message, kind = "success") {
  const toast = document.createElement("div");
  toast.className = `toast ${kind}`;
  toast.innerHTML = "<span></span><div></div>";
  toast.querySelector("span").textContent = kind === "error" ? "!" : "✓";
  toast.querySelector("div").textContent = message;
  $("#toast-stack").append(toast);
  setTimeout(() => dismissToast(toast), 3600);
}

function setIconStatus(selector, label, tone = "idle") {
  const indicator = $(selector);
  if (!indicator) return;
  indicator.dataset.tooltip = label;
  indicator.setAttribute("aria-label", label);
  indicator.classList.toggle("running", tone === "running");
  indicator.classList.toggle("failed", tone === "failed");
  indicator.classList.toggle("complete", tone === "complete");
  const hiddenLabel = indicator.querySelector(".sr-only");
  if (hiddenLabel) hiddenLabel.textContent = label;
}

function dateStamp(date = new Date()) {
  const two = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

function suggestedName() {
  const start = Number($("#start-page")?.value || 1);
  const lesson = selectedLesson();
  const chapter = selectedChapter();
  const suffix = productionMode === "lesson" && lesson
    ? lesson.id
    : productionMode === "chapter" && chapter
    ? `${chapter.id}-${chapterMode === "lesson" ? "lessons" : "full"}`
    : productionMode === "page"
    ? `p${start}-p${Number($("#end-page")?.value || start)}`
    : "course";
  return `studio-${dateStamp()}-${suffix}`;
}

function suggestedTextVoiceName() {
  return `voice-${dateStamp()}`;
}

function pageMeta(pageNumber) {
  const page = catalogPages[Number(pageNumber) - 1];
  if (!page) return "페이지 범위를 확인해 주세요";
  return `${page.chapter.toUpperCase()} · ${page.slideId} · ${page.firstStep}~${page.lastStep}스텝`;
}

function selectedLesson() {
  return catalogLessons.find((lesson) => lesson.id === $("#lesson-select")?.value) || catalogLessons[0] || null;
}

function selectedChapter() {
  return catalogChapters.find((chapter) => chapter.id === $("#chapter-select")?.value) || catalogChapters[0] || null;
}

function populateLessons() {
  const select = $("#lesson-select");
  select.replaceChildren(...catalogLessons.map((lesson) => {
    const option = document.createElement("option");
    option.value = lesson.id;
    option.textContent = lesson.title;
    return option;
  }));
  if (catalogLessons.length) select.value = catalogLessons[0].id;
  if (catalogLessons.length) applySelectedLesson();
  else setProductionMode("page");
}

function applySelectedLesson() {
  const lesson = selectedLesson();
  if (!lesson) {
    $("#lesson-title").textContent = "등록된 레슨이 없습니다.";
    $("#lesson-meta").textContent = "페이지 직접 선택을 사용해 주세요.";
    return;
  }
  $("#start-page").value = String(lesson.startPage);
  $("#end-page").value = String(lesson.endPage);
  $("#lesson-title").textContent = lesson.title;
  $("#lesson-meta").textContent = `${lesson.pageCount}페이지 · ${lesson.stepCount}스텝`;
  updatePageScope();
}

function populateChapters() {
  catalogChapters = buildChapterRanges(catalogPages);
  const select = $("#chapter-select");
  select.replaceChildren(...catalogChapters.map((chapter) => {
    const option = document.createElement("option");
    option.value = chapter.id;
    option.textContent = `${chapter.id.toUpperCase()} · ${chapter.start}–${chapter.end}페이지 · ${chapter.stepCount}스텝`;
    return option;
  }));
  if (catalogChapters.length) {
    select.value = catalogChapters[0].id;
    applySelectedChapter();
  }
}

function chapterLessons(chapter) {
  return catalogLessons.filter((lesson) => lesson.chapter === chapter?.id);
}

function applySelectedChapter() {
  const chapter = selectedChapter();
  if (!chapter) {
    $("#chapter-title").textContent = "등록된 챕터가 없습니다.";
    $("#chapter-meta").textContent = "페이지 직접 선택을 사용해 주세요.";
    return;
  }
  const lessons = chapterLessons(chapter);
  $("#start-page").value = String(chapter.start);
  $("#end-page").value = String(chapter.end);
  $("#chapter-title").textContent = `${chapter.id.toUpperCase()} 전체`;
  $("#chapter-meta").textContent = `${chapter.pageCount}페이지 · ${chapter.stepCount}스텝`;
  $("#chapter-mode-meta").textContent = chapterMode === "lesson"
    ? lessons.length > 1
      ? `${lessons.length}개 레슨 영상으로 나눠 만듭니다.`
      : "레슨 경계가 없어 챕터 전체를 한 단위로 만듭니다."
    : "챕터 전체를 하나의 영상으로 만듭니다.";
  updatePageScope();
}

function moveToPage(pageNumber) {
  const next = Math.min(totalPages, Math.max(1, Math.round(Number(pageNumber) || 1)));
  $("#start-page").value = String(next);
  if (Number($("#end-page").value) < next) $("#end-page").value = String(next);
  updatePageScope();
}

function updateCourseNavigator(start, end) {
  $("#previous-page").disabled = start <= 1;
  $("#next-page").disabled = start >= totalPages;
  const summary = summarizePageRange(catalogPages, start, end);
  $("#scope-chapter-stat").textContent = summary.chapterLabel;
  $("#scope-page-stat").textContent = `${summary.pageCount}페이지`;
  $("#scope-step-stat").textContent = `${summary.stepCount}스텝`;
}

function fileName(value) {
  return String(value || "").split("/").filter(Boolean).at(-1) || "경로 미설정";
}

function voiceProfileLabel() {
  if (appSettings?.modelId === "chatterbox-v3") return "실험 목소리";
  if (appSettings?.adapterId === "none") return "기본 복제 목소리";
  const adapter = appSettings?.adapters?.find((item) => item.id === appSettings.adapterId);
  const approved = adapter?.label === "jaeho-ko-r16-v1" && Math.abs(Number(appSettings?.adapterScale || 0.6) - 0.6) < 0.001;
  return approved ? "내 목소리 · 승인됨" : "내 목소리 · 실험 설정";
}

function updateProductionBrief() {
  const deliverable = $("#deliverable")?.value || "video";
  const labels = {
    video: ["완성 영상", $("#burn-captions")?.checked ? "자막 포함" : "자막 없음"],
    captions: ["음성과 자막", "영상은 만들지 않음"],
    audio: ["음성만", "영상은 만들지 않음"],
  };
  $("#advanced-output-summary").textContent = `${labels[deliverable][0]}${deliverable === "video" && $("#burn-captions")?.checked ? " · 자막 포함" : ""}`;
}

function textBreathLines(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
}

function updateVoiceDesign() {
  const text = $("#text-voice-input")?.value || "";
  const lines = textBreathLines(text);
  const candidateCount = Math.min(8, Math.max(2, Number($("#text-voice-count")?.value || 3)));
  const foreignTerms = [...new Set(text.match(/[A-Za-z][A-Za-z0-9.-]*/g) || [])];
  $("#voice-design-profile").textContent = voiceProfileLabel();
  $("#voice-generation-plan").textContent = `후보 ${candidateCount}개`;
  $("#voice-breath-summary").textContent = lines.length > 1 ? `${lines.length}개 호흡` : "줄바꿈 없음";
  $("#voice-term-summary").textContent = foreignTerms.length ? `영문 용어 ${foreignTerms.length}개` : "영문 용어 없음";
  if (!lines.length) {
    $("#voice-design-advice").textContent = "문장을 입력하면 읽기 편한 구조인지 확인해 드립니다.";
    return;
  }
  $("#voice-design-advice").textContent = lines.length === 1 && text.length > 45
    ? "문장이 깁니다. 자연스럽게 쉬고 싶은 지점에서 줄을 나눠 주세요."
    : foreignTerms.length
      ? "영문 용어는 후보를 들어보고 발음을 확인해 주세요."
      : lines.length > 1 ? "줄바꿈을 쉼의 기준으로 유지합니다." : "읽기 좋은 길이입니다.";
}

function updatePageScope() {
  const start = Math.max(1, Number($("#start-page").value || 1));
  const end = Math.max(start, Number($("#end-page").value || start));
  $("#start-page-meta").textContent = pageMeta(start);
  $("#end-page-meta").textContent = `${pageMeta(end)} · 마지막 스텝까지`;
  const lesson = selectedLesson();
  const chapter = selectedChapter();
  const lessons = chapterLessons(chapter);
  $("#scope-explanation").textContent = productionMode === "lesson" && lesson
    ? `${lesson.title} 전체를 만듭니다.`
    : productionMode === "chapter" && chapter
      ? chapterMode === "lesson"
        ? `${chapter.id.toUpperCase()} 전체를 ${lessons.length > 1 ? `${lessons.length}개 레슨 영상으로 나눠` : "한 편으로"} 만듭니다.`
        : `${chapter.id.toUpperCase()} 전체를 하나의 영상으로 만듭니다.`
      : `${start}페이지부터 ${end}페이지까지 만듭니다.`;
  $("#time-note").textContent = productionMode === "chapter" && chapterMode === "lesson" && lessons.length > 1
    ? "레슨별 결과를 각각 저장한 뒤 최근 결과에서 확인할 수 있습니다."
    : "완료되면 결과를 바로 열어 확인할 수 있습니다.";
  $("#job-name").value = suggestedName();
  updateCourseNavigator(start, end);
  updateProductionBrief();
}

function setProductionMode(mode) {
  return animateLayout($(".scope-field"), () => {
    productionMode = ["lesson", "page", "chapter"].includes(mode) ? mode : "lesson";
    $$("#mode-options button").forEach((button) => button.classList.toggle("selected", button.dataset.mode === productionMode));
    $("#lesson-panel").classList.toggle("hidden", productionMode !== "lesson");
    $("#chapter-panel").classList.toggle("hidden", productionMode !== "chapter");
    $("#manual-scope").classList.toggle("hidden", productionMode !== "page");
    if (productionMode === "lesson") applySelectedLesson();
    else if (productionMode === "chapter") applySelectedChapter();
    else updatePageScope();
  });
}

function setChapterMode(mode) {
  chapterMode = mode === "lesson" ? "lesson" : "single";
  $$("#chapter-mode-options button").forEach((button) => button.classList.toggle("selected", button.dataset.chapterMode === chapterMode));
  applySelectedChapter();
}

function paintGlobalRange() {
  const input = $("#global-scale");
  const min = Number(input.min);
  const max = Number(input.max);
  const percent = ((Number(input.value) - min) / (max - min)) * 100;
  input.style.background = `linear-gradient(to right, var(--lime) 0 ${percent}%, #353a32 ${percent}%)`;
  $("#global-scale-output").textContent = Number(input.value).toFixed(2);
}

function showJobView(view) {
  $("#job-workspace").classList.toggle("job-idle", view === "idle");
  $(".progress-card").classList.toggle("hidden", view === "idle");
  $("#active-progress").classList.toggle("hidden", view !== "active");
  $("#complete-panel").classList.toggle("hidden", view !== "complete");
  $("#job-panel-title").textContent = { active: "제작 진행", complete: "검수 완료" }[view] || "제작 진행";
}

function setBusy(busy) {
  $("#start-button").disabled = busy;
  $("#job-form").querySelectorAll("input, select, .segmented button").forEach((element) => { element.disabled = busy; });
  $("#cancel-button").classList.toggle("hidden", !busy);
  $("#active-progress .spinner").classList.toggle("hidden", !busy);
  if (!busy) $$(".stage-list li").forEach(item => item.classList.remove("running"));
}

function resetCancelButton(button) {
  button.disabled = false;
  button.textContent = "작업 중지";
  button.removeAttribute("aria-busy");
}

async function requestJobCancellation(button, kind) {
  if (kind === "create" && creationState !== "running") return;
  const previousLabel = kind === "create" ? $("#current-stage").textContent : $("#edit-running-label").textContent;
  button.disabled = true;
  button.textContent = "중지 요청 중…";
  button.setAttribute("aria-busy", "true");
  if (kind === "create") {
    creationState = "cancelling";
    setJobState("중지 요청 중", "running");
    $("#current-stage").textContent = "실행 중인 작업을 종료하고 있습니다.";
  } else {
    $("#edit-running-label").textContent = "실행 중인 작업을 종료하고 있습니다.";
  }
  try {
    const accepted = await api.cancel();
    if (!accepted) {
      resetCancelButton(button);
      if (kind === "create" && creationState === "cancelling") {
        creationState = "idle";
        setBusy(false);
        setJobState("종료됨", "idle");
        $("#current-stage").textContent = "이미 종료된 작업입니다. 새로 제작할 수 있습니다.";
      }
      showToast("현재 중지할 작업이 없습니다.");
    }
  } catch (error) {
    resetCancelButton(button);
    if (kind === "create" && creationState === "cancelling") {
      creationState = "running";
      setJobState("실행 중", "running");
      $("#current-stage").textContent = previousLabel;
    }
    showToast(`중지 요청 실패: ${error.message}`, "error");
  }
}

function setJobState(text, kind = "idle") {
  const badge = $("#job-state");
  badge.textContent = text;
  badge.className = `job-state ${kind}`;
  const label = kind === "running"
    ? text
    : kind === "failed" ? "확인이 필요한 오류가 있습니다"
      : text === "완료" ? "제작과 검증이 완료됐습니다" : "새 작업을 시작할 수 있습니다";
  setIconStatus("#create-top-status", label, kind === "running" ? "running" : kind === "failed" ? "failed" : text === "완료" ? "complete" : "idle");
}

function updateStages(current, done = false) {
  const mapped = ["snapshot", "export"].includes(current) ? "voice" : current;
  const currentIndex = orderedStages.indexOf(mapped);
  $$(".stage-list li").forEach((item) => {
    const index = orderedStages.indexOf(item.dataset.stage);
    item.classList.toggle("running", !done && index === currentIndex);
    item.classList.toggle("done", done || (currentIndex >= 0 && index < currentIndex));
  });
  $("#current-stage").textContent = stageNames[current] || "처리 중";
}

function appendLog(text) {
  const log = $("#job-log");
  appendFollowingLog(log, text);
}

function formatDuration(ms) {
  if (!ms) return "길이 확인 전";
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

let reviewTarget = null;
let reviewFindings = [];
let reviewSelection = null;
let reviewMode = 'regenerate';
let regionAudio = null;
let reviewStopAt = null;
let reviewRequest = 0;
let reviewBusy = false;
let latestCompleteReview = null;
let pendingCandidateContext = null;
let reviewResumeMs = 0;
const reviewPlayer = $('#review-player');

// 고른 교체는 바로 파일로 굽지 않고 여기 모인다. 예전에는 한 곳을 고칠 때마다
// 영상 전체를 다시 굽고 새 파일을 남긴 뒤 그 파일을 처음부터 다시 열었다.
// 확인할 곳이 넷이면 그 값을 네 번 치렀다. 모아 두었다가 한 번에 적용하면
// 재인코딩도 결과 파일도 하나로 끝난다.
const pendingFixes = new Map();

function pendingFixList() {
  return Array.from(pendingFixes.values()).sort((left, right) => left.startPage - right.startPage);
}

function renderPendingFixes() {
  const fixes = pendingFixList();
  const badge = $('#polish-count');
  badge.textContent = String(fixes.length);
  badge.classList.toggle('hidden', fixes.length === 0);
  $('#polish-pending').classList.toggle('hidden', fixes.length === 0);
  $('#polish-pending-count').textContent = fixes.length ? `${fixes.length}곳 교체 대기` : '교체 대기 없음';
  $('#polish-save').disabled = reviewBusy || fixes.length === 0;
  $('#polish-pending-list').replaceChildren(...fixes.map((fix) => {
    const item = document.createElement('li');
    const label = document.createElement('strong');
    label.textContent = `${fix.startPage}페이지`;
    const detail = document.createElement('small');
    detail.textContent = fix.label;
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'polish-drop';
    drop.textContent = '취소';
    drop.setAttribute('aria-label', `${fix.startPage}페이지 교체 취소`);
    drop.addEventListener('click', () => { pendingFixes.delete(fix.startPage); renderPendingFixes(); });
    item.append(label, detail, drop);
    return item;
  }));
}

// The strip is not a mode. One lesson is a line; a chapter grows the same line
// into rows. What was produced decides, not a setting the user has to pick.
function renderPolishStrip(video) {
  const strip = $('#polish-strip');
  if (!video) { strip.classList.add('hidden'); return; }
  const findings = video.voiceFindings || [];
  const pages = video.pages || [];
  strip.classList.remove('hidden');
  $('#polish-strip-name').textContent = video.name || '';
  const facts = [
    ['페이지', String(pages.length || '—')],
    ['확인 필요', String(findings.length)],
  ];
  $('#polish-facts').replaceChildren(...facts.map(([key, value]) => {
    const span = document.createElement('span');
    const label = document.createElement('i');
    label.textContent = key;
    const strong = document.createElement('b');
    strong.textContent = value;
    span.append(label, strong);
    return span;
  }));
  const flagged = new Set(findings.map((finding) => Number(finding.slideNumber)));
  $('#polish-spark').replaceChildren(...pages.slice(0, 120).map((page) => {
    const cell = document.createElement('i');
    if (flagged.has(Number(page.number))) cell.className = 'flagged';
    return cell;
  }));
}

// Why it was flagged is the whole basis for the judgement, so it sits next to
// the video rather than behind a disclosure.
function showFindingDiff(finding) {
  const panel = $('#polish-diff');
  const expected = String(finding?.expectedText || '');
  const recognized = String(finding?.recognizedText || '');
  if (!expected && !recognized) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  $('#polish-expected').textContent = expected || '(원문 없음)';
  $('#polish-recognized').textContent = recognized || '(받아쓰기 없음)';
  const terms = (finding?.terms || []).map((term) => term.term).filter(Boolean);
  $('#polish-diff-note').textContent = terms.length
    ? `걸린 단어: ${terms.join(', ')}`
    : (finding?.reasons || []).join(' · ');
}

function queueSelectedCandidate(token, name) {
  if (!pendingCandidateContext || !token) return false;
  const startPage = Number(pendingCandidateContext.startPage);
  const endPage = Number(pendingCandidateContext.endPage ?? startPage);
  if (!Number.isFinite(startPage)) return false;
  pendingFixes.set(startPage, {
    startPage,
    endPage,
    audioToken: token,
    label: name || '고른 목소리',
  });
  pendingCandidateContext = null;
  $('#review-candidates-host').classList.add('hidden');
  // 교체를 담았다면 그 페이지는 처리된 것이므로 목록에서도 내린다.
  reviewFindings
    .filter((finding) => Number(finding.slideNumber) === startPage)
    .forEach((finding) => clearedFindings.add(findingKey(finding)));
  renderFindings();
  renderPendingFixes();
  showToast(`${startPage}페이지 교체를 대기 목록에 담았습니다. 저장할 때 한 번에 적용됩니다.`);
  return true;
}

async function savePendingFixes() {
  const fixes = pendingFixList();
  if (!voiceVideo || !fixes.length || reviewBusy) return;
  const payload = {
    operation: 'voice-pages',
    name: `polish-${Date.now()}`,
    videoToken: voiceVideo.token,
    durationPolicy: $('#voice-duration-policy').value,
    patches: fixes.map((fix) => ({ startPage: fix.startPage, endPage: fix.endPage, audioToken: fix.audioToken })),
  };
  reviewPlayer.pause();
  try { setEditBusy(true); await api.startEdit(payload); }
  catch (error) { setEditBusy(false); showToast(error.message, 'error'); }
}

$('#polish-save').addEventListener('click', savePendingFixes);
$('#polish-discard').addEventListener('click', () => { pendingFixes.clear(); renderPendingFixes(); });


function renderCompleteVoiceFindings(findings = [], target = null) {
  latestCompleteReview = target;
  const summary = summarizeVoiceFindings(findings);
  $('#voice-quality-panel').classList.toggle('hidden', summary.total === 0);
  $('#voice-quality-panel').dataset.tone = summary.tone;
  $('#voice-quality-title').textContent = summary.title;
  $('#review-latest').classList.toggle('hidden', !target);
  $('#voice-quality-list').classList.toggle('hidden', Boolean(target));
  $('#voice-quality-list').replaceChildren(...(target ? [] : findings.map(finding => {
    const item = document.createElement('li'); item.textContent = `${voiceFindingLabel(finding)} · ${finding.slideNumber}페이지 · ${voiceFindingReason(finding)}`; return item;
  })));
}

// 목록에 남아 있는 것이 곧 남은 일이다. 들어 보고 문제 없다고 판단했거나
// 교체를 담은 항목은 그 자리에서 지워야, 무엇이 남았는지가 목록만 봐도 읽힌다.
// 판정 자체를 바꾸는 것이 아니라 이 영상을 보는 동안의 표시일 뿐이라, 다른
// 영상을 열면 초기화된다.
const clearedFindings = new Set();

function findingKey(finding) {
  return findingKeyOf(finding);
}

// 표시는 결과에 적힌다. 그래야 앱을 다시 켜도, 최근 결과에서 봐도 같은 상태다.
async function persistClearedFindings() {
  const target = voiceVideo?.reviewTarget;
  if (!target) return;
  try { await api.setClearedFindings(target, [...clearedFindings]); }
  catch (error) { showToast(`확인 표시를 저장하지 못했습니다. ${error.message}`, 'error'); }
}

function visibleFindings() {
  return reviewFindings.filter((finding) => !clearedFindings.has(findingKey(finding)));
}

function renderFindings() {
  const remaining = visibleFindings();
  const cleared = reviewFindings.length - remaining.length;
  $('#review-finding-count').textContent = String(remaining.length);
  const rows = remaining.map(renderVoiceFindingRow);
  if (cleared > 0) {
    const note = document.createElement('li');
    note.className = 'findings-cleared';
    const mark = document.createElement('b');
    mark.textContent = '✓';
    const label = document.createElement('span');
    label.textContent = `${cleared}곳 확인함`;
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.textContent = '되돌리기';
    undo.addEventListener('click', restoreClearedFindings);
    note.append(mark, label, undo);
    rows.push(note);
  }
  $('#review-findings-list').replaceChildren(...rows);
  $('#review-findings-note').textContent = reviewFindings.length === 0
    ? '표시된 자동 검수 항목이 없습니다. 검사가 놓칠 수 있으니 직접 듣고 확인하세요.'
    : remaining.length === 0
      ? '확인할 항목을 모두 정리했습니다. 담아 둔 교체가 있으면 저장하세요.'
      : '자동 검수 권장 구간입니다. 눌러서 직접 확인하세요.';
}

function clearFinding(finding) {
  clearedFindings.add(findingKey(finding));
  renderFindings();
  persistClearedFindings();
}

function restoreClearedFindings() {
  clearedFindings.clear();
  renderFindings();
  persistClearedFindings();
}

// 사유는 길고 대본 문장은 더 길다. 셋을 한 줄에 나란히 두면 문장이 잘리거나
// 줄이 무너지므로, 짧은 것(페이지·시각)만 윗줄에 두고 문장은 아래 한 줄을
// 통째로 쓴다. 사유는 아이콘 툴팁으로 접는다.
function renderVoiceFindingRow(finding) {
  const row = document.createElement('li');
  row.dataset.severity = finding.severity;

  const button = document.createElement('button');
  button.type = 'button'; button.className = 'voice-finding';

  const head = document.createElement('div');
  head.className = 'finding-head';
  const title = document.createElement('strong'); title.textContent = `${finding.slideNumber}페이지`;
  const time = document.createElement('span');
  time.className = 'finding-time';
  time.textContent = voiceFindingLabel(finding);
  head.append(title, time);

  const line = document.createElement('p');
  line.className = 'finding-line';
  line.textContent = String(finding.expectedText || '').trim() || voiceFindingReason(finding);

  button.append(head, line);

  const tools = document.createElement('div');
  tools.className = 'finding-tools';
  const why = document.createElement('span');
  why.className = 'finding-why';
  why.setAttribute('tabindex', '0');
  why.setAttribute('role', 'note');
  // 툴팁과 스크린리더가 같은 문구를 읽도록 한 값에서 낸다.
  why.dataset.tooltip = voiceFindingReason(finding);
  why.setAttribute('aria-label', `확인 사유: ${voiceFindingReason(finding)}`);
  why.textContent = 'ⓘ';
  const done = document.createElement('button');
  done.type = 'button'; done.className = 'finding-done';
  done.textContent = '확인';
  done.title = '확인 완료로 표시';
  done.setAttribute('aria-label', `${finding.slideNumber}페이지 확인 완료로 표시`);
  done.addEventListener('click', () => clearFinding(finding));
  tools.append(why, done);

  row.append(button, tools);
  button.addEventListener('click', () => {
    const page = voiceVideo?.pages?.find(p => p.number === Number(finding.slideNumber));
    selectReviewPage(page, voiceFindingReason(finding));
    showFindingDiff(finding);
    seekReview(Number(finding.startMs) / 1000, Number(finding.endMs) / 1000);
  });
  return row;
}

async function openReview(target, finding = null) {
  const request = ++reviewRequest;
  try {
    const video = await api.adoptResultVideo(target);
    if (request !== reviewRequest || reviewBusy) return false;
    setReviewVideo(video, target);
    $("[data-view='review']").click();
    if (finding) {
      selectReviewPage(video.pages?.find(p => p.number === Number(finding.slideNumber)), voiceFindingReason(finding));
      seekReview(Number(finding.startMs) / 1000, Number(finding.endMs) / 1000);
    }
    return true;
  } catch (error) { showToast(error.message, 'error'); return false; }
}

function setReviewVideo(video, target = null) {
  if (!video || reviewBusy) return;
  $$('audio,video').forEach(media => media.pause());
  voiceVideo = video; reviewTarget = target; reviewSelection = null; reviewStopAt = null;
  reviewMode = 'regenerate';
  $$('#review-mode-tabs button').forEach(button => button.classList.toggle('selected', button.dataset.repairMode === reviewMode));
  $('#edit-voice-panel').classList.remove('hidden');
  $('#review-mute-panel').classList.add('hidden');
  $('#review-mute-start').value = '0'; $('#review-mute-end').value = '0.2';
  regionAudio = null;
  $('#region-audio-preview').removeAttribute('src');
  $('#region-audio-preview').classList.add('hidden');
  $('#region-audio-name').textContent = 'WAV·M4A·MP3 파일을 선택하세요.';
  pendingCandidateContext = null;
  $('#review-candidates-host').classList.add('hidden');
  $('#review-saved').classList.add('hidden');
  pendingFixes.clear();
  renderPendingFixes();
  $('#polish-diff').classList.add('hidden');
  renderPolishStrip(video);
  $('#voice-video-name').textContent = video.name;
  reviewPlayer.src = video.videoUrl;
  reviewFindings = video.voiceFindings || [];
  clearedFindings.clear();
  for (const key of video.clearedFindings || []) clearedFindings.add(String(key));
  renderFindings();
  $('#review-pages').replaceChildren(...(video.pages || []).map(page => {
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = `${page.number}p`; button.dataset.page = page.number;
    button.title = `${formatDuration(page.startMs)} · ${page.text.slice(0, 70)}`;
    button.addEventListener('click', () => { selectReviewPage(page); seekReview(page.startMs / 1000); });
    return button;
  }));
  $('#review-selection-title').textContent = '수정할 부분을 선택하세요';
  $('#review-selection-reason').textContent = '영상을 멈추고 ‘이 페이지 수정’을 누르세요.';
  $('#review-player-status').textContent = video.pages?.length ? '재생 중에도 페이지를 선택해 수정할 수 있습니다.' : '페이지 정보가 없어 재생성은 사용할 수 없습니다. 구간 무음 처리는 가능합니다.';
  updateReviewPosition(); updateReviewAction();
}

function currentReviewPage() {
  const pages = voiceVideo?.pages || [];
  const ms = reviewPlayer.currentTime * 1000;
  return pages.find((page, index) => ms >= (index ? page.startMs : 0) && ms < (pages[index + 1]?.startMs ?? Infinity)) || null;
}
function updateReviewPosition() {
  const page = currentReviewPage();
  $('#review-current-page').textContent = page ? `${page.number}페이지 · ${Math.floor(reviewPlayer.currentTime / 60)}:${(reviewPlayer.currentTime % 60).toFixed(2).padStart(5, '0')}` : '페이지 정보 없음';
  $('#review-script').textContent = page?.text || '페이지 타임라인이 없는 영상입니다.';
  $('#review-select-page').disabled = reviewBusy || !page;
  $$('#review-pages button').forEach(button => button.setAttribute('aria-current', String(Number(button.dataset.page) === page?.number)));
}
function selectReviewPage(page, reason = '') {
  if (!page || reviewBusy) return;
  reviewPlayer.pause(); reviewSelection = page;
  $('#voice-start-page').value = $('#voice-end-page').value = String(page.number);
  $('#review-selection-title').textContent = `${page.number}페이지 수정`;
  $('#review-selection-reason').textContent = reason || `${formatDuration(page.startMs)}–${formatDuration(page.endMs)} · 직접 선택한 페이지`;
  updateVoicePageMeta(); updateReviewAction();
}
function updateReviewAction() {
  $('#start-review-button').disabled = reviewBusy || !voiceVideo || (reviewMode === 'regenerate' && !reviewSelection) || (reviewMode === 'replace' && !regionAudio);
  $('#review-original').disabled = !reviewSelection || reviewBusy;
  $('#start-review-label').textContent = reviewMode === 'mute' ? '선택 구간을 무음 처리한 새 버전 저장' : reviewMode === 'replace' ? '선택 구간의 음성을 교체한 새 버전 저장' : '새 목소리 후보 만들기';
  $('#review-form .review-save-note').textContent = reviewMode !== 'regenerate'
    ? '원본을 보관하고 수정본을 새 버전으로 저장합니다.' : '후보를 듣고 선택한 뒤 새 버전으로 저장합니다. 원본은 보관됩니다.';
}
function seekReview(start, end = null) {
  reviewPlayer.pause(); reviewStopAt = end;
  const seek = () => { reviewPlayer.currentTime = Math.max(0, start); updateReviewPosition(); };
  if (reviewPlayer.readyState >= 1) seek();
  else reviewPlayer.addEventListener('loadedmetadata', seek, {once:true});
}
async function playReviewRange(start, end) {
  seekReview(start, end);
  try { await reviewPlayer.play(); } catch { showToast('영상의 재생 버튼을 눌러 주세요.', 'error'); }
}
reviewPlayer.addEventListener('timeupdate', () => {
  updateReviewPosition();
  if (reviewStopAt != null && reviewPlayer.currentTime >= reviewStopAt) { reviewPlayer.pause(); reviewStopAt = null; }
});
reviewPlayer.addEventListener('loadedmetadata', () => { reviewPlayer.playbackRate = Number($('#review-speed').value); updateReviewPosition(); });
reviewPlayer.addEventListener('error', () => { $('#review-player-status').textContent = '영상을 열지 못했습니다. 원본 파일 위치를 확인해 주세요.'; });
$('#review-select-page').addEventListener('click', () => selectReviewPage(currentReviewPage()));
$('#review-back').addEventListener('click', () => seekReview(Math.max(0, reviewPlayer.currentTime - 5)));
$('#review-fine-back').addEventListener('click', () => seekReview(Math.max(0, reviewPlayer.currentTime - .05)));
$('#review-fine-next').addEventListener('click', () => seekReview(Math.min(reviewPlayer.duration || 0, reviewPlayer.currentTime + .05)));
$('#review-speed').addEventListener('change', () => { reviewPlayer.playbackRate = Number($('#review-speed').value); });
$('#review-original').addEventListener('click', () => reviewSelection && playReviewRange(reviewSelection.startMs / 1000, reviewSelection.endMs / 1000));
$('#review-latest').addEventListener('click', () => latestCompleteReview && openReview(latestCompleteReview));
$$('#review-mode-tabs button').forEach(button => button.addEventListener('click', () => {
  reviewMode = button.dataset.repairMode;
  $$('#review-mode-tabs button').forEach(b => b.classList.toggle('selected', b === button));
  $('#edit-voice-panel').classList.toggle('hidden', reviewMode !== 'regenerate');
  $('#review-mute-panel').classList.toggle('hidden', reviewMode === 'regenerate');
  $('#review-replacement-panel').classList.toggle('hidden', reviewMode !== 'replace');
  $('#review-region-description').textContent = reviewMode === 'replace' ? '선택한 구간의 음성만 준비한 파일로 교체합니다. 화면과 자막 시각은 유지됩니다.' : '불필요한 소리만 무음으로 바꿉니다. 영상 길이와 자막 시각은 유지됩니다.';
  $('#review-region-limit').textContent = reviewMode === 'replace' ? '0.05~10초 구간을 선택하세요. 짧은 파일은 나머지를 무음으로 채웁니다.' : '0.05~2초 구간을 선택하세요. 정상 발화가 포함되지 않았는지 먼저 확인하세요.';
  updateReviewAction();
}));
$('#pick-region-audio').addEventListener('click', async () => {
  try {
    const videoToken = voiceVideo?.token;
    const [audio] = await api.pickAudio();
    if (!audio || reviewBusy || videoToken !== voiceVideo?.token) return;
    regionAudio = audio;
    $('#region-audio-name').textContent = audio.name;
    $('#region-audio-preview').src = audio.audioUrl;
    $('#region-audio-preview').classList.remove('hidden');
    updateReviewAction();
  } catch (error) { showToast(error.message, 'error'); }
});
$('#review-mark-start').addEventListener('click', () => { reviewPlayer.pause(); $('#review-mute-start').value = reviewPlayer.currentTime.toFixed(3); });
$('#review-mark-end').addEventListener('click', () => { reviewPlayer.pause(); $('#review-mute-end').value = reviewPlayer.currentTime.toFixed(3); });
$('#review-range-play').addEventListener('click', () => playReviewRange(Math.max(0, Number($('#review-mute-start').value) - .6), Number($('#review-mute-end').value) + .6));
$('#review-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!voiceVideo || reviewBusy) return;
  if (reviewMode === 'regenerate' && !reviewSelection) return;
  const name = `review-${Date.now()}`;
  if (reviewMode === 'replace' && !regionAudio) return;
  const payload = reviewMode !== 'regenerate'
    ? {operation:reviewMode === 'replace' ? 'replace-region' : 'mute-region', name, videoToken:voiceVideo.token, audioToken:regionAudio?.token, muteStart:Number($('#review-mute-start').value), muteEnd:Number($('#review-mute-end').value)}
    : {operation:'voice-candidates', name, videoToken:voiceVideo.token, audioSource:'generate', originalStartMs:reviewSelection.startMs, originalEndMs:reviewSelection.endMs, sourceDisplayName:voiceVideo.name, startPage:reviewSelection.number, endPage:reviewSelection.number,
      candidateCount:Number($('#voice-candidate-count').value), durationPolicy:$('#voice-duration-policy').value};
  reviewResumeMs = reviewMode !== 'regenerate' ? Math.max(0, payload.muteStart * 1000 - 1000) : reviewSelection.startMs;
  pendingCandidateContext = {...payload};
  $("#review-candidates-host").classList.add("hidden");
  $("#review-saved").classList.add("hidden");
  reviewPlayer.pause();
  try { setEditBusy(true); await api.startEdit(payload); }
  catch (error) { setEditBusy(false); showToast(error.message, 'error'); }
});
$('#review-candidate-original').addEventListener('click', () => {
  if (pendingCandidateContext) playReviewRange(pendingCandidateContext.originalStartMs / 1000, pendingCandidateContext.originalEndMs / 1000);
});
$('#review-continue').addEventListener('click', async () => {
  if (!latestEditTarget) return;
  const resume = reviewResumeMs;
  if (!await openReview(latestEditTarget)) return;
  seekReview(resume / 1000);
  $('#review-version').textContent = '수정본 검수 중 · 이전 버전 보관됨';
});

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

// 사이드바 접기. 폭은 CSS 토큰 하나로 정해지므로 클래스만 토글하면 된다.
// 선택은 이 기기에만 남기면 되는 취향이라 localStorage에 둔다. 사생활 보호
// 창이나 저장이 막힌 환경에서는 접근 자체가 던지므로 감싸 둔다.
const SIDEBAR_KEY = 'voiceStudio.sidebarCollapsed';

function applySidebarCollapsed(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  const toggle = $('#sidebar-toggle');
  toggle.textContent = collapsed ? '›' : '‹';
  toggle.setAttribute('aria-expanded', String(!collapsed));
  const label = collapsed ? '사이드바 펼치기' : '사이드바 접기';
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
}

$('#sidebar-toggle').addEventListener('click', () => {
  const collapsed = !document.body.classList.contains('sidebar-collapsed');
  applySidebarCollapsed(collapsed);
  try { localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0'); } catch {}
});

try { applySidebarCollapsed(localStorage.getItem(SIDEBAR_KEY) === '1'); }
catch { applySidebarCollapsed(false); }

// 앱이 꺼져도 두 시간을 잃지 않는다는 약속은, 켰을 때 이어할 것이 있다고
// 먼저 말해 주어야 지켜진다.
async function refreshResumable() {
  try {
    const pending = await api.getResumable();
    $("#resume-banner").classList.toggle("hidden", !pending);
    if (!pending) return;
    $("#resume-title").textContent = pending.paused
      ? "일시정지된 작업이 있습니다"
      : "이어서 만들 작업이 있습니다";
    $("#resume-detail").textContent = pending.total > 1
      ? `${pending.title} · ${pending.total}편 중 ${pending.done}편 완료 · ${pending.remaining}편 남음`
      : `${pending.title} · 처음부터 다시 만듭니다`;
  } catch { $("#resume-banner").classList.add("hidden"); }
}

$("#pause-button").addEventListener("click", async () => {
  const paused = $("#pause-button").textContent === "이어하기";
  try { await (paused ? api.resume() : api.pause()); }
  catch (error) { showToast(error.message, "error"); }
});

$("#resume-continue").addEventListener("click", async () => {
  try {
    $("#resume-banner").classList.add("hidden");
    await api.resumeJob();
  } catch (error) {
    showToast(error.message, "error");
    await refreshResumable();
  }
});

$("#resume-discard").addEventListener("click", async () => {
  try { await api.discardResumable(); await refreshResumable(); }
  catch (error) { showToast(error.message, "error"); }
});

function optionPayload() {
  const lesson = productionMode === "lesson" ? selectedLesson() : null;
  const chapter = productionMode === "chapter" ? selectedChapter() : null;
  const name = $("#job-name").value.trim();
  return {
    name,
    title: lesson?.title || (chapter ? `${chapter.id.toUpperCase()} 전체` : `${name} 강의 영상`),
    mode: productionMode,
    startPage: Number($("#start-page").value),
    endPage: Number($("#end-page").value),
    chapter: chapter?.id || null,
    chapterMode: productionMode === "chapter" ? chapterMode : "single",
    deliverable: $("#deliverable").value,
    burnCaptions: $("#burn-captions").checked,
  };
}






function updateVoicePageMeta() {
  const start = Number($("#voice-start-page").value || 1);
  const end = Number($("#voice-end-page").value || start);
  const profile = appSettings?.modelId === "chatterbox-v3"
    ? "Chatterbox V3"
    : appSettings?.adapterId === "none"
      ? "Qwen3 기본 복제"
    : `${appSettings?.adapters?.find((item) => item.id === appSettings.adapterId)?.label || "파인튜닝"} · ${Number(appSettings?.adapterScale || 0.6).toFixed(2)}`;
  $("#voice-page-meta").textContent = `${start}~${end}페이지 음성을 ${profile} 설정으로 새로 만듭니다.`;
}


// 영상 편집은 클립 목록 하나다. 구간을 준 클립 하나가 자르기, 구간 없는 클립
// 여럿이 합치기, 섞으면 예전 두 탭으로는 만들 수 없던 편집이 된다. 화면이 하는
// 일은 그 목록을 보여 주고 고치게 하는 것뿐이고, 렌더는 compose 하나로 간다.
let editorClips = [];
let editorActive = -1;
const editorPlayer = $("#editor-player");

function editorClip() { return editorClips[editorActive] || null; }
function clipLengthMs(clip) { return Math.max(0, Number(clip.outMs) - Number(clip.inMs)); }

function formatTimecode(ms) {
  const total = Math.max(0, Number(ms) || 0);
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = Math.round(total % 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:`
    + `${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

// 초만 적어도, 분:초로 적어도, 시:분:초까지 적어도 받는다. 편집 중에 시간을
// 손으로 고치는 일은 잦고, 형식을 틀렸다고 막아 세울 일이 아니다.
function parseTimecodeMs(text) {
  const value = String(text ?? "").trim();
  if (!value) return null;
  const parts = value.split(":");
  if (parts.length > 3 || parts.some((part) => part !== "" && !/^\d*\.?\d*$/.test(part))) return null;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + (Number(part) || 0);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
}

function renderEditorOutput() {
  const total = editorClips.reduce((sum, clip) => sum + clipLengthMs(clip), 0);
  $("#editor-total").textContent = editorClips.length ? formatDuration(total) : "0:00";
  const trimmed = editorClips.filter((clip) => clip.inMs > 0 || clip.outMs < clip.durationMs).length;
  // 다시 굽는 비용은 클립마다 갈린다. 실행 전에 알려 주면 기다릴지 말지 고를 수 있다.
  $("#editor-quality").textContent = editorClips.length === 0
    ? "클립을 담으면 다시 구울지 그대로 쓸지 알려드립니다."
    : trimmed === 0
      ? "구간을 자른 클립이 없어 다시 굽지 않고 그대로 이어 붙입니다. 금방 끝납니다."
      : `${trimmed}개 클립만 다시 굽습니다. 나머지는 원본을 그대로 씁니다.`;
  $("#start-edit-label").textContent = editorClips.length > 1 ? "이어서 만들기" : "이대로 만들기";
}

function renderEditorClipFields() {
  const clip = editorClip();
  $("#editor-clip-name").textContent = clip ? clip.name : "담은 영상이 없습니다";
  $("#editor-clip-time").textContent = clip
    ? `${formatDuration(clip.inMs)}–${formatDuration(clip.outMs)} · 원본 ${formatDuration(clip.durationMs)}`
    : "—";
  $("#editor-in").value = clip ? formatTimecode(clip.inMs) : "00:00:00.000";
  $("#editor-out").value = clip ? formatTimecode(clip.outMs) : "00:00:00.000";
  for (const id of ["#editor-mark-in", "#editor-mark-out", "#editor-play-clip", "#editor-reset-clip", "#editor-in", "#editor-out"]) {
    $(id).disabled = !clip || reviewBusy;
  }
}

function renderEditorTrack() {
  $("#editor-count").textContent = String(editorClips.length);
  $("#editor-empty").classList.toggle("hidden", editorClips.length > 0);
  $("#start-edit-button").disabled = editorClips.length === 0 || reviewBusy;
  $("#editor-clips").replaceChildren(...editorClips.map((clip, index) => {
    const item = document.createElement("li");
    item.className = "track-clip";
    item.draggable = true;
    if (index === editorActive) item.classList.add("active");
    if (clip.inMs > 0 || clip.outMs < clip.durationMs) item.classList.add("trimmed");

    const order = document.createElement("b");
    order.textContent = String(index + 1);
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = clip.name;
    const meta = document.createElement("small");
    meta.textContent = clip.inMs > 0 || clip.outMs < clip.durationMs
      ? `${formatDuration(clip.inMs)}–${formatDuration(clip.outMs)} · ${formatDuration(clipLengthMs(clip))}`
      : `전체 · ${formatDuration(clipLengthMs(clip))}`;
    copy.append(title, meta);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "track-remove";
    remove.textContent = "×";
    remove.title = "이 클립 빼기";
    remove.setAttribute("aria-label", `${clip.name} 빼기`);
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      editorClips.splice(index, 1);
      selectEditorClip(Math.min(editorActive, editorClips.length - 1));
    });

    item.append(order, copy, remove);
    item.addEventListener("click", () => selectEditorClip(index));
    item.addEventListener("dragstart", (event) => {
      item.classList.add("dragging");
      event.dataTransfer.setData("text/plain", String(index));
      event.dataTransfer.effectAllowed = "move";
    });
    item.addEventListener("dragend", () => item.classList.remove("dragging"));
    item.addEventListener("dragover", (event) => event.preventDefault());
    item.addEventListener("drop", (event) => {
      event.preventDefault();
      const from = Number(event.dataTransfer.getData("text/plain"));
      if (!Number.isInteger(from) || from === index) return;
      const [moved] = editorClips.splice(from, 1);
      editorClips.splice(index, 0, moved);
      selectEditorClip(index);
    });
    return item;
  }));
  renderEditorOutput();
}

function selectEditorClip(index) {
  editorActive = index >= 0 && index < editorClips.length ? index : -1;
  const clip = editorClip();
  if (clip && editorPlayer.dataset.token !== clip.token) {
    editorPlayer.dataset.token = clip.token;
    editorPlayer.src = clip.videoUrl;
  }
  if (!clip) {
    editorPlayer.removeAttribute("src");
    editorPlayer.dataset.token = "";
  }
  renderEditorTrack();
  renderEditorClipFields();
}

function addEditorClips(videos = []) {
  const added = (videos || []).filter(Boolean).map((video) => {
    const durationMs = Math.max(1, Math.round(Number(video.durationMs) || 0));
    return { token: video.token, name: video.name, videoUrl: video.videoUrl, durationMs, inMs: 0, outMs: durationMs };
  });
  if (!added.length) return;
  editorClips = [...editorClips, ...added];
  if (!$("#edit-name").value.trim()) {
    $("#edit-name").value = `${added.length > 1 || editorClips.length > 1 ? "이어붙임" : "편집"}-${Date.now()}`;
  }
  selectEditorClip(editorClips.length - added.length);
  setIconStatus("#edit-top-status", `클립 ${editorClips.length}개를 담았습니다`);
}

async function pickEditorVideos() {
  try { addEditorClips(await api.pickVideos(true)); }
  catch (error) { showToast(error.message, "error"); }
}

function moveClipEdge(field, ms) {
  const clip = editorClip();
  if (!clip) return;
  const bounded = Math.max(0, Math.min(clip.durationMs, ms));
  if (field === "inMs") clip.inMs = Math.min(bounded, clip.outMs - 1);
  else clip.outMs = Math.max(bounded, clip.inMs + 1);
  renderEditorTrack();
  renderEditorClipFields();
}

$("#editor-pick").addEventListener("click", pickEditorVideos);
$("#editor-drop").addEventListener("click", (event) => { if (!event.target.closest("button")) pickEditorVideos(); });
$("#editor-mark-in").addEventListener("click", () => moveClipEdge("inMs", Math.round(editorPlayer.currentTime * 1000)));
$("#editor-mark-out").addEventListener("click", () => moveClipEdge("outMs", Math.round(editorPlayer.currentTime * 1000)));
$("#editor-reset-clip").addEventListener("click", () => {
  const clip = editorClip();
  if (!clip) return;
  clip.inMs = 0;
  clip.outMs = clip.durationMs;
  renderEditorTrack();
  renderEditorClipFields();
});
$("#editor-play-clip").addEventListener("click", () => {
  const clip = editorClip();
  if (!clip) return;
  editorPlayer.currentTime = clip.inMs / 1000;
  editorPlayer.play().catch(() => showToast("미리보기의 재생 버튼을 눌러 주세요.", "error"));
});
editorPlayer.addEventListener("timeupdate", () => {
  const clip = editorClip();
  if (clip && editorPlayer.currentTime * 1000 >= clip.outMs) editorPlayer.pause();
});
for (const [id, field] of [["#editor-in", "inMs"], ["#editor-out", "outMs"]]) {
  $(id).addEventListener("change", () => {
    const ms = parseTimecodeMs($(id).value);
    if (ms == null) {
      renderEditorClipFields();
      showToast("시간은 5, 1:30, 00:01:23.400 처럼 적어 주세요.", "error");
      return;
    }
    moveClipEdge(field, ms);
  });
}
$("#start-edit-button").addEventListener("click", async () => {
  if (!editorClips.length || reviewBusy) return;
  try {
    setEditBusy(true);
    openJobDialog("영상 만드는 중");
    await api.startEdit({
      operation: "compose",
      name: $("#edit-name").value.trim() || `편집-${Date.now()}`,
      clips: editorClips.map((clip) => ({ videoToken: clip.token, inMs: clip.inMs, outMs: clip.outMs })),
    });
  } catch (error) {
    setEditBusy(false);
    openJobDialog("입력 확인 필요");
    $("#edit-dialog-spinner").classList.add("hidden");
    $("#edit-dialog-error").classList.remove("hidden");
    $("#edit-error-message").textContent = error.message;
    $("#cancel-edit-button").classList.add("hidden");
    $("#close-edit-dialog").classList.remove("hidden");
  }
});

function setEditBusy(busy) {
  reviewBusy = busy;
  $("#review-form").querySelectorAll("input,select,button").forEach(el => { el.disabled = busy; });
  $("#pick-voice-video").disabled = busy;
  updateReviewAction();
  updateReviewPosition();
  $("#start-edit-button").disabled = busy;
  $$("#view-edit input, #view-edit select, #view-edit button").forEach((element) => { element.disabled = busy; });
  if (!busy) renderEditorTrack();
  setIconStatus("#edit-top-status", busy ? "영상 만드는 중" : "편집할 영상을 담으세요", busy ? "running" : "idle");
}

function appendEditLog(text) {
  const log = $("#edit-log");
  appendFollowingLog(log, text);
}

function openJobDialog(title) {
  const dialog = $("#edit-job-dialog");
  $("#edit-dialog-title").textContent = title;
  $("#edit-dialog-spinner").classList.remove("hidden");
  $("#edit-dialog-success").classList.add("hidden");
  $("#edit-dialog-error").classList.add("hidden");
  $("#candidate-gallery").classList.add("hidden");
  $("#batch-progress").classList.add("hidden");
  resetBatchProgress();
  $("#cancel-edit-button").classList.remove("hidden");
  resetCancelButton($("#cancel-edit-button"));
  $("#open-edit-result").classList.add("hidden");
  $("#reveal-edit-result").classList.add("hidden");
  $("#apply-voice-candidate").classList.add("hidden");
  $("#close-edit-dialog").classList.add("hidden");
  $("#edit-log").textContent = "";
  if (!dialog.open) dialog.showModal();
}

function renderVoiceCandidates(candidates) {
  voiceCandidates = candidates;
  selectedCandidateToken = null;
  $("#apply-voice-candidate").disabled = true;
  const list = $("#candidate-list");
  list.replaceChildren(...candidates.map((candidate, index) => {
    const card = document.createElement("label");
    card.className = "candidate-card";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "voiceCandidate";
    radio.value = candidate.token;
    radio.checked = false;
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = candidate.name;
    const meta = document.createElement("small");
    // Every take is read back by the independent reviewer, so the listener is
    // told what the machine heard before deciding what their own ear prefers.
    const findings = candidate.voiceFindings || [];
    const verdict = candidate.voiceFindings === undefined
      ? ""
      : findings.length
        ? ` · ${summarizeVoiceFindings(findings).title}`
        : " · 자동 검수 통과";
    meta.textContent =
      `${candidate.durationMs ? `${formatDuration(candidate.durationMs)} 길이` : "새로 만든 발화"}${verdict}`;
    if (findings.length) {
      card.dataset.verdict = summarizeVoiceFindings(findings).tone;
      meta.title = findings.map((finding) => `${finding.slideNumber}페이지 · ${voiceFindingReason(finding)}`).join("\n");
    }
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "metadata";
    audio.src = candidate.audioUrl;
    audio.addEventListener("play", () => {
      $$("#candidate-list audio").forEach((other) => { if (other !== audio) other.pause(); });
    });
    copy.append(title, meta, audio);
    card.append(radio, copy);
    radio.addEventListener("change", () => {
      selectedCandidateToken = radio.value;
      $("#apply-voice-candidate").disabled = false;
      $$(".candidate-card").forEach((item) => item.classList.toggle("selected", item === card));
    });
    return card;
  }));
}

function handleEditEvent(event) {
  if (event.type === "edit-started") {
    openJobDialog(
      event.options.operation === "voice-candidates"
        ? "목소리 후보 생성 중"
        : event.options.operation === "voice"
          ? "선택한 목소리로 교체 중"
          : "영상 편집 중",
    );
    setEditBusy(true);
  } else if (event.type === "stage") {
    $("#edit-running-label").textContent = event.stage === "voice" ? "새 목소리 생성 중" : event.stage === "verify" ? "결과 검증 중" : "영상 처리 중";
  } else if (event.type === "log") {
    appendEditLog(event.text);
  } else if (event.type === "voice-item-complete") {
    $("#batch-progress").classList.remove("hidden");
    $("#batch-progress-text").textContent = `${event.completed} / ${event.total} 완료 · ${event.name}`;
    $("#batch-progress-bar").style.width = `${event.completed / event.total * 100}%`;
    trackBatchProgress(event);
  } else if (event.type === "voice-candidates-ready") {
    candidatePurpose = "edit";
    setEditBusy(false);
    setIconStatus("#edit-top-status", "생성된 목소리 후보를 비교하고 있습니다");
    renderVoiceCandidates(event.candidates);
    if (event.options) pendingCandidateContext = { ...event.options };
    $('#review-candidates-host').classList.remove('hidden');
    $('#review-candidate-scope').textContent = `${pendingCandidateContext?.sourceDisplayName || ''} · ${pendingCandidateContext?.startPage || ''}페이지 전체 음성을 교체합니다.`;
    $('#review-candidates-host').insertBefore($('#candidate-gallery'), $('#review-candidate-actions'));
    $('#review-candidate-actions').append($('#apply-voice-candidate'));
    $('#edit-job-dialog').close();
    $('#review-candidates-host').scrollIntoView({behavior:'smooth', block:'nearest'});
    $("#edit-dialog-title").textContent = "목소리 후보 비교";
    $("#edit-dialog-spinner").classList.add("hidden");
    $("#batch-progress").classList.add("hidden");
    $("#candidate-gallery").classList.remove("hidden");
    $("#cancel-edit-button").classList.add("hidden");
    $("#apply-voice-candidate").classList.remove("hidden");
    $("#apply-voice-candidate").textContent = "이 목소리로 담기";
    $("#close-edit-dialog").classList.remove("hidden");
  } else if (event.type === "cancelling") {
    $("#edit-running-label").textContent = "안전하게 중지 중";
    $("#cancel-edit-button").disabled = true;
    $("#cancel-edit-button").textContent = "중지 중…";
  } else if (event.type === "edit-failed") {
    setEditBusy(false);
    setIconStatus("#edit-top-status", "영상 편집 오류를 확인해 주세요", "failed");
    $("#edit-dialog-spinner").classList.add("hidden");
    $("#edit-dialog-error").classList.remove("hidden");
    $("#edit-error-message").textContent = event.message;
    $("#cancel-edit-button").classList.add("hidden");
    $("#close-edit-dialog").classList.remove("hidden");
    appendEditLog(`\n[중단] ${event.message}\n`);
  } else if (event.type === "edit-complete") {
    setEditBusy(false);
    setIconStatus("#edit-top-status", "영상 편집과 검증이 완료됐습니다", "complete");
    latestEditTarget = event.report.target;
    if (event.report.operation === 'voice-pages') { pendingFixes.clear(); renderPendingFixes(); }
    if (['mute-region', 'replace-region', 'voice-page', 'voice-batch', 'voice-pages'].includes(event.report.operation)) {
      $('#review-saved').classList.remove('hidden');
      $('#review-candidates-host').classList.add('hidden');
    }
    $("#edit-dialog-spinner").classList.add("hidden");
    $("#edit-dialog-success").classList.remove("hidden");
    const count = event.report.outputs?.length || 1;
    $("#edit-complete-summary").textContent = `${count}개 결과 · 자동 검증 ${event.report.summary.passed}개 통과`;
    $("#cancel-edit-button").classList.add("hidden");
    $("#open-edit-result").classList.remove("hidden");
    $("#reveal-edit-result").classList.remove("hidden");
    $("#close-edit-dialog").classList.remove("hidden");
    if (['mute-region', 'replace-region', 'voice-page', 'voice-batch', 'voice-pages'].includes(event.report.operation)) {
      $('#edit-job-dialog').close();
      $('#review-saved').scrollIntoView({behavior:'smooth',block:'nearest'});
    }
    loadOutputs();
  }
}

function handleTextVoiceEvent(event) {
  if (event.type === "text-voice-started") {
    candidatePurpose = "text";
    $('#edit-job-dialog .job-modal-body').append($('#candidate-gallery'));
    $('#edit-job-dialog .modal-actions').append($('#apply-voice-candidate'));
    openJobDialog("텍스트 목소리 후보 생성 중");
    setIconStatus("#voice-top-status", "목소리 후보 생성 중", "running");
    $("#start-text-voices").disabled = true;
  } else if (event.type === "stage") {
    $("#edit-running-label").textContent = "서로 다른 발화 후보를 만들고 있습니다.";
  } else if (event.type === "log") {
    appendEditLog(event.text);
  } else if (event.type === "voice-item-complete") {
    $("#batch-progress").classList.remove("hidden");
    $("#batch-progress-text").textContent = `${event.completed} / ${event.total} 완료 · ${event.name}`;
    $("#batch-progress-bar").style.width = `${event.completed / event.total * 100}%`;
    trackBatchProgress(event);
  } else if (event.type === "text-voices-ready") {
    candidatePurpose = "text";
    renderVoiceCandidates(event.candidates);
    setIconStatus("#voice-top-status", "생성된 후보를 비교하고 있습니다");
    $("#start-text-voices").disabled = false;
    $("#edit-dialog-title").textContent = "목소리 후보 비교";
    $("#edit-dialog-spinner").classList.add("hidden");
    $("#batch-progress").classList.add("hidden");
    $("#candidate-gallery").classList.remove("hidden");
    $("#cancel-edit-button").classList.add("hidden");
    $("#apply-voice-candidate").textContent = "이 목소리 선택";
    $("#apply-voice-candidate").classList.remove("hidden");
    $("#close-edit-dialog").classList.remove("hidden");
  } else if (event.type === "text-voice-failed") {
    setIconStatus("#voice-top-status", "목소리 생성 오류를 확인해 주세요", "failed");
    $("#start-text-voices").disabled = false;
    $("#edit-dialog-spinner").classList.add("hidden");
    $("#edit-dialog-error").classList.remove("hidden");
    $("#edit-error-message").textContent = event.message;
    $("#cancel-edit-button").classList.add("hidden");
    $("#close-edit-dialog").classList.remove("hidden");
  } else if (event.type === "text-voice-selected") {
    latestEditTarget = event.report.target;
    setIconStatus("#voice-top-status", "목소리 선택과 저장이 완료됐습니다", "complete");
    $("#candidate-gallery").classList.add("hidden");
    $("#edit-dialog-success").classList.remove("hidden");
    $("#edit-complete-summary").textContent = `${formatDuration(event.report.durationMs)} · 선택한 WAV를 별도로 보관했습니다.`;
    $("#apply-voice-candidate").classList.add("hidden");
    $("#open-edit-result").classList.remove("hidden");
    $("#reveal-edit-result").classList.remove("hidden");
    $("#text-voice-name").value = suggestedTextVoiceName();
    loadOutputs();
  }
}

function outputLabel(item) {
  if (item.root === "voice") return "텍스트 목소리";
  if (item.root === "edit") {
    return { merge: "합친 영상", trim: "자른 영상", voice: "목소리 교체", "voice-page": "페이지 목소리 교체", "voice-batch": "목소리 교체" }[item.operation] || "편집 영상";
  }
  if (item.root === "pilot") return "강의 음성";
  return item.video ? "완성 강의 영상" : "강의 자막·음성";
}

function renderOutputSummary() {
  $("#results-count").textContent = String(outputItems.length);
  $("#result-count-summary").textContent = `${outputItems.length}개`;
}

function closeResultMenus({ restoreFocus = false } = {}) {
  const opened = $$(".result-menu[open]");
  for (const menu of opened) menu.removeAttribute("open");
  if (restoreFocus) opened.at(-1)?.querySelector("summary")?.focus();
}

function renderOutputs() {
  return animateLayout($("#output-list"), () => {
    const list = filterOutputItems(outputItems, $("#result-search").value, outputFilter);
    const container = $("#output-list");
    if (!list.length) {
      container.innerHTML = `<div class="empty-output">${outputItems.length ? "조건에 맞는 결과가 없습니다." : "아직 완성된 결과가 없습니다."}</div>`;
      return;
    }
    // 결과를 나열하는 것과, 남은 일을 보여 주는 것은 다르다. 상태를 한 마디로
    // 적고, 레슨으로 나눈 작업은 하나로 묶어 어디에 할 일이 남았는지 먼저
    // 읽히게 한다.
    const findingsOf = (item) => visibleVoiceFindings(item.voiceFindings, item.review?.clearedFindings);

    function buildRow(item, { compact = false } = {}) {
      const kind = outputKind(item);
      const findings = findingsOf(item);
      const state = outputState(item, findings);
      const approved = item.review?.status === "approved";
      const target = { root: item.root, name: item.name, day: item.day, store: item.store };

      const row = document.createElement("article");
      row.className = "output-item";
      row.dataset.state = state.key;
      row.innerHTML = `
        <div class="output-type ${kind}">${kind === "edit" ? "✂" : item.video ? "▶" : "♪"}</div>
        <div class="output-copy"><strong></strong><small></small></div>
        <div class="output-status" aria-label="결과 상태"><span class="state-pill ${state.tone}"></span></div>
        <div class="item-actions">
          <button class="open-button" type="button">열기</button>
          <details class="result-menu">
            <summary aria-label="결과 작업 더 보기">•••</summary>
            <div>
              <button class="review-button${approved ? " approved" : ""}" type="button">${approved ? "청취 승인 취소" : "청취 승인으로 표시"}</button>
              <button class="reveal-button" type="button">Finder에서 보기</button>
            </div>
          </details>
        </div>`;

      row.querySelector("strong").textContent = compact
        ? compactOutputLabel(item)
        : (item.displayName || item.name);
      row.querySelector("small").textContent = [
        compact ? "" : outputLabel(item),
        formatDuration(item.durationMs),
        compact ? "" : formatDate(item.updatedAt),
        findings.length ? voiceFindingSummaryLine(findings) : "",
      ].filter(Boolean).join(" · ");

      const pill = row.querySelector(".state-pill");
      pill.textContent = state.label;
      pill.tabIndex = 0;
      const detail = state.key === "failed"
        ? "자동 검증에 실패했거나 기록이 없습니다."
        : state.key === "attention"
          ? `${voiceFindingSummaryLine(findings)} · 다듬기에서 처리하세요`
          : state.key === "approved"
            ? "직접 듣고 승인한 결과입니다."
            : "자동 검수에서 걸린 곳이 없습니다. 직접 들어 보고 승인할 수 있습니다.";
      pill.dataset.tooltip = detail;
      pill.setAttribute("aria-label", `${state.label} · ${detail}`);

      const resultMenu = row.querySelector(".result-menu");
      resultMenu.addEventListener("toggle", () => {
        if (!resultMenu.open) { resultMenu.classList.remove("open-upward"); return; }
        $$(".result-menu[open]").forEach((other) => { if (other !== resultMenu) other.removeAttribute("open"); });
        const popover = resultMenu.querySelector(":scope > div");
        const availableBelow = window.innerHeight - resultMenu.getBoundingClientRect().bottom;
        resultMenu.classList.toggle("open-upward", shouldOpenMenuUpward(availableBelow, popover.offsetHeight));
      });
      row.querySelector(".review-button").addEventListener("click", async () => {
        try {
          item.review = await api.setOutputReview(target, approved ? "pending" : "approved");
          renderOutputSummary();
          renderOutputs();
          showToast(approved ? "청취 승인을 취소했습니다." : "직접 들은 결과로 표시했습니다.");
        } catch (error) { showToast(error.message, "error"); }
      });
      if (item.video) {
        row.querySelector(".open-button").textContent = findings.length ? "다듬기" : "열기";
        row.querySelector(".open-button").addEventListener("click", () => openReview(target));
      } else {
        row.querySelector(".open-button").addEventListener("click", () => api.open(target).catch((error) => showToast(error.message, "error")));
      }
      row.querySelector(".reveal-button").addEventListener("click", () => {
        resultMenu.removeAttribute("open");
        api.reveal(target).catch((error) => showToast(error.message, "error"));
      });
      return row;
    }

    function buildGroup(group) {
      const box = document.createElement("section");
      box.className = "output-group";
      const head = document.createElement("header");
      head.className = "output-group-head";
      const title = document.createElement("strong");
      title.textContent = outputGroupTitle(group);
      const meta = document.createElement("small");
      meta.textContent = `레슨 ${group.items.length}편 · ${formatDate(group.updatedAt)}`;
      const state = document.createElement("span");
      state.className = `state-pill ${group.attention ? "attention" : "ready"}`;
      state.textContent = group.attention
        ? `${group.attention}편에 확인 ${group.findings}곳`
        : "모두 확인 끝";
      const copy = document.createElement("div");
      copy.append(title, meta);
      head.append(copy, state);

      const body = document.createElement("div");
      body.className = "output-group-body";
      body.append(...group.items.map((item) => buildRow(item, { compact: true })));

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "output-group-toggle";
      // 할 일이 남은 묶음은 펼쳐 둔다. 다 끝난 묶음까지 열어 두면 남은 일이 묻힌다.
      let open = group.attention > 0;
      const paint = () => {
        body.classList.toggle("hidden", !open);
        toggle.textContent = open ? "접기" : `${group.items.length}편 보기`;
        toggle.setAttribute("aria-expanded", String(open));
      };
      toggle.addEventListener("click", () => { open = !open; paint(); });
      paint();
      head.append(toggle);

      box.append(head, body);
      return box;
    }

    container.replaceChildren(...groupOutputs(list, findingsOf).map((row) =>
      row.type === "group" ? buildGroup(row) : buildRow(row.item)));
  });
}

async function loadOutputs() {
  const refresh = $("#refresh-outputs");
  refresh.disabled = true;
  refresh.textContent = "불러오는 중";
  try {
    outputItems = await api.listOutputs();
    renderOutputSummary();
    renderOutputs();
  } catch (error) {
    $("#output-list").innerHTML = '<div class="empty-output">결과를 불러오지 못했습니다.</div>';
    showToast(error.message, "error");
  } finally {
    refresh.disabled = false;
    refresh.textContent = "새로고침";
  }
}

function renderSettings(settings) {
  appSettings = settings;
  $("#global-model").value = settings.modelId;
  const adapterSelect = $("#global-adapter");
  const options = [{ id: "none", label: "어댑터 없음 · 기본 복제" }, ...(settings.adapters || [])];
  adapterSelect.replaceChildren(...options.map((item) => {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.label;
    return option;
  }));
  adapterSelect.value = settings.adapterId;
  adapterSelect.disabled = settings.modelId !== "qwen3-tts";
  $("#global-scale").value = String(settings.adapterScale);
  $("#global-parallelism").value = String(settings.voiceParallelism);
  $("#global-scale-field").classList.toggle("hidden", settings.modelId !== "qwen3-tts" || settings.adapterId === "none");
  paintGlobalRange();
  const selectedAdapter = settings.adapters?.find((item) => item.id === settings.adapterId) || null;
  const approved = settings.modelId === "qwen3-tts"
    && selectedAdapter?.label === "jaeho-ko-r16-v1"
    && Math.abs(Number(settings.adapterScale || 0.6) - 0.6) < 0.001;
  $("#sidebar-model").textContent = approved ? "제작 목소리" : "음성 설정";
  $("#sidebar-adapter").textContent = selectedAdapter
    ? `${selectedAdapter.label} · ${Number(settings.adapterScale).toFixed(2)}`
    : settings.modelId === "chatterbox-v3" ? "Chatterbox V3" : "Qwen3 기본 복제";
  for (const [key, value] of Object.entries(settings.paths || {})) {
    const input = $(`#path-${key}`);
    if (input) input.value = value;
  }
  $("#output-root-name").textContent = fileName(settings.paths?.outputRoot || "output");
  updateVoicePageMeta();
  updateProductionBrief();
  updateVoiceDesign();
  updateProfileGuard();
}

function updateProfileGuard() {
  const modelId = $("#global-model").value;
  const adapterId = $("#global-adapter").value;
  const adapter = appSettings?.adapters?.find((item) => item.id === adapterId);
  const scale = Number($("#global-scale").value);
  const approved = modelId === "qwen3-tts" && adapter?.label === "jaeho-ko-r16-v1" && Math.abs(scale - 0.6) < 0.001;
  const guard = $("#profile-guard");
  guard.classList.toggle("approved", approved);
  guard.classList.toggle("experimental", !approved);
  guard.querySelector(":scope > span").textContent = approved ? "✓" : "!";
  $("#profile-guard-title").textContent = approved ? "제작 목소리" : "실험 설정";
  $("#profile-guard-copy").textContent = approved
    ? "jaeho-ko-r16-v1 · 강도 0.60"
    : `${modelId === "chatterbox-v3" ? "Chatterbox V3" : adapter?.label || "Qwen3 기본 복제"}${adapter ? ` · 강도 ${scale.toFixed(2)}` : ""}`;
  $("#restore-production-profile").classList.toggle("hidden", approved);
}

function restoreProductionProfile() {
  const adapter = appSettings?.adapters?.find((item) => item.label === "jaeho-ko-r16-v1");
  $("#global-model").value = "qwen3-tts";
  $("#global-adapter").disabled = false;
  if (adapter) $("#global-adapter").value = adapter.id;
  $("#global-scale").value = "0.6";
  $("#global-scale-field").classList.toggle("hidden", !adapter);
  paintGlobalRange();
  updateProfileGuard();
}

async function openModelSettings() {
  renderSettings(await api.getSettings());
  $("#finetune-name").value = `jaeho-ko-r16-${dateStamp()}`.toLowerCase();
  $("#finetune-panel").classList.add("hidden");
  $("#open-finetune-panel").setAttribute("aria-expanded", "false");
  $(".advanced-engine-settings").open = false;
  $(".advanced-paths").open = false;
  $("#model-settings-dialog").showModal();
}

function handleTrainingEvent(event) {
  if (event.type === "training-started") {
    openJobDialog("파인튜닝 학습 중");
    $("#edit-running-label").textContent = "새 음성 어댑터를 학습하고 있습니다.";
  } else if (event.type === "log") {
    appendEditLog(event.text);
  } else if (event.type === "training-failed") {
    $("#edit-dialog-spinner").classList.add("hidden");
    $("#edit-dialog-error").classList.remove("hidden");
    $("#edit-error-message").textContent = event.message;
    $("#cancel-edit-button").classList.add("hidden");
    $("#close-edit-dialog").classList.remove("hidden");
  } else if (event.type === "training-complete") {
    renderSettings(event.settings);
    $("#edit-dialog-spinner").classList.add("hidden");
    $("#edit-dialog-success").classList.remove("hidden");
    $("#edit-complete-summary").textContent = `${event.adapter?.label || "새 어댑터"} 학습 완료 · 전역 설정에 적용됨`;
    $("#cancel-edit-button").classList.add("hidden");
    $("#close-edit-dialog").classList.remove("hidden");
  }
}

function handleJobEvent(event) {
  if (["log", "progress", "stage"].includes(event.type)) return renderJobEvent(event);
  const container = ["edit", "text-voice", "training"].includes(event.jobKind)
    ? $("#edit-job-dialog .job-modal-body") : $("#job-workspace");
  return animateLayout(container, () => renderJobEvent(event));
}

function renderJobEvent(event) {
  if (event.jobKind === "text-voice") {
    handleTextVoiceEvent(event);
    return;
  }
  if (event.jobKind === "edit") {
    handleEditEvent(event);
    return;
  }
  if (event.jobKind === "training") {
    handleTrainingEvent(event);
    return;
  }
  if (event.type === "started") {
    creationState = "running";
    latestTarget = { root: "render", name: event.options.name };
    $("#open-latest").textContent = "영상 열기";
    $("#job-log").textContent = "";
    renderCompleteVoiceFindings([]);
    showJobView("active");
    setBusy(true);
    setJobState("실행 중", "running");
    resetCancelButton($("#cancel-button"));
    resetJobPace();
    updateStages("starting");
  } else if (event.type === "plan") {
    jobPlan = { units: event.units || [], completedPages: 0, completedMs: 0, unitStartedAt: null };
    renderJobPace();
  } else if (event.type === "unit") {
    advanceChapterPlan(event.index);
    jobUnit = { index: event.index, total: event.total };
    // 편이 바뀌면 속도 관측을 다시 시작한다. 레슨마다 길이가 달라 앞 편의
    // 속도로 다음 편을 재면 남은 시간이 크게 어긋난다.
    jobPace = null;
    renderJobPace();
  } else if (event.type === "voice-progress") {
    if (creationState !== "running") return;
    if (!jobPace || jobPace.total !== event.total) {
      jobPace = { baseline: event.done, total: event.total, startedAt: Date.now(), done: event.done };
    } else {
      jobPace.done = event.done;
    }
    renderJobPace();
  } else if (event.type === "stage") {
    if (creationState !== "running") return;
    updateStages(event.stage, event.state === "done" && event.stage === "verify");
  } else if (event.type === "log") {
    appendLog(event.text);
  } else if (event.type === "paused") {
    setJobState("일시정지", "paused");
    $("#pause-button").textContent = "이어하기";
    $("#current-stage").textContent = event.immediate ? "일시정지됨" : "이번 편을 마치고 멈춥니다";
    // 멈춰 있는 동안은 시간을 세지 않는다. 그러지 않으면 남은 시간이 멈춘
    // 만큼 부풀어 다시 켰을 때 엉뚱한 값을 말한다.
    jobPausedAt = Date.now();
  } else if (event.type === "resumed") {
    setJobState("실행 중", "running");
    $("#pause-button").textContent = "일시정지";
    if (jobPausedAt) {
      const away = Date.now() - jobPausedAt;
      if (jobPace) jobPace.startedAt += away;
      if (jobPlan?.unitStartedAt) jobPlan.unitStartedAt += away;
      jobPausedAt = null;
    }
    renderJobPace();
  } else if (event.type === "cancelling") {
    creationState = "cancelling";
    setJobState("중지 중", "running");
    $("#current-stage").textContent = "안전하게 중지 중";
    $("#cancel-button").disabled = true;
    $("#cancel-button").textContent = "중지 중…";
  } else if (event.type === "failed") {
    refreshResumable();
    creationState = event.cancelled ? "cancelled" : "failed";
    setBusy(false);
    resetCancelButton($("#cancel-button"));
    showJobView("active");
    setJobState(event.cancelled ? "중지됨" : "오류", event.cancelled ? "idle" : "failed");
    $("#current-stage").textContent = event.message;
    appendLog(`\n[중단] ${event.message}\n`);
    $("#job-log").closest("details").open = true;
    loadOutputs();
  } else if (event.type === "complete") {
    refreshResumable();
    creationState = "done";
    setBusy(false);
    resetCancelButton($("#cancel-button"));
    showJobView("complete");
    setJobState("완료", "idle");
    updateStages("verify", true);
    const report = event.report;
    latestTarget = report.target;
    const findings = report.voiceFindings || [];
    const unitCount = report.units?.length || 1;
    const voiceLine = findings.length
      ? ` · 목소리 확인 ${findings.length}곳`
      : report.voiceQuality ? " · 목소리 검수 통과" : "";
    $("#complete-summary").textContent = unitCount > 1
      ? `${unitCount}개 영상 · ${formatDuration(report.durationMs)} 합계 · 모든 결과 검증 통과`
      : `${formatDuration(report.durationMs)} · ${report.summary.passed}개 항목 모두 통과${voiceLine}`;
    $("#open-latest").textContent = unitCount > 1 ? "첫 영상 열기" : "영상 열기";
    renderCompleteVoiceFindings(findings, report.videoPath ? report.target : null);
    loadOutputs();
    $("#job-name").value = suggestedName();
    updateProductionBrief();
  }
}

// 제작은 길다. 무엇을 하는 중인지만 알려주고 언제 끝나는지는 말해 주지 않으면
// 자리를 뜰 수도, 기다릴 수도 없다.
//
// 시계가 둘 필요한 경우는 하나뿐이다. 레슨 하나, 페이지 직접 선택, 챕터를 한
// 영상으로 만들기는 모두 한 편짜리라 '이 작업이 언제 끝나는지'가 곧 전부다.
// 챕터를 레슨 단위로 나눌 때만 '이 편'과 '전체'가 서로 다른 답이 되고, 그때만
// main 이 plan 을 보낸다.
let jobPace = null;
let jobUnit = null;
let jobPlan = null;
let jobPausedAt = null;

// 목소리 후보도 하나에 수십 초씩 걸린다. 몇 개 남았는지만 알려주는 것과
// 얼마나 더 기다려야 하는지 알려주는 것은 다르다.
let batchPace = null;

function trackBatchProgress(event) {
  if (!batchPace || batchPace.total !== event.total) {
    batchPace = { baseline: event.completed, total: event.total, startedAt: Date.now() };
  }
  $("#batch-eta").textContent = etaLabel({
    done: event.completed,
    total: event.total,
    elapsedMs: Date.now() - batchPace.startedAt,
    baseline: batchPace.baseline,
  });
}

function resetBatchProgress() {
  batchPace = null;
  $("#batch-eta").textContent = "";
}

function renderJobPace() {
  const unit = jobUnit ? unitLabel(jobUnit) : "";
  $("#job-unit").textContent = unit;
  $("#job-unit").classList.toggle("hidden", !unit);
  $("#job-eta").textContent = jobPace
    ? etaLabel({
        done: jobPace.done,
        total: jobPace.total,
        elapsedMs: Date.now() - jobPace.startedAt,
        baseline: jobPace.baseline,
        scope: jobPlan ? "unit" : "job",
      })
    : "";
  const whole = jobPlan ? chapterProgressLabel() : "";
  $("#job-total-eta").textContent = whole;
  $("#job-total-eta").classList.toggle("hidden", !whole);
}

function chapterProgressLabel() {
  const units = jobPlan.units || [];
  const index = Math.max(1, Number(jobUnit?.index || 1));
  const current = units[index - 1];
  if (!current) return "";
  return chapterEtaLabel({
    completedPages: jobPlan.completedPages,
    completedMs: jobPlan.completedMs,
    currentPages: current.pages,
    currentElapsedMs: jobPlan.unitStartedAt ? Date.now() - jobPlan.unitStartedAt : 0,
    pendingPages: units.slice(index).reduce((total, unit) => total + Number(unit.pages || 0), 0),
  });
}

// 편이 끝날 때마다 그 편의 실제 소요와 분량을 더해 속도를 갱신한다.
function advanceChapterPlan(index) {
  if (!jobPlan) return;
  const previous = (jobPlan.units || [])[index - 2];
  if (previous && jobPlan.unitStartedAt) {
    jobPlan.completedMs += Date.now() - jobPlan.unitStartedAt;
    jobPlan.completedPages += Number(previous.pages || 0);
  }
  jobPlan.unitStartedAt = Date.now();
}

function resetJobPace() {
  jobPace = null;
  jobUnit = null;
  jobPlan = null;
  jobPausedAt = null;
  $("#pause-button").textContent = "일시정지";
  renderJobPace();
}

// 청크 하나가 몇십 초 걸리므로, 이벤트 사이에도 남은 시간이 줄어드는 것이
// 보이도록 주기적으로 다시 그린다.
if (typeof setInterval === "function") {
  setInterval(() => { if (jobPace) renderJobPace(); }, 5_000);
}

async function initialize() {
  window.scrollTo(0, 0);
  if (!api) {
    $("#runtime-label").textContent = "Electron에서 열어 주세요";
    $("#open-model-settings").dataset.tooltip = "Electron에서 열어 주세요";
    return;
  }
  $("#job-name").value = suggestedName();
  $("#text-voice-name").value = suggestedTextVoiceName();
  api.onJobEvent(handleJobEvent);
  refreshResumable();
  const [status, settings] = await Promise.all([api.getStatus(), api.getSettings()]);
  renderSettings(settings);
  catalogPages = status.catalog?.pages || [];
  catalogLessons = status.catalog?.lessons || [];
  totalPages = Math.max(1, Number(status.catalog?.totalPages || 0));
  populateChapters();
  populateLessons();
  for (const selector of ["#start-page", "#end-page"]) {
    $(selector).max = String(totalPages);
  }
  for (const selector of ["#voice-start-page", "#voice-end-page"]) {
    $(selector).max = String(totalPages);
  }
  $("#start-page-total").textContent = `/ ${totalPages}`;
  $("#end-page-total").textContent = `/ ${totalPages}`;
  updatePageScope();
  updateVoicePageMeta();
  updateProductionBrief();
  updateVoiceDesign();
  const capabilities = status.capabilities || {};
  const readyCount = Object.values(capabilities).filter(Boolean).length;
  const ready = readyCount === Object.keys(capabilities).length && readyCount > 0;
  $("#runtime-dot").classList.toggle("ready", readyCount > 0);
  const runtimeLabel = ready
    ? "전체 기능 준비됨"
    : readyCount > 0 ? "일부 기능 준비됨" : "환경 설정 필요";
  $("#runtime-label").textContent = runtimeLabel;
  $("#open-model-settings").dataset.tooltip = runtimeLabel;
  for (const issue of status.setupIssues || []) appendLog(`[환경] ${issue}\n`);
  setBusy(false);
  if (["running", "cancelling"].includes(status.activeJob?.state)) {
    if (status.activeJob.kind === "edit") {
      openJobDialog("영상 편집 중");
      setEditBusy(true);
    } else if (status.activeJob.kind === "training") {
      openJobDialog("파인튜닝 학습 중");
    } else if (status.activeJob.kind === "text-voice") {
      candidatePurpose = "text";
      openJobDialog("텍스트 목소리 후보 생성 중");
      $("#start-text-voices").disabled = true;
    } else {
      creationState = status.activeJob.state;
      showJobView("active");
      setBusy(true);
      setJobState("실행 중", "running");
      updateStages(status.activeJob.stage);
      if (creationState === "cancelling") handleJobEvent({ type: "cancelling", jobKind: "create" });
    }
  }
  if (status.activeJob?.kind === "create" && ["failed", "cancelled"].includes(status.activeJob.state)) {
    handleJobEvent({ type: "failed", cancelled: status.activeJob.state === "cancelled", message: status.activeJob.error || "이전 작업이 종료됐습니다." });
  }
  await loadOutputs();
  const initialView = new URLSearchParams(window.location.search).get("view");
  if (["voice", "review", "edit", "results"].includes(initialView)) {
    $(`[data-view='${initialView}']`).click();
  } else if (["results-menu-bottom", "results-menu-outside"].includes(initialView)) {
    $("[data-view='results']").click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const lastResult = $$(".output-item").at(-1);
    lastResult?.scrollIntoView({ block: "end" });
    lastResult?.querySelector(".result-menu")?.setAttribute("open", "");
    if (initialView === "results-menu-outside") $("#output-list").click();
    return;
  } else if (initialView === "replace-voice") {
    $("[data-view='review']").click();
  } else if (initialView === "settings") {
    await openModelSettings();
  }
  window.scrollTo(0, 0);
}

$$("#mode-options button").forEach((button) => button.addEventListener("click", () => setProductionMode(button.dataset.mode)));
$("#lesson-select").addEventListener("change", applySelectedLesson);
$("#chapter-select").addEventListener("change", applySelectedChapter);
$$("#chapter-mode-options button").forEach((button) => button.addEventListener("click", () => setChapterMode(button.dataset.chapterMode)));
$("#start-page").addEventListener("input", () => {
  if (Number($("#end-page").value) < Number($("#start-page").value)) {
    $("#end-page").value = $("#start-page").value;
  }
  updatePageScope();
});
$("#end-page").addEventListener("input", updatePageScope);
$("#previous-page").addEventListener("click", () => moveToPage(Number($("#start-page").value) - 1));
$("#next-page").addEventListener("click", () => moveToPage(Number($("#start-page").value) + 1));
$("#deliverable").addEventListener("change", (event) => {
  $("#burn-captions").disabled = event.target.value !== "video";
  updateProductionBrief();
});
$("#burn-captions").addEventListener("change", updateProductionBrief);
$("#job-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if ($("#start-button").disabled) return;
  setBusy(true);
  try {
    await api.start(optionPayload());
  } catch (error) {
    creationState = "failed";
    setBusy(false);
    showJobView("active");
    $("#current-stage").textContent = error.message;
    $("#job-log").closest("details").open = true;
    $("#job-form").classList.add("shake");
    setTimeout(() => $("#job-form").classList.remove("shake"), 600);
    appendLog(`[오류] ${error.message}\n`);
    setJobState("확인 필요", "failed");
  }
});
$("#text-voice-input").addEventListener("input", (event) => {
  $("#text-voice-length").textContent = new Intl.NumberFormat("ko-KR").format(event.target.value.length);
  updateVoiceDesign();
});
$("#text-voice-count").addEventListener("input", updateVoiceDesign);
$("#text-voice-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api.startTextVoices({
      name: $("#text-voice-name").value.trim(),
      text: $("#text-voice-input").value,
      candidateCount: Number($("#text-voice-count").value),
    });
  } catch (error) {
    $("#text-voice-form").classList.add("shake");
    setTimeout(() => $("#text-voice-form").classList.remove("shake"), 600);
    openJobDialog("입력 확인 필요");
    $("#edit-dialog-spinner").classList.add("hidden");
    $("#edit-dialog-error").classList.remove("hidden");
    $("#edit-error-message").textContent = error.message;
    $("#cancel-edit-button").classList.add("hidden");
    $("#close-edit-dialog").classList.remove("hidden");
  }
});
$("#cancel-button").addEventListener("click", (event) => requestJobCancellation(event.currentTarget, "create"));
$("#open-latest").addEventListener("click", () => latestCompleteReview ? openReview(latestCompleteReview) : latestTarget && api.open(latestTarget));
$("#reveal-latest").addEventListener("click", () => latestTarget && api.reveal(latestTarget));
$("#refresh-outputs").addEventListener("click", loadOutputs);
$("#result-search").addEventListener("input", renderOutputs);
document.addEventListener("click", (event) => {
  if (!event.target.closest(".result-menu")) closeResultMenus();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !document.querySelector(".result-menu[open]")) return;
  event.preventDefault();
  closeResultMenus({ restoreFocus: true });
});
$$("#result-filters button").forEach((button) => button.addEventListener("click", () => {
  outputFilter = button.dataset.outputFilter;
  $$("#result-filters button").forEach((item) => item.classList.toggle("selected", item === button));
  renderOutputs();
}));
$("#pick-voice-video").addEventListener("click", async () => {
  try { const [video] = await api.pickVideos(false); if (video) setReviewVideo(video); }
  catch (error) { showToast(error.message, "error"); }
});
$("#voice-start-page").addEventListener("input", () => {
  if (Number($("#voice-end-page").value) < Number($("#voice-start-page").value)) $("#voice-end-page").value = $("#voice-start-page").value;
  updateVoicePageMeta();
});
$("#voice-end-page").addEventListener("input", updateVoicePageMeta);
$("#cancel-edit-button").addEventListener("click", (event) => requestJobCancellation(event.currentTarget, "edit"));
$("#open-edit-result").addEventListener("click", () => latestEditTarget && api.open(latestEditTarget));
$("#reveal-edit-result").addEventListener("click", () => latestEditTarget && api.reveal(latestEditTarget));
$("#apply-voice-candidate").addEventListener("click", async () => {
  if (!selectedCandidateToken) return;
  try {
    if (candidatePurpose === "text") {
      await api.selectTextVoice(selectedCandidateToken);
      return;
    }
    if (!pendingCandidateContext || reviewBusy) return;
    $$('audio,video').forEach(media => media.pause());
    // Queue it instead of writing a video now. The whole set is applied in one
    // pass when the user saves, so the picture is encoded once, not once per fix.
    const chosen = voiceCandidates.find(item => item.token === selectedCandidateToken);
    if (queueSelectedCandidate(selectedCandidateToken, chosen?.name)) return;
    setEditBusy(true);
    await api.startEdit({
      operation: "voice", name: `${pendingCandidateContext.name}-applied-${Date.now()}`,
      videoToken: pendingCandidateContext.videoToken,
      audioSource: "file", audioToken: selectedCandidateToken,
      startPage: pendingCandidateContext.startPage, endPage: pendingCandidateContext.endPage,
      durationPolicy: pendingCandidateContext.durationPolicy,
    });
  } catch (error) {
    setEditBusy(false);
    openJobDialog("교체 실패");
    $("#edit-dialog-title").textContent = "교체 실패";
    $("#candidate-gallery").classList.add("hidden");
    $("#edit-dialog-error").classList.remove("hidden");
    $("#edit-error-message").textContent = error.message;
  }
});
$("#close-edit-dialog").addEventListener("click", () => $("#edit-job-dialog").close());
$("#open-model-settings").addEventListener("click", openModelSettings);
$$('[data-close-dialog]').forEach((button) => button.addEventListener("click", () => $(`#${button.dataset.closeDialog}`).close()));
$("#global-adapter").addEventListener("change", () => {
  $("#global-scale-field").classList.toggle("hidden", $("#global-adapter").value === "none");
  updateProfileGuard();
});
$("#global-model").addEventListener("change", () => {
  const qwen = $("#global-model").value === "qwen3-tts";
  $("#global-adapter").disabled = !qwen;
  $("#global-scale-field").classList.toggle("hidden", !qwen || $("#global-adapter").value === "none");
  updateProfileGuard();
});
$("#global-scale").addEventListener("input", () => {
  paintGlobalRange();
  updateProfileGuard();
});
$("#restore-production-profile").addEventListener("click", restoreProductionProfile);
$("#save-model-settings").addEventListener("click", async () => {
  const settings = await api.saveSettings({
    modelId: $("#global-model").value,
    adapterId: $("#global-adapter").value,
    adapterScale: Number($("#global-scale").value),
    voiceParallelism: Number($("#global-parallelism").value),
    paths: Object.fromEntries(
      $$("[id^='path-']").map((input) => [input.id.slice("path-".length), input.value]),
    ),
  });
  renderSettings(settings);
  $("#model-settings-dialog").close();
});
$$('[data-pick-path]').forEach((button) => button.addEventListener("click", async () => {
  const value = await api.pickLocation(button.dataset.pickPath);
  if (value) {
    $(`#path-${button.dataset.pickPath}`).value = value;
    if (button.dataset.pickPath === "outputRoot") $("#output-root-name").textContent = fileName(value);
  }
}));
$("#open-finetune-panel").addEventListener("click", () => {
  animateLayout($("#finetune-panel").closest(".settings-column"), () => {
    $("#finetune-panel").classList.toggle("hidden");
    $("#open-finetune-panel").setAttribute("aria-expanded", String(!$("#finetune-panel").classList.contains("hidden")));
  });
});
$("#start-finetune").addEventListener("click", async () => {
  const name = $("#finetune-name").value.trim();
  const maxSteps = Number($("#finetune-steps").value);
  $("#model-settings-dialog").close();
  openJobDialog("파인튜닝 준비 중");
  try {
    await api.startFinetune({ name, maxSteps });
  } catch (error) {
    $("#edit-job-dialog").close();
    await openModelSettings();
    $("#finetune-panel").classList.remove("hidden");
    $("#finetune-panel > p").textContent = error.message;
  }
});

function attachNativeDrop(element, kind, onFiles) {
  element.addEventListener("dragover", (event) => { event.preventDefault(); element.classList.add("drag-over"); });
  element.addEventListener("dragleave", () => element.classList.remove("drag-over"));
  element.addEventListener("drop", async (event) => {
    event.preventDefault();
    element.classList.remove("drag-over");
    try { onFiles(await api.registerDroppedFiles(event.dataTransfer.files, kind)); }
    catch (error) { appendEditLog(`[파일 오류] ${error.message}\n`); }
  });
}
attachNativeDrop($("#editor-drop"), "video", (files) => addEditorClips(files));
attachNativeDrop($("#pick-voice-video"), "video", (files) => { if (files[0]) setReviewVideo(files[0]); });
let currentView = "new";
let renderedView = "new";
let navigationVersion = 0;
const viewScrollPositions = new Map();
const viewHistory = createViewHistory('new');
function navigateToView(view, traversal = false) {
  if (view === currentView) return;
  if (!traversal) viewHistory.visit(view);
  $('#window-back').disabled = !viewHistory.canBack;
  $('#window-forward').disabled = !viewHistory.canForward;
  const button = $(`.nav-item[data-view="${view}"]`);
  viewScrollPositions.set(renderedView, window.scrollY);
  currentView = view;
  const version = ++navigationVersion;
  transitionPage(() => {
    if (version !== navigationVersion) return;
    $$(".nav-item").forEach((item) => {
      item.classList.toggle("active", item === button);
      if (item === button) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
    renderedView = view;
    for (const page of $$(".page-view")) page.classList.toggle("hidden", page.id !== `view-${view}`);
    window.scrollTo({ top: viewScrollPositions.get(view) || 0, behavior: "instant" });
  });
  if (view !== "review") reviewPlayer.pause();
  if (view === "results") loadOutputs();
}
$$('[data-view]').forEach(button => button.addEventListener('click', () => navigateToView(button.dataset.view)));
$('#window-back').addEventListener('click', () => navigateToView(viewHistory.back(), true));
$('#window-forward').addEventListener('click', () => navigateToView(viewHistory.forward(), true));
initialize().catch((error) => {
  $("#runtime-label").textContent = "환경 확인 실패";
  appendLog(`[초기화 오류] ${error.message}\n`);
});

setEditOperation("merge");
setTrimMode("time");

// One audible source at a time when comparing the original with candidates.
document.addEventListener('play', event => {
  if (!event.target.matches('audio,video')) return;
  $$('audio,video').forEach(media => { if (media !== event.target) media.pause(); });
}, true);
