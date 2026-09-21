import { VIDEO_QUALITIES } from "../../shared/video-quality.mjs";

// 화면 녹화. 디스플레이 하나를 원래 해상도 그대로 녹화한다. 정지는 결과를 남기고
// 취소는 버린다. 내레이션은 여기서 붙이지 않고 다듬기의 구간 음성 교체로 넣는다.
//
// 무엇이 녹화되는지는 두 곳에서 보인다. main이 녹화할 화면을 빨간 테두리로 감싸
// 세고(record-countdown) 정지할 때까지 그 테두리를 둔다. 앱 안에서는 그 화면을 1초마다
// 떠서 비춘다(record-preview).

// 화면 이름(Capture screen N)만으로는 어느 모니터인지, 덱과 그대로 합쳐지는지 알 수
// 없다. 합치기는 크기가 덱과 같을 때만 복사로 끝나므로 그 사실을 화면 옆에 적는다.
export function displayHint({ width, height } = {}) {
  const deck = Object.values(VIDEO_QUALITIES).find(quality => quality.width === width && quality.height === height);
  if (deck?.id === "standard") return { tone: "ready", text: "덱 1080p와 다시 굽지 않고 합쳐집니다" };
  if (deck) return { tone: "note", text: `덱 ${deck.label.split(" · ")[1]}와 같은 크기 · 복사 합치기는 확인 전` };
  if (width * 9 === height * 16) return { tone: "note", text: "16:9 · 덱과 크기가 달라 합칠 때 다시 인코딩합니다" };
  return { tone: "warn", text: "16:9가 아니라 덱과 합치면 위아래나 옆에 검은 띠가 생깁니다" };
}

export function defaultDisplay(displays = []) {
  const usable = displays.filter(display => !display.error);
  return (usable.find(display => displayHint(display).tone === "ready") || usable[0])?.name || null;
}

export function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const two = value => String(value).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  return hours ? `${hours}:${two(minutes)}:${two(total % 60)}` : `${Math.floor(total / 60)}:${two(total % 60)}`;
}

