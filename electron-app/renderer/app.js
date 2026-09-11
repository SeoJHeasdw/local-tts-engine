import { createOutputsController } from "./controllers/outputs.mjs";
import { createEditorController } from "./controllers/editor.mjs";
import { createReviewController } from "./controllers/review.mjs";
import { animateLayout, transitionPage, dismissToast, appendFollowingLog } from "./motion.mjs";
import { VIDEO_QUALITIES, DEFAULT_VIDEO_QUALITY, videoQuality } from "../shared/video-quality.mjs";

import { buildChapterRanges, createViewHistory, completionFindings, completionSummary, etaLabel, summarizePageRange, summarizeVoiceFindings, unitLabel, voiceFindingReason } from "./view-utils.mjs";
import { createJobPace } from "./job-pace.mjs";

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
const mediaState = { latestEditTarget: null, voiceVideo: null };
let appSettings = null;
let voiceCandidates = [];
let selectedCandidateToken = null;
let candidatePurpose = "edit";
let catalogChapters = [];
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
  $("#video-quality-field").classList.toggle("hidden", deliverable !== "video");
  $("#video-quality").disabled = deliverable !== "video";
  const quality = videoQuality($("#video-quality").value || DEFAULT_VIDEO_QUALITY);
  $("#video-quality-hint").textContent = quality.id === "ultra"
    ? "4K로 글자와 도형의 세부를 살립니다. 제작 시간과 파일 크기가 가장 큽니다."
    : quality.id === "high"
      ? "1080p보다 약 1.8배 많은 픽셀로 글자와 도형을 선명하게 만듭니다."
      : "기존과 같은 화면 크기입니다. 중간 녹화 압축을 제거해 선명도는 개선했습니다.";
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
  $("#pause-button").classList.toggle("hidden", !busy);
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
    renderJobPace();
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
        renderJobPace();
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
      renderJobPace();
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

// outputs 는 아래에서 만들어지지만, 이 함수는 화면을 열 때 불린다.
const review = createReviewController({ $, api, showToast, setEditBusy, $$, formatDuration, updateVoicePageMeta, mediaState,
  neighbours: (target) => outputs.videoNeighbours(target), refreshOutputs: () => outputs.loadOutputs() });

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

// 사이드바 접기. 폭은 CSS 토큰 하나로 정해지므로 클래스만 토글하면 된다.
// 선택은 이 기기에만 남기면 되는 취향이라 localStorage에 둔다. 사생활 보호
// 창이나 저장이 막힌 환경에서는 접근 자체가 던지므로 감싸 둔다.
const SIDEBAR_KEY = 'voiceStudio.sidebarCollapsed';

function applySidebarCollapsed(collapsed, { animate = false } = {}) {
  // 첫 그림은 미끄러지지 않는다. 창을 여는 순간 사이드바가 제 자리를 찾아
  // 움직이면 무언가 잘못된 것처럼 보인다. 누른 뒤부터만 움직인다.
  document.body.classList.toggle('sidebar-motion', animate);
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  const toggle = $('#sidebar-toggle');
  toggle.setAttribute('aria-expanded', String(!collapsed));
  const label = collapsed ? '사이드바 펼치기' : '사이드바 접기';
  toggle.setAttribute('aria-label', label);
  toggle.dataset.tooltip = label;
}

$('#sidebar-toggle').addEventListener('click', () => {
  const collapsed = !document.body.classList.contains('sidebar-collapsed');
  applySidebarCollapsed(collapsed, { animate: true });
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
      : pending.failed ? "실패한 레슨을 다시 제작할 수 있습니다"
      : "이어서 만들 작업이 있습니다";
    const when = pending.startedAt ? `${formatDate(pending.startedAt)} 시작 · ` : "";
    $("#resume-detail").textContent = pending.total > 1
      ? `${when}${pending.title} · ${pending.total}편 중 ${pending.done}편 완료 · 남은 ${pending.remaining}편을 이어서 만듭니다`
      : `${when}${pending.title} · 처음부터 다시 만듭니다`;
  } catch { $("#resume-banner").classList.add("hidden"); }
}

