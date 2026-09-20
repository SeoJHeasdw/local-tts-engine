// 앱 데모 시나리오의 검증·정규화. 동사·선택자·자리표시자·제한 시간만 다루고
// 실행은 하지 않는다. 순수 계산이라 렌더러도 읽을 수 있다.
//
// 시나리오는 "앱을 아는 유일한 파일"이다. 촬영 엔진은 앱 이름을 모른다. 그래서
// 여기서 거르지 못한 오타는 앱을 띄우고 수십 초를 찍은 뒤에야 드러난다.
const APP_KINDS = ["electron", "web"];
const TARGET_KEYS = ["role", "name", "exact", "placeholder", "text", "label"];
const DEFAULT_STEP_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const MAX_PAUSE_MS = 60_000;
const MAX_TYPE_CHARS = 2000;
// 사람 속도의 타이핑. 글자마다 이 사이에서 흔들린다(설계 5절).
export const TYPE_DELAY_MS = Object.freeze({ min: 35, max: 70 });

function fail(where, message) {
  throw new Error(`시나리오 ${where}: ${message}`);
}

function requireText(value, where, what) {
  if (typeof value !== "string" || !value.trim()) fail(where, `${what}이(가) 필요합니다.`);
  return value;
}

function optionalTimeout(value, where, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    fail(where, `제한 시간은 0보다 크고 ${MAX_TIMEOUT_MS}ms 이하인 숫자여야 합니다.`);
  }
  return Math.round(value);
}

// 대상은 두 가지로 적는다. 문자열은 선택자, 객체는 getBy*다. 객체를 둘 이상의
// getBy*로 해석할 수 있으면 어느 쪽을 쓸지 읽는 사람이 알 수 없으므로 거절한다.
export function normalizeTarget(target, where) {
  if (typeof target === "string") {
    if (!target.trim()) fail(where, "선택자가 비어 있습니다.");
    return { kind: "selector", selector: target };
  }
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    fail(where, "대상은 선택자 문자열이거나 { role, name } 같은 객체여야 합니다.");
  }
  const unknown = Object.keys(target).filter(key => !TARGET_KEYS.includes(key));
  if (unknown.length) fail(where, `대상에 알 수 없는 항목이 있습니다: ${unknown.join(", ")}`);
  if (target.exact !== undefined && typeof target.exact !== "boolean") {
    fail(where, "exact는 true·false여야 합니다.");
  }
  const exact = target.exact === true;
  if (target.role !== undefined) {
    requireText(target.role, where, "role");
    if (target.name !== undefined) requireText(target.name, where, "name");
    for (const key of ["placeholder", "text", "label"]) {
      if (target[key] !== undefined) fail(where, `role 대상에는 ${key}를 함께 쓸 수 없습니다.`);
    }
    return { kind: "role", role: target.role, name: target.name ?? null, exact };
  }
  const by = ["placeholder", "text", "label"].filter(key => target[key] !== undefined);
  if (by.length !== 1) fail(where, "대상은 role·placeholder·text·label 중 하나여야 합니다.");
  const [kind] = by;
  requireText(target[kind], where, kind);
  return { kind, value: target[kind], exact };
}

