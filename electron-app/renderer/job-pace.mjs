import { formatCountdown } from "./view-utils.mjs";

// 제작은 길다. 무엇을 하는 중인지만 알려 주고 언제 끝나는지 말해 주지 않으면
// 자리를 뜰 수도, 기다릴 수도 없다.
//
// 한 편은 목소리 → 자료 연결 → 자막 → 촬영 → 검증 순서로 지난다. 진행 숫자가
// 붙는 단계는 목소리뿐이라, 예전에는 그 단계를 벗어나는 순간 남은 시간이
// 사라지고 '계산 중'만 남았다. 촬영은 강의 길이만큼 실시간으로 도는 가장 긴
// 단계다. 정작 기다림이 제일 긴 구간에서 시계가 꺼져 있던 셈이다.
//
// 그래서 여기서는 단계마다 실제로 걸린 시간을 모아 두고, 남은 단계의 몫을 더해
// 답한다. 촬영은 합성이 끝나야 알 수 있는 음성 길이로 잰다.
const STAGE_PLANS = {
  video: ["voice", "export", "captions", "capture", "verify"],
  captions: ["voice", "export", "captions", "verify"],
  audio: ["voice", "verify"],
};

// 전체 몫이 아직 안 잡힐 때 "무엇을 기다리는 중인지"라도 말하기 위한 이름이다.
export const STAGE_NOUNS = {
  voice: "목소리 생성",
  export: "영상 자료 연결",
  captions: "자막 생성",
  capture: "화면 촬영",
  verify: "결과 검증",
};

// 목소리와 촬영이 한 편의 시간을 거의 다 쓴다. 이 둘을 모르면 남은 시간을 말할
// 수 없지만, 나머지 짧은 단계는 모른 채로 두고 0으로 세도 분 단위 답이 흔들리지
// 않는다. 짧은 단계 때문에 시계 전체를 끄지 않는다.
const MAJOR_STAGES = new Set(["voice", "capture"]);

// 30초 아래는 분으로 말하면 오히려 틀린 값처럼 보인다.
// 초 단위로 세는 시계에서 45초는 너무 이르다. 0:45에서 '곧 완료'로 굳어
// 버리면 마지막 45초 동안 시계가 멈춘 것처럼 보인다.
const ALMOST_DONE_MS = 10_000;

function stagePlan(deliverable) {
  return STAGE_PLANS[deliverable] || STAGE_PLANS.video;
}

// 첫 편은 잴 것이 없어 시계가 늦게 선다. 그런데 같은 기기·같은 화질이면 페이지당
// 음성 길이도, 촬영 시간 대 음성 길이의 비율도 실행마다 크게 다르지 않다. 지난
// 실행에서 잰 값을 시작값으로 두되, 이번 실행의 실측이 곧 이기도록 무게를 줄여
// 넣는다. 화질이 다르면 촬영 비용이 달라지므로 화질별로 따로 기억한다.
const RATE_STORE_KEY = "job-pace-rates-v1";
const PRIOR_PAGES = 20;
const PRIOR_DURATION_MS = 20 * 60_000;

function browserStore() {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    return {
      read: () => JSON.parse(storage.getItem(RATE_STORE_KEY) || "{}"),
      write: (value) => storage.setItem(RATE_STORE_KEY, JSON.stringify(value)),
    };
  } catch { return null; }
}

function cappedRate(sample, limitKey, limit) {
  const weight = Number(sample?.[limitKey]);
  const total = Number(sample?.ms ?? sample?.durationMs);
  if (!(weight > 0) || !(total > 0)) return null;
  const scale = Math.min(1, limit / weight);
  return { ...sample, [limitKey]: weight * scale, [sample.ms === undefined ? "durationMs" : "ms"]: total * scale };
}