$("#pause-button").addEventListener("click", async () => {
  const paused = ["이어하기", "정지 예약 취소"].includes($("#pause-button").textContent);
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
    videoQuality: $("#video-quality").value || DEFAULT_VIDEO_QUALITY,
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
const editor = createEditorController({ $, formatDuration, review, setIconStatus, api, showToast, setEditBusy, openJobDialog });

function setEditBusy(busy) {
  review.reviewBusy = busy;
  $("#review-form").querySelectorAll("input,select,button").forEach(el => { el.disabled = busy; });
  $("#pick-voice-video").disabled = busy;
  $$('#review-region-wave button').forEach(button=>{button.disabled=busy;});
  review.updateReviewAction();
  review.updateReviewPosition();
  $("#start-edit-button").disabled = busy;
  $$("#view-edit input, #view-edit select, #view-edit button").forEach((element) => { element.disabled = busy; });
  if (!busy) editor.renderEditorTrack();
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
    if (event.options) review.pendingCandidateContext = { ...event.options };
    $('#review-candidates-host').classList.remove('hidden');
    const spoken = review.pendingCandidateContext?.overrideText;
    $('#review-candidate-scope').textContent = `${review.pendingCandidateContext?.sourceDisplayName || ''} · ${review.pendingCandidateContext?.startPage || ''}페이지 전체 음성을 교체합니다.${spoken ? ` 입력한 말: “${spoken}”` : ''}`;
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
    mediaState.latestEditTarget = event.report.target;
    if (event.report.operation === 'voice-pages') { review.pendingFixes.clear(); review.renderPendingFixes(); }
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
    outputs.loadOutputs();
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
    mediaState.latestEditTarget = event.report.target;
    setIconStatus("#voice-top-status", "목소리 선택과 저장이 완료됐습니다", "complete");
    $("#candidate-gallery").classList.add("hidden");
    $("#edit-dialog-success").classList.remove("hidden");
    $("#edit-complete-summary").textContent = `${formatDuration(event.report.durationMs)} · 선택한 WAV를 별도로 보관했습니다.`;
    $("#apply-voice-candidate").classList.add("hidden");
    $("#open-edit-result").classList.remove("hidden");
    $("#reveal-edit-result").classList.remove("hidden");
    $("#text-voice-name").value = suggestedTextVoiceName();
    outputs.loadOutputs();
  }
}

const outputs = createOutputsController({ $, $$, api, showToast, formatDuration, formatDate, review });

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
    // 실행 중에는 이어할 것이 없다. 다시 묻지 않으면 시작 전에 떠 있던 옛
    // 기록이 진행 중인 작업 위에 그대로 남는다.
    refreshResumable();
    latestTarget = { root: "render", name: event.options.name };
    $("#open-latest").textContent = "영상 열기";
    $("#job-log").textContent = "";
    review.renderCompleteVoiceFindings([]);
    showJobView("active");
    setBusy(true);
    setJobState("실행 중", "running");
    resetCancelButton($("#cancel-button"));
    resetJobPace(event.options);
    updateStages("starting");
  } else if (event.type === "plan") {
    if (creationState !== "running") return;
    pace.plan(event.units || []);
    renderJobPace();
  } else if (event.type === "unit") {
    if (creationState !== "running") return;
    // 편이 바뀌면 앞 편의 실제 소요가 속도가 되고, 이 편의 관측은 처음부터
    // 다시 잰다. 레슨마다 분량이 달라 앞 편의 속도를 그대로 물려줄 수 없다.
    pace.startUnit({ index: event.index, total: event.total });
    renderJobPace();
  } else if (event.type === "unit-duration") {
    if (creationState !== "running") return;
    pace.unitDuration(event.durationMs);
    renderJobPace();
  } else if (event.type === "voice-progress") {
    if (creationState !== "running") return;
    pace.voiceProgress(event);
    renderJobPace();
  } else if (event.type === "slept") {
    pace.slept(event.ms);
    renderJobPace();
  } else if (event.type === "unit-failed") {
    if (creationState !== "running") return;
    pace.unitFailed();
    $("#job-failure-note").textContent = `${event.failedCount}개 레슨 실패 · 나머지 레슨 제작을 계속합니다`;
    $("#job-failure-note").classList.remove("hidden");
    $("#current-stage").textContent = `${event.title} 제작 실패 · 다음 레슨 준비 중`;
    renderJobPace();
  } else if (event.type === "stage") {
    if (creationState !== "running") return;
    pace.stage(event.stage, event.state);
    updateStages(event.stage, event.state === "done" && event.stage === "verify");
    renderJobPace();
  } else if (event.type === "log") {
    appendLog(event.text);
  } else if (event.type === "paused") {
    if (creationState !== "running") return;
    const pending = event.immediate === false;
    setJobState(pending ? "일시정지 대기" : "일시정지", pending ? "running" : "paused");
    $("#pause-button").textContent = pending ? "정지 예약 취소" : "이어하기";
    $("#current-stage").textContent = pending ? "이번 편을 마치고 멈춥니다" : "일시정지됨";
    // 촬영 중의 정지 예약은 아직 멈춘 것이 아니다. 실제로 멈춘 때에만 시계를
    // 세운다.
    if (!pending) pace.pause();
    renderJobPace();
  } else if (event.type === "resumed") {
    if (creationState !== "running") return;
    setJobState("실행 중", "running");
    $("#pause-button").textContent = "일시정지";
    pace.resume();
    renderJobPace();
  } else if (event.type === "cancelling") {
    creationState = "cancelling";
    renderJobPace();
    setJobState("중지 중", "running");
    $("#current-stage").textContent = "안전하게 중지 중";
    $("#cancel-button").disabled = true;
    $("#cancel-button").textContent = "중지 중…";
  } else if (event.type === "failed") {
    refreshResumable();
    creationState = event.cancelled ? "cancelled" : "failed";
    renderJobPace();
    setBusy(false);
    resetCancelButton($("#cancel-button"));
    showJobView("active");
    setJobState(event.cancelled ? "중지됨" : "오류", event.cancelled ? "idle" : "failed");
    $("#current-stage").textContent = event.message;
    appendLog(`\n[중단] ${event.message}\n`);
    $("#job-log").closest("details").open = true;
    outputs.loadOutputs();
  } else if (event.type === "complete" || event.type === "partial-complete") {
    refreshResumable();
    // 이번 실행의 실측을 닫아 둔다. 다음 실행의 첫 편은 이 값으로 시작한다.
    pace.finish();
    const report = event.report;
    const failedCount = report.failedUnits?.length || 0;
    creationState = failedCount ? (report.units?.length ? 'partial' : 'failed') : "done";
    renderJobPace();
    setBusy(false);
    resetCancelButton($("#cancel-button"));
    showJobView("complete");
    setJobState(failedCount ? (report.units?.length ? "일부 제작 실패" : "제작 실패") : "완료", failedCount ? "failed" : "idle");
    updateStages("verify", !failedCount);
    $("#complete-panel").classList.toggle("has-failures", Boolean(failedCount));
    $("#complete-panel .complete-icon").textContent = failedCount ? "!" : "✓";
    $("#complete-title").textContent = failedCount ? "제작을 마쳤지만 실패한 레슨이 있습니다" : "제작과 검증이 끝났습니다";
    $("#complete-failures").textContent = (report.failedUnits || []).map(unit => `${unit.title || unit.name}\n${unit.message}`).join('\n\n');
    $("#complete-failures").classList.toggle("hidden", !failedCount);
    latestTarget = report.target;
    const findings = completionFindings(report);
    const unitCount = report.units?.length || 1;
    $("#complete-summary").textContent = completionSummary(report, formatDuration(report.durationMs));
    if (findings.length && !failedCount) setJobState('제작 완료 · 확인 필요', 'idle');
    $("#complete-panel .complete-actions").classList.toggle('hidden', !report.target);
    $("#open-latest").textContent = unitCount > 1 ? "첫 영상 열기" : "영상 열기";
    review.renderCompleteVoiceFindings(findings, report.videoPath ? report.target : null);
    outputs.loadOutputs();
    $("#job-name").value = suggestedName();
    updateProductionBrief();
  }
}

