import { buildEditPlan, zoomAt } from "../../shared/demo-plan.mjs";
import { cameraBox, cameraPoint, cameraSetting, frameForBox } from "../../shared/demo-camera.mjs";

// 원본 한 프레임 위에서 구도를 고른다. 포인터 이동 중에는 IPC·인코딩 없이 같은
// 순수 구도 계산을 써서 즉시 보여 주고, 완성본 반영은 별도의 명시적 동작이다.
export function createDemoCameraEditor({ $, api, onSave }) {
  const dialog = $("#demo-camera-dialog"), raw = $("#demo-camera-source"), image = $("#demo-camera-image");
  const result = $("#demo-camera-result"), outline = $("#demo-camera-selection");
  let project = null, scene = null, data = null, draft = null, anchor = null;
  let request = 0, pending = false, saving = false;
  const clone = value => value == null ? null : structuredClone(value);
  const viewport = () => data?.recording.viewport;
  const effective = () => cameraSetting(draft ?? scene.recordedCamera ?? "auto", viewport());
  const seconds = ms => `${(ms / 1000).toFixed(1)}초`;
  const note = text => { $("#demo-camera-status").textContent = text; };

  function controls() {
    for (const id of ["#demo-camera-save", "#demo-camera-apply", "#demo-camera-mode", "#demo-camera-time", "#demo-camera-zoom", "#demo-camera-padding"])
      $(id).disabled = !data || pending || saving;
    $("#demo-camera-cancel").disabled = saving;
    $("#demo-camera-auto-point").disabled = !data?.automaticAvailable || pending || saving;
  }

  function paint() {
    controls();
    if (!data) return;
    const view = viewport(), selected = effective();
    const plan = buildEditPlan(data.recording, { narration: data.narration,
      cameras: { ...data.cameras, [scene.id]: selected }, options: { fps: data.fps, maxSpeed: data.maxSpeed } });
    const manual = typeof selected === "object";
    $("#demo-camera-adjustments").classList.toggle("hidden", !manual);
    $("#demo-camera-mode").value = draft == null ? "inherit" : typeof draft === "string" ? draft : "focus";
    $("#demo-camera-time").max = String(Math.max(0, data.endMs - data.startMs - 1000 / data.fps));
    $("#demo-camera-time").value = String(data.atMs - data.startMs);
    $("#demo-camera-time-label").textContent = `장면 ${seconds(data.atMs - data.startMs)} / ${seconds(data.endMs - data.startMs)}`;
    raw.style.aspectRatio = `${view.width} / ${view.height}`;
    $("#demo-camera-result-frame").style.aspectRatio = raw.style.aspectRatio;
    outline.classList.toggle("hidden", !manual);
    let framing;
    if (manual) {
      const box = selected.box;
      outline.style.left = `${box.x / view.width * 100}%`;
      outline.style.top = `${box.y / view.height * 100}%`;
      outline.style.width = `${box.w / view.width * 100}%`;
      outline.style.height = `${box.h / view.height * 100}%`;
      $("#demo-camera-zoom").value = String(selected.maxZoom);
      $("#demo-camera-padding").value = String(selected.padding);
      const peak = plan.zoom.find(key => key.atMs >= data.startMs && key.atMs < data.endMs && key.z > 1.01);
      framing = peak ? frameForBox(box, view, selected) : { z: 1, cx: view.width / 2, cy: view.height / 2 };
      $("#demo-camera-result-note").textContent = data.endMs - data.startMs < 1200
        ? "이 장면은 확대 전환을 넣기에는 짧아 전체 화면을 유지합니다."
        : `${framing.z.toFixed(2)}배 · 이 장면에 적용할 확대 구도. 재생 시 앞뒤로 부드럽게 전환합니다.`;
    } else {
      framing = zoomAt(plan, data.atMs);
      $("#demo-camera-result-note").textContent = selected === "overview" ? "전체 화면을 유지합니다."
        : !data.automaticAvailable ? "이 장면에는 자동으로 확대할 구간이 없습니다. 원본에서 영역을 직접 그려 주세요."
        : `${framing.z.toFixed(2)}배 · 이 시점의 자동 구도입니다. 촬영할 때 기록한 클릭·영역을 따릅니다.`;
    }
    result.style.transform = `translate(${50 - framing.cx / view.width * framing.z * 100}%, ${50 - framing.cy / view.height * framing.z * 100}%) scale(${framing.z})`;
  }

  async function loadFrame(atMs) {
    const mine = ++request;
    pending = true;
    note("원본 화면을 불러오고 있습니다…");
    controls();
    try {
      const next = await api.readDemoCameraPreview({ outDir: project.outDir, sceneId: scene.id, atMs });
      if (mine !== request) return;
      data = next;
      image.src = next.imageUrl;
      result.src = next.imageUrl;
      note("사진으로 구도를 미리 봅니다. 왼쪽 원본에서 드래그하면 오른쪽 확대가 바로 바뀝니다.");
    } catch (error) {
      if (mine !== request) return;
      note(`미리보기 실패: ${error.message}`);
    } finally {
      if (mine === request) { pending = false; paint(); }
    }
  }

  function manual() {
    if (draft && typeof draft === "object") return;
    const view = viewport();
    draft = { mode: "focus", box: { x: view.width / 4, y: view.height / 4, w: view.width / 2, h: view.height / 2 }, padding: 48, maxZoom: 1.6 };
  }

  $("#demo-camera-mode").addEventListener("change", async event => {
    if (!data || pending || saving) return;
    const value = event.target.value;
    if (value === "focus") manual();
    else draft = value === "inherit" ? null : value;
    paint();
    if (effective() === "auto" && data.automaticAvailable) await loadFrame(data.defaultAtMs);
  });
  $("#demo-camera-auto-point").addEventListener("click", async () => {
    if (!data || pending || saving) return;
    draft = "auto";
    await loadFrame(data.defaultAtMs);
  });
  $("#demo-camera-time").addEventListener("change", event => {
    if (data && !saving) void loadFrame(data.startMs + Number(event.target.value));
  });
  for (const [id, key] of [["#demo-camera-zoom", "maxZoom"], ["#demo-camera-padding", "padding"]]) {
    $(id).addEventListener("input", event => {
      if (!data || pending || saving) return;
      manual();
      draft[key] = Number(event.target.value);
      paint();
    });
  }

  raw.addEventListener("pointerdown", event => {
    if (!data || pending || saving || event.button !== 0) return;
    event.preventDefault();
    manual();
    anchor = cameraPoint(event.clientX, event.clientY, raw.getBoundingClientRect(), viewport());
    raw.setPointerCapture(event.pointerId);
    raw.focus();
    paint();
  });
  raw.addEventListener("pointermove", event => {
    if (!anchor) return;
    const box = cameraBox(anchor, cameraPoint(event.clientX, event.clientY, raw.getBoundingClientRect(), viewport()));
    if (box.w < 4 || box.h < 4) return;
    draft.box = box;
    paint();
  });
  const endDrag = () => { anchor = null; };
  raw.addEventListener("pointerup", endDrag);
  raw.addEventListener("pointercancel", endDrag);
  raw.addEventListener("lostpointercapture", endDrag);
  raw.addEventListener("keydown", event => {
    if (!data || pending || saving || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    manual();
    const view = viewport(), box = draft.box, step = (event.shiftKey ? .05 : .01);
    box.x = Math.max(0, Math.min(view.width - box.w, box.x + (event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0) * view.width * step));
    box.y = Math.max(0, Math.min(view.height - box.h, box.y + (event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0) * view.height * step));
    paint();
  });

  function close() {
    request++;
    anchor = null;
    dialog.close();
    image.removeAttribute("src"); result.removeAttribute("src");
    data = null; project = null; scene = null;
  }
  async function commit(render) {
    if (!data || pending || saving) return;
    saving = true;
    controls(); note(render ? "저장하고 영상에 반영하고 있습니다…" : "구도를 저장하고 있습니다…");
    try {
      await onSave({ outDir: project.outDir, sceneId: scene.id, camera: clone(draft), render });
      close();
    } catch (error) { note(`적용 실패: ${error.message}`); }
    finally { saving = false; controls(); }
  }
  $("#demo-camera-cancel").addEventListener("click", () => { if (!saving) close(); });
  dialog.addEventListener("cancel", event => { event.preventDefault(); if (!saving) close(); });
  $("#demo-camera-save").addEventListener("click", () => commit(false));
  $("#demo-camera-apply").addEventListener("click", () => commit(true));

  return {
    async open(value, selectedScene) {
      project = value; scene = selectedScene; draft = clone(scene.camera); data = null; saving = false;
      image.removeAttribute("src"); result.removeAttribute("src"); outline.classList.add("hidden");
      result.style.transform = "";
      $("#demo-camera-title").textContent = `구도 편집 · ${scene.id}`;
      $("#demo-camera-result-note").textContent = "";
      dialog.showModal();
      await loadFrame(null);
    },
    get isOpen() { return dialog.open; },
  };
}
