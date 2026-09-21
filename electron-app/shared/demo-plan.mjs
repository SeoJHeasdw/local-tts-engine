// 촬영 기록(scenes.json)과 장면별 내레이션 길이에서 편집 계획을 만든다.
// 순수 계산이다. ffmpeg 인자는 main/editing/demo-render.mjs가 이 계획을 받아 만든다.
//
// 계획은 프레임 단위로 센다. 구간을 밀리초로 재면 빨리 감기 배율마다 반 프레임씩
// 남아 최종 프레임 수가 계획과 어긋난다. 여기서 프레임으로 굳히면 "프레임 수 =
// 계획 길이"를 검증에서 그대로 쓸 수 있다.
export const PLAN_DEFAULTS = Object.freeze({
  fps: 25,
  // 파일럿 영상을 보고 정한다(설계 14절 3번). 시작값 4배.
  maxSpeed: 4,
  zoom: 1.6,
  leadMs: 300,        // 걸음 시작 이 만큼 전에 확대를 시작한다
  zoomInMs: 600,
  holdAfterMs: 800,   // 걸음이 끝나고 이 만큼 더 확대를 유지한다
  zoomOutMs: 600,
  mergeGapMs: 1500,   // 다음 확대가 이 안에 오면 되돌리지 않고 옮겨 간다
  narrationLeadMs: 300,
  narrationTailMs: 500,
  minFastMs: 400,     // 이보다 짧은 기다림은 감지 않는다
});

const FAST_VERBS = new Set(["waitFor", "waitGone"]);
const ZOOM_VERBS = new Set(["click", "type"]);

function fail(message) { throw new Error(`편집 계획: ${message}`); }

// 장면을 감을 수 있는 구간과 사람 동작 구간으로 자른다. 사람이 누르고 치는
// 자리는 1배다. 감는 것은 기다림뿐이다.
function sceneCuts(scene, frameMs, minFastMs) {
  const at = ms => Math.round(ms / frameMs);
  const startFrame = at(scene.startMs);
  const endFrame = at(scene.endMs);
  if (!(endFrame > startFrame)) fail(`장면 ${scene.id}의 길이가 0입니다.`);
  const cuts = [];
  let cursor = startFrame;
  for (const step of scene.steps || []) {
    if (!FAST_VERBS.has(step.verb)) continue;
    if (!Number.isFinite(step.startMs) || !Number.isFinite(step.endMs)) continue;
    const from = Math.max(cursor, at(step.startMs));
    const to = Math.min(endFrame, at(step.endMs));
    if (to - from < Math.round(minFastMs / frameMs)) continue;
    if (from > cursor) cuts.push({ from: cursor, to: from, fast: false });
    cuts.push({ from, to, fast: true });
    cursor = to;
  }
  if (cursor < endFrame) cuts.push({ from: cursor, to: endFrame, fast: false });
  return cuts;
}

// 구간마다 남길 수 있는 최소 프레임. 상한은 구간 전체를 감지 않은 길이다.
const fastFloor = (cut, maxSpeed) => Math.max(1, Math.ceil((cut.to - cut.from) / maxSpeed));

// 감고 남길 총 프레임을 각 기다림에 나눠 준다. 먼저 구간마다 최소를 주고 남는
// 몫을 길이에 비례해 나눈다. 상한을 구간별로 지키므로 어느 한 구간만 최대 배율을
// 넘겨 감기는 일이 없다 — 반올림으로 한 구간이 4.04배가 되던 자리다.
function shareFastFrames(cuts, target, maxSpeed) {
  const fast = cuts.filter(cut => cut.fast);
  if (!fast.length) return new Map();
  const mins = fast.map(cut => fastFloor(cut, maxSpeed));
  const maxs = fast.map(cut => cut.to - cut.from);
  const total = Math.min(maxs.reduce((sum, value) => sum + value, 0),
    Math.max(mins.reduce((sum, value) => sum + value, 0), target));
  const room = maxs.reduce((sum, value, at) => sum + value - mins[at], 0);
  const extra = total - mins.reduce((sum, value) => sum + value, 0);
  const exact = fast.map((_, at) => mins[at] + (room ? extra * (maxs[at] - mins[at]) / room : 0));
  const frames = exact.map(value => Math.floor(value));
  let drift = total - frames.reduce((sum, value) => sum + value, 0);
  const order = frames.map((_, at) => at).sort((a, b) => (exact[b] - frames[b]) - (exact[a] - frames[a]));
  for (let round = 0; drift > 0 && round < order.length * 2; round++) {
    const at = order[round % order.length];
    if (frames[at] >= maxs[at]) continue;
    frames[at]++; drift--;
  }
  return new Map(fast.map((cut, at) => [cut, frames[at]]));
}