// 시계가 둘 필요한 경우는 하나뿐이다. 레슨 하나, 페이지 직접 선택, 챕터를 한
// 영상으로 만들기는 모두 한 편짜리라 '이 작업이 언제 끝나는지'가 곧 전부다.
// 챕터를 레슨 단위로 나눌 때만 '이 편'과 '전체'가 서로 다른 답이 되고, 그때만
// main 이 plan 을 보낸다. 남은 시간 계산 자체는 job-pace 가 맡는다.
const pace = createJobPace();

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

// 세 시간짜리 챕터에서 '레슨 7/11'만으로는 어느 편이 끝났고 어느 편이 실패했는지
// 알 수 없다. 편마다 한 줄을 두되 접어 두고, 요약만 늘 보이게 한다.
const UNIT_STATE_LABELS = { done: "완료", running: "제작 중", failed: "실패", skipped: "이미 완성", pending: "대기" };
let jobUnitsSignature = "";

function renderJobUnits() {
  const units = pace.snapshot().units;
  $("#job-units").classList.toggle("hidden", units.length < 2);
  const signature = units.map((unit) => unit.state).join("");
  if (!units.length || signature === jobUnitsSignature) return;
  jobUnitsSignature = signature;
  const counted = (state) => units.filter((unit) => unit.state === state).length;
  const done = counted("done") + counted("skipped");
  const failed = counted("failed");
  $("#job-units-detail").textContent = [
    `${units.length}편 중 ${done}편 완료`,
    failed ? `${failed}편 실패` : "",
    `${units.length - done - failed}편 남음`,
  ].filter(Boolean).join(" · ");
  $("#job-units-list").replaceChildren(...units.map((unit, index) => {
    const row = document.createElement("li");
    row.dataset.state = unit.state;
    const number = document.createElement("b");
    number.textContent = String(index + 1);
    const title = document.createElement("span");
    title.textContent = unit.title || `${index + 1}편`;
    const state = document.createElement("i");
    state.textContent = UNIT_STATE_LABELS[unit.state] || "";
    row.append(number, title, state);
    return row;
  }));
}

