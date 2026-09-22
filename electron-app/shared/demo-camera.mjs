// 촬영 조작과 별개인 구도 계산. 모든 좌표는 CSS px, 시각은 완성 영상의 프레임이다.
export function cameraMode(value = "auto") {
  if (!["auto", "overview"].includes(value)) throw new Error("장면 구도는 auto 또는 overview여야 합니다.");
  return value;
}

export function cameraSetting(value, viewport) {
  if (value == null) return null;
  if (typeof value === "string") return cameraMode(value);
  if (typeof value !== "object" || value.mode !== "focus"
      || Object.keys(value).some(key => !["mode", "box", "padding", "maxZoom"].includes(key))) {
    throw new Error("장면 구도 설정을 확인해 주세요.");
  }
  const padding = value.padding ?? 48, maxZoom = value.maxZoom ?? 1.6;
  if (padding > 512) throw new Error("영역 여백은 512px 이하여야 합니다.");
  frameForBox(value.box, viewport, { padding, maxZoom });
  const { x, y, w, h } = value.box;
  return { mode: "focus", box: { x, y, w, h }, padding, maxZoom };
}

export function cameraLabel(value) {
  if (value == null) return "촬영 설정 따름";
  if (value === "overview") return "전체 화면";
  if (value === "auto") return "촬영 기록으로 자동 확대";
  return "직접 지정한 영역 확대";
}

export function sameCamera(a, b, viewport) {
  return JSON.stringify(cameraSetting(a ?? "auto", viewport)) === JSON.stringify(cameraSetting(b ?? "auto", viewport));
}

// 포인터 위치를 원본 CSS 좌표로 환산한다. 영상 화면의 레터박스를 포함한 바깥 상자가
// 아니라 실제 원본 이미지의 상자를 받는다.
export function cameraPoint(clientX, clientY, rect, viewport) {
  return { x: Math.max(0, Math.min(viewport.width, (clientX - rect.left) / rect.width * viewport.width)),
    y: Math.max(0, Math.min(viewport.height, (clientY - rect.top) / rect.height * viewport.height)) };
}

