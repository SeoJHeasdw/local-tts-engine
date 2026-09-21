// 새로 만들기의 앱 데모. 시나리오를 골라 직접 만든 앱을 자동으로 조작하며 찍는다.
//
// 강의 제작과 방향이 반대다. 화면을 먼저 찍고 대본이 그 길이에 맞춘다. 찍은 뒤의 대본·
// 목소리·완성본은 다듬기가 한다(controllers/demo-polish.mjs) — 사람이 보고 판단하는
// 단계를 영상 옆 한 화면에 모으기 위해서다. 화면 녹화가 찍고 나서 다듬기로 넘기는 것과 같다.

export function createAppDemoController({
  $, $$, api, showToast, setIconStatus, openInPolish = async () => {}, document = globalThis.document,
}) {
  let scenarios = [];
  let scenario = null;
  let running = false;
  // 방금 찍은 결과. 결과 카드의 "다듬기에서 대본 쓰기"가 이것을 연다.
  let latest = null;

  function status(label, tone = "idle") {
    setIconStatus("#demo-top-status", label, tone);
  }

  function setRunning(on) {
    running = on;
    $("#demo-progress").classList.toggle("hidden", !on);
    $("#demo-setup").classList.toggle("hidden", on);
    if (on) $("#demo-done").classList.add("hidden");
    $("#demo-cancel").disabled = false;
    for (const button of $$("[data-demo-action]")) button.disabled = on;
    renderScenario();
    status(on ? "촬영 중" : "대기", on ? "running" : "idle");
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
        aria-checked="${scenario?.file === item.file}" data-scenario="${escapeHtml(item.file)}"${item.error || running ? " disabled" : ""}>
        <strong>${escapeHtml(item.name)}</strong>
        <small>${escapeHtml(item.from || "")}</small>
        <small>${escapeHtml(detail)}</small>
      </button>`;
    }).join("");
    panel.innerHTML = `
      <div class="display-list" role="radiogroup" aria-label="촬영할 시나리오">
        ${cards || '<p class="display-empty">옆 저장소에서 시나리오를 찾지 못했습니다.\n"시나리오 고르기"로 직접 열어 주세요.</p>'}
      </div>
      ${scenario ? `<div class="demo-chips">${scenario.scenes.map(scene => `
        <span class="demo-chip${scene.timeScale < 1 ? " slow" : ""}">${escapeHtml(scene.id)}${
          scene.timeScale < 1 ? `<b>${Math.round(1 / scene.timeScale)}배로 되돌림</b>` : ""}</span>`).join("")}</div>
        <p class="context-advice">${escapeHtml(scenario.file)}</p>` : ""}`;
    $("#demo-record-start").disabled = !scenario || running;
  }

  // 녹화처럼 결과 카드는 설정 위에 붙고 설정은 그대로 보인다. 다시 찍는 길을 찾아 헤매지 않는다.
  function finished({ ok, title, summary }) {
    $("#demo-done").classList.remove("hidden");
    $("#demo-done").dataset.tone = ok ? "ready" : "failed";
    $("#demo-done-icon").textContent = ok ? "✓" : "!";
    $("#demo-done-title").textContent = title;
    $("#demo-done-summary").textContent = summary;
    $("#demo-polish-go").classList.toggle("hidden", !ok || !latest);
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, ch =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  function handleEvent(event) {
    if (event.jobKind !== "demo-record") return;
    if (event.type === "demo-started") {
      latest = null;
      $("#demo-log").textContent = "";
      setRunning(true);
    } else if (event.type === "log") {
      const log = $("#demo-log");
      log.textContent = (log.textContent + event.text).slice(-20_000);
    } else if (event.type === "demo-complete") {
      setRunning(false);
      latest = event.project || null;
      finished({
        ok: true,
        title: "촬영을 마쳤습니다",
        summary: latest ? `${latest.name} · 장면 ${latest.scenes.length}개 · 촬영 ${seconds(latest.durationMs)}` : "",
      });
      status("촬영을 마쳤습니다", "complete");
      $("#demo-name").value = "";
    } else if (event.type === "demo-failed") {
      setRunning(false);
      if (event.cancelled) {
        status("촬영을 중지했습니다");
        showToast("촬영을 중지했습니다. 결과는 남기지 않았습니다.");
        return;
      }
      finished({ ok: false, title: "촬영하지 못했습니다", summary: event.message });
      status("촬영 오류를 확인해 주세요", "failed");
    }
  }

  async function guarded(work, label) {
    try {
      await work();
    } catch (error) {
      setRunning(false);
      status("실패", "failed");
      showToast(`${label} 실패: ${error.message}`, "error");
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

    // 찍어 둔 결과는 다듬기에서 잇는다. CLI로 찍었든 저번에 찍었든 같은 폴더다.
    $("#demo-open")?.addEventListener("click", async () => {
      try {
        const opened = await api.pickDemoProject();
        if (opened) await openInPolish(opened);
      } catch (error) { showToast(`결과 폴더 읽기 실패: ${error.message}`, "error"); }
    });

    $("#demo-record-start")?.addEventListener("click", () => guarded(async () => {
      if (!scenario) throw new Error("시나리오를 먼저 골라 주세요.");
      setRunning(true);
      await api.startDemoRecord({ scenarioFile: scenario.file, name: $("#demo-name").value.trim() || undefined });
    }, "촬영"));

    $("#demo-polish-go")?.addEventListener("click", async () => {
      if (!latest) return;
      try { await openInPolish(latest); } catch (error) { showToast(error.message, "error"); }
    });
    $("#demo-dismiss")?.addEventListener("click", () => $("#demo-done").classList.add("hidden"));

    // 중지는 다른 작업과 같은 길을 쓴다. 촬영이 만든 폴더는 작업자가 치운다.
    $("#demo-cancel")?.addEventListener("click", async () => {
      $("#demo-cancel").disabled = true;
      try {
        if (!await api.cancel()) $("#demo-cancel").disabled = false;
      } catch (error) {
        $("#demo-cancel").disabled = false;
        showToast(`중지 요청 실패: ${error.message}`, "error");
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
    },
    /** 촬영 중에 창을 다시 열었을 때. */
    restore() {
      setRunning(true);
    },
  };
}
