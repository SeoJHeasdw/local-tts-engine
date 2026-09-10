export function createEditorController({ $, formatDuration, review, setIconStatus, api, showToast, setEditBusy, openJobDialog, document = globalThis.document }) {
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
        ? "규격이 같은 전체 클립은 그대로 이어 붙입니다. 규격이 다르면 가장 큰 입력 해상도에 맞춥니다."
        : `자른 구간을 정확히 반영해 다시 만듭니다. 가장 큰 입력 해상도를 유지합니다.`;
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
      $(id).disabled = !clip || review.reviewBusy;
    }
  }

  function renderEditorTrack() {
    $("#editor-count").textContent = String(editorClips.length);
    $("#editor-empty").classList.toggle("hidden", editorClips.length > 0);
    $("#start-edit-button").disabled = editorClips.length === 0 || review.reviewBusy;
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
    if (!editorClips.length || review.reviewBusy) return;
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

  return {
    renderEditorTrack,
    addEditorClips,
  };
}