function normalizeStep(step, where) {
  if (!step || typeof step !== "object" || Array.isArray(step)) fail(where, "걸음은 객체여야 합니다.");
  const verbs = ["click", "type", "press", "hover", "scroll", "waitFor", "waitGone", "pause"]
    .filter(verb => Object.hasOwn(step, verb));
  if (verbs.length !== 1) {
    fail(where, `걸음 하나에 동사 하나여야 합니다(있는 것: ${verbs.join(", ") || "없음"}).`);
  }
  const [verb] = verbs;
  const known = new Set([verb, "timeoutMs", "zoom", "text", "delta"]);
  const unknown = Object.keys(step).filter(key => !known.has(key));
  if (unknown.length) fail(where, `${verb}에 알 수 없는 항목이 있습니다: ${unknown.join(", ")}`);
  if (step.zoom !== undefined && typeof step.zoom !== "boolean") fail(where, "zoom은 true·false여야 합니다.");
  // 확대는 사람이 만지는 자리에만 건다. 기다림·스크롤을 확대하면 화면이 계속 흔들린다.
  const zoomable = ["click", "type"].includes(verb);
  if (step.zoom === true && !zoomable) fail(where, `${verb}에는 확대를 켤 수 없습니다.`);
  const base = {
    verb,
    timeoutMs: optionalTimeout(step.timeoutMs, where, DEFAULT_STEP_TIMEOUT_MS),
    zoom: zoomable && step.zoom !== false,
  };
  if (verb === "pause") {
    const ms = step.pause;
    if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_PAUSE_MS) {
      fail(where, `pause는 0보다 크고 ${MAX_PAUSE_MS}ms 이하여야 합니다.`);
    }
    return { ...base, ms: Math.round(ms) };
  }
  if (verb === "press") {
    return { ...base, key: requireText(step.press, where, "누를 키") };
  }
  if (verb === "type") {
    const text = step.text;
    if (typeof text !== "string" || !text.length) fail(where, "type에는 칠 글(text)이 필요합니다.");
    if (text.length > MAX_TYPE_CHARS) fail(where, `한 번에 칠 수 있는 글은 ${MAX_TYPE_CHARS}자까지입니다.`);
    return { ...base, target: normalizeTarget(step.type, where), text };
  }
  if (verb === "scroll") {
    const delta = step.delta;
    if (delta !== undefined && (!Number.isFinite(delta) || delta === 0)) {
      fail(where, "scroll의 delta는 0이 아닌 숫자여야 합니다.");
    }
    return { ...base, target: normalizeTarget(step.scroll, where), delta: delta === undefined ? 600 : Math.round(delta) };
  }
  return { ...base, target: normalizeTarget(step[verb], where) };
}

function normalizeScene(scene, index, seen) {
  const where = `장면 ${index + 1}`;
  if (!scene || typeof scene !== "object" || Array.isArray(scene)) fail(where, "장면은 객체여야 합니다.");
  const id = requireText(scene.id, where, "id").trim();
  // 장면 id는 결과 폴더 이름(narration/<장면>)과 대본 키가 된다.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) fail(where, `id "${id}"는 영소문자·숫자·붙임표만 쓸 수 있습니다.`);
  if (seen.has(id)) fail(where, `id "${id}"가 중복됐습니다.`);
  seen.add(id);
  if (!Array.isArray(scene.steps) || !scene.steps.length) fail(`${where}(${id})`, "steps가 비어 있습니다.");
  const textFrom = scene.textFrom === undefined ? "main" : requireText(scene.textFrom, `${where}(${id})`, "textFrom");
  return {
    id,
    textFrom,
    steps: scene.steps.map((step, at) => normalizeStep(step, `${where}(${id}) 걸음 ${at + 1}`)),
  };
}

function normalizeApp(app) {
  const where = "app";
  if (!app || typeof app !== "object" || Array.isArray(app)) fail(where, "app이 필요합니다.");
  const kind = requireText(app.kind, where, "kind");
  if (!APP_KINDS.includes(kind)) fail(where, `kind는 ${APP_KINDS.join("·")} 중 하나여야 합니다.`);
  const command = value => {
    if (!Array.isArray(value) || !value.length || !value.every(part => typeof part === "string" && part.length)) {
      fail(where, "명령은 비어 있지 않은 문자열 배열이어야 합니다.");
    }
    return [...value];
  };
  const normalized = {
    kind,
    cwd: app.cwd === undefined ? null : requireText(app.cwd, where, "cwd"),
    prepare: app.prepare === undefined ? null : command(app.prepare),
    server: null,
    env: {},
    files: {},
    ready: { console: null, selector: null, timeoutMs: 60_000 },
  };
  if (app.server !== undefined) {
    if (!app.server || typeof app.server !== "object") fail(where, "server는 객체여야 합니다.");
    normalized.server = {
      command: command(app.server.command),
      url: requireText(app.server.url, where, "server.url"),
      timeoutMs: optionalTimeout(app.server.timeoutMs, where, 60_000),
    };
  }
  for (const [key, value] of Object.entries(app.env || {})) {
    if (typeof value !== "string") fail(where, `env.${key}는 문자열이어야 합니다.`);
    normalized.env[key] = value;
  }
  for (const [key, value] of Object.entries(app.files || {})) {
    if (typeof value !== "string") fail(where, `files["${key}"]는 문자열이어야 합니다.`);
    // 작업 폴더 밖에 쓰지 않는다. 시나리오는 데모 데이터만 놓는 자리다.
    if (key.startsWith("/") || key.split("/").includes("..")) fail(where, `files["${key}"]는 작업 폴더 안 상대 경로여야 합니다.`);
    normalized.files[key] = value;
  }
  if (app.ready !== undefined) {
    if (!app.ready || typeof app.ready !== "object") fail(where, "ready는 객체여야 합니다.");
    normalized.ready = {
      console: app.ready.console === undefined ? null : requireText(app.ready.console, where, "ready.console"),
      selector: app.ready.selector === undefined ? null : requireText(app.ready.selector, where, "ready.selector"),
      timeoutMs: optionalTimeout(app.ready.timeoutMs, where, 60_000),
    };
  }
  if (kind === "electron") {
    normalized.executable = requireText(app.executable, where, "executable");
    normalized.args = app.args === undefined ? [] : command(app.args);
    normalized.window = app.window === undefined ? null : requireText(app.window, where, "window");
  } else {
    normalized.url = requireText(app.url ?? app.window, where, "url");
  }
  return normalized;
}