export function createJobPace({ now = () => Date.now(), store = browserStore() } = {}) {
  let deliverable = "video";
  let forcedSplit = false;
  let units = [];
  let unit = null;
  let unitStartedAt = null;
  let unitPages = 0;
  let unitDurationMs = 0;
  let unitCaptureMs = 0;
  let stage = null;
  let voice = null;
  let pausedAt = null;
  let samples = freshSamples();
  let rateKey = "standard";

  function freshSamples() {
    return {
      // 단계별 페이지당 소요. 끝난 단계만 들어간다.
      stages: new Map(),
      // 촬영 시간 ÷ 음성 길이. 실시간 촬영이라 1에 가깝지만 화질·인코딩으로 는다.
      capture: { ms: 0, durationMs: 0 },
      // 페이지당 음성 길이. 아직 합성하지 않은 편의 촬영 몫을 여기서 잡는다.
      audio: { durationMs: 0, pages: 0 },
      // 편 전체의 페이지당 소요. 남은 편들의 몫이다.
      units: { ms: 0, pages: 0 },
    };
  }

  // 멈춰 있는 동안은 시간을 세지 않는다. 그러지 않으면 남은 시간이 멈춘 만큼
  // 부풀어 다시 켰을 때 엉뚱한 값을 말한다.
  const clock = () => pausedAt ?? now();
  const since = (at) => (at ? Math.max(0, clock() - at) : 0);

  function shift(ms) {
    if (!(ms > 0)) return;
    if (unitStartedAt) unitStartedAt += ms;
    if (stage) stage.startedAt += ms;
    if (voice) voice.startedAt += ms;
  }

  function addStageSample(name, ms) {
    if (!STAGE_NOUNS[name] || !(unitPages > 0) || !(ms > 0)) return;
    const sample = samples.stages.get(name) || { ms: 0, pages: 0 };
    sample.ms += ms;
    sample.pages += unitPages;
    samples.stages.set(name, sample);
  }

  function closeStage() {
    if (!stage) return;
    const elapsed = since(stage.startedAt);
    addStageSample(stage.name, elapsed);
    if (stage.name === "capture") unitCaptureMs += elapsed;
    stage = null;
  }

  // 편이 끝나면 그 편의 실제 소요와 분량이 속도가 된다. 촬영이 한 번 실패해 다시
  // 돌았다면 두 번의 합이 그 편의 촬영 시간이므로, 비율은 편 단위로만 더한다.
  function closeUnit() {
    closeStage();
    const current = unit ? units[unit.index - 1] : null;
    if (current?.state === "running") current.state = unit.failed ? "failed" : "done";
    if (unitStartedAt && unitPages > 0 && !unit?.failed) {
      samples.units.ms += since(unitStartedAt);
      samples.units.pages += unitPages;
    }
    if (unitCaptureMs > 0 && unitDurationMs > 0) {
      samples.capture.ms += unitCaptureMs;
      samples.capture.durationMs += unitDurationMs;
    }
    unitStartedAt = null;
    unitDurationMs = 0;
    unitCaptureMs = 0;
    voice = null;
    savePriors();
  }

  function loadPriors(quality) {
    rateKey = String(quality || "standard");
    if (!store) return;
    let saved = null;
    try { saved = store.read()?.[rateKey]; } catch { saved = null; }
    if (!saved) return;
    for (const [name, sample] of Object.entries(saved.stages || {})) {
      const capped = cappedRate(sample, "pages", PRIOR_PAGES);
      if (capped) samples.stages.set(name, { ms: capped.ms, pages: capped.pages });
    }
    const capture = cappedRate(saved.capture, "durationMs", PRIOR_DURATION_MS);
    if (capture) samples.capture = { ms: capture.ms, durationMs: capture.durationMs };
    const audio = cappedRate(saved.audio, "pages", PRIOR_PAGES);
    if (audio) samples.audio = { durationMs: audio.durationMs, pages: audio.pages };
    const units = cappedRate(saved.units, "pages", PRIOR_PAGES);
    if (units) samples.units = { ms: units.ms, pages: units.pages };
  }

  function savePriors() {
    if (!store) return;
    try {
      const all = store.read() || {};
      all[rateKey] = {
        stages: Object.fromEntries([...samples.stages].map(([name, sample]) => {
          const capped = cappedRate(sample, "pages", PRIOR_PAGES);
          return [name, capped ? { ms: capped.ms, pages: capped.pages } : sample];
        })),
        capture: cappedRate(samples.capture, "durationMs", PRIOR_DURATION_MS) || samples.capture,
        audio: cappedRate(samples.audio, "pages", PRIOR_PAGES) || samples.audio,
        units: cappedRate(samples.units, "pages", PRIOR_PAGES) || samples.units,
      };
      store.write(all);
    } catch { /* 기록을 남기지 못해도 이번 실행의 계산은 그대로 이어간다. */ }
  }

  function ratePerPage(name) {
    const sample = samples.stages.get(name);
    return sample && sample.pages > 0 ? sample.ms / sample.pages : null;
  }

  function captureRatio() {
    return samples.capture.durationMs > 0 ? samples.capture.ms / samples.capture.durationMs : null;
  }

  function audioMsPerPage() {
    return samples.audio.pages > 0 ? samples.audio.durationMs / samples.audio.pages : null;
  }

  function estimateStageMs(name, { pages = unitPages, durationMs = unitDurationMs } = {}) {
    if (name === "capture") {
      const ratio = captureRatio() ?? 1;
      if (durationMs > 0) return durationMs * ratio;
      const perPage = audioMsPerPage();
      if (perPage && pages > 0) return perPage * pages * ratio;
    }
    const rate = ratePerPage(name);
    return rate != null && pages > 0 ? rate * pages : null;
  }

  // 관측을 시작한 지점부터 잰다. 화면을 늦게 열었어도 그 지점이 기준이다.
  function voiceRemainingMs() {
    if (!voice) return null;
    const done = voice.done - voice.baseline;
    const left = voice.total - voice.done;
    if (!(voice.total > 0) || !(done > 0)) return null;
    if (left <= 0) return 0;
    return (since(voice.startedAt) / done) * left;
  }

  function currentStageRemainingMs() {
    if (!stage) return null;
    if (stage.name === "voice") {
      const measured = voiceRemainingMs();
      if (measured != null) return measured;
    }
    const estimate = estimateStageMs(stage.name);
    return estimate == null ? null : Math.max(0, estimate - since(stage.startedAt));
  }

  function unitRemainingMs() {
    const plan = stagePlan(deliverable);
    const index = stage ? plan.indexOf(stage.name) : -1;
    if (index < 0) return null;
    let total = 0;
    for (const name of plan.slice(index)) {
      const estimate = name === stage.name ? currentStageRemainingMs() : estimateStageMs(name);
      if (estimate == null) {
        if (MAJOR_STAGES.has(name)) return null;
        continue;
      }
      total += estimate;
    }
    return total;
  }

  // 편 개수로 나누면 남은 편이 가벼운지 무거운지를 놓친다. CH02 실측에서 편
  // 평균으로는 90분, 페이지 가중으로는 54분이 나왔고 실제는 뒤쪽이었다.
  function unitMsPerPage() {
    if (samples.units.pages > 0) return samples.units.ms / samples.units.pages;
    // 첫 편이 끝나기 전에도, 이미 지나온 단계의 속도로 한 편의 몫을 조립한다.
    const plan = stagePlan(deliverable);
    const perPageAudio = audioMsPerPage() ?? (unitDurationMs > 0 && unitPages > 0 ? unitDurationMs / unitPages : null);
    let total = 0;
    for (const name of plan) {
      const estimate = estimateStageMs(name, { pages: 1, durationMs: perPageAudio ?? 0 });
      if (estimate == null) {
        if (MAJOR_STAGES.has(name)) return null;
        continue;
      }
      total += estimate;
    }
    return total;
  }

  function pendingPages() {
    if (!unit) return 0;
    return units.slice(Number(unit.index))
      .filter((item) => !item.completed)
      .reduce((total, item) => total + Math.max(0, Number(item.pages) || 0), 0);
  }

  function chapterRemainingMs() {
    if (!units.length || !unit) return null;
    const perPage = unitMsPerPage();
    let current = unitRemainingMs();
    if (current == null && perPage != null && unitPages > 0) {
      current = Math.max(0, perPage * unitPages - since(unitStartedAt));
    }
    if (current == null) return null;
    const pending = pendingPages();
    if (pending === 0) return current;
    return perPage == null ? null : current + perPage * pending;
  }

  function remainingText(ms, scope) {
    if (ms < ALMOST_DONE_MS) return scope === "unit" ? "이 편 곧 완료" : "곧 완료";
    const label = formatCountdown(ms);
    if (!label) return "";
    return scope === "unit" ? `이 편 ${label} 남음` : `${label} 남음`;
  }

  function split() {
    return forcedSplit || units.length > 1 || Number(unit?.total) > 1;
  }

  // 한 편짜리 작업에는 두 번째 시계가 필요 없다. 레슨 하나, 페이지 직접 선택,
  // 챕터를 한 영상으로 만들기는 모두 '이 작업이 언제 끝나는지'가 곧 전부다.
  function labels({ running = false } = {}) {
    const twoClocks = split();
    if (!running) return { unit: "", total: "", unitBusy: false, totalBusy: false };
    if (pausedAt) {
      return { unit: "일시정지", total: twoClocks ? "전체 일시정지" : "", unitBusy: false, totalBusy: false };
    }
    const scope = twoClocks ? "unit" : "job";
    const remaining = unitRemainingMs();
    let unitText = remaining == null ? "" : remainingText(remaining, scope);
    if (!unitText) {
      // 전체 몫을 아직 못 내도 지금 단계의 몫은 아는 때가 있다. 그때는 무엇을
      // 기다리는 중인지라도 말한다.
      const stageRest = currentStageRemainingMs();
      const noun = stage ? STAGE_NOUNS[stage.name] : null;
      if (noun && stageRest != null && stageRest >= ALMOST_DONE_MS) {
        unitText = `${noun} ${formatCountdown(stageRest)} 남음`;
      }
    }
    const whole = twoClocks ? chapterRemainingMs() : null;
    const totalText = !twoClocks ? "" : whole == null ? "" : `전체 ${remainingText(whole, "job")}`;
    return {
      unit: unitText || `${twoClocks ? "이 편 " : ""}남은 시간 계산 중`,
      total: !twoClocks ? "" : totalText || "전체 남은 시간 계산 중",
      unitBusy: !unitText,
      totalBusy: twoClocks && !totalText,
    };
  }

  return {
    labels,
    get currentUnit() { return unit; },
    // 편 목록만 필요한 자리가 있다. 1초마다 불리는 자리라, 거기서 남은 시간
    // 추정까지 통째로 다시 돌릴 까닭이 없다. snapshot 은 검사용으로 남긴다.
    unitStates() { return units.map((item) => ({ ...item })); },
    // 검사와 화면 상태 확인용. 계산에 쓰는 값은 여기서만 읽는다.
    snapshot() {
      return {
        deliverable, unit, unitPages, unitDurationMs, paused: Boolean(pausedAt),
        units: units.map((item) => ({ ...item })),
        stage: stage ? { ...stage } : null,
        voice: voice ? { ...voice } : null,
        unitRemainingMs: unitRemainingMs(),
        chapterRemainingMs: chapterRemainingMs(),
        msPerPage: unitMsPerPage(),
      };
    },
    start(options = {}) {
      deliverable = STAGE_PLANS[options.deliverable] ? options.deliverable : "video";
      forcedSplit = options.mode === "chapter" && options.chapterMode === "lesson";
      units = [];
      unit = null;
      unitStartedAt = null;
      // 한 편짜리는 plan 이 오지 않는다. 선택한 범위가 곧 그 편의 분량이다.
      unitPages = Math.max(0, Number(options.endPage ?? 0) - Number(options.startPage ?? 1) + 1) || 0;
      unitDurationMs = 0;
      unitCaptureMs = 0;
      stage = null;
      voice = null;
      pausedAt = null;
      samples = freshSamples();
      loadPriors(options.videoQuality);
      if (!forcedSplit && unitPages > 0) unitStartedAt = now();
    },
    plan(planned = []) {
      units = planned.map((item) => ({
        title: item.title,
        pages: Math.max(1, Number(item.pages) || 1),
        completed: Boolean(item.completed),
        // 이미 완성돼 건너뛰는 편과 아직 손대지 않은 편은 다른 일이다.
        state: item.completed ? "skipped" : "pending",
      }));
    },
    startUnit(next = {}) {
      closeUnit();
      unit = { index: Number(next.index), total: Number(next.total), failed: false };
      if (units[unit.index - 1]) units[unit.index - 1].state = "running";
      unitPages = Math.max(0, Number(units[unit.index - 1]?.pages) || 0);
      unitStartedAt = now();
    },
    // 촬영은 강의 길이만큼 실시간으로 돈다. 합성이 끝나야 그 길이를 알 수 있다.
    unitDuration(durationMs) {
      const value = Number(durationMs);
      if (!(value > 0)) return;
      unitDurationMs = value;
      if (unitPages > 0) {
        samples.audio.durationMs += value;
        samples.audio.pages += unitPages;
      }
    },
    stage(name, state = "running") {
      if (state === "done") {
        if (stage?.name === name) closeStage();
        // 검증 단계는 별도 프로세스가 아니라 이벤트가 오지 않는다. 마지막 단계가
        // 끝난 자리에서 바로 다음 단계를 세워 그 시간도 함께 잰다.
        const plan = stagePlan(deliverable);
        const index = plan.indexOf(name);
        const next = index < 0 ? null : plan[index + 1];
        if (next) stage = { name: next, startedAt: now() };
        return;
      }
      if (stage?.name !== name) closeStage();
      if (name !== "voice") voice = null;
      if (!stage) stage = { name, startedAt: now() };
    },
    voiceProgress({ done, total } = {}) {
      // 진행 숫자는 목소리 단계에서만 나온다. 단계 이벤트보다 먼저 닿아도
      // 무엇을 재는 중인지 알 수 있다.
      if (!stage) stage = { name: "voice", startedAt: now() };
      if (!voice || voice.total !== Number(total)) {
        voice = { baseline: Number(done), total: Number(total), done: Number(done), startedAt: now() };
        return;
      }
      voice.done = Number(done);
    },
    unitFailed() {
      if (unit) unit.failed = true;
      if (unit && units[unit.index - 1]) units[unit.index - 1].state = "failed";
      closeStage();
      unitStartedAt = null;
      voice = null;
    },
    pause() {
      if (!pausedAt) pausedAt = now();
    },
    resume() {
      if (!pausedAt) return;
      shift(now() - pausedAt);
      pausedAt = null;
    },
    // 마지막 편은 다음 편이 없어 닫히지 않는다. 한 편짜리 작업은 편 이벤트가
    // 아예 없다. 끝난 자리에서 한 번 닫아야 그 실측이 다음 실행의 시작값이 된다.
    finish() {
      closeUnit();
      stage = null;
    },
    // 맥이 잠든 동안에는 제작도 멈춰 있다. 그 시간을 경과로 세면 남은 시간이
    // 자고 일어난 만큼 부풀어, 남은 편들의 몫까지 함께 늘어난다.
    slept(ms) {
      if (pausedAt) return;
      shift(Number(ms));
    },
  };
}
