// 응용 프로그램 창을 촬영용으로 다루는 계약. 덱 화면의 `deck-page.mjs`와 같은
// 자리에 앉는 형제다. 프레임 전송(recorder)·규격(encoding)·보고서는 그대로 쓴다.
//
// 이 파일은 어떤 앱인지 모른다. 앱을 아는 것은 시나리오 파일뿐이고, 여기는 시나리오가
// 적은 동사를 Playwright 조작으로 옮기고 그 시각·좌표를 기록할 뿐이다.
import fs from "node:fs";
import path from "node:path";
import { TYPE_DELAY_MS, stepBudgetMs } from "../../shared/demo-scenario.mjs";
import { frameForBox } from "../../shared/demo-camera.mjs";
import { TAP_MS, glideCursor, installCursorOverlay, moveCursor, prepareTap, lastTap } from "./cursor-overlay.mjs";
import { waitForServer } from "./site.mjs";
import { abortable, demoDelay as sleep, startDemoCommand } from "./demo-runtime.mjs";

const GLIDE_MS = 320;        // 커서가 한 번 움직이는 데 걸리는 시간
const HOVER_MS = 200;
const SCROLL_STEP_MS = 30;
const CLICK_HOLD_MS = 60;    // 누르고 떼기 사이
const TYPE_LEAD_MS = 180;

/**
 * 이 장면에서 **우리가 그리는 움직임**의 길이.
 *
 * 앱이 장면을 ¼ 속도로 그리면(`timeScale`) 편집은 그 장면을 4배로 되돌린다. 그때
 * 커서·클릭 표시·타이핑이 제 속도로 움직였다면 되돌리면서 네 배로 빨라져 뚝뚝
 * 끊겨 보인다 — 특히 확대 구간에서는 움직인 거리가 1.6배로 커져 더 두드러진다.
 * 그래서 앱이 느려진 만큼 우리 움직임도 늘린다. 촬영이 받는 그림의 수도 그만큼
 * 늘어나므로, 되돌린 뒤의 커서는 오히려 더 매끄럽다.
 */
export function sceneMotion(timeScale = 1) {
  const stretch = timeScale > 0 && timeScale <= 1 ? 1 / timeScale : 1;
  const scale = value => Math.round(value * stretch);
  return {
    stretch,
    glideMs: scale(GLIDE_MS),
    hoverMs: scale(HOVER_MS),
    scrollStepMs: scale(SCROLL_STEP_MS),
    clickHoldMs: scale(CLICK_HOLD_MS),
    clickJitterMs: scale(40),
    tapMs: scale(TAP_MS),
    typeLeadMs: scale(TYPE_LEAD_MS),
    typeDelayMs: { min: TYPE_DELAY_MS.min * stretch, max: TYPE_DELAY_MS.max * stretch },
  };
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    throw new Error("앱 데모 촬영에는 playwright가 필요합니다. 저장소에서 npm install을 먼저 실행하세요.");
  }
}

// 타이핑 흔들림은 씨앗에서 만든다. 같은 시나리오를 다시 찍으면 같은 리듬이라
// 두 촬영을 견줄 수 있다.
function seededRandom(seed) {
  let state = [...String(seed)].reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0, 0x811c9dc5);
  return () => {
    state = (Math.imul(state, 0x343fd) + 0x269ec3) >>> 0;
    return ((state >>> 8) & 0xffff) / 0x10000;
  };
}

export function locate(page, target) {
  const exact = target.exact === true;
  switch (target.kind) {
    case "selector": return page.locator(target.selector);
    case "role": return target.name === null
      ? page.getByRole(target.role)
      : page.getByRole(target.role, { name: target.name, exact });
    case "placeholder": return page.getByPlaceholder(target.value, { exact });
    case "text": return page.getByText(target.value, { exact });
    case "label": return page.getByLabel(target.value, { exact });
    default: throw new Error(`알 수 없는 대상 종류: ${target.kind}`);
  }
}

export function describeTarget(target) {
  if (target.kind === "selector") return target.selector;
  if (target.kind === "role") return `${target.role}${target.name ? ` "${target.name}"` : ""}`;
  return `${target.kind}="${target.value}"`;
}

/**
 * 시나리오가 말한 앱을 띄우고 촬영할 페이지를 돌려준다.
 *
 * 돌려주는 `close`는 띄운 순서의 반대로 거둔다. 서버·앱이 남으면 다음 촬영이
 * 포트나 프로파일에서 막힌다.
 */
