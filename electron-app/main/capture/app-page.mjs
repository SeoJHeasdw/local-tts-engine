// 응용 프로그램 창을 촬영용으로 다루는 계약. 덱 화면의 `deck-page.mjs`와 같은
// 자리에 앉는 형제다. 프레임 전송(recorder)·규격(encoding)·보고서는 그대로 쓴다.
//
// 이 파일은 어떤 앱인지 모른다. 앱을 아는 것은 시나리오 파일뿐이고, 여기는 시나리오가
// 적은 동사를 Playwright 조작으로 옮기고 그 시각·좌표를 기록할 뿐이다.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { TYPE_DELAY_MS } from "../../shared/demo-scenario.mjs";
import { TAP_MS, glideCursor, installCursorOverlay, moveCursor, showTap } from "./cursor-overlay.mjs";
import { waitForServer } from "./site.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

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

function runCommand(command, { cwd, env, label }) {
  return new Promise((resolve, reject) => {
    const [file, ...args] = command;
    const child = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout.on("data", () => {});
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8192); });
    child.once("error", reject);
    child.once("close", code => code === 0
      ? resolve()
      : reject(new Error(`${label} 실패 (종료 ${code})${stderr.trim() ? `\n${stderr.trim()}` : ""}`)));
  });
}

/**
 * 시나리오가 말한 앱을 띄우고 촬영할 페이지를 돌려준다.
 *
 * 돌려주는 `close`는 띄운 순서의 반대로 거둔다. 서버·앱이 남으면 다음 촬영이
 * 포트나 프로파일에서 막힌다.
 */
export async function launchDemoApp(scenario, { workDir, onLog = () => {} }) {
  const { _electron, chromium } = await loadPlaywright();
  const app = scenario.app;
  const cwd = app.cwd ? path.resolve(app.cwd) : process.cwd();
  const consoleLines = [];
  const cleanups = [];
  const close = async () => {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
    cleanups.length = 0;
  };

  try {
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
      await runCommand(app.prepare, { cwd, env, label: "시나리오 준비 명령" });
    }

    if (app.server) {
      onLog(`화면 서버: ${app.server.command.join(" ")}`);
      const [file, ...args] = app.server.command;
      const server = spawn(file, args, { cwd, env, stdio: ["ignore", "ignore", "pipe"], detached: true });
      let serverError = "";
      server.stderr.on("data", chunk => { serverError = (serverError + chunk).slice(-8192); });
      cleanups.push(async () => { try { process.kill(-server.pid, "SIGTERM"); } catch { server.kill("SIGTERM"); } });
      const exited = new Promise((_, reject) => server.once("close", code =>
        reject(new Error(`화면 서버가 먼저 끝났습니다 (종료 ${code})${serverError.trim() ? `\n${serverError.trim()}` : ""}`))));
      await Promise.race([waitForServer(app.server.url), exited]);
    }

    let page = null;
    if (app.kind === "electron") {
      const launched = await _electron.launch({
        executablePath: path.resolve(cwd, app.executable),
        args: [...app.args, `--user-data-dir=${path.join(workDir, "profile")}`],
        env, cwd, timeout: app.ready.timeoutMs,
      });
      cleanups.push(() => launched.close());
      // 준비 신호는 창이 열리자마자 올 수 있다. 창을 고른 뒤에 듣기 시작하면 그
      // 줄을 놓치고 영영 기다린다. 그래서 열리는 모든 창을 즉시 듣는다.
      const heard = new Set();
      const listen = window => {
        if (heard.has(window)) return;
        heard.add(window);
        window.on("console", message => consoleLines.push(message.text()));
      };
      launched.on("window", listen);
      for (const window of launched.windows()) listen(window);
      const deadline = Date.now() + app.ready.timeoutMs;
      while (!page && Date.now() < deadline) {
        for (const window of launched.windows()) listen(window);
        page = launched.windows().find(window => !app.window || window.url().startsWith(app.window)) || null;
        if (!page) await sleep(200);
      }
      if (!page) {
        throw new Error(`앱 창을 찾지 못했습니다${app.window ? ` (${app.window})` : ""}. `
          + `열린 창: ${JSON.stringify(launched.windows().map(window => window.url()))}`);
      }
      await launched.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) {
          // 개발 모드로 띄운 앱은 DevTools를 연다. 영상에 나오면 안 된다.
          window.webContents.closeDevTools();
          // 창 위에 놓인 실제 마우스가 화면을 건드리지 않게 한다. CDP로 보내는
          // 조작은 OS 히트 테스트를 거치지 않아 그대로 들어간다.
          window.setIgnoreMouseEvents(true);
        }
      }).catch(() => {});
    } else {
      // headless라 실제 마우스가 닿지 않는다. 덱 촬영과 같은 렌더 경로다.
      const browser = await chromium.launch({ headless: true, args: ["--enable-gpu", "--use-gl=angle", "--use-angle=metal"] });
      cleanups.push(() => browser.close());
      const context = await browser.newContext({
        viewport: { width: scenario.viewport.width, height: scenario.viewport.height },
        deviceScaleFactor: scenario.viewport.scale,
      });
      page = await context.newPage();
      page.on("console", message => consoleLines.push(message.text()));
      await page.goto(app.url, { waitUntil: "domcontentloaded", timeout: app.ready.timeoutMs });
    }

    if (app.ready.selector) {
      await page.waitForSelector(app.ready.selector, { state: "visible", timeout: app.ready.timeoutMs });
    }
    if (app.ready.console) {
      const deadline = Date.now() + app.ready.timeoutMs;
      while (!consoleLines.some(line => line.includes(app.ready.console))) {
        if (Date.now() > deadline) throw new Error(`앱 준비 신호를 기다리다 시간이 지났습니다: "${app.ready.console}"`);
        await sleep(200);
      }
    }

    // 창으로는 1920×1080을 만들 수 없다(내장 화면 작업 영역에 막힌다). 에뮬레이션으로
    // CSS 크기와 배율을 주면 스크린캐스트가 정확히 그 크기의 PNG를 준다.
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: scenario.viewport.width, height: scenario.viewport.height,
      deviceScaleFactor: scenario.viewport.scale, mobile: false,
    });
    await installCursorOverlay(page);
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    await sleep(600);
    return { page, session, consoleLines, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function boxOf(locator, target, timeoutMs) {
  await locator.first().waitFor({ state: "visible", timeout: timeoutMs });
  const box = await locator.first().boundingBox();
  if (!box) throw new Error(`대상의 위치를 읽지 못했습니다: ${describeTarget(target)}`);
  return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) };
}