function normalizeViewport(viewport) {
  const value = viewport || {};
  const width = value.width === undefined ? 1920 : value.width;
  const height = value.height === undefined ? 1080 : value.height;
  const scale = value.scale === undefined ? 2 : value.scale;
  for (const [name, number] of [["width", width], ["height", height]]) {
    if (!Number.isInteger(number) || number < 320 || number > 3840) fail("viewport", `${name}는 320~3840의 정수여야 합니다.`);
  }
  if (!Number.isFinite(scale) || scale <= 0 || scale > 4) fail("viewport", "scale은 0보다 크고 4 이하여야 합니다.");
  // 프레임은 CSS 크기 × 배율이다. yuv420p가 받도록 짝수여야 한다.
  const frame = { width: Math.round(width * scale), height: Math.round(height * scale) };
  if (frame.width % 2 || frame.height % 2) {
    fail("viewport", `프레임 크기 ${frame.width}×${frame.height}는 짝수가 아닙니다. 크기나 배율을 바꿔 주세요.`);
  }
  return { width, height, scale, frame };
}

/**
 * 시나리오 파일을 읽어 실행 가능한 모양으로 굳힌다.
 *
 * 자리표시자(`{scenario}`·`{work}`)는 여기서 풀지 않는다. 검증은 파일을 읽는
 * 시점에, 자리표시자는 작업 폴더가 정해지는 실행 시점에 풀리기 때문이다.
 */
export function normalizeScenario(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("파일", "객체가 아닙니다.");
  if (raw.schemaVersion !== 1) fail("파일", "schemaVersion은 1이어야 합니다.");
  const name = requireText(raw.name, "파일", "name").trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) fail("파일", `name "${name}"은 영소문자·숫자·붙임표만 쓸 수 있습니다.`);
  if (!Array.isArray(raw.scenes) || !raw.scenes.length) fail("파일", "scenes가 비어 있습니다.");
  const seen = new Set();
  const scenes = raw.scenes.map((scene, index) => normalizeScene(scene, index, seen));
  const scenario = {
    schemaVersion: 1,
    name,
    app: normalizeApp(raw.app),
    viewport: normalizeViewport(raw.viewport),
    scenes,
  };
  // 장면 전체가 최대 얼마나 걸릴 수 있는지. recorder.begin의 넉넉한 상한이 된다.
  scenario.budgetMs = scenes.reduce((sum, scene) => sum
    + scene.steps.reduce((inner, step) => inner + (step.verb === "pause" ? step.ms : step.timeoutMs), 0), 0);
  return scenario;
}

// `{scenario}`·`{work}`만 푼다. 알 수 없는 표시가 남으면 조용히 넘기지 않는다.
export function resolvePlaceholders(value, replacements) {
  if (Array.isArray(value)) return value.map(item => resolvePlaceholders(item, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolvePlaceholders(item, replacements)]));
  }
  if (typeof value !== "string") return value;
  const resolved = value.replace(/\{(\w+)\}/g, (match, key) => {
    if (!Object.hasOwn(replacements, key)) throw new Error(`시나리오에 알 수 없는 자리표시자 ${match}가 있습니다.`);
    return replacements[key];
  });
  return resolved;
}
