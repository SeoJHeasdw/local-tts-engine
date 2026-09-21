import { planBlocks, zoomSpans } from "../../shared/demo-plan.mjs";
import { captureVideoFileName } from "../../shared/video-quality.mjs";

// 다듬기의 앱 데모 작업면. 찍어 둔 결과를 보며 장면마다 대본을 쓰고, 목소리 후보를 그
// 장면 영상에 맞춰 듣고 고르고, 완성본을 굽는다. CLI 검수 페이지(review.html)가 하던
// 보기를 앱 안으로 옮겼다 — 브라우저로 떨어지면 거기서 본 것을 들고 앱으로 돌아와 고쳐야 했다.
//
// 강의 다듬기와 작업면을 따로 둔다. 강의는 mp4를 직접 고치지만 앱 데모 완성본은 편집
// 계획에서 매번 새로 굽는다. 여기서 mp4를 고치면 다음 렌더에 사라진다. 고치는 것은 언제나
// 대본·확정·고른 후보(demo/script.json)이고, 굽는 것은 CLI와 같은 작업자다.

export const DEMO_POLISH_STEPS = ["demo-voice", "demo-render"];

/** 후보가 지금 대본이 아니라 예전 대본을 읽고 있는가. 모르면(기록 없음) 아니라고 본다. */
export function isStale(scene) {
  if (!scene?.candidates?.length || typeof scene.voicedText !== "string") return false;
  return scene.voicedText.trim() !== String(scene.text || "").trim();
}

/** 목소리를 새로 만들 장면: 확정한 대본이 있는데 후보가 없거나 예전 대본을 읽는다. */
export function scenesNeedingVoice(project) {
  return (project?.scenes || [])
    .filter(scene => scene.status === "approved" && scene.text?.trim()
      && (!scene.candidates?.length || isStale(scene)))
    .map(scene => scene.id);
}

/** 다음에 할 일. 결과 폴더의 상태만 보고 정한다. */
export function nextStep(project) {
  if (!project) return "record";
  const scenes = project.scenes || [];
  if (!scenes.some(scene => scene.status === "approved" && scene.text?.trim())) return "script";
  if (scenesNeedingVoice(project).length) return "voice";
  const approved = scenes.filter(scene => scene.status === "approved");
  if (approved.some(scene => !scene.selected)) return "select";
  return "render";
}

export function stepLabel(step) {
  return {
    record: "시나리오를 골라 촬영합니다",
    script: "장면마다 대본을 쓰고 확정합니다",
    voice: "확정한 대본으로 목소리 후보를 만듭니다",
    select: "후보를 영상에 맞춰 듣고 장면마다 하나를 고릅니다",
    render: "고른 목소리로 완성본을 만듭니다",
  }[step] || "";
}

export function sceneSeconds(scene) {
  const src = (scene.endMs - scene.startMs) / 1000;
  // 느리게 찍은 장면은 편집이 되돌린다. 화면에는 되돌린 뒤의 길이를 보여 준다.
  return { src, out: src * (scene.timeScale ?? 1) };
}

/** 후보 파일 이름(candidate-01)을 사람이 읽는 이름으로. */
export function candidateLabel(candidate) {
  const number = /candidate-(\d+)/.exec(candidate?.name || "")?.[1];
  return number ? `후보 ${Number(number)}` : candidate?.name || "후보";
}

/** 영어를 따로 읽은 구간 수. 기록이 없는 예전 후보(undefined)는 말하지 않는다. */
export function englishParts(candidate) {
  const count = (candidate?.voiceRouting?.segments || []).filter(part => part.language === "English").length;
  return count ? `영어 ${count}구간` : "";
}

/** 기본으로 볼 완성본: 1440p(기본 화질)가 있으면 그것, 없으면 가장 큰 것. */
export function defaultVersion(videos = []) {
  return (videos.find(video => /-high\.mp4$/.test(video.name)) || videos.at(-1))?.name || null;
}

/** 방금 구운 화질의 파일 이름. 렌더와 같은 이름 규칙이다(1080p는 꼬리가 없고, 자막을 구우면 -captioned). */
export function bakedVersion(project, quality, burnCaptions = false) {
  if (!project || !quality) return null;
  const name = captureVideoFileName(project.name, { videoQuality: quality, burnCaptions });
  return project.videos.some(video => video.name === name) ? name : null;
}

