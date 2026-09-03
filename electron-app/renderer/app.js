import {
  buildChapterRanges,
  filterOutputItems,
  outputKind,
  shouldOpenMenuUpward,
  summarizePageRange,
  summarizeVoiceFindings,
  voiceFindingLabel,
  voiceFindingReason,
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
let catalogPages = [];
let catalogLessons = [];
let totalPages = 715;
let latestTarget = null;
let latestEditTarget = null;
let editOperation = "merge";
let voiceSource = "file";
let trimMode = "time";
let mergeVideos = [];
let trimVideo = null;
let voiceVideo = null;
let voiceAudio = null;
let appSettings = null;
let voiceCandidates = [];
let selectedCandidateToken = null;
let candidatePurpose = "edit";
let catalogChapters = [];
let outputItems = [];
let outputFilter = "all";

function showToast(message, kind = "success") {
  const toast = document.createElement("div");
  toast.className = `toast ${kind}`;
  toast.innerHTML = "<span></span><div></div>";
  toast.querySelector("span").textContent = kind === "error" ? "!" : "✓";
  toast.querySelector("div").textContent = message;
  $("#toast-stack").append(toast);
  setTimeout(() => toast.remove(), 3600);
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
  const suffix = productionMode === "lesson" && lesson
    ? lesson.id
    : productionMode === "bundle"
    ? `p${start}-p${Number($("#end-page")?.value || start)}`
    : `preview-p${start}`;
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
  else setProductionMode("preview");
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

function chapterForPage(pageNumber) {
  return catalogChapters.find((chapter) => pageNumber >= chapter.start && pageNumber <= chapter.end) || null;
}

function populateChapterJump() {
  catalogChapters = buildChapterRanges(catalogPages);
  const select = $("#chapter-jump");
  select.replaceChildren(...catalogChapters.map((chapter) => {
    const option = document.createElement("option");
    option.value = chapter.id;
    option.textContent = `${chapter.id.toUpperCase()} · ${chapter.start}–${chapter.end}페이지 · ${chapter.stepCount}스텝`;
    return option;
  }));
}

function moveToPage(pageNumber) {
  const next = Math.min(totalPages, Math.max(1, Math.round(Number(pageNumber) || 1)));
  $("#start-page").value = String(next);
  if (Number($("#end-page").value) < next) $("#end-page").value = String(next);
  updatePageScope();
}

function updateCourseNavigator(start, end) {
  const chapter = chapterForPage(start);
  if (chapter) $("#chapter-jump").value = chapter.id;
  $("#previous-page").disabled = start <= 1;
  $("#next-page").disabled = start >= totalPages;
  const summary = summarizePageRange(catalogPages, start, productionMode === "bundle" ? end : start);
  $("#scope-chapter-stat").textContent = summary.chapterLabel;
  $("#scope-page-stat").textContent = productionMode === "bundle" ? `${summary.pageCount}페이지` : `${start}페이지 시작`;
  $("#scope-step-stat").textContent = productionMode === "bundle" ? `${summary.stepCount}스텝` : `${summary.stepCount}스텝부터`;
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
  $("#scope-explanation").textContent = productionMode === "lesson" && lesson
    ? `${lesson.title} 전체를 만듭니다.`
    : productionMode === "preview"
      ? `${start}페이지부터 약 30초 분량을 만듭니다.`
      : `${start}페이지부터 ${end}페이지까지 만듭니다.`;
  $("#time-note").textContent = productionMode === "preview"
    ? "짧게 확인한 뒤 필요한 범위로 확장하세요."
    : "완료되면 결과를 바로 열어 확인할 수 있습니다.";
  $("#job-name").value = suggestedName();
  updateCourseNavigator(start, end);
  updateProductionBrief();
}

function setProductionMode(mode) {
  productionMode = ["lesson", "preview", "bundle"].includes(mode) ? mode : "lesson";
  $$("#mode-options button").forEach((button) => button.classList.toggle("selected", button.dataset.mode === productionMode));
  $("#lesson-panel").classList.toggle("hidden", productionMode !== "lesson");
  $("#manual-scope").classList.toggle("hidden", productionMode === "lesson");
  $("#range-arrow").classList.toggle("hidden", productionMode !== "bundle");
  $("#end-page-group").classList.toggle("hidden", productionMode !== "bundle");
  if (productionMode === "lesson") applySelectedLesson();
  else updatePageScope();
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
}

function resetCancelButton(button) {
  button.disabled = false;
  button.textContent = "작업 중지";
  button.removeAttribute("aria-busy");
}

async function requestJobCancellation(button, kind) {
  button.disabled = true;
  button.textContent = "중지 요청 중…";
  button.setAttribute("aria-busy", "true");
  if (kind === "create") {
    setJobState("중지 요청 중", "running");
    $("#current-stage").textContent = "실행 중인 작업을 종료하고 있습니다.";
  } else {
    $("#edit-running-label").textContent = "실행 중인 작업을 종료하고 있습니다.";
  }
  try {
    const accepted = await api.cancel();
    if (!accepted) {
      resetCancelButton(button);
      showToast("현재 중지할 작업이 없습니다.", "error");
    }
  } catch (error) {
    resetCancelButton(button);
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
  log.textContent = `${log.textContent}${text}`.slice(-30000);
  log.scrollTop = log.scrollHeight;
}

function formatDuration(ms) {
  if (!ms) return "길이 확인 전";
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function renderCompleteVoiceFindings(findings = [], target = null) {
  const panel = $("#voice-quality-panel");
  const list = $("#voice-quality-list");
  const summary = summarizeVoiceFindings(findings);
  panel.classList.toggle("hidden", summary.total === 0);
  panel.dataset.tone = summary.tone;
  panel.dataset.repairable = target ? "yes" : "no";
  $("#voice-quality-title").textContent = summary.title;
  list.replaceChildren(...findings.map((finding) => renderVoiceFindingRow(finding, target)));
}

function renderVoiceFindingRow(finding, target) {
  const item = document.createElement("li");
  item.dataset.severity = finding.severity === "warning" ? "warning" : "failed";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "voice-finding";
  const time = document.createElement("span");
  time.textContent = voiceFindingLabel(finding);
  const copy = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = `${finding.slideNumber}페이지 · ${finding.slideId}`;
  const reason = document.createElement("small");
  reason.textContent = voiceFindingReason(finding);
  copy.append(title, reason);
  button.append(time, copy);
  button.title = finding.expectedText && finding.recognizedText
    ? `대본 발음: ${finding.expectedText}\n받아쓰기: ${finding.recognizedText}`
    : reason.textContent;
  if (target) {
    button.addEventListener("click", () => openVoiceRepair(target, finding));
  } else {
    button.disabled = true;
  }
  item.append(button);
  return item;
}

// Reviewing a segment and fixing it are one motion: the editor opens already
// pointed at the video and the page that was flagged.
async function openVoiceRepair(target, finding) {
  try {
    const video = await api.adoptResultVideo(target);
    voiceVideo = video;
    $("#voice-video-name").textContent = video.name;
    $("[data-view='edit']").click();
    setEditOperation("voice");
    setVoiceSource("generate");
    $("#voice-start-page").value = String(finding.slideNumber);
    $("#voice-end-page").value = String(finding.slideNumber);
    updateVoicePageMeta();
    $("#edit-name").value = suggestedEditName();
    showToast(`${finding.slideNumber}페이지 목소리를 다시 만들 준비가 됐습니다.`);
  } catch (error) {
    showToast(error.message, "error");
  }
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function optionPayload() {
  const lesson = productionMode === "lesson" ? selectedLesson() : null;
  const name = $("#job-name").value.trim();
  return {
    name,
    title: lesson?.title || `${name} 강의 영상`,
    mode: productionMode === "preview" ? "preview" : "bundle",
    startPage: Number($("#start-page").value),
    endPage: productionMode === "preview" ? null : Number($("#end-page").value),
    deliverable: $("#deliverable").value,
    burnCaptions: $("#burn-captions").checked,
  };
}

function suggestedEditName(operation = editOperation) {
  const labels = { merge: "merged", trim: "trimmed", voice: "voice" };
  return `edit-${dateStamp()}-${labels[operation]}`;
}

function setEditOperation(operation) {
  editOperation = ["merge", "trim", "voice"].includes(operation) ? operation : "merge";
  $$("#edit-operation-tabs button").forEach((button) => button.classList.toggle("selected", button.dataset.operation === editOperation));
  $("#edit-merge-panel").classList.toggle("hidden", editOperation !== "merge");
  $("#edit-trim-panel").classList.toggle("hidden", editOperation !== "trim");
  $("#edit-voice-panel").classList.toggle("hidden", editOperation !== "voice");
  $("#start-edit-label").textContent = { merge: "영상 합치기", trim: "영상 자르기", voice: "목소리 후보 생성" }[editOperation];
  $("#edit-name").value = suggestedEditName();
  if (editOperation === "voice") setVoiceSource("generate");
}

function setVoiceSource(source) {
  voiceSource = source === "generate" ? "generate" : "file";
  $$("#voice-source-tabs button").forEach((button) => button.classList.toggle("selected", button.dataset.source === voiceSource));
  $("#pick-voice-audio").classList.toggle("hidden", voiceSource !== "file");
  $("#generated-voice-options").classList.toggle("hidden", voiceSource !== "generate");
  if (editOperation === "voice") {
    $("#start-edit-label").textContent = voiceSource === "generate" ? "목소리 후보 생성" : "목소리 교체";
  }
}

function setTrimMode(mode) {
  trimMode = mode === "pages" ? "pages" : "time";
  $$("#trim-mode-tabs button").forEach((button) => button.classList.toggle("selected", button.dataset.trimMode === trimMode));
  $("#trim-time-options").classList.toggle("hidden", trimMode !== "time");
  $("#trim-page-options").classList.toggle("hidden", trimMode !== "pages");
  $("#trim-hint").textContent = trimMode === "pages"
    ? trimVideo?.pageRange
      ? `이 영상은 ${trimVideo.pageRange.start}~${trimVideo.pageRange.end}페이지 타임라인과 연결되어 있습니다.`
      : "앱에서 만든 타임라인 영상만 페이지로 자를 수 있습니다."
    : "초 단위 숫자나 시:분:초 형식을 사용할 수 있습니다.";
}

function renderMergeQueue() {
  const queue = $("#merge-queue");
  queue.replaceChildren(...mergeVideos.map((file, index) => {
    const row = document.createElement("li");
    row.className = "queue-item";
    row.draggable = true;
    row.dataset.index = String(index);
    row.innerHTML = '<span class="queue-handle">⠿</span><strong></strong><button type="button">×</button>';
    row.querySelector("strong").textContent = `${index + 1}. ${file.name}`;
    row.querySelector("button").addEventListener("click", () => {
      mergeVideos.splice(index, 1);
      renderMergeQueue();
    });
    row.addEventListener("dragstart", () => row.classList.add("dragging"));
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
    row.addEventListener("dragover", (event) => event.preventDefault());
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      const dragging = queue.querySelector(".dragging");
      if (!dragging) return;
      const from = Number(dragging.dataset.index);
      const [moved] = mergeVideos.splice(from, 1);
      mergeVideos.splice(index, 0, moved);
      renderMergeQueue();
    });
    return row;
  }));
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

function editPayload() {
  const common = { operation: editOperation, name: $("#edit-name").value.trim() };
  if (editOperation === "merge") return { ...common, videoTokens: mergeVideos.map((file) => file.token) };
  if (editOperation === "trim") {
    return {
      ...common,
      videoToken: trimVideo?.token,
      trimMode,
      startTime: $("#trim-start").value,
      endTime: $("#trim-end").value,
      trimStartPage: Number($("#trim-start-page").value),
      trimEndPage: Number($("#trim-end-page").value),
    };
  }
  const operation = voiceSource === "generate" ? "voice-candidates" : "voice";
  return {
    ...common,
    operation,
    videoToken: voiceVideo?.token,
    audioSource: voiceSource,
    audioToken: voiceAudio?.token,
    startPage: Number($("#voice-start-page").value),
    endPage: Number($("#voice-end-page").value),
    candidateCount: Number($("#voice-candidate-count").value),
    durationPolicy: $("#voice-duration-policy").value,
  };
}

function setEditBusy(busy) {
  $("#start-edit-button").disabled = busy;
  $("#edit-form").querySelectorAll("input, select, button:not(#cancel-edit-button)").forEach((element) => { element.disabled = busy; });
  setIconStatus("#edit-top-status", busy ? "영상 편집 중" : "편집할 영상을 선택하세요", busy ? "running" : "idle");
}

function appendEditLog(text) {
  const log = $("#edit-log");
  log.textContent = `${log.textContent}${text}`.slice(-30000);
  log.scrollTop = log.scrollHeight;
}

function openJobDialog(title) {
  const dialog = $("#edit-job-dialog");
  $("#edit-dialog-title").textContent = title;
  $("#edit-dialog-spinner").classList.remove("hidden");
  $("#edit-dialog-success").classList.add("hidden");
  $("#edit-dialog-error").classList.add("hidden");
  $("#candidate-gallery").classList.add("hidden");
  $("#batch-progress").classList.add("hidden");
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
  selectedCandidateToken = candidates[0]?.token || null;
  const list = $("#candidate-list");
  list.replaceChildren(...candidates.map((candidate, index) => {
    const card = document.createElement("label");
    card.className = `candidate-card${index === 0 ? " selected" : ""}`;
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "voiceCandidate";
    radio.value = candidate.token;
    radio.checked = index === 0;
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
  } else if (event.type === "voice-candidates-ready") {
    candidatePurpose = "edit";
    setEditBusy(false);
    setIconStatus("#edit-top-status", "생성된 목소리 후보를 비교하고 있습니다");
    renderVoiceCandidates(event.candidates);
    $("#edit-dialog-title").textContent = "목소리 후보 비교";
    $("#edit-dialog-spinner").classList.add("hidden");
    $("#batch-progress").classList.add("hidden");
    $("#candidate-gallery").classList.remove("hidden");
    $("#cancel-edit-button").classList.add("hidden");
    $("#apply-voice-candidate").classList.remove("hidden");
    $("#apply-voice-candidate").textContent = "선택한 목소리로 교체";
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
    $("#edit-dialog-spinner").classList.add("hidden");
    $("#edit-dialog-success").classList.remove("hidden");
    const count = event.report.outputs?.length || 1;
    $("#edit-complete-summary").textContent = `${count}개 결과 · 자동 검증 ${event.report.summary.passed}개 통과`;
    $("#cancel-edit-button").classList.add("hidden");
    $("#open-edit-result").classList.remove("hidden");
    $("#reveal-edit-result").classList.remove("hidden");
    $("#close-edit-dialog").classList.remove("hidden");
    loadOutputs();
  }
}

function handleTextVoiceEvent(event) {
  if (event.type === "text-voice-started") {
    candidatePurpose = "text";
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
  const list = filterOutputItems(outputItems, $("#result-search").value, outputFilter);
  const container = $("#output-list");
  if (!list.length) {
    container.innerHTML = `<div class="empty-output">${outputItems.length ? "조건에 맞는 결과가 없습니다." : "아직 완성된 결과가 없습니다."}</div>`;
    return;
  }
  container.replaceChildren(...list.map((item) => {
    const kind = outputKind(item);
    const approved = item.review?.status === "approved";
    const row = document.createElement("article");
    row.className = "output-item";
    row.innerHTML = `
      <div class="output-type ${kind}">${kind === "edit" ? "✂" : item.video ? "▶" : "♪"}</div>
      <div class="output-copy"><strong></strong><small></small></div>
      <div class="output-status" aria-label="결과 상태">
        <span class="status-symbol ${item.ok ? "verified" : "unverified"}" tabindex="0" data-tooltip="${item.ok ? "자동 파일 검증 완료" : "자동 검증 기록 없음"}" aria-label="${item.ok ? "자동 파일 검증 완료" : "자동 검증 기록 없음"}">${item.ok ? "✓" : "!"}</span>
        <span class="status-symbol ${approved ? "reviewed" : "review-pending"}" tabindex="0" data-tooltip="${approved ? "직접 확인 완료" : "직접 확인 필요"}" aria-label="${approved ? "직접 확인 완료" : "직접 확인 필요"}">${approved ? "✓" : "○"}</span>
      </div>
      <div class="item-actions">
        <button class="open-button" type="button">열기</button>
        <details class="result-menu">
          <summary aria-label="결과 작업 더 보기">•••</summary>
          <div>
            <button class="review-button${approved ? " approved" : ""}" type="button">${approved ? "확인 완료 취소" : "확인 완료로 표시"}</button>
            <button class="reveal-button" type="button">Finder에서 보기</button>
          </div>
        </details>
      </div>`;
    row.querySelector("strong").textContent = item.displayName || item.name;
    const findings = item.voiceFindings || [];
    const voiceSummary = summarizeVoiceFindings(findings);
    row.querySelector("small").textContent = [
      outputLabel(item),
      formatDuration(item.durationMs),
      formatDate(item.updatedAt),
      voiceSummary.total ? `목소리 ${voiceSummary.title}` : "",
    ].filter(Boolean).join(" · ");
    const automaticStatus = row.querySelector(".output-status .status-symbol");
    const automaticLabel = !item.ok
      ? "자동 검증 실패 또는 기록 없음"
      : voiceSummary.total
        ? `${voiceSummary.title} · ${voiceFindingSummaryLine(findings)}`
        : "파일과 음성 자동 검수 완료";
    automaticStatus.classList.toggle("verified", Boolean(item.ok) && !voiceSummary.total);
    automaticStatus.classList.toggle("advisory", Boolean(item.ok) && voiceSummary.total > 0);
    automaticStatus.textContent = item.ok ? (voiceSummary.total ? "!" : "✓") : "!";
    automaticStatus.dataset.tooltip = automaticLabel;
    automaticStatus.setAttribute("aria-label", automaticLabel);
    const target = { root: item.root, name: item.name, day: item.day, store: item.store };
    const resultMenu = row.querySelector(".result-menu");
    resultMenu.addEventListener("toggle", () => {
      if (!resultMenu.open) {
        resultMenu.classList.remove("open-upward");
        return;
      }
      $$(".result-menu[open]").forEach((other) => {
        if (other !== resultMenu) other.removeAttribute("open");
      });
      const popover = resultMenu.querySelector(":scope > div");
      const availableBelow = window.innerHeight - resultMenu.getBoundingClientRect().bottom;
      resultMenu.classList.toggle("open-upward", shouldOpenMenuUpward(availableBelow, popover.offsetHeight));
    });
    row.querySelector(".review-button").addEventListener("click", async () => {
      try {
        const review = await api.setOutputReview(target, approved ? "pending" : "approved");
        item.review = review;
        renderOutputSummary();
        renderOutputs();
        showToast(approved ? "확인 완료 표시를 취소했습니다." : "직접 확인한 결과로 표시했습니다.");
      } catch (error) {
        showToast(error.message, "error");
      }
    });
    if (voiceSummary.total && item.video) {
      const findingsPanel = document.createElement("ul");
      findingsPanel.className = "output-findings";
      findingsPanel.replaceChildren(...findings.map((finding) => renderVoiceFindingRow(finding, target)));
      row.append(findingsPanel);
    }
    row.querySelector(".open-button").addEventListener("click", () => api.open(target).catch((error) => showToast(error.message, "error")));
    row.querySelector(".reveal-button").addEventListener("click", () => {
      resultMenu.removeAttribute("open");
      api.reveal(target).catch((error) => showToast(error.message, "error"));
    });
    return row;
  }));
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
    latestTarget = { root: "render", name: event.options.name };
    $("#job-log").textContent = "";
    renderCompleteVoiceFindings([]);
    showJobView("active");
    setBusy(true);
    setJobState("실행 중", "running");
    resetCancelButton($("#cancel-button"));
    updateStages("starting");
  } else if (event.type === "stage") {
    updateStages(event.stage, event.state === "done" && event.stage === "verify");
  } else if (event.type === "log") {
    appendLog(event.text);
  } else if (event.type === "cancelling") {
    setJobState("중지 중", "running");
    $("#current-stage").textContent = "안전하게 중지 중";
    $("#cancel-button").disabled = true;
    $("#cancel-button").textContent = "중지 중…";
  } else if (event.type === "failed") {
    setBusy(false);
    resetCancelButton($("#cancel-button"));
    showJobView("active");
    setJobState(event.cancelled ? "중지됨" : "오류", event.cancelled ? "idle" : "failed");
    $("#current-stage").textContent = event.message;
    appendLog(`\n[중단] ${event.message}\n`);
    loadOutputs();
  } else if (event.type === "complete") {
    setBusy(false);
    resetCancelButton($("#cancel-button"));
    showJobView("complete");
    setJobState("완료", "idle");
    updateStages("verify", true);
    const report = event.report;
    latestTarget = report.target;
    const findings = report.voiceFindings || [];
    const voiceLine = findings.length
      ? ` · 목소리 확인 ${findings.length}곳`
      : report.voiceQuality ? " · 목소리 검수 통과" : "";
    $("#complete-summary").textContent =
      `${formatDuration(report.durationMs)} · ${report.summary.passed}개 항목 모두 통과${voiceLine}`;
    renderCompleteVoiceFindings(findings, report.videoPath ? report.target : null);
    loadOutputs();
    $("#job-name").value = suggestedName();
    updateProductionBrief();
  }
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
  const [status, settings] = await Promise.all([api.getStatus(), api.getSettings()]);
  renderSettings(settings);
  catalogPages = status.catalog?.pages || [];
  catalogLessons = status.catalog?.lessons || [];
  totalPages = Math.max(1, Number(status.catalog?.totalPages || 0));
  populateChapterJump();
  populateLessons();
  for (const selector of ["#start-page", "#end-page"]) {
    $(selector).max = String(totalPages);
  }
  for (const selector of ["#voice-start-page", "#voice-end-page", "#trim-start-page", "#trim-end-page"]) {
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
  if (status.activeJob?.state === "running") {
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
      showJobView("active");
      setBusy(true);
      setJobState("실행 중", "running");
      updateStages(status.activeJob.stage);
    }
  }
  await loadOutputs();
  const initialView = new URLSearchParams(window.location.search).get("view");
  if (["voice", "edit", "results"].includes(initialView)) {
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
    $("[data-view='edit']").click();
    $("[data-operation='voice']").click();
    $("[data-source='generate']").click();
  } else if (initialView === "settings") {
    await openModelSettings();
  }
  window.scrollTo(0, 0);
}

$$("#mode-options button").forEach((button) => button.addEventListener("click", () => setProductionMode(button.dataset.mode)));
$("#lesson-select").addEventListener("change", applySelectedLesson);
$("#start-page").addEventListener("input", () => {
  if (Number($("#end-page").value) < Number($("#start-page").value)) {
    $("#end-page").value = $("#start-page").value;
  }
  updatePageScope();
});
$("#end-page").addEventListener("input", updatePageScope);
$("#previous-page").addEventListener("click", () => moveToPage(Number($("#start-page").value) - 1));
$("#next-page").addEventListener("click", () => moveToPage(Number($("#start-page").value) + 1));
$("#chapter-jump").addEventListener("change", () => {
  const chapter = catalogChapters.find((item) => item.id === $("#chapter-jump").value);
  if (chapter) moveToPage(chapter.start);
});
$("#select-chapter-range").addEventListener("click", () => {
  const chapter = catalogChapters.find((item) => item.id === $("#chapter-jump").value);
  if (!chapter) return;
  $("#start-page").value = String(chapter.start);
  $("#end-page").value = String(chapter.end);
  setProductionMode("bundle");
  showToast(`${chapter.id.toUpperCase()} 전체 ${chapter.pageCount}페이지를 선택했습니다.`);
});
$("#deliverable").addEventListener("change", (event) => {
  $("#burn-captions").disabled = event.target.value !== "video";
  updateProductionBrief();
});
$("#burn-captions").addEventListener("change", updateProductionBrief);
$("#job-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api.start(optionPayload());
  } catch (error) {
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
$("#open-latest").addEventListener("click", () => latestTarget && api.open(latestTarget));
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
$$("#edit-operation-tabs button").forEach((button) => button.addEventListener("click", () => setEditOperation(button.dataset.operation)));
$$("#voice-source-tabs button").forEach((button) => button.addEventListener("click", () => setVoiceSource(button.dataset.source)));
$$("#trim-mode-tabs button").forEach((button) => button.addEventListener("click", () => setTrimMode(button.dataset.trimMode)));
$("#pick-merge-videos").addEventListener("click", async () => {
  mergeVideos.push(...await api.pickVideos(true));
  renderMergeQueue();
});
$("#pick-trim-video").addEventListener("click", async () => {
  [trimVideo] = await api.pickVideos(false);
  if (trimVideo) {
    $("#trim-video-name").textContent = trimVideo.name;
    if (trimVideo.pageRange) {
      $("#trim-start-page").value = String(trimVideo.pageRange.start);
      $("#trim-end-page").value = String(trimVideo.pageRange.end);
      setTrimMode("pages");
    } else {
      setTrimMode("time");
    }
  }
});
$("#pick-voice-video").addEventListener("click", async () => {
  [voiceVideo] = await api.pickVideos(false);
  if (voiceVideo) {
    $("#voice-video-name").textContent = voiceVideo.name;
    if (voiceVideo.pageRange) {
      $("#voice-start-page").value = String(voiceVideo.pageRange.start);
      $("#voice-end-page").value = String(voiceVideo.pageRange.end);
    }
    updateVoicePageMeta();
  }
});
$("#pick-voice-audio").addEventListener("click", async () => {
  [voiceAudio] = await api.pickAudio();
  if (voiceAudio) $("#voice-audio-name").textContent = voiceAudio.name;
});
$("#voice-start-page").addEventListener("input", () => {
  if (Number($("#voice-end-page").value) < Number($("#voice-start-page").value)) $("#voice-end-page").value = $("#voice-start-page").value;
  updateVoicePageMeta();
});
$("#voice-end-page").addEventListener("input", updateVoicePageMeta);
$("#edit-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try { await api.startEdit(editPayload()); }
  catch (error) {
    openJobDialog("입력 확인 필요");
    $("#edit-dialog-spinner").classList.add("hidden");
    $("#edit-dialog-error").classList.remove("hidden");
    $("#edit-error-message").textContent = error.message;
    $("#cancel-edit-button").classList.add("hidden");
    $("#close-edit-dialog").classList.remove("hidden");
  }
});
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
    if (!voiceVideo) return;
    await api.startEdit({
      operation: "voice",
      name: $("#edit-name").value.trim(),
      videoToken: voiceVideo.token,
      audioSource: "file",
      audioToken: selectedCandidateToken,
      startPage: Number($("#voice-start-page").value),
      endPage: Number($("#voice-end-page").value),
      durationPolicy: $("#voice-duration-policy").value,
    });
  } catch (error) {
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
$("#open-finetune-panel").addEventListener("click", () => $("#finetune-panel").classList.toggle("hidden"));
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
attachNativeDrop($("#merge-drop-zone"), "video", (files) => { mergeVideos.push(...files); renderMergeQueue(); });
attachNativeDrop($("#pick-trim-video"), "video", (files) => {
  [trimVideo] = files;
  if (!trimVideo) return;
  $("#trim-video-name").textContent = trimVideo.name;
  if (trimVideo.pageRange) {
    $("#trim-start-page").value = String(trimVideo.pageRange.start);
    $("#trim-end-page").value = String(trimVideo.pageRange.end);
    setTrimMode("pages");
  }
});
attachNativeDrop($("#pick-voice-video"), "video", (files) => {
  [voiceVideo] = files;
  if (!voiceVideo) return;
  $("#voice-video-name").textContent = voiceVideo.name;
  if (voiceVideo.pageRange) {
    $("#voice-start-page").value = String(voiceVideo.pageRange.start);
    $("#voice-end-page").value = String(voiceVideo.pageRange.end);
  }
  updateVoicePageMeta();
});
attachNativeDrop($("#pick-voice-audio"), "audio", (files) => {
  [voiceAudio] = files;
  if (voiceAudio) $("#voice-audio-name").textContent = voiceAudio.name;
});
$$('[data-view]').forEach((button) => button.addEventListener("click", async () => {
  const view = button.dataset.view;
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item === button));
  $("#view-new").classList.toggle("hidden", view !== "new");
  $("#view-voice").classList.toggle("hidden", view !== "voice");
  $("#view-edit").classList.toggle("hidden", view !== "edit");
  $("#view-results").classList.toggle("hidden", view !== "results");
  if (view === "results") await loadOutputs();
  window.scrollTo({ top: 0, behavior: "instant" });
}));

initialize().catch((error) => {
  $("#runtime-label").textContent = "환경 확인 실패";
  appendLog(`[초기화 오류] ${error.message}\n`);
});

setEditOperation("merge");
setVoiceSource("file");
setTrimMode("time");
