// 촬영하는 페이지의 시계. 실시간으로 흐르는 화면을 받아 칸에 나눠 담으면 칸마다 담기는
// 페이지 시각이 흔들린다(2026-09-28 CH00: 40ms 칸에 16~70ms). 그래서 녹화하는 동안은
// 페이지가 보는 시간을 멈춰 두고, 한 칸(40ms)씩 넘긴 뒤 그 순간을 그대로 찍는다.
//
// 페이지가 시간을 얻는 길을 모두 이 시계에 묶는다.
//   · performance.now · Date · setTimeout/setInterval · requestAnimationFrame: 페이지 안에서 바꿔 끼운다.
//   · CSS 애니메이션·전환, Web Animations: CDP로 문서 타임라인을 멈추고 칸마다 각 애니메이션의
//     startTime을 옮긴다. 페이지에는 타임라인 시각과 startTime을 시계 좌표로 보여 준다.
//   · <video>/<audio>: 멈춰 두고 칸마다 그 시각으로 옮긴다. SVG(SMIL)도 같다.
// CDP 가상 시간(Emulation.setVirtualTimePolicy)은 쓰지 않는다. Chromium 1234 + Metal에서
// 타임라인을 멈춘 채 새 장면을 올리면 Page.captureScreenshot이 끝나지 않았다(2026-09-28).
// BeginFrame 제어는 macOS에서 지원하지 않는다("BeginFrameControl is not supported on MacOS yet").
//
// 페이지는 멈추기 전까지 제 시계로 돈다(준비·첫 장면 이동은 실시간). 멈춘 뒤에도 브라우저
// 안쪽의 작업(모듈 받기·WebGL 준비·영상 해독)은 실제 시간으로 돈다. 그래서 칸을 넘기지
// 않고 기다리면 불러오는 동안의 빈 화면이 영상에 남지 않는다.

const PAGE_CALL_TIMEOUT_MS = 30000;
const MEDIA_SEEK_TIMEOUT_MS = 5000;