export function cameraBox(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export function sourceTimeAt(plan, outputMs) {
  const frameMs = 1000 / plan.fps;
  const last = plan.segments.at(-1);
  for (const segment of plan.segments) {
    const played = segment.outFrames * frameMs;
    if (outputMs >= segment.outStartMs + played + segment.holdMs) continue;
    const offset = Math.max(0, Math.min(played, outputMs - segment.outStartMs));
    const source = segment.srcStartMs + offset / played * (segment.srcEndMs - segment.srcStartMs);
    return Math.max(segment.srcStartMs, Math.min(segment.srcEndMs - frameMs, Math.floor(source / frameMs) * frameMs));
  }
  return Math.max(last.srcStartMs, last.srcEndMs - frameMs);
}

export function clampCenter(point, z, viewport) {
  const half = { x: viewport.width / (2 * z), y: viewport.height / (2 * z) };
  return {
    cx: Math.min(Math.max(point.cx, half.x), viewport.width - half.x),
    cy: Math.min(Math.max(point.cy, half.y), viewport.height - half.y),
  };
}

// 고른 영역 전체와 여백이 들어오는 배율. 버튼 중심의 고정 확대가 제목을 자르던
// 문제를 피한다. 원본 화면 밖 콘텐츠는 촬영돼 있지 않으므로 추측해서 채우지 않는다.
export function frameForBox(box, viewport, { padding = 48, maxZoom = 1.6 } = {}) {
  if (!box || ![box.x, box.y, box.w, box.h, padding, maxZoom].every(Number.isFinite)
      || box.w <= 0 || box.h <= 0 || padding < 0 || maxZoom < 1 || maxZoom > 3
      || box.x < 0 || box.y < 0 || box.x + box.w > viewport.width + .5
      || box.y + box.h > viewport.height + .5) {
    throw new Error("보여 줄 영역은 촬영 화면 안에 있어야 합니다. 먼저 스크롤로 영역 전체를 보여 주세요.");
  }
  const left = Math.max(0, box.x - padding), top = Math.max(0, box.y - padding);
  const right = Math.min(viewport.width, box.x + box.w + padding);
  const bottom = Math.min(viewport.height, box.y + box.h + padding);
  const z = Math.max(1, Math.min(maxZoom, viewport.width / (right - left), viewport.height / (bottom - top)));
  return { z, ...clampCenter({ cx: (left + right) / 2, cy: (top + bottom) / 2 }, z, viewport) };
}

export function cameraKeyframes(marks, options, frameMs, totalFrames, viewport) {
  const ticks = ms => Math.round(ms / frameMs);
  const wide = { z: 1, cx: viewport.width / 2, cy: viewport.height / 2 };
  const inTicks = Math.max(1, ticks(options.zoomInMs)), outTicks = Math.max(1, ticks(options.zoomOutMs));
  const lead = ticks(options.leadMs), tail = ticks(options.holdAfterMs);
  const groups = [];
  for (const mark of marks) {
    const framing = mark.framing || { z: options.zoom, ...clampCenter({ cx: mark.point.x, cy: mark.point.y }, options.zoom, viewport) };
    if (framing.z <= 1.001) continue;
    const item = { ...mark, framing, lead: mark.directed ? 0 : lead };
    const group = groups.at(-1), previous = group?.marks.at(-1);
    const near = previous && Math.hypot(
      (framing.cx - previous.framing.cx) / viewport.width,
      (framing.cy - previous.framing.cy) / viewport.height,
    ) <= options.mergeDistance;
    if (previous && !item.cutBefore && previous.sceneId === mark.sceneId && near
        && mark.startFrame <= previous.sceneEndFrame
        && mark.startFrame - (previous.endFrame + tail) <= ticks(options.mergeGapMs)) {
      group.marks.push(item);
    } else groups.push({ marks: [item] });
  }
  for (const group of groups) {
    const first = group.marks[0], last = group.marks.at(-1);
    group.start = Math.max(first.sceneStartFrame, first.startFrame - first.lead);
    group.end = Math.min(last.sceneEndFrame, Math.max(last.startFrame - last.lead + inTicks, last.endFrame + tail) + outTicks);
  }
  // 먼 두 조작의 확대가 시간상 겹치면 사이를 나눈다. 키프레임을 역순으로 넣고
  // 조용히 버리거나, 확대 상태 그대로 화면 반대편까지 이동하지 않는다.
  for (let i = 1; i < groups.length; i++) {
    const prev = groups[i - 1], next = groups[i];
    if (prev.end <= next.start) continue;
    const boundary = Math.round((prev.marks.at(-1).endFrame + next.marks[0].startFrame) / 2);
    prev.end = Math.min(prev.end, boundary);
    next.start = Math.max(next.start, boundary);
  }
  const keys = [];
  const push = (atFrame, framing) => {
    const at = Math.max(0, Math.min(totalFrames, atFrame));
    const last = keys.at(-1);
    if (last?.atFrame === at) { Object.assign(last, framing); return; }
    if (last && last.atFrame > at) throw new Error("구도 키프레임의 순서가 어긋났습니다.");
    keys.push({ atFrame: at, ...framing });
  };
  for (const group of groups) {
    // 0.6초 전환 둘을 놓을 틈도 없으면 전체 화면을 지킨다. 전환을 한두 프레임으로
    // 압축해 번쩍이는 확대를 만들지 않는다.
    if (group.end - group.start < inTicks + outTicks) continue;
    push(group.start, wide);
    let lastAt = group.start;
    for (const [index, mark] of group.marks.entries()) {
      const peak = Math.min(group.end - outTicks, Math.max(lastAt, group.start + inTicks, mark.startFrame - mark.lead + inTicks));
      push(peak, mark.framing);
      const next = group.marks[index + 1];
      const hold = Math.max(peak, Math.min(group.end - outTicks, mark.endFrame + tail,
        next ? next.startFrame - next.lead : Infinity));
      push(hold, mark.framing);
      lastAt = hold;
    }
    push(group.end, wide);
  }
  return keys;
}
