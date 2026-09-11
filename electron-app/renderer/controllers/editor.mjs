export function createEditorController({ $, review, setIconStatus, api, showToast, setEditBusy, openJobDialog, document = globalThis.document }) {
  // 영상 편집은 클립 목록 하나다. 구간을 준 클립 하나가 자르기, 구간 없는 클립
  // 여럿이 합치기, 섞으면 예전 두 탭으로는 만들 수 없던 편집이 된다. 화면이 하는
  // 일은 그 목록을 보여 주고 고치게 하는 것뿐이고, 렌더는 compose 하나로 간다.
  let editorClips = [];

  let editorActive = -1;

  // 이어서 미리보기 중에는 한 클립의 끝이 멈춤이 아니라 다음 클립의 시작이다.
  let previewingAll = false;

  const editorPlayer = $("#editor-player");

  function editorClip() { return editorClips[editorActive] || null; }

  function clipLengthMs(clip) { return Math.max(0, Number(clip.outMs) - Number(clip.inMs)); }

  function trimmed(clip) { return clip.inMs > 0 || clip.outMs < clip.durationMs; }

  // 공용 formatDuration 은 0을 '길이 확인 전'이라고 읽는다. 길이를 아직 모르는
  // 결과 목록에서는 맞는 말이지만, 편집기의 0은 '모름'이 아니라 '처음'이다.
  // 여기서는 아는 숫자만 다루므로 자리와 길이를 그대로 시계로 적는다.
  function formatMark(ms) {
    const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
    const whole = Math.round(total);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  }

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

  // 담은 것이 없을 때는 큰 자리 하나만 남긴다. 빈 재생기와 눌리지 않는 단추를
  // 함께 보여 주면 무엇부터 해야 하는지가 오히려 흐려진다. 하나라도 담으면 그
  // 자리는 사라지고, 다시 담는 길은 클립 줄의 '＋ 영상 담기'와 끌어다 놓기다.
  function renderEditorShell() {
    const empty = editorClips.length === 0;
    $("#editor-drop").classList.toggle("hidden", !empty);
    $(".editor").classList.toggle("hidden", empty);
    $(".editor-track").classList.toggle("hidden", empty);
  }

  function renderEditorOutput() {
    const total = editorClips.reduce((sum, clip) => sum + clipLengthMs(clip), 0);
    $("#editor-total").textContent = editorClips.length ? formatMark(total) : "0:00";
    const cut = editorClips.filter(trimmed).length;
    // 다시 굽는 비용은 클립마다 갈린다. 실행 전에 알려 주면 기다릴지 말지 고를 수 있다.
    $("#editor-quality").textContent = editorClips.length === 0
      ? "클립을 담으면 다시 구울지 그대로 쓸지 알려드립니다."
      : cut === 0
        ? "규격이 같은 전체 클립은 그대로 이어 붙입니다. 규격이 다르면 가장 큰 입력 해상도에 맞춥니다."
        : `자른 구간을 정확히 반영해 다시 만듭니다. 가장 큰 입력 해상도를 유지합니다.`;
    $("#start-edit-label").textContent = editorClips.length > 1 ? "이어서 만들기" : "이대로 만들기";
    $("#editor-preview-all").disabled = editorClips.length === 0 || review.reviewBusy;
    $("#editor-preview-all").textContent = previewingAll ? "미리보기 멈추기" : "처음부터 이어서 미리보기";
  }

  // 쓸 구간을 숫자로만 정하면, 어디를 자르고 있는지는 머릿속에서 그려야 한다.
  // 클립 전체 길이를 막대 하나로 두고 남길 구간을 띠로 칠하면 그 그림이 화면에
  // 있다. 재생 위치도 같은 자에 얹어 지금 듣는 데가 구간 안인지 밖인지 보인다.
  function renderTrim() {
    const clip = editorClip();
    const span = Math.max(1, Number(clip?.durationMs) || 1);
    const percent = (ms) => `${Math.max(0, Math.min(100, (Number(ms) || 0) / span * 100))}%`;
    const start = clip ? percent(clip.inMs) : "0%";
    $("#editor-trim-band").style.left = start;
    $("#editor-trim-band").style.width = clip
      ? `${Math.max(0, Math.min(100, clipLengthMs(clip) / span * 100))}%` : "0%";
    $("#editor-trim-cursor").style.left = clip ? percent(editorPlayer.currentTime * 1000) : "0%";
    $("#editor-trim-in").style.left = start;
    $("#editor-trim-out").style.left = clip ? percent(clip.outMs) : "0%";
    for (const [id, ms] of [["#editor-trim-in", clip?.inMs], ["#editor-trim-out", clip?.outMs]]) {
      $(id).setAttribute("aria-label", `구간 ${id.endsWith("in") ? "시작" : "끝"} ${formatTimecode(ms)}, 좌우 방향키로 0.1초 이동`);
    }
    $("#editor-trim-note").textContent = !clip
      ? "막대를 눌러 옮기고, 시작·끝 손잡이를 끌어 쓸 구간만 남기세요."
      : trimmed(clip)
        ? `남길 길이 ${formatMark(clipLengthMs(clip))} · 원본 ${formatMark(clip.durationMs)}에서 잘라 냅니다.`
        : `원본 전체 ${formatMark(clip.durationMs)}를 그대로 씁니다.`;
  }

  function renderEditorClipFields() {
    const clip = editorClip();
    $("#editor-clip-name").textContent = clip ? clip.name : "담은 영상이 없습니다";
    $("#editor-clip-time").textContent = clip
      ? `${formatMark(clip.inMs)}–${formatMark(clip.outMs)} · 원본 ${formatMark(clip.durationMs)}`
      : "—";
    $("#editor-in").value = clip ? formatTimecode(clip.inMs) : "00:00:00.000";
    $("#editor-out").value = clip ? formatTimecode(clip.outMs) : "00:00:00.000";
    for (const id of ["#editor-mark-in", "#editor-mark-out", "#editor-play-clip", "#editor-reset-clip",
      "#editor-in", "#editor-out", "#editor-close", "#editor-duplicate", "#editor-trim-in", "#editor-trim-out"]) {
      $(id).disabled = !clip || review.reviewBusy;
    }
    // 나누기는 재생 위치가 구간 안쪽에 있을 때만 뜻이 있다. 시작이나 끝에 붙은
    // 자리에서 나누면 길이 0인 클립이 생긴다.
    $("#editor-split").disabled = !clip || review.reviewBusy || !splitPointMs();
    renderTrim();
  }

  function splitPointMs() {
    const clip = editorClip();
    if (!clip) return null;
    const at = Math.round(editorPlayer.currentTime * 1000);
    return at > clip.inMs + 10 && at < clip.outMs - 10 ? at : null;
  }

  function renderEditorTrack() {
    $("#editor-count").textContent = String(editorClips.length);
    $("#start-edit-button").disabled = editorClips.length === 0 || review.reviewBusy;
    $("#editor-clips").replaceChildren(...editorClips.map((clip, index) => renderClipRow(clip, index)));
    renderEditorShell();
    renderEditorOutput();
  }

  function renderClipRow(clip, index) {
    const item = document.createElement("li");
    item.className = "track-clip";
    item.draggable = true;
    if (index === editorActive) item.classList.add("active");
    if (trimmed(clip)) item.classList.add("trimmed");

    const order = document.createElement("b");
    order.textContent = String(index + 1);
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = clip.name;
    const meta = document.createElement("small");
    meta.textContent = trimmed(clip)
      ? `${formatMark(clip.inMs)}–${formatMark(clip.outMs)} · ${formatMark(clipLengthMs(clip))}`
      : `전체 · ${formatMark(clipLengthMs(clip))}`;
    copy.append(title, meta);

    // 끌어서 옮기는 길만 두면, 손이 미끄러진 자리에서 순서가 조용히 바뀐다.
    // 한 칸씩 확실히 옮기는 길을 나란히 둔다.
    const tools = document.createElement("div");
    tools.className = "track-tools";
    for (const [step, label, hint] of [[-1, "◀", "앞으로 옮기기"], [1, "▶", "뒤로 옮기기"]]) {
      const move = document.createElement("button");
      move.type = "button";
      move.className = "track-move";
      move.textContent = label;
      move.title = hint;
      move.setAttribute("aria-label", `${clip.name} ${hint}`);
      move.disabled = review.reviewBusy || (step < 0 ? index === 0 : index === editorClips.length - 1);
      move.addEventListener("click", (event) => { event.stopPropagation(); moveClip(index, index + step); });
      tools.append(move);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "track-remove";
    remove.textContent = "×";
    remove.title = "이 클립 빼기";
    remove.setAttribute("aria-label", `${clip.name} 빼기`);
    remove.addEventListener("click", (event) => { event.stopPropagation(); removeClip(index); });
    tools.append(remove);

    item.append(order, copy, tools);
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
      // 파일을 클립 위에 놓은 것이라면 순서 바꾸기가 아니라 담기다. 바깥의
      // 끌어다 놓기가 받도록 여기서는 아무 것도 하지 않는다.
      const raw = event.dataTransfer.getData("text/plain");
      const from = Number(raw);
      if (raw === "" || !Number.isInteger(from) || from === index) return;
      event.stopPropagation();
      moveClip(from, index);
    });
    return item;
  }

  function moveClip(from, to) {
    if (review.reviewBusy) return;
    const target = Math.max(0, Math.min(editorClips.length - 1, to));
    if (from === target || !editorClips[from]) return;
    const [moved] = editorClips.splice(from, 1);
    editorClips.splice(target, 0, moved);
    selectEditorClip(target);
  }

  function removeClip(index) {
    if (review.reviewBusy || !editorClips[index]) return;
    editorClips.splice(index, 1);
    selectEditorClip(Math.min(index, editorClips.length - 1));
  }

  function selectEditorClip(index) {
    editorActive = index >= 0 && index < editorClips.length ? index : -1;
    const clip = editorClip();
    if (clip && editorPlayer.dataset.token !== clip.token) {
      editorPlayer.dataset.token = clip.token;
      editorPlayer.src = clip.videoUrl;
    }
    if (!clip) {
      previewingAll = false;
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

  // 한 영상의 중간을 들어내는 일은 편집에서 가장 흔한 손짓인데, 구간 하나짜리
  // 클립으로는 표현할 수 없었다. 재생 위치에서 둘로 나누면 앞뒤가 각각 클립이
  // 되고, 가운데를 빼는 것은 그중 하나를 지우는 일이 된다.
  function splitClip() {
    const at = splitPointMs();
    const clip = editorClip();
    if (!clip || at == null || review.reviewBusy) return false;
    const tail = { ...clip, inMs: at, outMs: clip.outMs };
    clip.outMs = at;
    editorClips.splice(editorActive + 1, 0, tail);
    selectEditorClip(editorActive + 1);
    showToast(`${formatMark(at)}에서 두 클립으로 나눴습니다.`);
    return true;
  }

  function duplicateClip() {
    const clip = editorClip();
    if (!clip || review.reviewBusy) return false;
    editorClips.splice(editorActive + 1, 0, { ...clip });
    selectEditorClip(editorActive + 1);
    return true;
  }

  function playClipRange(clip) {
    editorPlayer.currentTime = clip.inMs / 1000;
    editorPlayer.play().catch(() => showToast("미리보기의 재생 버튼을 눌러 주세요.", "error"));
  }

  // 클립마다 따로 들어 보는 것과 이어 붙인 결과를 보는 것은 다른 일이다. 굽기
  // 전에 순서와 이음매를 확인할 길이 없으면, 몇 분을 기다린 뒤에야 순서가
  // 틀렸다는 것을 안다. 완벽한 재생은 아니고 클립 경계에서 한 번 끊긴다.
  function togglePreviewAll() {
    if (!editorClips.length || review.reviewBusy) return;
    if (previewingAll) {
      previewingAll = false;
      editorPlayer.pause();
      renderEditorOutput();
      return;
    }
    previewingAll = true;
    renderEditorOutput();
    if (editorActive !== 0) selectEditorClip(0);
    playClipRange(editorClips[0]);
  }

  function advancePreview() {
    const next = editorActive + 1;
    if (next >= editorClips.length) {
      previewingAll = false;
      editorPlayer.pause();
      renderEditorOutput();
      return;
    }
    selectEditorClip(next);
    const clip = editorClip();
    // 다음 클립이 다른 파일이면 메타데이터를 읽은 뒤라야 그 자리로 옮길 수 있다.
    if (editorPlayer.readyState >= 1) playClipRange(clip);
    else editorPlayer.addEventListener("loadedmetadata", () => playClipRange(clip), { once: true });
  }

  $("#editor-pick").addEventListener("click", pickEditorVideos);
  $("#editor-add").addEventListener("click", pickEditorVideos);

  $("#editor-drop").addEventListener("click", (event) => { if (!event.target.closest("button")) pickEditorVideos(); });

  $("#editor-close").addEventListener("click", () => removeClip(editorActive));

  $("#editor-mark-in").addEventListener("click", () => moveClipEdge("inMs", Math.round(editorPlayer.currentTime * 1000)));

  $("#editor-mark-out").addEventListener("click", () => moveClipEdge("outMs", Math.round(editorPlayer.currentTime * 1000)));

  $("#editor-split").addEventListener("click", splitClip);

  $("#editor-duplicate").addEventListener("click", duplicateClip);

  $("#editor-preview-all").addEventListener("click", togglePreviewAll);

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
    previewingAll = false;
    renderEditorOutput();
    playClipRange(clip);
  });

  editorPlayer.addEventListener("timeupdate", () => {
    const clip = editorClip();
    if (!clip) return;
    renderTrim();
    $("#editor-split").disabled = review.reviewBusy || !splitPointMs();
    if (editorPlayer.currentTime * 1000 < clip.outMs) return;
    if (previewingAll) advancePreview();
    else editorPlayer.pause();
  });

  // 구간 막대를 직접 잡는다. 손잡이는 시간을 옮기고, 빈 자리를 누르면 그 자리로
  // 재생 위치가 간다. 끄는 동안에는 재생을 멈춘다 — 움직이는 그림 위에서
  // 경계를 맞추는 것은 맞출 수 없는 과녁을 겨누는 일이다.
  function trimTimeAt(clientX) {
    const clip = editorClip();
    const rect = $("#editor-trim-track").getBoundingClientRect();
    if (!clip || !(rect.width > 0)) return null;
    const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round(fraction * clip.durationMs);
  }

  for (const side of ["in", "out"]) {
    const handle = $(`#editor-trim-${side}`);
    const field = side === "in" ? "inMs" : "outMs";
    let pointer = null;
    handle.addEventListener("pointerdown", (event) => {
      if (review.reviewBusy) return;
      pointer = event.pointerId;
      handle.setPointerCapture?.(pointer);
      editorPlayer.pause();
    });
    handle.addEventListener("pointermove", (event) => {
      if (pointer !== event.pointerId) return;
      const ms = trimTimeAt(event.clientX);
      if (ms != null) moveClipEdge(field, ms);
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
      handle.addEventListener(type, () => { pointer = null; });
    }
    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const clip = editorClip();
      if (!clip) return;
      const step = (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 1000 : 100);
      moveClipEdge(field, clip[field] + step);
    });
  }

  $("#editor-trim-track").addEventListener("pointerdown", (event) => {
    if (event.target.closest?.(".trim-handle")) return;
    const ms = trimTimeAt(event.clientX);
    if (ms == null) return;
    editorPlayer.currentTime = ms / 1000;
    renderEditorClipFields();
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

  // 편집은 같은 손짓의 되풀이다. 자르고 듣고 다시 자르는 동안 손이 자판을
  // 떠나지 않도록, 편집기에서 흔히 쓰는 자리를 그대로 둔다. 글자를 치는
  // 중이거나 대화상자가 열려 있으면 자판은 그쪽 것이다.
  const SHORTCUT_SKIP_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON", "SUMMARY", "A"]);

  function editorShortcut(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if ($("#view-edit")?.classList?.contains("hidden")) return;
    if (document.querySelector?.("dialog[open]")) return;
    if (event.target?.isContentEditable || SHORTCUT_SKIP_TAGS.has(event.target?.tagName)) return;
    if (!editorClip()) return;
    const seek = (seconds) => {
      editorPlayer.currentTime = Math.max(0, editorPlayer.currentTime + seconds);
      renderEditorClipFields();
    };
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (key === " ") {
      event.preventDefault();
      if (editorPlayer.paused) editorPlayer.play().catch(() => {});
      else editorPlayer.pause();
    } else if (key === "ArrowLeft") { event.preventDefault(); seek(-5); }
    else if (key === "ArrowRight") { event.preventDefault(); seek(5); }
    else if (key === ",") { event.preventDefault(); seek(-0.1); }
    else if (key === ".") { event.preventDefault(); seek(0.1); }
    else if (key === "i") { event.preventDefault(); moveClipEdge("inMs", Math.round(editorPlayer.currentTime * 1000)); }
    else if (key === "o") { event.preventDefault(); moveClipEdge("outMs", Math.round(editorPlayer.currentTime * 1000)); }
    else if (key === "s") { event.preventDefault(); splitClip(); }
    else if (key === "[") { event.preventDefault(); selectEditorClip(Math.max(0, editorActive - 1)); }
    else if (key === "]") { event.preventDefault(); selectEditorClip(Math.min(editorClips.length - 1, editorActive + 1)); }
    else if (key === "Delete" || key === "Backspace") { event.preventDefault(); removeClip(editorActive); }
  }

  document.addEventListener?.("keydown", editorShortcut);

  $("#start-edit-button").addEventListener("click", async () => {
    if (!editorClips.length || review.reviewBusy) return;
    try {
      previewingAll = false;
      editorPlayer.pause();
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

  // 처음 그림은 담은 것이 없는 상태다. 단추와 칸을 모두 그 상태로 맞춰 둔다.
  selectEditorClip(-1);

  return {
    renderEditorTrack,
    addEditorClips,
    editorShortcut,
    splitClip,
    duplicateClip,
    removeClip,
    moveClip,
    togglePreviewAll,
    selectEditorClip,
    get clips() { return editorClips; },
    get activeIndex() { return editorActive; },
    get previewingAll() { return previewingAll; },
  };
}