// 느리게 찍은 장면은 통째로 되돌린다. 기다림만 감으면 같은 장면이 두 속도로 흘러
// 화면이 어긋난다 — ¼로 찍은 3D는 4배로 돌려야 원래 속도가 되고, 그때 촬영이 받은
// 서로 다른 그림이 모두 쓰여 부드러워진다.
function planSlowedScene(scene, narrationMs, options, frameMs) {
  const at = ms => Math.round(ms / frameMs);
  const from = at(scene.startMs);
  const to = at(scene.endMs);
  if (!(to > from)) fail(`장면 ${scene.id}의 길이가 0입니다.`);
  const srcFrames = to - from;
  const needed = narrationMs > 0
    ? Math.ceil((options.narrationLeadMs + narrationMs + options.narrationTailMs) / frameMs)
    : 0;
  // 되돌린 길이가 내레이션보다 짧으면 덜 되돌린다. 3D가 멈춘 채로 말이 이어지는
  // 것보다 조금 느리게 흐르는 편이 낫다. 찍은 속도보다 빨라지지는 않는다.
  const restored = Math.max(1, Math.round(srcFrames * scene.timeScale));
  const outFrames = Math.min(srcFrames, Math.max(restored, needed));
  const holdFrames = Math.max(0, needed - outFrames);
  return {
    segments: [{
      sceneId: scene.id,
      kind: "slowed",
      srcStartFrame: from,
      srcEndFrame: to,
      outFrames,
      speed: Number((srcFrames / outFrames).toFixed(6)),
    }],
    holdFrames,
    outFrames: outFrames + holdFrames,
  };
}

function planScene(scene, narrationMs, options, frameMs) {
  if (scene.timeScale !== undefined && scene.timeScale < 1) {
    return planSlowedScene(scene, narrationMs, options, frameMs);
  }
  const cuts = sceneCuts(scene, frameMs, options.minFastMs);
  const normalFrames = cuts.filter(cut => !cut.fast).reduce((sum, cut) => sum + (cut.to - cut.from), 0);
  const fastFrames = cuts.filter(cut => cut.fast).reduce((sum, cut) => sum + (cut.to - cut.from), 0);
  // 감을 수 있는 만큼 감은 길이. 각 기다림은 최소 한 프레임을 남긴다.
  const floorFast = cuts.filter(cut => cut.fast)
    .reduce((sum, cut) => sum + fastFloor(cut, options.maxSpeed), 0);
  const shortest = normalFrames + floorFast;
  const needed = narrationMs > 0
    ? Math.ceil((options.narrationLeadMs + narrationMs + options.narrationTailMs) / frameMs)
    : 0;
  const target = Math.max(needed, shortest);
  const fastTarget = Math.min(fastFrames, Math.max(floorFast, target - normalFrames));
  const shares = shareFastFrames(cuts, fastTarget, options.maxSpeed);

  const segments = cuts.map(cut => {
    const srcFrames = cut.to - cut.from;
    const outFrames = cut.fast ? shares.get(cut) ?? srcFrames : srcFrames;
    return {
      sceneId: scene.id,
      kind: cut.fast ? "fast" : "normal",
      srcStartFrame: cut.from,
      srcEndFrame: cut.to,
      outFrames,
      // 실제 배율은 프레임 수로 되돌려 적는다. 계획과 렌더가 같은 값을 쓴다.
      speed: Number((srcFrames / outFrames).toFixed(6)),
    };
  });
  const played = segments.reduce((sum, segment) => sum + segment.outFrames, 0);
  // 감아도 목표보다 짧으면 장면 끝 화면을 멈춰 채운다.
  const holdFrames = Math.max(0, target - played);
  return { segments, holdFrames, outFrames: played + holdFrames };
}

function clampCenter(point, z, viewport) {
  const half = { x: viewport.width / (2 * z), y: viewport.height / (2 * z) };
  return {
    cx: Math.min(Math.max(point.cx, half.x), viewport.width - half.x),
    cy: Math.min(Math.max(point.cy, half.y), viewport.height - half.y),
  };
}