// 이 함수는 문자열로 페이지에 들어간다. 바깥 변수를 쓰지 않는다.
function pageClock(mediaSeekTimeoutMs) {
  const g = globalThis;
  if (g.__captureClock) return;
  const perf = g.performance;
  const nativeNow = perf.now.bind(perf);
  const NativeDate = g.Date;
  const nativeDateNow = NativeDate.now.bind(NativeDate);
  const nativeSetTimeout = g.setTimeout.bind(g);
  const nativeClearTimeout = g.clearTimeout.bind(g);
  const nativeRaf = g.requestAnimationFrame.bind(g);
  const accessor = (proto, name) => {
    for (let p = proto; p; p = Object.getPrototypeOf(p)) {
      const found = Object.getOwnPropertyDescriptor(p, name);
      if (found) return { owner: p, ...found };
    }
    return null;
  };
  const startTime = accessor(g.Animation.prototype, "startTime");
  const timelineTime = accessor(g.DocumentTimeline.prototype, "currentTime");
  const mediaPaused = accessor(g.HTMLMediaElement.prototype, "paused");
  const nativePause = g.HTMLMediaElement.prototype.pause;
  const report = (error) => { try { g.reportError(error); } catch { nativeSetTimeout(() => { throw error; }); } };
  // 한 번 비워 주면 밀린 microtask와 바로 뒤의 작업(React 스케줄러의 MessageChannel)이 돈다.
  const yieldTask = () => new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
    channel.port2.postMessage(0);
  });

  let held = false, now = 0, dateOrigin = 0, frozenAt = null;
  const current = () => (held ? now : nativeNow());

  Object.defineProperty(perf, "now", { configurable: true, writable: true, value: function now() { return current(); } });
  const heldDate = () => Math.floor(dateOrigin + now);
  function Date(...args) {
    if (!new.target) return held ? new NativeDate(heldDate()).toString() : NativeDate();
    return Reflect.construct(NativeDate, args.length || !held ? args : [heldDate()], new.target);
  }
  Date.prototype = NativeDate.prototype;
  Date.now = function now() { return held ? heldDate() : nativeDateNow(); };
  Date.parse = NativeDate.parse;
  Date.UTC = NativeDate.UTC;
  g.Date = Date;

  // ── 타이머: 멈춘 동안에는 시계를 넘길 때 기한이 된 것만 순서대로 부른다 ──
  const timers = new Map();
  let nextTimer = 1, nesting = 0;
  const armLive = (id, timer) => {
    timer.native = held ? null : nativeSetTimeout(() => fireTimer(id), Math.max(0, timer.at - nativeNow()));
  };
  function schedule(handler, delay, args, repeat) {
    let ms = Number(delay);
    if (!(ms > 0)) ms = 0;
    // HTML의 중첩 타이머 하한. 0ms 타이머가 스스로를 다시 걸어도 시계가 앞으로 간다.
    if (nesting >= 5 || repeat) ms = Math.max(ms, 4);
    const id = nextTimer++;
    const timer = { at: current() + ms, every: repeat ? ms : null, handler, args, nesting: nesting + 1, native: null };
    timers.set(id, timer);
    armLive(id, timer);
    return id;
  }
  function fireTimer(id) {
    const timer = timers.get(id);
    if (!timer) return;
    timer.native = null;
    if (timer.every === null) timers.delete(id);
    else { timer.at = held ? timer.at + timer.every : nativeNow() + timer.every; armLive(id, timer); }
    const outer = nesting;
    nesting = timer.nesting;
    try {
      if (typeof timer.handler === "function") timer.handler.apply(g, timer.args);
      else (0, eval)(String(timer.handler));
    } catch (error) {
      report(error);
    } finally {
      nesting = outer;
    }
  }
  const cancel = (id) => {
    const timer = timers.get(Number(id));
    if (!timer) return;
    if (timer.native !== null) nativeClearTimeout(timer.native);
    timers.delete(Number(id));
  };
  g.setTimeout = function setTimeout(handler, delay = 0, ...args) { return schedule(handler, delay, args, false); };
  g.setInterval = function setInterval(handler, delay = 0, ...args) { return schedule(handler, delay, args, true); };
  g.clearTimeout = function clearTimeout(id) { cancel(id); };
  g.clearInterval = function clearInterval(id) { cancel(id); };
  const dueTimer = (limit) => {
    let found = null;
    for (const [id, timer] of timers) {
      if (timer.at <= limit && (!found || timer.at < found.timer.at)) found = { id, timer };
    }
    return found;
  };

  // ── 화면 갱신: 멈춘 동안에는 칸을 찍을 때만 부른다 ──
  let frameQueue = new Map(), nextFrame = 1, pump = 0;
  const runFrame = (timestamp) => {
    const batch = frameQueue;
    frameQueue = new Map();
    for (const callback of batch.values()) {
      try { callback(timestamp); } catch (error) { report(error); }
    }
    return batch.size;
  };
  const livePump = (timestamp) => { pump = 0; if (!held) runFrame(timestamp); };
  g.requestAnimationFrame = function requestAnimationFrame(callback) {
    if (typeof callback !== "function") {
      throw new TypeError("Failed to execute 'requestAnimationFrame' on 'Window': parameter 1 is not of type 'Function'.");
    }
    const id = nextFrame++;
    frameQueue.set(id, callback);
    if (!held && !pump) pump = nativeRaf(livePump);
    return id;
  };
  g.cancelAnimationFrame = function cancelAnimationFrame(id) { frameQueue.delete(Number(id)); };

  // ── 애니메이션: 문서 타임라인은 frozenAt에 멈춰 있다. 페이지에는 시계 좌표로 보인다 ──
  const shift = () => (held && frozenAt !== null ? now - frozenAt : 0);
  const onDocumentTimeline = (animation) => animation.timeline === g.document.timeline;
  Object.defineProperty(startTime.owner, "startTime", {
    configurable: true, enumerable: startTime.enumerable,
    get() {
      const value = startTime.get.call(this);
      return value === null || !onDocumentTimeline(this) ? value : value + shift();
    },
    set(value) {
      startTime.set.call(this, value === null || !onDocumentTimeline(this) ? value : value - shift());
    },
  });
  Object.defineProperty(timelineTime.owner, "currentTime", {
    configurable: true, enumerable: timelineTime.enumerable,
    get() {
      const value = timelineTime.get.call(this);
      return held && frozenAt !== null && this === g.document.timeline && value !== null ? now : value;
    },
  });
  // 각 애니메이션의 시작 시각(시계 좌표). 페이지가 startTime을 바꾸면(재생·일시정지·
  // currentTime·배속) 타임라인 값이 우리가 둔 것과 달라지고, 그때의 시각으로 다시 읽는다.
  const tracked = new WeakMap();
  function syncAnimations() {
    if (!held || frozenAt === null) return 0;
    const offset = now - frozenAt;
    let count = 0;
    // getAnimations는 밀린 스타일을 먼저 반영한다. 방금 붙은 CSS 전환도 여기서 생긴다.
    for (const animation of g.document.getAnimations()) {
      if (!onDocumentTimeline(animation)) continue;
      const rate = animation.playbackRate;
      const state = animation.playState;
      if (!rate || (state !== "running" && state !== "finished")) continue;
      let start = startTime.get.call(animation);
      if (start === null) {
        // 재생을 기다리는 애니메이션은 이 순간에 시작한다(브라우저라면 다음 화면 갱신에서 시작한다).
        if (!animation.pending) continue;
        startTime.set.call(animation, frozenAt - (animation.currentTime ?? 0) / rate);
        start = startTime.get.call(animation);
      }
      let record = tracked.get(animation);
      if (!record || Math.abs(record.native - start) > 1e-3) {
        record = { at: start + offset, native: start };
        tracked.set(animation, record);
      }
      const want = record.at - offset;
      if (Math.abs(want - start) > 1e-6) startTime.set.call(animation, want);
      record.native = startTime.get.call(animation);
      count++;
    }
    return count;
  }
  const setNow = (to) => {
    syncAnimations();
    now = Math.max(now, to);
    syncAnimations();
  };

  // ── SVG(SMIL): 최상위 svg마다 제 시계가 있다 ──
  const svgClocks = new WeakMap();
  function syncSvg() {
    for (const svg of g.document.querySelectorAll("svg")) {
      if (svg.ownerSVGElement || typeof svg.setCurrentTime !== "function") continue;
      let clock = svgClocks.get(svg);
      if (!clock) {
        // 페이지가 이미 멈춰 둔 svg는 페이지의 것이다.
        clock = svg.animationsPaused() ? { skip: true } : { base: svg.getCurrentTime(), at: now };
        svgClocks.set(svg, clock);
        if (!clock.skip) svg.pauseAnimations();
      }
      if (!clock.skip) svg.setCurrentTime(clock.base + (now - clock.at) / 1000);
    }
  }

  // ── 영상·소리: 실제로는 멈춰 두고 칸마다 그 시각으로 옮긴다. 페이지에는 재생 중으로 보인다 ──
  const media = new WeakMap();
  const takeMedia = (element, base) => {
    const record = { playing: true, base, at: now, quietPause: true, ended: false, shown: false };
    media.set(element, record);
    nativePause.call(element);
    return record;
  };
  const position = (record, element) => record.base + (now - record.at) / 1000 * element.playbackRate;
  Object.defineProperty(mediaPaused.owner, "paused", {
    configurable: true, enumerable: mediaPaused.enumerable,
    get() {
      const record = held ? media.get(this) : null;
      return record ? !record.playing : mediaPaused.get.call(this);
    },
  });
  // 멈춘 동안의 play()는 실제로 재생하지 않는다. 재생하면 'play' 사건이 오기 전까지 실제
  // 시간으로 흘러 영상이 한 프레임쯤 앞서 시작한다(2026-09-28 측정 약 35ms).
  const nativePlay = g.HTMLMediaElement.prototype.play;
  g.HTMLMediaElement.prototype.play = function play() {
    if (!held) return nativePlay.call(this);
    const record = media.get(this);
    if (record?.playing) return Promise.resolve();
    if (record) Object.assign(record, { playing: true, base: this.currentTime, at: now, ended: false });
    else takeMedia(this, this.currentTime);
    this.dispatchEvent(new Event("play"));
    this.dispatchEvent(new Event("playing"));
    return Promise.resolve();
  };
  g.HTMLMediaElement.prototype.pause = function pause() {
    const record = held ? media.get(this) : null;
    if (!record) return nativePause.call(this);
    if (record.playing) {
      record.base = position(record, this); record.at = now; record.playing = false;
      this.dispatchEvent(new Event("pause"));
    }
  };
  // 자동 재생은 play()를 거치지 않는다. 사건이 왔을 때는 이미 조금 재생됐으므로 재생한 구간의
  // 시작을 재생 위치로 삼는다.
  const onPlay = (event) => {
    const element = event.target;
    if (!held || !(element instanceof g.HTMLMediaElement) || !event.isTrusted) return;
    const record = media.get(element);
    if (record?.playing) { record.quietPause = true; nativePause.call(element); return; }
    let base = element.currentTime;
    for (let i = element.played.length - 1; i >= 0; i--) {
      if (element.played.start(i) <= base + 1e-3 && base <= element.played.end(i) + 1e-3) { base = element.played.start(i); break; }
    }
    if (record) { Object.assign(record, { playing: true, base, at: now, ended: false, quietPause: true }); nativePause.call(element); }
    else takeMedia(element, base);
  };
  const onPause = (event) => {
    const record = media.get(event.target);
    if (record?.quietPause && event.isTrusted) { record.quietPause = false; event.stopImmediatePropagation(); }
  };
  const seekFailed = (element, at) => new Error(
    `영상 ${element.currentSrc || element.src}을 ${at.toFixed(3)}초로 옮기지 못했습니다(지금 ${element.currentTime.toFixed(3)}초). `
    + "범위 요청을 받는 서버에서 열어야 합니다. 멈춘 영상을 찍지 않습니다.");
  const settleMedia = (element, at) => new Promise((resolve, reject) => {
    const timer = nativeSetTimeout(() => {
      element.removeEventListener("seeked", seeked);
      reject(seekFailed(element, at));
    }, mediaSeekTimeoutMs);
    // 옮긴 그림이 합성기에 넘어가도록 실제 화면 갱신을 한 번 기다린다. 멈춘 영상을 옮기면
    // headless에서 requestVideoFrameCallback이 오지 않는다(2026-09-28, 12/12회).
    const seeked = () => {
      nativeClearTimeout(timer);
      if (Math.abs(element.currentTime - at) > 0.001) reject(seekFailed(element, at));
      else nativeRaf(() => resolve());
    };
    element.addEventListener("seeked", seeked, { once: true });
  });
  async function syncMedia() {
    const waits = [];
    for (const element of g.document.querySelectorAll("video, audio")) {
      let record = media.get(element);
      if (!record) {
        if (mediaPaused.get.call(element)) continue;
        record = takeMedia(element, element.currentTime);
      }
      if (!record.playing || element.readyState < 1) continue;
      let at = position(record, element);
      const duration = element.duration;
      if (Number.isFinite(duration) && duration > 0) {
        if (element.loop) at %= duration;
        else if (at >= duration) {
          at = duration;
          if (!record.ended) { record.ended = true; record.playing = false; element.dispatchEvent(new Event("ended")); }
        }
      }
      // 처음 잡은 영상은 같은 위치라도 한 번 옮긴다. 그래야 그 그림이 합성된 뒤에 찍는다.
      if (record.shown && Math.abs(element.currentTime - at) < 1e-4) continue;
      record.shown = true;
      element.currentTime = at;
      waits.push(settleMedia(element, at));
    }
    await Promise.all(waits);
    return waits.length;
  }

  g.__captureClock = {
    // Node 쪽이 문서 타임라인을 멈춘 뒤에 부른다.
    hold() {
      if (held) return now;
      // 정수 ms에서 멈춘다. 칸 시각(멈춘 시각 + k·40ms)이 부동소수 오차 없이 떨어진다.
      now = Math.ceil(nativeNow());
      dateOrigin = nativeDateNow() - now;
      frozenAt = timelineTime.get.call(g.document.timeline);
      held = true;
      for (const timer of timers.values()) if (timer.native !== null) { nativeClearTimeout(timer.native); timer.native = null; }
      g.addEventListener("play", onPlay, true);
      g.addEventListener("pause", onPause, true);
      for (const element of g.document.querySelectorAll("video, audio")) {
        if (!mediaPaused.get.call(element)) takeMedia(element, element.currentTime);
      }
      syncAnimations();
      syncSvg();
      return now;
    },
    get now() { return current(); },
    // 기한이 된 타이머를 시각 순서대로 부르며 시계를 target까지 넘긴다. 타이머마다
    // 한 번씩 비워 그 타이머가 맡긴 후속 작업도 같은 시각에 돌게 한다.
    async advanceTo(target) {
      if (!held) throw new Error("페이지 시계가 멈춰 있지 않습니다.");
      if (!(target >= now)) throw new Error(`페이지 시계를 되돌릴 수 없습니다: ${now} → ${target}`);
      await yieldTask();
      let fired = 0;
      for (let due = dueTimer(target); due; due = dueTimer(target)) {
        setNow(due.timer.at);
        fireTimer(due.id);
        fired++;
        await yieldTask();
        if (fired > 100000) throw new Error("페이지 타이머가 끝없이 이어져 시계를 넘길 수 없습니다.");
      }
      setNow(target);
      return fired;
    },
    // 지금 시각으로 한 번 그린다. 그 뒤의 화면 캡처가 이 순간을 담는다.
    async frame() {
      if (!held) throw new Error("페이지 시계가 멈춰 있지 않습니다.");
      await yieldTask();
      syncAnimations();
      const callbacks = runFrame(now);
      const animations = syncAnimations();
      syncSvg();
      const seeks = await syncMedia();
      return { at: now, callbacks, animations, seeks };
    },
  };
}

