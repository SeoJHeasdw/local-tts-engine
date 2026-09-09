import { animateLayout } from "../motion.mjs";
import { filterOutputItems, visibleVoiceFindings, outputKind, outputState, outputRowTitle, voiceFindingSummaryLine, shouldOpenMenuUpward, outputGroupTitle, groupOutputs } from "../view-utils.mjs";

export function createOutputsController({ $, $$, api, showToast, formatDuration, formatDate, review, document = globalThis.document }) {
  let outputItems = [];

  let outputFilter = "all";

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

  // 이름은 그 자리에서 고치는 것이 가장 짧다. 대화상자를 띄우면 어느 줄을
  // 고치는 중인지 눈에서 놓치고, 고친 결과도 뒤에 가려 보이지 않는다.
  function editOutputName(element, item, target) {
    if (!item.fileName || element.querySelector("input")) return;
    const previous = element.textContent;
    const field = document.createElement("input");
    field.type = "text";
    field.className = "rename-field";
    field.value = item.fileName;
    field.setAttribute("aria-label", "파일 이름");
    element.replaceChildren(field);
    const dot = item.fileName.lastIndexOf(".");
    field.focus();
    field.setSelectionRange(0, dot > 0 ? dot : item.fileName.length);
    let settled = false;
    const restore = () => { element.replaceChildren(); element.textContent = previous; };
    const commit = async () => {
      if (settled) return;
      settled = true;
      const value = field.value.trim();
      if (!value || value === item.fileName) return restore();
      try {
        const renamed = await api.renameOutput(target, value);
        showToast(`이름을 ${renamed.fileName}(으)로 바꿨습니다.`);
        await loadOutputs();
      } catch (error) { showToast(error.message, "error"); restore(); }
    };
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); commit(); }
      if (event.key === "Escape") { event.preventDefault(); settled = true; restore(); }
    });
    field.addEventListener("blur", commit);
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
                <button class="rename-button" type="button">이름 바꾸기</button>
                <button class="reveal-button" type="button">Finder에서 보기</button>
                <button class="delete-button" type="button">휴지통으로 보내기</button>
              </div>
            </details>
          </div>`;

        const title = row.querySelector("strong");
        title.textContent = outputRowTitle(item, { compact });
        if (item.fileName) {
          title.title = `${item.fileName} · 더블클릭해서 이름 바꾸기`;
          title.classList.add("renamable");
          title.addEventListener("dblclick", () => editOutputName(title, item, target));
        }
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
          row.querySelector(".open-button").addEventListener("click", () => review.openReview(target));
        } else {
          row.querySelector(".open-button").addEventListener("click", () => api.open(target).catch((error) => showToast(error.message, "error")));
        }
        row.querySelector(".rename-button").addEventListener("click", () => {
          resultMenu.removeAttribute("open");
          editOutputName(row.querySelector("strong"), item, target);
        });
        row.querySelector(".rename-button").disabled = !item.fileName;
        row.querySelector(".reveal-button").addEventListener("click", () => {
          resultMenu.removeAttribute("open");
          api.reveal(target).catch((error) => showToast(error.message, "error"));
        });
        row.querySelector(".delete-button").addEventListener("click", async () => {
          resultMenu.removeAttribute("open");
          try {
            if (!await api.deleteOutput(target)) return;
            showToast("휴지통으로 보냈습니다. Finder에서 되돌릴 수 있습니다.");
            await loadOutputs();
          } catch (error) { showToast(error.message, "error"); }
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

  return {
    loadOutputs,
    renderOutputs,
    closeResultMenus,
    get outputFilter() { return outputFilter; },
    set outputFilter(value) { outputFilter = value; },
  };
}