export function createRecordingController({
  $, api, showToast, setIconStatus, formatDuration, review, outputs, suggestName,
  document = globalThis.document, now = () => Date.now(),
  setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval,
}) {
  let displays = [];
  let audioDevices = [];
  let selected = null;
  let listing = null;
  let phase = "idle";
  let since = null;
  let clock = null;
  let latestTarget = null;
  // 녹화 중인 화면. 미리보기 설명과, 첫 미리보기가 오기 전에 비출 썸네일을 여기서 얻는다.
  let recordingDisplay = null;
  // 음성 포함은 매번 끔으로 시작한다. 화면 속 소리까지 녹음할 일은 드물다.
  let audioOn = false;
  let withAudio = false;

  const busy = () => ["starting", "recording", "finishing", "cancelling"].includes(phase);

  function status(label, tone = "idle") {
    setIconStatus("#record-top-status", label, tone);
    $('.nav-item[data-view="record"]')?.classList.toggle("recording", phase === "recording");
  }

  // 녹화 중에는 진행 카드만 보인다. 그 밖에는 언제나 녹화 설정이 보이고, 방금 끝난 녹화는
  // 그 위의 결과 카드로 남는다. 완료 화면이 설정을 대신하던 때는 다시 찍는 길을 찾아 헤맸고,
  // 다른 화면에 다녀와도 완료 화면 그대로라 당황했다(2026-09-21 사용자 지적).
  function show(panel) {
    $("#record-form").classList.toggle("hidden", panel === "live");
    $("#record-live").classList.toggle("hidden", panel !== "live");
    if (panel === "live") $("#record-done").classList.add("hidden");
  }

  function renderDisplays(message = "") {
    const list = $("#display-list");
    if (message || !displays.length) {
      const empty = document.createElement("p");
      empty.className = "display-empty";
      empty.textContent = message || "연결된 화면을 찾지 못했습니다.";
      list.replaceChildren(empty);
      $("#record-start").disabled = true;
      return;
    }
    list.replaceChildren(...displays.map(display => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "display-card";
      card.setAttribute("role", "radio");
      card.setAttribute("aria-checked", String(display.name === selected));
      card.disabled = Boolean(display.error) || busy();
      const frame = document.createElement("span");
      frame.className = "display-thumb";
      if (display.thumbnail) {
        const image = document.createElement("img");
        image.src = display.thumbnail;
        image.alt = "";
        frame.append(image);
      }
      const size = document.createElement("strong");
      size.textContent = display.error ? "찍을 수 없음" : `${display.width}×${display.height}`;
      // 모니터 이름이 있으면 그것으로 적는다. "Capture screen 1"은 어느 모니터인지 말하지 않는다.
      const name = document.createElement("small");
      name.textContent = display.label || display.name;
      card.title = display.name;
      const hint = document.createElement("em");
      const { tone, text } = display.error ? { tone: "warn", text: display.error.split("\n")[0] } : displayHint(display);
      hint.dataset.tone = tone;
      hint.textContent = text;
      card.append(frame, size, name, hint);
      card.addEventListener("click", () => {
        selected = display.name;
        renderDisplays();
      });
      return card;
    }));
    $("#record-start").disabled = !selected || busy();
  }

  function renderAudio() {
    $("#record-audio").checked = audioOn;
    $("#record-audio-field").classList.toggle("hidden", !audioOn);
    const select = $("#record-audio-device");
    const previous = select.value;
    select.replaceChildren(...audioDevices.map(device => {
      const option = document.createElement("option");
      option.value = device.name;
      option.textContent = device.name;
      return option;
    }));
    if (audioDevices.some(device => device.name === previous)) select.value = previous;
    select.disabled = !audioDevices.length || busy();
    // 2026-09-18 실측: ffmpeg의 마이크 입력은 이 Mac에서 소리의 13%쯤을 놓쳤다. 녹화는
    // 되지만 검증에서 걸리므로, 켜기 전에 알 수 있게 적어 둔다.
    $("#record-audio-hint").textContent = audioDevices.length
      ? "이 Mac에서는 마이크 소리 일부(약 13%)가 빠져 검증에서 걸립니다. 컴퓨터 소리는 루프백 장치를 설치해야 목록에 나타납니다."
      : "입력 장치를 찾지 못했습니다.";
  }

  async function loadDisplays() {
    if (listing || busy()) return listing;
    renderDisplays("화면을 찾고 있습니다…");
    $("#refresh-displays").disabled = true;
    listing = (async () => {
      try {
        ({ displays = [], audioDevices = [] } = await api.listDisplays());
        if (!displays.some(display => display.name === selected && !display.error)) selected = defaultDisplay(displays);
        renderDisplays();
        renderAudio();
      } catch (error) {
        displays = [];
        renderDisplays(error.message);
        showToast(error.message, "error");
      } finally {
        listing = null;
        $("#refresh-displays").disabled = busy();
      }
    })();
    return listing;
  }

  // 목록은 화면마다 한 프레임씩 찍어 만든다. 화면을 처음 열 때만 찾고, 모니터를 바꾼
  // 뒤에는 다시 찾기로 새로 고친다.
  function opened() {
    if (!displays.length && !busy()) loadDisplays();
  }

  function lock() {
    $("#record-form").querySelectorAll("input, select, button").forEach(element => { element.disabled = busy(); });
    if (!busy()) renderDisplays();
  }

  function tick() {
    if (since !== null) $("#record-elapsed").textContent = formatClock(now() - since);
  }

  function stopClock() {
    if (clock !== null) clearInterval(clock);
    clock = null;
  }

  function startClock(at = now()) {
    stopClock();
    since = at;
    tick();
    clock = setInterval(tick, 500);
  }

  function displayCaption(display, note) {
    if (!display) return note;
    const size = display.width ? `${display.width}×${display.height}` : "";
    return [display.label || display.name, size, note].filter(Boolean).join(" · ");
  }

  // 미리보기 틀의 상태: 세는 중(countdown) → 시작하는 중(starting) → 녹화 중(live) → 저장 중(finishing).
  function monitor(stateName, { tag, caption } = {}) {
    $("#record-monitor").dataset.state = stateName;
    if (tag) $("#record-monitor-tag-text").textContent = tag;
    if (caption !== undefined) $("#record-monitor-caption").textContent = caption;
    $("#record-countdown").classList.toggle("hidden", stateName !== "countdown");
  }

  function live(label) {
    $("#record-phase").textContent = label;
    $("#record-stop").disabled = phase !== "recording";
    $("#record-cancel").disabled = phase === "cancelling";
    $("#record-cancel").textContent = phase === "cancelling" ? "취소 중…" : "취소";
  }

  function finishedPanel({ ok, title, summary, warnings = [] }) {
    show("form");
    $("#record-done").classList.remove("hidden");
    $("#record-done").dataset.tone = ok ? (warnings.length ? "warn" : "ready") : "failed";
    $("#record-done-icon").textContent = ok && !warnings.length ? "✓" : "!";
    $("#record-done-title").textContent = title;
    $("#record-done-summary").textContent = summary;
    $("#record-done-warnings").textContent = warnings.join("\n");
    $("#record-done-warnings").classList.toggle("hidden", !warnings.length);
    for (const id of ["#record-review", "#record-open", "#record-reveal"]) $(id).classList.toggle("hidden", !latestTarget);
    // 방금 녹화한 뒤라 썸네일이 옛 화면이다. 다음 녹화를 고르기 전에 새로 찍는다.
    loadDisplays();
  }

  function reset() {
    phase = "idle";
    since = null;
    audioOn = false;
    stopClock();
    $("#record-warning").classList.add("hidden");
    lock();
    renderAudio();
  }

  function handleEvent(event) {
    if (event.type === "record-started") {
      phase = "starting";
      withAudio = Boolean(event.options?.audioDevice);
      latestTarget = null;
      $("#record-log").textContent = "";
      $("#record-elapsed").textContent = "0:00";
      $("#record-warning").classList.add("hidden");
      $("#record-mirror").classList.add("hidden");
      recordingDisplay = displays.find(display => display.name === event.options?.display) || null;
      $("#record-preview").src = recordingDisplay?.thumbnail || "";
      monitor("starting", { tag: "준비", caption: displayCaption(recordingDisplay, "녹화할 화면") });
      show("live");
      lock();
      live("녹화할 화면을 준비하고 있습니다");
      status("녹화 준비 중", "running");
    } else if (event.type === "record-countdown") {
      if (phase !== "starting") return;
      if (event.label && recordingDisplay) recordingDisplay = { ...recordingDisplay, label: event.label };
      if (event.remaining > 0) {
        $("#record-countdown").textContent = String(event.remaining);
        monitor("countdown", { tag: "곧 녹화", caption: displayCaption(recordingDisplay, "녹화할 화면") });
        live(event.framed
          ? `${event.remaining}초 뒤 녹화합니다 · 빨간 테두리를 두른 화면이 녹화됩니다. 테두리는 정지하면 사라지고 영상에는 담기지 않습니다`
          : `${event.remaining}초 뒤 녹화합니다`);
      } else {
        monitor("starting", { tag: "시작 중" });
        live("녹화를 시작하고 있습니다");
      }
    } else if (event.type === "record-phase" && event.phase === "recording") {
      if (phase !== "starting") return;
      phase = "recording";
      startClock();
      monitor("live", { tag: "REC", caption: displayCaption(recordingDisplay, "1초마다 새로 비춥니다") });
      live(`녹화 중 · ${withAudio ? "음성 포함" : "음성 없음"}`);
      status("녹화 중", "running");
    } else if (event.type === "record-preview") {
      if (phase !== "recording") return;
      $("#record-preview").src = event.image;
      $("#record-mirror").classList.toggle("hidden", !event.mirrored);
    } else if (event.type === "record-preview-paused") {
      if (phase !== "recording") return;
      monitor("live", { caption: displayCaption(recordingDisplay, "녹화 품질을 지키려고 미리보기를 멈췄습니다") });
    } else if (event.type === "record-phase" && event.phase === "progress") {
      if (!event.dup && !event.drop) return;
      $("#record-warning").textContent = `프레임 복제 ${event.dup} · 누락 ${event.drop}. 인코딩이 화면 변화를 따라가지 못하고 있습니다.`;
      $("#record-warning").classList.remove("hidden");
    } else if (event.type === "record-finishing" || (event.type === "record-phase" && event.phase === "finishing")) {
      if (["cancelling", "idle"].includes(phase)) return;
      phase = "finishing";
      tick();
      stopClock();
      monitor("finishing", { tag: "저장 중" });
      live(withAudio ? "녹화를 마무리하고 검증하는 중" : "녹화를 마무리하고 무음 트랙을 붙이는 중");
      status("녹화 마무리 중", "running");
    } else if (event.type === "cancelling") {
      phase = "cancelling";
      stopClock();
      monitor("finishing", { tag: "취소 중" });
      live("녹화를 취소하는 중 · 결과를 버립니다");
    } else if (event.type === "log") {
      const log = $("#record-log");
      log.textContent = (log.textContent + event.text).slice(-20_000);
    } else if (event.type === "record-complete") {
      const report = event.report;
      latestTarget = report.target;
      reset();
      const display = report.source?.display;
      finishedPanel({
        ok: true,
        title: report.warnings?.length ? "녹화했지만 확인할 경고가 있습니다" : "녹화를 저장했습니다",
        summary: [formatDuration(report.durationMs), display ? `${display.width}×${display.height}` : "",
          report.source?.audio === "device" ? `음성 · ${report.source.audioDevice}` : "무음 트랙"].filter(Boolean).join(" · "),
        warnings: report.warnings || [],
      });
      status(report.warnings?.length ? "녹화 완료 · 경고 확인" : "녹화를 저장했습니다", "complete");
      $("#record-name").value = suggestName();
      outputs.loadOutputs();
    } else if (event.type === "record-failed") {
      reset();
      if (event.cancelled) {
        show("form");
        status("녹화를 취소했습니다");
        showToast("녹화를 취소했습니다. 결과는 남기지 않았습니다.");
        return;
      }
      finishedPanel({ ok: false, title: "녹화하지 못했습니다", summary: event.message });
      status("녹화 오류를 확인해 주세요", "failed");
      outputs.loadOutputs();
    }
  }

  // 녹화 중에 앱 창을 다시 열었을 때. 녹화가 언제 시작됐는지는 작업 시작 시각으로 갈음한다.
  function restore(job) {
    phase = job.stage === "record" ? "recording" : "starting";
    recordingDisplay = displays.find(display => display.name === job.options?.display) || null;
    monitor(phase === "recording" ? "live" : "starting", {
      tag: phase === "recording" ? "REC" : "준비",
      caption: displayCaption(recordingDisplay, phase === "recording" ? "1초마다 새로 비춥니다" : "녹화할 화면"),
    });
    show("live");
    lock();
    if (phase === "recording") startClock(Date.parse(job.startedAt) || now());
    live(phase === "recording" ? "녹화 중" : "녹화할 화면을 준비하고 있습니다");
    if (job.state === "cancelling") handleEvent({ type: "cancelling" });
    status("녹화 중", "running");
  }

  $("#record-audio").addEventListener("change", () => {
    audioOn = $("#record-audio").checked;
    renderAudio();
  });
  $("#refresh-displays").addEventListener("click", () => loadDisplays());
  $("#record-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (busy() || !selected) return;
    const audioDevice = audioOn ? $("#record-audio-device").value : null;
    if (audioOn && !audioDevice) return showToast("녹음할 입력 장치를 골라 주세요.", "error");
    $("#record-start").disabled = true;
    try {
      await api.startRecording({ display: selected, audioDevice, name: $("#record-name").value.trim() });
    } catch (error) {
      $("#record-start").disabled = false;
      showToast(error.message, "error");
    }
  });
  $("#record-stop").addEventListener("click", async () => {
    $("#record-stop").disabled = true;
    try {
      if (!await api.finishRecording()) {
        $("#record-stop").disabled = phase !== "recording";
        showToast("정지할 녹화가 없습니다.", "error");
      }
    } catch (error) {
      $("#record-stop").disabled = phase !== "recording";
      showToast(`정지 요청 실패: ${error.message}`, "error");
    }
  });
  $("#record-cancel").addEventListener("click", async () => {
    $("#record-cancel").disabled = true;
    try {
      if (!await api.cancel()) $("#record-cancel").disabled = false;
    } catch (error) {
      $("#record-cancel").disabled = false;
      showToast(`취소 요청 실패: ${error.message}`, "error");
    }
  });
  $("#record-review").addEventListener("click", () => latestTarget && review.openReview(latestTarget));
  $("#record-open").addEventListener("click", () => latestTarget && api.open(latestTarget));
  $("#record-reveal").addEventListener("click", () => latestTarget && api.reveal(latestTarget));
  $("#record-dismiss").addEventListener("click", () => $("#record-done").classList.add("hidden"));

  return { opened, loadDisplays, handleEvent, restore, get phase() { return phase; } };
}