export async function launchDemoApp(scenario, { workDir, onLog = () => {}, signal } = {}) {
  signal?.throwIfAborted();
  const { _electron, chromium } = await loadPlaywright();
  const app = scenario.app;
  const cwd = app.cwd ? path.resolve(app.cwd) : process.cwd();
  const consoleLines = [];
  const windowLines = new Map();
  const cleanups = [];
  const lifetime = new AbortController();
  const running = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  let closing = null, closed = false, readyTimer = null;
  const own = cleanup => {
    if (closed) void cleanup().catch(() => {});
    else cleanups.push(cleanup);
  };
  const close = () => {
    if (closing) return closing;
    closed = true;
    clearTimeout(readyTimer);
    running.removeEventListener("abort", onAbort);
    lifetime.abort(new Error("촬영 앱을 닫았습니다."));
    // 하나가 닫히길 기다리느라 서버의 종료까지 늦추지 않는다.
    closing = Promise.allSettled(cleanups.splice(0).reverse().map(cleanup => cleanup())).then(() => {});
    return closing;
  };
  const onAbort = () => { void close(); };
  running.addEventListener("abort", onAbort, { once: true });
  const wait = promise => abortable(promise, running);
  const listen = window => {
    const lines = [];
    windowLines.set(window, lines);
    window.on("console", message => {
      lines.push(message.text());
      consoleLines.push(message.text());
      if (lines.length > 500) lines.shift();
      if (consoleLines.length > 500) consoleLines.shift();
    });
  };

  try {
    running.throwIfAborted();
    for (const [relative, body] of Object.entries(app.files)) {
      const file = path.join(workDir, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body, "utf8");
    }
    // VSCode 안에서 켜져 있으면 Electron이 Node로 뜬다. 반드시 지운다.
    const env = { ...process.env, ...app.env };
    delete env.ELECTRON_RUN_AS_NODE;

    if (app.prepare) {
      onLog(`준비: ${app.prepare.join(" ")}`);
      const preparing = startDemoCommand(app.prepare, { cwd, env, label: "시나리오 준비 명령" });
      own(() => preparing.stop());
      const timeout = setTimeout(() => lifetime.abort(new Error("시나리오 준비 명령의 제한 시간이 지났습니다.")), app.prepareTimeoutMs);
      try {
        const result = await wait(preparing.exited);
        if (result.code !== 0) throw new Error(result.message);
      } finally { clearTimeout(timeout); await preparing.stop(); }
    }

    if (app.server) {
      onLog(`화면 서버: ${app.server.command.join(" ")}`);
      const server = startDemoCommand(app.server.command, { cwd, env, label: "화면 서버" });
      own(() => server.stop());
      server.exited.then(result => {
        if (!closed) lifetime.abort(new Error(result.message));
      }, error => { if (!closed) lifetime.abort(error); });
      await waitForServer(app.server.url, { timeoutMs: app.server.timeoutMs, signal: running });
    }

    readyTimer = setTimeout(() => lifetime.abort(new Error("앱 준비의 제한 시간이 지났습니다.")), app.ready.timeoutMs);
    let page = null;
    if (app.kind === "electron") {
      const launched = await wait(_electron.launch({
        executablePath: path.resolve(cwd, app.executable),
        args: [...app.args, `--user-data-dir=${path.join(workDir, "profile")}`],
        env, cwd, timeout: app.ready.timeoutMs,
      }).then(launched => { own(() => launched.close()); return launched; }));
      // 준비 신호는 창이 열리자마자 올 수 있다. 창을 고른 뒤에 듣기 시작하면 그
      // 줄을 놓치고 영영 기다린다. 그래서 열리는 모든 창을 즉시 듣는다.
      const heard = new Set();
      const listenWindow = window => {
        if (heard.has(window)) return;
        heard.add(window);
        listen(window);
      };
      launched.on("window", listenWindow);
      for (const window of launched.windows()) listenWindow(window);
      const deadline = Date.now() + app.ready.timeoutMs;
      while (!page && Date.now() < deadline) {
        for (const window of launched.windows()) listenWindow(window);
        page = launched.windows().find(window => !app.window || window.url().startsWith(app.window)) || null;
        if (!page) await sleep(200, running);
      }
      if (!page) {
        throw new Error(`앱 창을 찾지 못했습니다${app.window ? ` (${app.window})` : ""}. `
          + `열린 창: ${JSON.stringify(launched.windows().map(window => window.url()))}`);
      }
      await wait(launched.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) {
          // 개발 모드로 띄운 앱은 DevTools를 연다. 영상에 나오면 안 된다.
          window.webContents.closeDevTools();
          // 창 위에 놓인 실제 마우스가 화면을 건드리지 않게 한다. CDP로 보내는
          // 조작은 OS 히트 테스트를 거치지 않아 그대로 들어간다.
          window.setIgnoreMouseEvents(true);
        }
      }));
    } else {
      // headless라 실제 마우스가 닿지 않는다. 덱 촬영과 같은 렌더 경로다.
      const browser = await wait(chromium.launch({ headless: true, args: ["--enable-gpu", "--use-gl=angle", "--use-angle=metal"] })
        .then(browser => { own(() => browser.close()); return browser; }));
      const context = await wait(browser.newContext({
        viewport: { width: scenario.viewport.width, height: scenario.viewport.height },
        deviceScaleFactor: scenario.viewport.scale,
      }));
      page = await wait(context.newPage());
      listen(page);
      await wait(page.goto(app.url, { waitUntil: "domcontentloaded", timeout: app.ready.timeoutMs }));
    }

    if (app.ready.selector) {
      await wait(page.waitForSelector(app.ready.selector, { state: "visible", timeout: app.ready.timeoutMs }));
    }
    if (app.ready.console) {
      // Electron.launch가 돌아오기 전에 찍힌 준비 신호도 Playwright의 기록에서 읽는다.
      // 다른 창의 같은 로그로 촬영할 창이 준비됐다고 판단하지 않는다.
      const lines = windowLines.get(page);
      const early = await wait(page.consoleMessages());
      lines.push(...early.map(message => message.text()));
      const deadline = Date.now() + app.ready.timeoutMs;
      while (!lines.some(line => line.includes(app.ready.console))) {
        if (Date.now() > deadline) throw new Error(`앱 준비 신호를 기다리다 시간이 지났습니다: "${app.ready.console}"`);
        await sleep(200, running);
      }
    }

    // 창으로는 1920×1080을 만들 수 없다(내장 화면 작업 영역에 막힌다). 에뮬레이션으로
    // CSS 크기와 배율을 주면 스크린캐스트가 정확히 그 크기의 PNG를 준다.
    const session = await wait(page.context().newCDPSession(page));
    await wait(session.send("Emulation.setDeviceMetricsOverride", {
      width: scenario.viewport.width, height: scenario.viewport.height,
      deviceScaleFactor: scenario.viewport.scale, mobile: false,
    }));
    await wait(installCursorOverlay(page));
    await wait(page.evaluate(() => document.fonts?.ready));
    await sleep(600, running);
    clearTimeout(readyTimer);
    return { page, session, consoleLines, close, signal: running };
  } catch (error) {
    await close();
    throw error;
  }
}

