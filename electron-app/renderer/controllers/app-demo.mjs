// 앱 데모 촬영 화면. 촬영 → 대본 → 목소리 → 렌더를 한 화면의 단계로 잇는다.
//
// 강의 제작과 방향이 반대다. 화면을 먼저 찍고 대본이 그 길이에 맞춘다. 그래서
// 단계가 순서대로 열린다 — 찍기 전에는 대본 칸이 없고, 대본을 확정하기 전에는
// 후보를 만들 수 없다. 고르는 것은 언제나 사람이다.

export const DEMO_STEPS = ["demo-record", "demo-voice", "demo-render"];

/** 다음에 할 일. 결과 폴더의 상태만 보고 정한다. */
export function nextStep(project) {
  if (!project) return "record";
  const scenes = project.scenes || [];
  if (!scenes.some(scene => scene.status === "approved" && scene.text?.trim())) return "script";
  if (!scenes.some(scene => scene.candidates?.length)) return "voice";
  const approved = scenes.filter(scene => scene.status === "approved");
  if (approved.some(scene => !scene.selected)) return "select";
  return "render";
}

export function stepLabel(step) {
  return {
    record: "시나리오를 골라 촬영합니다",
    script: "장면마다 대본을 쓰고 확정합니다",
    voice: "확정한 대본으로 목소리 후보를 만듭니다",
    select: "후보를 듣고 장면마다 하나를 고릅니다",
    render: "고른 음성으로 완성본을 만듭니다",
  }[step] || "";
}

export function sceneSeconds(scene) {
  const src = (scene.endMs - scene.startMs) / 1000;
  // 느리게 찍은 장면은 편집이 되돌린다. 화면에는 되돌린 뒤의 길이를 보여 준다.
  return { src, out: src * (scene.timeScale ?? 1) };
}