// 페이지 스크립트보다 먼저 들어가야 한다. 이동(goto) 전에 부른다.
export async function installPageClock(page) {
  await page.addInitScript(`(${pageClock})(${MEDIA_SEEK_TIMEOUT_MS});`);
}

async function bounded(promise, message) {
  let timeout;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), PAGE_CALL_TIMEOUT_MS);
    })]);
  } finally { clearTimeout(timeout); }
}

// 페이지 시계를 지금 시각에 멈춘다. 이후 페이지 시간은 advanceTo로만 흐른다.
// 반환하는 시각(ms)은 멈춘 순간부터 잰 페이지 시간이다.
export async function holdPageClock(page, session, { width, height }) {
  // Animation 도메인은 켠 채 둔다. 끄면 문서 타임라인이 다시 흐른다(2026-09-28 확인).
  await session.send("Animation.enable");
  await session.send("Animation.setPlaybackRate", { playbackRate: 0 });
  const origin = await page.evaluate(() => {
    if (!window.__captureClock) throw new Error("페이지 시계가 설치되지 않았습니다. 이동 전에 installPageClock을 부르세요.");
    return window.__captureClock.hold();
  });
  let elapsed = 0;
  return {
    get elapsedMs() { return elapsed; },
    async advanceTo(ms) {
      if (ms < elapsed) throw new Error(`페이지 시계를 되돌릴 수 없습니다: ${elapsed}ms → ${ms}ms`);
      if (ms === elapsed) return 0;
      const fired = await bounded(page.evaluate((to) => window.__captureClock.advanceTo(to), origin + ms),
        `페이지가 ${PAGE_CALL_TIMEOUT_MS / 1000}초 안에 ${ms}ms로 시계를 넘기지 못했습니다.`);
      elapsed = ms;
      return fired;
    },
    async frame() {
      const result = await bounded(page.evaluate(() => window.__captureClock.frame()),
        `페이지가 ${PAGE_CALL_TIMEOUT_MS / 1000}초 안에 ${elapsed}ms 화면을 그리지 못했습니다.`);
      return { ...result, at: result.at - origin };
    },
    // 지금 화면을 무손실 PNG로 받는다. 합성기가 새로 그린 한 장이다.
    async shoot() {
      const { data } = await bounded(session.send("Page.captureScreenshot", {
        format: "png", optimizeForSpeed: true, captureBeyondViewport: false, fromSurface: true,
      }), `브라우저가 ${PAGE_CALL_TIMEOUT_MS / 1000}초 안에 ${elapsed}ms 화면을 넘기지 않았습니다.`);
      const png = Buffer.from(data, "base64");
      if (png.length < 24 || png.toString("hex", 0, 8) !== "89504e470d0a1a0a"
        || png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) {
        throw new Error(`브라우저 프레임이 요청한 ${width}×${height} PNG가 아닙니다. 촬영을 중단합니다.`);
      }
      return png;
    },
  };
}