async function boxOf(locator, target, timeoutMs) {
  await locator.waitFor({ state: "visible", timeout: timeoutMs });
  await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs });
  const box = await locator.boundingBox({ timeout: timeoutMs });
  if (!box) throw new Error(`대상의 위치를 읽지 못했습니다: ${describeTarget(target)}`);
  return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) };
}

/**
 * 시나리오의 장면을 차례로 실행하며 시각과 좌표를 기록한다.
 *
 * `clock()`은 녹화 시작 기준 경과 ms다. 기록한 시각이 곧 편집 계획의 근거이므로
 * 걸음을 실행하는 쪽과 시계를 읽는 쪽이 같아야 한다.
 */
export async function runScenes(page, scenario, { clock, onEvent = () => {}, signal }) {
  signal?.throwIfAborted();
  const random = seededRandom(scenario.name);
  let cursor = { x: scenario.viewport.width / 2, y: scenario.viewport.height / 2 };
  await abortable(moveCursor(page, cursor.x, cursor.y), signal);

  const glide = async (to, motion) => {
    await glideCursor(page, cursor, to, motion.glideMs);
    cursor = to;
  };

  const scenes = [];
  for (const scene of scenario.scenes) {
    signal?.throwIfAborted();
    const motion = sceneMotion(scene.timeScale);
    const startMs = clock();
    const steps = [];
    let screenText = null;
    const rememberText = async () => {
      const source = page.locator(scene.textFrom).first();
      if (!await abortable(source.isVisible().catch(() => false), signal)) return;
      const text = await abortable(source.innerText({ timeout: 2000 })
        .then(text => text.replace(/\n{3,}/g, "\n\n").trim()).catch(() => null), signal);
      if (text) screenText = text;
    };
    onEvent({ phase: "scene", scene: scene.id });
    for (const [index, step] of scene.steps.entries()) {
      signal?.throwIfAborted();
      const at = clock();
      const record = { verb: step.verb, zoom: step.zoom, startMs: at, endMs: at };
      onEvent({ phase: "step", scene: scene.id, step: index + 1, verb: step.verb,
        target: step.target ? describeTarget(step.target) : null });
      const deadline = new AbortController();
      // pause는 정확히 정한 만큼 쉰다. 타이머 경합으로 정상 pause를 실패시키지 않는다.
      const timer = setTimeout(() => deadline.abort(new Error("걸음의 제한 시간이 지났습니다.")),
        stepBudgetMs(step, scene.timeScale) + 1000);
      const running = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
      const act = task => { running.throwIfAborted(); return abortable(task(), running); };
      try {
        // 다음 화면으로 넘어가는 조작 뒤에는 현재 오버레이가 없어질 수 있다.
        // 마지막에만 읽으면 실제 장면 대신 뒤의 main을 대본 근거로 남기게 된다.
        if (["click", "press"].includes(step.verb)) await act(rememberText);
        if (step.verb === "pause") {
          await sleep(step.ms, running);
        } else if (step.verb === "overview") {
          // 편집 구도만 바꾼다. 실제 앱·마우스·포커스는 움직이지 않는다.
        } else if (step.verb === "focus") {
          const target = locate(page, step.target);
          await act(() => target.waitFor({ state: "visible", timeout: step.timeoutMs }));
          const handle = await act(() => target.elementHandle({ timeout: step.timeoutMs }));
          if (!handle) throw new Error("보여 줄 영역이 사라졌습니다.");
          try {
            await act(() => handle.waitForElementState("stable", { timeout: step.timeoutMs }));
            const box = await act(() => handle.boundingBox());
            if (!box) throw new Error("보여 줄 영역의 위치를 읽지 못했습니다.");
            record.box = { x: box.x, y: box.y, w: box.width, h: box.height };
            record.padding = step.padding;
            record.maxZoom = step.maxZoom;
            frameForBox(record.box, scenario.viewport, step);
          } finally { await handle.dispose(); }
        } else if (step.verb === "press") {
          await act(() => page.keyboard.press(step.key));
        } else if (step.verb === "waitFor") {
          await act(() => locate(page, step.target).waitFor({ state: "visible", timeout: step.timeoutMs }));
        } else if (step.verb === "waitGone") {
          await act(() => locate(page, step.target).waitFor({ state: "hidden", timeout: step.timeoutMs }));
        } else {
          const locator = locate(page, step.target);
          const box = await act(() => boxOf(locator, step.target, step.timeoutMs));
          const point = { x: box.x + Math.round(box.w / 2), y: box.y + Math.round(box.h / 2) };
          record.box = box;
          record.point = point;
          await act(() => glide(point, motion));
          if (step.verb === "hover") {
            await act(() => locator.hover({ timeout: step.timeoutMs }));
            await sleep(motion.hoverMs, running);
          } else if (step.verb === "scroll") {
            await act(() => locator.hover({ timeout: step.timeoutMs }));
            // 한 번에 굴리면 화면이 튄다. 나눠서 굴린다.
            for (let done = 0; done < Math.abs(step.delta); done += 120) {
              await act(() => page.mouse.wheel(0, Math.sign(step.delta) * Math.min(120, Math.abs(step.delta) - done)));
              await sleep(motion.scrollStepMs, running);
            }
          } else {
            // 실제 클릭은 locator가 수행한다. 이동 후 레이아웃이 바뀌거나 버튼이 가려져도
            // 안정·활성·hit target 검사를 다시 통과해야 하며 엉뚱한 좌표를 누르지 않는다.
            await act(() => prepareTap(page, motion.tapMs));
            await act(() => locator.click({ timeout: step.timeoutMs,
              delay: motion.clickHoldMs + Math.round(random() * motion.clickJitterMs) }));
            const clicked = await act(() => lastTap(page));
            if (clicked) record.point = cursor = clicked;
            if (step.verb === "type") {
              const input = await act(() => locator.elementHandle({ timeout: step.timeoutMs }));
              if (!input) throw new Error("입력할 대상이 사라졌습니다.");
              try { await act(() => input.waitForElementState("editable", { timeout: step.timeoutMs })); }
              finally { await input.dispose(); }
              await sleep(motion.typeLeadMs, running);
              for (const char of step.text) {
                await act(() => locator.pressSequentially(char, { timeout: step.timeoutMs }));
                await sleep(motion.typeDelayMs.min + random() * (motion.typeDelayMs.max - motion.typeDelayMs.min), running);
              }
            }
          }
        }
      } catch (error) {
        const where = step.target ? ` (${describeTarget(step.target)})` : "";
        const reason = running.aborted ? running.reason : error;
        throw new Error(`장면 ${scene.id}의 ${step.verb}${where}에서 멈췄습니다: ${reason.message}`, { cause: reason });
      } finally { clearTimeout(timer); }
      record.endMs = clock();
      steps.push(record);
      onEvent({ phase: "step-complete", scene: scene.id, step: index + 1, record });
    }
    // 장면이 끝난 화면의 글. 대본 초안의 근거이며 대본 자체는 여기서 만들지 않는다.
    await rememberText();
    scenes.push({ id: scene.id, startMs, endMs: clock(), timeScale: scene.timeScale, camera: scene.camera, steps, screenText });
  }
  return scenes;
}