export function createAppDemoController({
  $, $$, api, showToast, setIconStatus, goToView = () => {}, document = globalThis.document,
}) {
  let scenarios = [];
  let scenario = null;
  let project = null;
  let running = null;

  const busy = () => running !== null;

  function status(label, tone = "idle") {
    setIconStatus("#demo-top-status", label, tone);
  }

  function setRunning(step) {
    running = step;
    $("#demo-progress").classList.toggle("hidden", !step);
    $("#demo-progress-label").textContent = step
      ? { "demo-record": "촬영 중입니다", "demo-voice": "목소리 후보를 만들고 있습니다", "demo-render": "완성본을 만들고 있습니다" }[step]
      : "";
    for (const button of $$("[data-demo-action]")) button.disabled = Boolean(step);
    status(step ? "실행 중" : "대기", step ? "busy" : "idle");
  }

  const seconds = ms => `${(ms / 1000).toFixed(1)}초`;

  function renderScenario() {
    const panel = $("#demo-scenario");
    const cards = scenarios.map(item => {
      const slow = (item.scenes || []).filter(scene => scene.timeScale < 1).length;
      const detail = item.error
        ? item.error
        : `장면 ${item.scenes.length}개${slow ? ` · 느리게 찍는 장면 ${slow}개` : ""}`;
      return `<button type="button" class="display-card" role="radio"
        aria-checked="${scenario?.file === item.file}" data-scenario="${escapeHtml(item.file)}"${item.error ? " disabled" : ""}>
        <strong>${escapeHtml(item.name)}</strong>
        <small>${escapeHtml(item.from || "")}</small>
        <small>${escapeHtml(detail)}</small>
      </button>`;
    }).join("");
    panel.innerHTML = `
      <div class="display-list" role="radiogroup" aria-label="촬영할 시나리오">
        ${cards || '<p class="display-empty">옆 저장소에서 시나리오를 찾지 못했습니다.\n"다른 파일 고르기"로 직접 열어 주세요.</p>'}
      </div>
      ${scenario ? `<div class="demo-chips">${scenario.scenes.map(scene => `
        <span class="demo-chip${scene.timeScale < 1 ? " slow" : ""}">${escapeHtml(scene.id)}${
          scene.timeScale < 1 ? `<b>${Math.round(1 / scene.timeScale)}배로 되돌림</b>` : ""}</span>`).join("")}</div>
        <p class="context-advice">${escapeHtml(scenario.file)}</p>` : ""}`;
    $("#demo-record-start").disabled = !scenario || busy();
  }

  function sceneCard(scene) {
    const { src, out } = sceneSeconds(scene);
    const back = scene.timeScale < 1 ? ` · ${Math.round(1 / scene.timeScale)}배로 되돌림` : "";
    return `
      <article class="card record-card demo-scene" data-scene="${escapeHtml(scene.id)}">
        <div class="card-heading">
          <div><h2>${escapeHtml(scene.id)}</h2></div>
          <small class="demo-scene-length">촬영 ${seconds(src * 1000)} → 완성 약 ${seconds(out * 1000)}${back}</small>
        </div>
        <label class="field full"><span>대본</span>
          <textarea rows="3" data-demo-text="${escapeHtml(scene.id)}" spellcheck="false" placeholder="이 장면에서 할 말을 적습니다.">${escapeHtml(scene.text)}</textarea>
          <small>완성 길이보다 길면 편집이 덜 되돌립니다 — 그만큼 화면이 느려 보입니다.</small>
        </label>
        <label class="check-row full"><input type="checkbox" data-demo-approved="${escapeHtml(scene.id)}"${scene.status === "approved" ? " checked" : ""}><span><strong>대본 확정</strong><small>확정한 장면만 목소리를 만듭니다.</small></span></label>
        ${scene.screenText ? `<details class="advanced-options full"><summary><span>찍힌 화면의 글</span><small>대본의 근거</small></summary><div><pre class="demo-screen-text">${escapeHtml(scene.screenText)}</pre></div></details>` : ""}
        ${scene.candidates.length ? `<div class="candidate-gallery">
          <p>후보 ${scene.candidates.length}벌 — 듣고 하나를 고릅니다. 고르면 바로 저장됩니다.</p>
          <div>${scene.candidates.map(candidate => `
            <label class="candidate-card${scene.selected === candidate.file ? " selected" : ""}">
              <input type="radio" name="voice-${escapeHtml(scene.id)}" value="${escapeHtml(candidate.file)}"${scene.selected === candidate.file ? " checked" : ""} data-demo-select="${escapeHtml(scene.id)}">
              <div>
                <strong>${escapeHtml(candidate.name)}</strong>
                <small>${candidate.durationMs ? seconds(candidate.durationMs) : "길이 모름"}</small>
                <audio controls preload="none" src="${escapeHtml(candidate.url)}"></audio>
              </div>
            </label>`).join("")}</div>
        </div>` : '<p class="context-advice">아직 목소리 후보가 없습니다. 대본을 확정하고 아래에서 만듭니다.</p>'}
      </article>`;
  }

  function renderProject() {
    const host = $("#demo-project");
    if (!project) {
      host.classList.add("hidden");
      return;
    }
    host.classList.remove("hidden");
    $("#demo-step-hint").textContent = stepLabel(nextStep(project));
    $("#demo-project-name").textContent = project.name;
    $("#demo-project-meta").textContent =
      `${project.scenario} · 촬영 ${seconds(project.durationMs)} · 장면 ${project.scenes.length}개`;
    $("#demo-scenes").innerHTML = project.scenes.map(sceneCard).join("");
    $("#demo-videos").innerHTML = project.videos.length
      ? project.videos.map(video => `<li><a href="${escapeHtml(video.url)}" target="_blank">${escapeHtml(video.name)}</a></li>`).join("")
      : '<li>아직 완성본이 없습니다.</li>';
    $("#demo-review").classList.toggle("hidden", !project.reviewUrl);
    if (project.reviewUrl) $("#demo-review").href = project.reviewUrl;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, ch =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  function collectScenes() {
    return (project?.scenes || []).map(scene => ({
      id: scene.id,
      text: $(`[data-demo-text="${CSS.escape(scene.id)}"]`)?.value ?? scene.text,
      status: $(`[data-demo-approved="${CSS.escape(scene.id)}"]`)?.checked ? "approved" : "draft",
      selected: $(`[data-demo-select="${CSS.escape(scene.id)}"]:checked`)?.value ?? scene.selected,
    }));
  }

  async function saveScript({ quiet = false } = {}) {
    if (!project) return null;
    project = await api.saveDemoScript(project.outDir, collectScenes());
    renderProject();
    if (!quiet) showToast("대본을 저장했습니다.");
    return project;
  }

  async function guarded(work, label) {
    try {
      await work();
    } catch (error) {
      setRunning(null);
      status("실패", "error");
      showToast(`${label} 실패: ${error.message}`);
    }
  }

  function handleEvent(event) {
    if (!DEMO_STEPS.includes(event.jobKind)) return;
    if (event.type === "demo-started") setRunning(event.step);
    if (event.type === "demo-complete") {
      setRunning(null);
      status("끝", "ready");
      if (event.project) { project = event.project; renderProject(); }
      showToast({ "demo-record": "촬영을 마쳤습니다.", "demo-voice": "목소리 후보가 나왔습니다.", "demo-render": "완성본을 만들었습니다." }[event.step]);
    }
    if (event.type === "demo-failed") {
      setRunning(null);
      status(event.cancelled ? "중지" : "실패", event.cancelled ? "idle" : "error");
      showToast(event.cancelled ? "중지했습니다." : `실패: ${event.message}`);
    }
  }

  function bind() {
    $("#demo-pick")?.addEventListener("click", () => guarded(async () => {
      const picked = await api.pickDemoScenario();
      if (!picked) return;
      scenario = picked;
      if (!scenarios.some(item => item.file === picked.file)) scenarios = [...scenarios, picked];
      renderScenario();
    }, "시나리오 읽기"));

    // 목록에서 고르는 길이 먼저다. 파일 고르기는 목록 밖의 시나리오를 위한 것이다.
    $("#demo-scenario")?.addEventListener("click", event => {
      const card = event.target.closest("[data-scenario]");
      if (!card) return;
      scenario = scenarios.find(item => item.file === card.dataset.scenario) || scenario;
      renderScenario();
    });

    // 찍어 둔 결과를 이어 받는다. CLI로 찍었든 저번에 찍었든 같은 폴더다.
    $("#demo-open")?.addEventListener("click", () => guarded(async () => {
      const opened = await api.pickDemoProject();
      if (!opened) return;
      project = opened;
      renderProject();
    }, "결과 폴더 읽기"));

    $("#demo-record-start")?.addEventListener("click", () => guarded(async () => {
      if (!scenario) throw new Error("시나리오를 먼저 골라 주세요.");
      setRunning("demo-record");
      await api.startDemoRecord({ scenarioFile: scenario.file, name: $("#demo-name").value.trim() || undefined });
    }, "촬영"));

    $("#demo-save")?.addEventListener("click", () => guarded(() => saveScript(), "대본 저장"));

    $("#demo-voice-start")?.addEventListener("click", () => guarded(async () => {
      await saveScript({ quiet: true });
      setRunning("demo-voice");
      await api.startDemoVoice({ outDir: project.outDir, candidates: Number($("#demo-candidates").value) || 3 });
    }, "목소리"));

    $("#demo-render-start")?.addEventListener("click", () => guarded(async () => {
      await saveScript({ quiet: true });
      setRunning("demo-render");
      await api.startDemoRender({ outDir: project.outDir, quality: $("#demo-quality").value });
    }, "렌더"));

    $("#demo-scenes")?.addEventListener("change", event => {
      if (!event.target.matches("[data-demo-select]")) return;
      const card = event.target.closest(".candidate-card");
      for (const other of card.parentElement.querySelectorAll(".candidate-card")) {
        other.classList.toggle("selected", other === card);
      }
      void saveScript({ quiet: true });
    });

    // 중지는 다른 작업과 같은 길을 쓴다. 촬영이 만든 폴더는 작업자가 치운다.
    $("#demo-cancel")?.addEventListener("click", async () => {
      $("#demo-cancel").disabled = true;
      try {
        if (!await api.cancel()) $("#demo-cancel").disabled = false;
      } catch (error) {
        $("#demo-cancel").disabled = false;
        showToast(`중지 요청 실패: ${error.message}`);
      }
    });
  }

  return {
    bind,
    handleEvent,
    async opened() {
      if (!scenarios.length) {
        scenarios = await api.listDemoScenarios().catch(() => []);
      }
      renderScenario();
      renderProject();
      status(busy() ? "실행 중" : "대기", busy() ? "busy" : "idle");
    },
    /** 앱 데모 작업 중에 창을 다시 열었을 때. 결과 폴더는 작업이 끝나는 사건에 함께 온다. */
    restore(job) {
      setRunning(job.kind);
    },
    /** 다른 화면이나 CLI가 만든 결과 폴더를 그대로 이어 받는다. */
    async open(outDir) {
      project = await api.readDemoProject(outDir);
      renderProject();
      return project;
    },
    /** 최근 결과에서 고른 앱 데모를 이 화면으로 가져온다. */
    async resume(target) {
      const outDir = await api.demoProjectDir(target);
      await this.open(outDir);
      goToView("demo");
    },
  };
}