/**
 * 시나리오의 장면을 차례로 실행하며 시각과 좌표를 기록한다.
 *
 * `clock()`은 녹화 시작 기준 경과 ms다. 기록한 시각이 곧 편집 계획의 근거이므로
 * 걸음을 실행하는 쪽과 시계를 읽는 쪽이 같아야 한다.
 */
export async function runScenes(page, scenario, { clock, onEvent = () => {} }) {
  const random = seededRandom(scenario.name);
  let cursor = { x: scenario.viewport.width / 2, y: scenario.viewport.height / 2 };
  await moveCursor(page, cursor.x, cursor.y);

  const glide = async (to, motion) => {
    await glideCursor(page, cursor, to, motion.glideMs);
    cursor = to;
  };

  const scenes = [];
  for (const scene of scenario.scenes) {
    const motion = sceneMotion(scene.timeScale);
    const startMs = clock();
    const steps = [];
    onEvent({ phase: "scene", scene: scene.id });
    for (const step of scene.steps) {
      const at = clock();
      const record = { verb: step.verb, startMs: at, endMs: at };
      try {
        if (step.verb === "pause") {
          await sleep(step.ms);
        } else if (step.verb === "press") {
          await page.keyboard.press(step.key);
        } else if (step.verb === "waitFor") {
          await locate(page, step.target).first().waitFor({ state: "visible", timeout: step.timeoutMs });
        } else if (step.verb === "waitGone") {
          await locate(page, step.target).first().waitFor({ state: "hidden", timeout: step.timeoutMs });
        } else {
          const locator = locate(page, step.target);
          const box = await boxOf(locator, step.target, step.timeoutMs);
          const point = { x: box.x + Math.round(box.w / 2), y: box.y + Math.round(box.h / 2) };
          record.box = box;
          record.point = point;
          await glide(point, motion);
          if (step.verb === "hover") {
            await sleep(motion.hoverMs);
          } else if (step.verb === "scroll") {
            // 한 번에 굴리면 화면이 튄다. 나눠서 굴린다.
            for (let done = 0; done < Math.abs(step.delta); done += 120) {
              await page.mouse.wheel(0, Math.sign(step.delta) * Math.min(120, Math.abs(step.delta) - done));
              await sleep(motion.scrollStepMs);
            }
          } else {
            await page.mouse.down();
            await showTap(page, motion.tapMs);
            await sleep(motion.clickHoldMs + Math.round(random() * motion.clickJitterMs));
            await page.mouse.up();
            if (step.verb === "type") {
              await sleep(motion.typeLeadMs);
              for (const char of step.text) {
                await page.keyboard.type(char);
                await sleep(motion.typeDelayMs.min + random() * (motion.typeDelayMs.max - motion.typeDelayMs.min));
              }
            }
          }
        }
      } catch (error) {
        const where = step.target ? ` (${describeTarget(step.target)})` : "";
        throw new Error(`장면 ${scene.id}의 ${step.verb}${where}에서 멈췄습니다: ${error.message}`, { cause: error });
      }
      record.endMs = clock();
      steps.push(record);
    }
    // 장면이 끝난 화면의 글. 대본 초안의 근거이며 대본 자체는 여기서 만들지 않는다.
    const screenText = await page.locator(scene.textFrom).first().innerText({ timeout: 2000 })
      .then(text => text.replace(/\n{3,}/g, "\n\n").trim())
      .catch(() => null);
    scenes.push({ id: scene.id, startMs, endMs: clock(), timeScale: scene.timeScale, steps, screenText });
  }
  return scenes;
}