function renderJobPace() {
  renderJobUnits();
  const unit = pace.currentUnit ? unitLabel(pace.currentUnit) : "";
  $("#job-unit").textContent = unit;
  $("#job-unit").classList.toggle("hidden", !unit);
  const clocks = pace.labels({ running: creationState === "running" });
  renderEta($("#job-eta"), clocks.unit, clocks.unitBusy);
  renderEta($("#job-total-eta"), clocks.total, clocks.totalBusy);
}

function renderEta(element, label, calculating) {
  element.textContent = label;
  element.classList.toggle("hidden", !label);
  element.classList.toggle("eta-calculating", calculating);
  element.setAttribute("aria-busy", String(calculating));
}

function resetJobPace(options = {}) {
  pace.start(options);
  jobUnitsSignature = "";
  $("#job-units").classList.add("hidden");
  $("#job-units-list").replaceChildren();
  $("#job-failure-note").textContent = "";
  $("#job-failure-note").classList.add("hidden");
  $("#pause-button").textContent = "일시정지";
  renderJobPace();
}

// 실행 중에만 추정값을 갱신한다. 실패·중지 후 옛 남은 시간을 되살리지 않는다.
if (typeof setInterval === "function") {
  setInterval(() => { if (creationState === "running") renderJobPace(); }, 5_000);
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
  await outputs.loadOutputs();
  const initialView = new URLSearchParams(window.location.search).get("view");
  if (["voice", "review", "edit", "results"].includes(initialView)) {
    $(`[data-view='${initialView}']`).click();
  } else if (initialView === "results-group-menu") {
    // 묶음 안의 행에서 연 메뉴는 묶음 밖까지 나와야 한다. 잘리는지는 그 자리를
    // 찍어 봐야만 알 수 있어서, 확인할 자리를 화면 하나로 남겨 둔다.
    $("[data-view='results']").click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const grouped = $(".output-group .output-item:last-child");
    grouped?.scrollIntoView({ block: "center" });
    grouped?.querySelector(".result-menu")?.setAttribute("open", "");
    return;
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
try {
  const savedQuality = localStorage.getItem("tts-video-quality");
  $("#video-quality").value = Object.hasOwn(VIDEO_QUALITIES, savedQuality) ? savedQuality : DEFAULT_VIDEO_QUALITY;
} catch { $("#video-quality").value = DEFAULT_VIDEO_QUALITY; }
$("#video-quality").addEventListener("change", () => {
  try { localStorage.setItem("tts-video-quality", $("#video-quality").value); } catch {}
  updateProductionBrief();
});
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
$("#open-latest").addEventListener("click", () => review.latestCompleteReview ? review.openReview(review.latestCompleteReview) : latestTarget && api.open(latestTarget));
$("#reveal-latest").addEventListener("click", () => latestTarget && api.reveal(latestTarget));
$("#refresh-outputs").addEventListener("click", outputs.loadOutputs);
$("#result-search").addEventListener("input", outputs.renderOutputs);
document.addEventListener("click", (event) => {
  if (!event.target.closest(".result-menu")) outputs.closeResultMenus();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !document.querySelector(".result-menu[open]")) return;
  event.preventDefault();
  outputs.closeResultMenus({ restoreFocus: true });
});
$$("#result-filters button").forEach((button) => button.addEventListener("click", () => {
  outputs.outputFilter = button.dataset.outputFilter;
  $$("#result-filters button").forEach((item) => item.classList.toggle("selected", item === button));
  outputs.renderOutputs();
}));
$('#voice-video-name').addEventListener('dblclick', () => {
  const element = $('#voice-video-name');
  if (!mediaState.voiceVideo || review.reviewBusy || element.querySelector('input')) return;
  const current = mediaState.voiceVideo.name;
  const field = document.createElement('input');
  field.type = 'text';
  field.className = 'rename-field';
  field.value = current;
  field.setAttribute('aria-label', '검수 중인 파일 이름');
  element.replaceChildren(field);
  const dot = current.lastIndexOf('.');
  field.focus();
  field.setSelectionRange(0, dot > 0 ? dot : current.length);
  let settled = false;
  const commit = async () => {
    if (settled) return;
    settled = true;
    const value = field.value.trim();
    if (!value || value === current) return review.paintReviewFileName(current);
    try {
      const renamed = await api.renameVideo(mediaState.voiceVideo.token, value);
      mediaState.voiceVideo = { ...mediaState.voiceVideo, name: renamed.name, videoUrl: renamed.videoUrl };
      // 재생 중이던 자리를 잃지 않고 새 경로로 옮겨 붙인다.
      const at = review.reviewPlayer.currentTime;
      review.reviewPlayer.src = renamed.videoUrl;
      review.reviewPlayer.addEventListener('loadedmetadata', () => { review.reviewPlayer.currentTime = at; }, { once: true });
      review.paintReviewFileName(renamed.name);
      showToast(`이름을 ${renamed.name}(으)로 바꿨습니다.`);
      outputs.loadOutputs();
    } catch (error) { showToast(error.message, 'error'); review.paintReviewFileName(current); }
  };
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); commit(); }
    if (event.key === 'Escape') { event.preventDefault(); settled = true; review.paintReviewFileName(current); }
  });
  field.addEventListener('blur', commit);
});
$("#pick-voice-video").addEventListener("click", async () => {
  try { const [video] = await api.pickVideos(false); if (video) review.setReviewVideo(video); }
  catch (error) { showToast(error.message, "error"); }
});
$("#voice-start-page").addEventListener("input", () => {
  if (Number($("#voice-end-page").value) < Number($("#voice-start-page").value)) $("#voice-end-page").value = $("#voice-start-page").value;
  updateVoicePageMeta();
});
$("#voice-end-page").addEventListener("input", updateVoicePageMeta);
$("#cancel-edit-button").addEventListener("click", (event) => requestJobCancellation(event.currentTarget, "edit"));
$("#open-edit-result").addEventListener("click", () => mediaState.latestEditTarget && api.open(mediaState.latestEditTarget));
$("#reveal-edit-result").addEventListener("click", () => mediaState.latestEditTarget && api.reveal(mediaState.latestEditTarget));
$("#apply-voice-candidate").addEventListener("click", async () => {
  if (!selectedCandidateToken) return;
  try {
    if (candidatePurpose === "text") {
      await api.selectTextVoice(selectedCandidateToken);
      return;
    }
    if (!review.pendingCandidateContext || review.reviewBusy) return;
    $$('audio,video').forEach(media => media.pause());
    // Queue it instead of writing a video now. The whole set is applied in one
    // pass when the user saves, so the picture is encoded once, not once per fix.
    const chosen = voiceCandidates.find(item => item.token === selectedCandidateToken);
    if (review.queueSelectedCandidate(selectedCandidateToken, chosen?.name)) return;
    setEditBusy(true);
    await api.startEdit({
      operation: "voice", name: `${review.pendingCandidateContext.name}-applied-${Date.now()}`,
      videoToken: review.pendingCandidateContext.videoToken,
      audioSource: "file", audioToken: selectedCandidateToken,
      startPage: review.pendingCandidateContext.startPage, endPage: review.pendingCandidateContext.endPage,
      durationPolicy: review.pendingCandidateContext.durationPolicy,
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
attachNativeDrop($("#editor-drop"), "video", (files) => editor.addEditorClips(files));
attachNativeDrop($("#pick-voice-video"), "video", (files) => { if (files[0]) review.setReviewVideo(files[0]); });
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
  if (view !== "review") review.reviewPlayer.pause();
  if (view === "results") outputs.loadOutputs();
}
$$('[data-view]').forEach(button => button.addEventListener('click', () => navigateToView(button.dataset.view)));
$('#window-back').addEventListener('click', () => navigateToView(viewHistory.back(), true));
$('#window-forward').addEventListener('click', () => navigateToView(viewHistory.forward(), true));
initialize().catch((error) => {
  $("#runtime-label").textContent = "환경 확인 실패";
  appendLog(`[초기화 오류] ${error.message}\n`);
});


// One audible source at a time when comparing the original with candidates.
document.addEventListener('play', event => {
  if (!event.target.matches('audio,video')) return;
  $$('audio,video').forEach(media => { if (media !== event.target) media.pause(); });
}, true);