// 확대 키프레임. 값은 CSS px이고 시각은 완성 영상 기준이다. z=1에서는 화면 전체가
// 보이므로 중심은 언제나 화면 한가운데다 — 가두기가 그 사실을 만든다.
function zoomKeyframes(marks, options, frameMs, totalFrames, viewport) {
  const frame = ms => Math.round(ms / frameMs);
  const middle = { cx: viewport.width / 2, cy: viewport.height / 2 };
  const keys = [];
  const push = (atFrame, z, point) => {
    const at = Math.min(Math.max(atFrame, 0), totalFrames);
    const { cx, cy } = clampCenter(point, z, viewport);
    const last = keys.at(-1);
    if (last && last.atFrame === at) { last.z = z; last.cx = cx; last.cy = cy; return; }
    if (last && last.atFrame > at) return;
    keys.push({ atFrame: at, z, cx, cy });
  };
  for (const [index, mark] of marks.entries()) {
    const point = { cx: mark.point.x, cy: mark.point.y };
    const inFrom = mark.startFrame - frame(options.leadMs);
    const inTo = inFrom + frame(options.zoomInMs);
    const holdTo = Math.max(inTo, mark.endFrame + frame(options.holdAfterMs));
    const next = marks[index + 1];
    const nextInFrom = next ? next.startFrame - frame(options.leadMs) : null;
    // 되돌리는 도중에 다음 확대가 오면 축소 자체가 깜빡임이 된다. 유지한 채 옮긴다.
    const merged = next !== undefined && nextInFrom - holdTo <= frame(options.mergeGapMs);
    if (keys.length === 0 || keys.at(-1).z === 1) push(inFrom, 1, middle);
    push(inTo, options.zoom, point);
    push(holdTo, options.zoom, point);
    if (!merged) push(holdTo + frame(options.zoomOutMs), 1, middle);
  }
  return keys;
}

/**
 * 촬영 기록과 장면별 내레이션 길이로 편집 계획을 만든다.
 *
 * `narration`은 `{ [장면 id]: { durationMs, file } }`다. 없는 장면은 내레이션 없이
 * 원본 길이를 따른다. 대본을 확정하지 않은 장면이 있어도 계획은 만들어진다 —
 * 길이만 달라지므로 대본을 고치고 다시 계획해도 다시 찍을 필요가 없다.
 */
export function buildEditPlan(scenes, { narration = {}, options = {} } = {}) {
  if (!scenes || typeof scenes !== "object") fail("촬영 기록이 없습니다.");
  if (scenes.schemaVersion !== 1) fail("촬영 기록의 schemaVersion은 1이어야 합니다.");
  const list = Array.isArray(scenes.scenes) ? scenes.scenes : [];
  if (!list.length) fail("촬영 기록에 장면이 없습니다.");
  const settings = { ...PLAN_DEFAULTS, ...options };
  if (!(settings.maxSpeed >= 1)) fail("최대 배율은 1 이상이어야 합니다.");
  const frameMs = 1000 / settings.fps;
  const viewport = scenes.viewport || {};
  if (!(viewport.width > 0 && viewport.height > 0)) fail("촬영 기록에 화면 크기가 없습니다.");

  for (const [index, scene] of list.entries()) {
    const previous = list[index - 1];
    if (previous && scene.startMs < previous.endMs) fail(`장면 ${scene.id}이 앞 장면과 겹칩니다.`);
  }

  const segments = [];
  const planned = [];
  const marks = [];
  let outFrame = 0;
  for (const scene of list) {
    const voice = narration[scene.id] || null;
    const narrationMs = Number(voice?.durationMs) > 0 ? Number(voice.durationMs) : 0;
    const { segments: parts, holdFrames, outFrames } = planScene(scene, narrationMs, settings, frameMs);
    const sceneStart = outFrame;
    for (const part of parts) {
      const mapped = { ...part, outStartFrame: outFrame, holdFrames: 0 };
      outFrame += part.outFrames;
      segments.push(mapped);
    }
    if (holdFrames) segments.at(-1).holdFrames = holdFrames;
    outFrame += holdFrames;

    // 걸음의 원본 시각을 완성 영상 시각으로 옮긴다. 사람 동작은 1배 구간에 있어
    // 이 대응이 정확하다.
    const toOut = srcFrame => {
      let at = sceneStart;
      for (const part of parts) {
        if (srcFrame <= part.srcStartFrame) return at;
        if (srcFrame < part.srcEndFrame) {
          return at + Math.round((srcFrame - part.srcStartFrame) * part.outFrames / (part.srcEndFrame - part.srcStartFrame));
        }
        at += part.outFrames;
      }
      return at;
    };
    for (const step of scene.steps || []) {
      if (!ZOOM_VERBS.has(step.verb) || step.zoom === false || !step.point) continue;
      marks.push({
        sceneId: scene.id,
        startFrame: toOut(Math.round(step.startMs / frameMs)),
        endFrame: toOut(Math.round(step.endMs / frameMs)),
        point: step.point,
      });
    }
    planned.push({
      id: scene.id,
      srcStartMs: Math.round(scene.startMs / frameMs) * frameMs,
      srcEndMs: Math.round(scene.endMs / frameMs) * frameMs,
      outStartMs: sceneStart * frameMs,
      outEndMs: outFrame * frameMs,
      holdMs: holdFrames * frameMs,
      narration: narrationMs
        ? { atMs: (sceneStart + Math.round(settings.narrationLeadMs / frameMs)) * frameMs,
            durationMs: narrationMs, file: voice.file ?? null }
        : null,
    });
  }

  const zoom = zoomKeyframes(marks, settings, frameMs, outFrame, viewport)
    .map(key => ({ atMs: key.atFrame * frameMs, z: key.z, cx: key.cx, cy: key.cy }));

  return {
    schemaVersion: 1,
    scenario: scenes.scenario || null,
    fps: settings.fps,
    maxSpeed: settings.maxSpeed,
    viewport: { width: viewport.width, height: viewport.height, scale: viewport.scale ?? 1 },
    totalFrames: outFrame,
    durationMs: outFrame * frameMs,
    segments: segments.map(segment => ({
      sceneId: segment.sceneId,
      kind: segment.kind,
      srcStartMs: segment.srcStartFrame * frameMs,
      srcEndMs: segment.srcEndFrame * frameMs,
      speed: segment.speed,
      outStartMs: segment.outStartFrame * frameMs,
      outFrames: segment.outFrames,
      holdMs: segment.holdFrames * frameMs,
    })),
    scenes: planned,
    zoom,
  };
}