const seconds = ms => `${(ms / 1000).toFixed(1)}초`;
const SKIP_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON", "SUMMARY", "A"]);

export function createDemoPolishController({
  $, api, showToast, show = () => {}, document = globalThis.document,
}) {
  let project = null;
  let sceneId = null;
  let version = null;
  let captionsOn = true;
  let running = null;
  let blocked = null;
  let together = null;
  const player = $("#demo-player");
  const voicePreview = $("#demo-voice-preview");

  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, ch =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const busy = () => running !== null;
  const scenes = () => project?.scenes || [];
  const currentScene = () => scenes().find(scene => scene.id === sceneId) || scenes()[0] || null;
  const planScene = id => project?.plan?.scenes?.find(scene => scene.id === id) || null;
  const currentVideo = () => project?.videos?.find(video => video.name === version) || null;

  // ---------------------------------------------------------------- 머리
  function renderHead() {
    $("#demo-polish-name").textContent = project ? project.name : "찍어 둔 결과를 여세요.";
    const plan = project?.plan;
    const facts = project ? [
      ["장면", String(scenes().length)],
      ["촬영", seconds(project.durationMs)],
      ...(plan ? [["완성", seconds(plan.durationMs)], ["최대 배율", `${plan.maxSpeed}배`],
        ["확대", `${zoomSpans(plan).length}곳`]] : []),
    ] : [];
    $("#demo-polish-facts").replaceChildren(...facts.map(([key, value]) => {
      const span = document.createElement("span");
      const label = document.createElement("i");
      label.textContent = key;
      const strong = document.createElement("b");
      strong.textContent = value;
      span.append(label, strong);
      return span;
    }));
    const verdict = $("#demo-polish-verdict");
    const checks = project?.checks || [];
    verdict.classList.toggle("hidden", project?.ok === null || project?.ok === undefined);
    if (project && project.ok !== null && project.ok !== undefined) {
      const passed = checks.filter(check => check.ok).length;
      verdict.dataset.tone = project.ok ? "ok" : "bad";
      verdict.textContent = project.ok ? `검증 ${passed}/${checks.length} 통과` : `검증 실패 ${checks.length - passed}`;
    }
  }

  // ---------------------------------------------------------------- 영상
  function renderStage() {
    const videos = project?.videos || [];
    const video = currentVideo();
    $("#demo-stage-empty").classList.toggle("hidden", Boolean(video) || !project);
    player.classList.toggle("hidden", !video);
    const url = video?.url || "";
    if (player.dataset.src !== url) {
      const at = player.currentTime || 0;
      const playing = !player.paused;
      player.dataset.src = url;
      if (url) {
        player.src = url;
        // 화질을 바꿔도 같은 자리를 본다. 해상도 비교가 이 화면의 일이다.
        player.addEventListener("loadedmetadata", () => {
          player.currentTime = Math.min(at, player.duration || at);
          if (playing) player.play().catch(() => {});
        }, { once: true });
      } else {
        player.removeAttribute("src");
        player.load?.();
      }
    }
    $("#demo-versions").innerHTML = videos.map(item => `<button type="button" role="radio"
      aria-checked="${item.name === version}" class="${item.name === version ? "selected" : ""}"
      data-demo-version="${escapeHtml(item.name)}">${escapeHtml(item.label)} · ${(item.bytes / 1048576).toFixed(0)}MB</button>`).join("");
    $("#demo-versions").style.gridTemplateColumns = `repeat(${Math.max(1, videos.length)}, auto)`;
    $("#demo-versions").classList.toggle("hidden", !videos.length);
    $("#demo-captions").classList.toggle("hidden", !project?.captions?.length || !video);
    $("#demo-captions").setAttribute("aria-pressed", String(captionsOn));
    $("#demo-preview-render").disabled = busy() || Boolean(blocked);
    $("#demo-preview-render").inert = Boolean(blocked);
  }

  // 완성 시각 위에 구간·배율·확대·장면을 그린다. 누르면 그 자리로 옮긴다.
  // 굽기 전에는 계획이 없어 장면 막대만 촬영 길이 비율로 그린다.
  function renderTrack() {
    const track = $("#demo-track");
    if (!project) { track.innerHTML = ""; return; }
    const plan = project.plan;
    const total = plan?.durationMs || 1;
    const pct = ms => (ms / total * 100).toFixed(3);
    const strip = plan
      ? plan.scenes.map(scene => ({ id: scene.id, weight: scene.outEndMs - scene.outStartMs, at: scene.outStartMs }))
      : scenes().map(scene => ({ id: scene.id, weight: sceneSeconds(scene).out, at: null }));
    const stripTotal = strip.reduce((sum, item) => sum + item.weight, 0) || 1;
    const sceneButtons = strip.map(item => {
      const scene = scenes().find(entry => entry.id === item.id);
      const state = !scene ? "" : scene.selected ? "voiced" : scene.status === "approved" ? "approved" : "draft";
      return `<button type="button" class="demo-scene-tab" data-demo-scene="${escapeHtml(item.id)}"
        data-state="${state}" aria-current="${item.id === sceneId}"
        data-flex="${(item.weight / stripTotal * 100).toFixed(4)} 1 0"
        title="${escapeHtml(item.id)}">${escapeHtml(item.id)}</button>`;
    }).join("");
    if (!plan) {
      track.innerHTML = `<div class="demo-strip" aria-label="장면">${sceneButtons}</div>`;
      applyGeometry(track);
      return;
    }
    const marks = Array.from({ length: Math.floor(total / 5000) + 1 }, (_, index) => index * 5000);
    track.innerHTML = `
      <div class="demo-ruler" aria-hidden="true">${marks.map(ms => `<span data-left="${pct(ms)}">${Math.round(ms / 1000)}s</span>`).join("")}</div>
      <div class="demo-bar" aria-label="구간과 배율">
        ${planBlocks(plan).map(block => `<button type="button" class="demo-block ${block.kind}" data-demo-at="${Math.round(block.at)}"
          data-flex="0 0 ${(block.ms / total * 100).toFixed(4)}%" title="${escapeHtml(block.label)} · ${seconds(block.ms)}">${escapeHtml(block.label)}</button>`).join("")}
        <i class="demo-playhead" id="demo-playhead"></i>
      </div>
      <div class="demo-zooms" aria-label="확대">${zoomSpans(plan).map(span => `<button type="button" class="demo-zoom"
        data-demo-at="${Math.round(span.fromMs)}" data-left="${pct(span.fromMs)}" data-width="${pct(span.toMs - span.fromMs)}"
        title="확대 ${seconds(span.toMs - span.fromMs)}"></button>`).join("")}</div>
      <div class="demo-strip" aria-label="장면">${sceneButtons}</div>`;
    applyGeometry(track);
    paintPlayhead();
  }

  // 앱의 보안 정책(CSP style-src 'self')은 마크업 안의 style 속성을 막는다. 길이와 자리는
  // data-*로 적어 두고 여기서 스타일 객체로 건다 — 스크립트가 거는 스타일은 막지 않는다.
  function applyGeometry(root) {
    for (const element of root.querySelectorAll("[data-flex]")) element.style.flex = element.dataset.flex;
    for (const element of root.querySelectorAll("[data-left]")) element.style.left = `${element.dataset.left}%`;
    for (const element of root.querySelectorAll("[data-width]")) element.style.width = `${element.dataset.width}%`;
  }

  function paintPlayhead() {
    const head = $("#demo-playhead");
    const total = project?.plan?.durationMs;
    if (head && total) head.style.left = `${Math.min(100, player.currentTime * 1000 / total * 100).toFixed(3)}%`;
  }

  // ---------------------------------------------------------------- 장면
  function renderScene() {
    const panel = $("#demo-scene-panel");
    const scene = currentScene();
    if (!scene) {
      panel.innerHTML = `<h2>장면</h2><p>최근 결과에서 앱 데모를 고르거나 "다른 촬영 열기"로 결과 폴더를 여세요.</p>`;
      return;
    }
    const index = scenes().indexOf(scene);
    const { src, out } = sceneSeconds(scene);
    const planned = planScene(scene.id);
    const restored = scene.timeScale < 1 ? ` · ${Math.round(1 / scene.timeScale)}배로 되돌림` : "";
    const placed = planned
      ? `완성 ${seconds(planned.outStartMs)}–${seconds(planned.outEndMs)}${planned.narration ? ` · 내레이션 ${seconds(planned.narration.durationMs)}` : " · 내레이션 없음"}`
      : "아직 굽지 않았습니다";
    const canTogether = Boolean(planned && currentVideo());
    const stale = isStale(scene);
    const voiceBlocked = busy() || Boolean(blocked);
    const voiceReady = scene.status === "approved" && scene.text?.trim();
    panel.innerHTML = `
      <div class="demo-scene-head">
        <button type="button" class="secondary-small" data-demo-step="-1" aria-label="앞 장면"${index ? "" : " disabled"}>◀</button>
        <div><small>장면 ${index + 1} / ${scenes().length}</small><h2>${escapeHtml(scene.id)}</h2></div>
        <button type="button" class="secondary-small" data-demo-step="1" aria-label="다음 장면"${index < scenes().length - 1 ? "" : " disabled"}>▶</button>
      </div>
      <p class="demo-scene-when">촬영 ${seconds(src * 1000)} → 약 ${seconds(out * 1000)}${restored}<br>${placed}</p>
      <label class="field full"><span>대본</span>
        <textarea id="demo-scene-text" rows="4" spellcheck="false" placeholder="이 장면에서 할 말을 적습니다.">${escapeHtml(scene.text)}</textarea>
        <small>완성 길이보다 길면 편집이 덜 되돌립니다 — 그만큼 화면이 느려 보입니다.</small>
      </label>
      <label class="check-row full"><input type="checkbox" id="demo-scene-approved"${scene.status === "approved" ? " checked" : ""}><span><strong>대본 확정</strong><small>확정한 장면만 목소리를 만듭니다.</small></span></label>
      ${stale ? '<p class="demo-stale" role="status">대본을 고친 뒤라 후보가 예전 대본을 읽습니다. 후보를 다시 만드세요.</p>' : ""}
      ${scene.screenText ? `<details class="advanced-options full"><summary><span>찍힌 화면의 글</span><small>대본의 근거</small></summary><div><pre class="demo-screen-text">${escapeHtml(scene.screenText)}</pre></div></details>` : ""}
      ${scene.candidates.length ? `<div class="candidate-gallery">
        <p>후보 ${scene.candidates.length}벌 — ${canTogether ? "영상에 맞춰 듣고" : "듣고"} 하나를 고릅니다. 고르면 바로 저장됩니다.</p>
        <div>${scene.candidates.map(candidate => `
          <label class="candidate-card${scene.selected === candidate.file ? " selected" : ""}">
            <input type="radio" name="demo-voice" value="${escapeHtml(candidate.file)}"${scene.selected === candidate.file ? " checked" : ""} data-demo-select>
            <div>
              <strong>${escapeHtml(candidateLabel(candidate))}${scene.selected === candidate.file ? " · 쓰는 중" : ""}</strong>
              <small>${[candidate.durationMs ? seconds(candidate.durationMs) : "길이 모름", englishParts(candidate)].filter(Boolean).join(" · ")}</small>
              <div class="demo-candidate-listen">
                ${canTogether ? `<button type="button" class="secondary-small" data-demo-together="${escapeHtml(candidate.file)}"
                  aria-pressed="${together?.file === candidate.file}">${together?.file === candidate.file ? "멈춤" : "영상에 맞춰 듣기"}</button>` : ""}
                <audio controls preload="none" src="${escapeHtml(candidate.url)}"></audio>
              </div>
            </div>
          </label>`).join("")}</div>
      </div>` : `<p class="demo-scene-empty">${voiceReady ? "아직 목소리 후보가 없습니다." : "대본을 쓰고 확정하면 목소리 후보를 만들 수 있습니다."}</p>`}
      <button type="button" class="secondary-small demo-scene-voice" id="demo-scene-voice"${voiceReady && !voiceBlocked ? "" : " disabled"}>${scene.candidates.length ? "이 장면 후보 다시 만들기" : "이 장면 후보 만들기"}</button>`;
    $("#demo-scene-voice").inert = Boolean(blocked);
  }

  // ---------------------------------------------------------------- 만들기
  // 결과 전체의 일(확정한 장면들의 후보, 완성본 굽기)은 위 한 줄이 맡는다. 다음 차례인
  // 단추만 밝게 세운다 — 두 단추가 똑같이 밝으면 어느 쪽이 차례인지 읽히지 않는다.
  function renderActions() {
    const list = scenes();
    const needs = scenesNeedingVoice(project);
    const step = nextStep(project);
    const unchosen = list.filter(scene => scene.status === "approved" && !scene.selected).length;
    $("#demo-command").classList.toggle("hidden", !project);
    $("#demo-polish-hint").innerHTML = project ? `<b>다음</b> · ${escapeHtml(stepLabel(step))}` : "";
    const approved = list.filter(scene => scene.status === "approved").length;
    const chosen = list.filter(scene => scene.selected).length;
    const notes = [`대본 확정 ${approved}/${list.length} · 목소리 고름 ${chosen}/${list.length}`];
    if (needs.length) notes.push(`후보를 새로 만들 장면 ${needs.join(", ")}`);
    else if (unchosen) notes.push(`목소리를 고르지 않은 확정 장면 ${unchosen}개는 내레이션 없이 들어갑니다`);
    $("#demo-command-note").textContent = project ? notes.join(" · ") : "";
    $("#demo-voice-all").textContent = needs.length ? `후보 만들기 · ${needs.length}장면` : "후보 만들기";
    const voiceFirst = step === "voice";
    $("#demo-voice-all").classList.toggle("primary-small", voiceFirst);
    $("#demo-voice-all").classList.toggle("secondary-small", !voiceFirst);
    const renderFirst = !voiceFirst && step !== "script";
    $("#demo-render-start").classList.toggle("primary-small", renderFirst);
    $("#demo-render-start").classList.toggle("secondary-small", !renderFirst);
    const off = !project || busy() || Boolean(blocked);
    $("#demo-voice-all").disabled = off || !needs.length;
    $("#demo-render-start").disabled = off;
    for (const id of ["#demo-voice-all", "#demo-render-start", "#demo-candidates", "#demo-quality", "#demo-burn"]) $(id).inert = Boolean(blocked);
    $("#demo-polish-pick").disabled = busy();
    // 도는 동안은 단추 자리에 진행이 선다. 끝나면 결과가 이 화면에 바로 들어온다.
    $("#demo-command-actions").classList.toggle("hidden", Boolean(running));
    $("#demo-running").classList.toggle("hidden", !running);
    if (running) {
      $("#demo-running-label").textContent = running.step === "demo-voice" ? "목소리 후보를 만들고 있습니다" : "완성본을 굽고 있습니다";
      $("#demo-running-note").textContent = running.step === "demo-voice"
        ? (running.scenes?.length ? `장면 ${running.scenes.join(", ")}` : "확정한 장면 모두")
        : [{ standard: "1080p", high: "1440p", ultra: "4K" }[running.quality], running.burnCaptions ? "자막 굽기" : ""].filter(Boolean).join(" · ");
    }
    $("#demo-blocked").classList.toggle("hidden", !blocked);
    $("#demo-blocked").textContent = blocked ? `${blocked} · 끝나면 여기서 만들 수 있습니다` : "";
  }

  function renderChecks() {
    const checks = project?.checks || [];
    const warnings = project?.warnings || [];
    $("#demo-checks").classList.toggle("hidden", !checks.length);
    $("#demo-checks-title").textContent = `자동 검증 ${checks.filter(check => check.ok).length}/${checks.length}`;
    $("#demo-check-list").innerHTML = [
      ...checks.map(check => `<li data-ok="${check.ok}"><b aria-hidden="true">${check.ok ? "✓" : "✕"}</b><span>${escapeHtml(check.label)}</span>${check.detail ? `<small>${escapeHtml(check.detail)}</small>` : ""}</li>`),
      ...warnings.map(warning => `<li data-ok="warn"><b aria-hidden="true">!</b><span>${escapeHtml(warning)}</span></li>`),
    ].join("");
  }

  function render() {
    renderHead();
    renderStage();
    renderTrack();
    renderScene();
    renderActions();
    renderChecks();
  }

  // ---------------------------------------------------------------- 재생
  function seek(ms, { play = true } = {}) {
    if (!currentVideo()) return;
    stopTogether();
    player.currentTime = Math.max(0, ms / 1000);
    if (play) player.play().catch(() => {});
  }

  function selectScene(id, { jump = true } = {}) {
    if (!scenes().some(scene => scene.id === id)) return;
    stopTogether();
    sceneId = id;
    renderTrack();
    renderScene();
    const planned = planScene(id);
    if (jump && planned) seek(planned.outStartMs, { play: false });
  }

  function stepScene(delta) {
    const list = scenes();
    const index = list.findIndex(scene => scene.id === sceneId);
    const next = list[Math.max(0, Math.min(list.length - 1, index + delta))];
    if (next) selectScene(next.id);
  }

  // 후보를 그 장면 영상 위에 얹어 듣는다. 완성본의 소리는 끄고 후보만 들린다. 후보 길이가
  // 지금 완성본의 내레이션과 다르면 다시 구울 때 그 장면 길이가 따라 바뀐다.
  function playTogether(file) {
    const scene = currentScene();
    const planned = planScene(scene?.id);
    const candidate = scene?.candidates.find(item => item.file === file);
    if (!candidate || !planned || !currentVideo()) return;
    if (together?.file === file) { stopTogether(); return; }
    stopTogether();
    together = { file, muted: player.muted };
    player.dataset.pair = "demo-together";
    voicePreview.dataset.pair = "demo-together";
    player.muted = true;
    voicePreview.src = candidate.url;
    player.currentTime = (planned.narration?.atMs ?? planned.outStartMs) / 1000;
    Promise.all([player.play(), voicePreview.play()]).catch(() => stopTogether());
    renderScene();
  }

  function stopTogether() {
    if (!together) return;
    const { muted } = together;
    together = null;
    voicePreview.pause();
    player.pause();
    player.muted = muted;
    delete player.dataset.pair;
    delete voicePreview.dataset.pair;
    renderScene();
  }

  player.addEventListener("timeupdate", () => {
    const ms = player.currentTime * 1000;
    const cue = captionsOn ? (project?.captions || []).find(item => ms >= item.startMs && ms < item.endMs) : null;
    const caption = $("#demo-caption");
    if (caption.textContent !== (cue?.text || "")) caption.textContent = cue?.text || "";
    caption.dataset.on = String(Boolean(cue));
    paintPlayhead();
    // 재생이 흘러가는 장면을 따라 오른쪽 장면 칸을 바꾼다. 쓰는 중에는 바꾸지 않는다.
    const current = project?.plan?.scenes?.find(scene => ms >= scene.outStartMs && ms < scene.outEndMs);
    const typing = document.activeElement?.id === "demo-scene-text";
    if (current && current.id !== sceneId && !player.paused && !together && !typing) {
      sceneId = current.id;
      renderScene();
      for (const tab of document.querySelectorAll("[data-demo-scene]")) {
        tab.setAttribute("aria-current", String(tab.dataset.demoScene === sceneId));
      }
    }
  });
  player.addEventListener("pause", () => { if (together && !voicePreview.paused) stopTogether(); });
  voicePreview.addEventListener("ended", () => setTimeout(stopTogether, 300));

  // ---------------------------------------------------------------- 저장
  function edits() {
    return scenes().map(scene => ({ id: scene.id, text: scene.text, status: scene.status, selected: scene.selected }));
  }

  async function save({ quiet = true } = {}) {
    if (!project) return null;
    const outDir = project.outDir;
    const saved = await api.saveDemoScript(outDir, edits());
    if (project?.outDir !== outDir) return saved;
    project = saved;
    renderHead();
    renderTrack();
    renderActions();
    if (!quiet) showToast("대본을 저장했습니다.");
    return project;
  }

  const guarded = (label, work) => work().catch(error => showToast(`${label} 실패: ${error.message}`, "error"));

  // ---------------------------------------------------------------- 사건
  function handleEvent(event) {
    if (!DEMO_POLISH_STEPS.includes(event.jobKind)) return;
    if (event.type === "demo-started") {
      running = { step: event.step, scenes: event.scenes || [], quality: event.quality, burnCaptions: Boolean(event.burnCaptions), outDir: event.outDir };
      $("#demo-polish-log").textContent = "";
      renderActions();
      renderScene();
      renderStage();
    } else if (event.type === "log") {
      const log = $("#demo-polish-log");
      log.textContent = (log.textContent + event.text).slice(-20_000);
    } else if (event.type === "demo-complete") {
      const finished = running;
      running = null;
      if (event.project && (!project || event.project.outDir === project.outDir)) {
        project = event.project;
        if (!scenes().some(scene => scene.id === sceneId)) sceneId = scenes()[0]?.id ?? null;
        // 방금 구운 화질로 바꿔 보여 준다. 그것을 보려고 구웠다.
        // 자막이 없어 굽지 못했으면 자막 없는 이름으로 나온다. 둘 다 찾아본다.
        const baked = finished?.step === "demo-render"
          ? bakedVersion(project, finished.quality, finished.burnCaptions) || bakedVersion(project, finished.quality)
          : null;
        if (baked) version = baked;
        else if (!project.videos.some(video => video.name === version)) version = defaultVersion(project.videos);
      }
      render();
      showToast(event.step === "demo-voice" ? "목소리 후보가 나왔습니다. 영상에 맞춰 듣고 고르세요." : "완성본을 만들었습니다.");
    } else if (event.type === "demo-failed") {
      running = null;
      render();
      showToast(event.cancelled ? "중지했습니다." : `실패: ${event.message}`, event.cancelled ? "success" : "error");
    }
  }

  // ---------------------------------------------------------------- 연결
  $("#demo-polish-pick").addEventListener("click", () => guarded("결과 폴더 읽기", async () => {
    const picked = await api.pickDemoProject();
    if (picked) load(picked);
  }));
  $("#demo-versions").addEventListener("click", event => {
    const button = event.target.closest("[data-demo-version]");
    if (!button) return;
    version = button.dataset.demoVersion;
    renderStage();
  });
  $("#demo-captions").addEventListener("click", () => {
    captionsOn = !captionsOn;
    $("#demo-captions").setAttribute("aria-pressed", String(captionsOn));
    if (!captionsOn) { $("#demo-caption").textContent = ""; $("#demo-caption").dataset.on = "false"; }
  });
  $("#demo-track").addEventListener("click", event => {
    const tab = event.target.closest("[data-demo-scene]");
    if (tab) return selectScene(tab.dataset.demoScene);
    const at = event.target.closest("[data-demo-at]");
    if (at) seek(Number(at.dataset.demoAt));
  });
  const panel = $("#demo-scene-panel");
  panel.addEventListener("click", event => {
    const step = event.target.closest("[data-demo-step]");
    if (step) return stepScene(Number(step.dataset.demoStep));
    const listen = event.target.closest("[data-demo-together]");
    if (listen) { event.preventDefault(); return playTogether(listen.dataset.demoTogether); }
    if (event.target.closest("#demo-scene-voice")) {
      const scene = currentScene();
      guarded("목소리", async () => {
        await save();
        await api.startDemoVoice({ outDir: project.outDir, candidates: Number($("#demo-candidates").value) || 3, scene: scene.id });
      });
    }
  });
  // 쓰는 대로 들고 있다가 칸을 떠날 때(change) 저장한다. 글자마다 파일을 쓰지 않는다.
  panel.addEventListener("input", event => {
    if (event.target.id !== "demo-scene-text") return;
    const scene = currentScene();
    if (scene) scene.text = event.target.value;
  });
  panel.addEventListener("change", event => {
    const scene = currentScene();
    if (!scene) return;
    if (event.target.id === "demo-scene-text") {
      scene.text = event.target.value.trim();
    } else if (event.target.id === "demo-scene-approved") {
      scene.status = event.target.checked ? "approved" : "draft";
    } else if (event.target.matches("[data-demo-select]")) {
      scene.selected = event.target.value;
      for (const card of panel.querySelectorAll(".candidate-card")) {
        card.classList.toggle("selected", card.contains(event.target));
      }
    } else return;
    guarded("대본 저장", async () => {
      await save();
      // 확정·고르기는 이 칸의 모양을 바꾼다(후보 단추, 쓰는 중 표시). 글은 쓰는 자리를 지킨다.
      if (event.target.id !== "demo-scene-text") renderScene();
      else if (isStale(currentScene()) !== Boolean(panel.querySelector(".demo-stale"))) renderScene();
    });
  });
  $("#demo-voice-all").addEventListener("click", () => guarded("목소리", async () => {
    await save();
    const needs = scenesNeedingVoice(project);
    if (!needs.length) return;
    await api.startDemoVoice({ outDir: project.outDir, candidates: Number($("#demo-candidates").value) || 3, scenes: needs });
  }));
  $("#demo-render-start").addEventListener("click", () => guarded("완성본", async () => {
    await save();
    await api.startDemoRender({ outDir: project.outDir, quality: $("#demo-quality").value, burnCaptions: $("#demo-burn").checked });
  }));
  $("#demo-preview-render").addEventListener("click", () => guarded("미리 굽기", async () => {
    await save();
    await api.startDemoRender({ outDir: project.outDir, quality: "standard" });
  }));
  // 중지는 다른 작업과 같은 길을 쓴다.
  $("#demo-polish-cancel").addEventListener("click", async () => {
    $("#demo-polish-cancel").disabled = true;
    try {
      if (!await api.cancel()) showToast("중지할 작업이 없습니다.");
    } catch (error) {
      showToast(`중지 요청 실패: ${error.message}`, "error");
    } finally {
      $("#demo-polish-cancel").disabled = false;
    }
  });

  // 자판: 강의 다듬기와 같은 손버릇이다(space 재생, ←→ 이동, [ ] 앞뒤). 한 칸이 장면이다.
  function shortcut(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if ($("#view-review")?.classList.contains("hidden") || $("#review-demo")?.classList.contains("hidden")) return;
    if (document.querySelector?.("dialog[open]")) return;
    const target = event.target;
    if (target?.isContentEditable || SKIP_TAGS.has(target?.tagName)) return;
    if (event.key === " ") {
      if (!currentVideo()) return;
      event.preventDefault();
      if (player.paused) player.play().catch(() => {});
      else player.pause();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (!currentVideo()) return;
      event.preventDefault();
      seek(player.currentTime * 1000 + (event.key === "ArrowLeft" ? -2000 : 2000), { play: !player.paused });
    } else if (event.key === "[" || event.key === "]") {
      event.preventDefault();
      stepScene(event.key === "[" ? -1 : 1);
    } else if (/^[1-9]$/.test(event.key)) {
      const scene = scenes()[Number(event.key) - 1];
      if (scene) { event.preventDefault(); selectScene(scene.id); }
    }
  }
  document.addEventListener?.("keydown", shortcut);
  // 처음에는 빈 작업면을 그려 둔다. 단추가 "열 결과 없음" 상태에서 시작한다.
  render();

  function load(next, { keepScene = false } = {}) {
    const same = project?.outDir === next.outDir;
    stopTogether();
    project = next;
    if (!(keepScene && same) || !scenes().some(scene => scene.id === sceneId)) {
      // 처음 열면 할 일이 남은 첫 장면에서 시작한다. 후보가 예전 대본을 읽는 장면도 할 일이다.
      const todo = scenes().find(scene => !scene.text?.trim() || scene.status !== "approved"
        || !scene.selected || isStale(scene));
      sceneId = (todo || scenes()[0])?.id ?? null;
    }
    if (!same || !project.videos.some(video => video.name === version)) version = defaultVersion(project.videos);
    render();
    show();
  }

  return {
    /** 결과 폴더를 연다. CLI로 찍었든 새로 만들기에서 찍었든 같은 폴더다. */
    async open(outDir) {
      load(await api.readDemoProject(outDir), { keepScene: true });
    },
    /** 이미 읽어 둔 결과를 그대로 연다(촬영이 끝나며 온 것). */
    load,
    /** 최근 결과에서 고른 앱 데모를 연다. */
    async openTarget(target) {
      const outDir = await api.demoProjectDir(target);
      await this.open(outDir);
    },
    /** 이 작업면으로 돌아온다. 도는 작업을 보러 오는 길이다. */
    reveal() { render(); show(); },
    handleEvent,
    /** 목소리·렌더 중에 창을 다시 열었을 때. 결과는 끝나는 사건에 함께 온다. */
    restore(job) {
      running = { step: job.kind, scenes: [], quality: null };
      render();
    },
    /** 다른 작업이 돌 때 시작 단추만 막는다. 대본은 그동안에도 쓸 수 있다. */
    setBlocked(note) {
      if (blocked === note) return;
      blocked = note;
      renderStage();
      renderScene();
      renderActions();
    },
    pause() {
      stopTogether();
      player.pause();
    },
    get project() { return project; },
  };
}