// 어느 시각의 확대 상태. 키프레임 사이는 코사인 이징이고 중심은 화면 밖으로
// 나가지 않게 가둔다. 렌더의 ffmpeg 식과 같은 값을 내야 한다.
export function zoomAt(plan, atMs) {
  const keys = plan.zoom || [];
  const middle = { cx: plan.viewport.width / 2, cy: plan.viewport.height / 2 };
  if (!keys.length) return { z: 1, ...middle };
  if (atMs <= keys[0].atMs) return { z: keys[0].z, ...clampCenter(keys[0], keys[0].z, plan.viewport) };
  const last = keys.at(-1);
  if (atMs >= last.atMs) return { z: last.z, ...clampCenter(last, last.z, plan.viewport) };
  const index = keys.findIndex((key, at) => keys[at + 1] && atMs < keys[at + 1].atMs);
  const from = keys[index];
  const to = keys[index + 1];
  const span = to.atMs - from.atMs;
  const ratio = span > 0 ? (1 - Math.cos(Math.PI * (atMs - from.atMs) / span)) / 2 : 1;
  const mix = (a, b) => a + (b - a) * ratio;
  const z = mix(from.z, to.z);
  return { z, ...clampCenter({ cx: mix(from.cx, to.cx), cy: mix(from.cy, to.cy) }, z, plan.viewport) };
}

// 키프레임 넷이 확대 한 번이다. 하나씩 찍으면 같은 글자가 겹쳐 무엇이 몇 번인지
// 알 수 없다. 1배를 벗어나 있는 동안을 한 칸으로 묶는다.
export function zoomSpans(plan) {
  const spans = [];
  let open = null;
  for (const key of plan.zoom || []) {
    if (key.z > 1.01 && open === null) open = key.atMs;
    else if (key.z <= 1.01 && open !== null) { spans.push({ fromMs: open, toMs: key.atMs }); open = null; }
  }
  if (open !== null) spans.push({ fromMs: open, toMs: plan.durationMs });
  return spans;
}

// 완성 시각 위의 구간. 감은 곳·1배·끝 화면 멈춤을 한 칸씩 늘어놓는다. CLI 검수 페이지와
// 앱의 다듬기가 같은 막대를 그린다.
export function planBlocks(plan) {
  const parts = [];
  for (const segment of plan.segments) {
    const played = segment.outFrames * 1000 / plan.fps;
    if (played > 0) {
      parts.push({ ms: played, at: segment.outStartMs, kind: segment.speed > 1.01 ? "fast" : "",
        label: segment.speed > 1.01 ? `${segment.speed.toFixed(1)}배` : "1배" });
    }
    if (segment.holdMs > 0) {
      parts.push({ ms: segment.holdMs, at: segment.outStartMs + played, kind: "hold", label: "멈춤" });
    }
  }
  return parts;
}
