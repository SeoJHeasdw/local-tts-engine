// 강의 덱 화면을 촬영용으로 다루는 계약. 덱이 소유한 약속(`.stage`,
// `[data-capture-slide]`, `udemy-deck-sync` 채널, 이동 키)을 아는 유일한 파일이다.
// 다른 화면(응용 프로그램 창·디스플레이)을 찍게 되면 이 파일의 형제를 만들고
// recorder·encoding·보고서는 그대로 쓴다.
import { captionOverlayCss } from "./caption-style.mjs";

const NAV_TIMEOUT_MS = 5000;
const FIRST_RENDER_TIMEOUT_MS = 30000;
const TRANSITION_RENDER_TIMEOUT_MS = 1000;
const WORLD_CANVAS_SELECTOR = ".ow canvas, .wk canvas, .cs canvas, .pw canvas";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function installCaptionOverlay(page, profile) {
  await page.evaluate(({ css }) => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    const overlay = document.createElement("div");
    overlay.id = "narration-caption-overlay";
    overlay.setAttribute("aria-hidden", "true");
    overlay.dataset.visible = "false";
    const layer = document.createElement("div");
    layer.id = "narration-caption-stage";
    layer.appendChild(overlay);
    document.body.appendChild(layer);

    window.__startNarrationCaptions = (cues) => {
      const startedAt = performance.now();
      let cueIndex = 0;
      let previousText = null;

      const render = () => {
        const elapsedMs = performance.now() - startedAt;
        while (cueIndex < cues.length && elapsedMs >= cues[cueIndex].endMs) cueIndex++;
        const cue = cues[cueIndex];
        const text = cue && elapsedMs >= cue.startMs && elapsedMs < cue.endMs
          ? cue.text
          : "";
        if (text !== previousText) {
          overlay.textContent = text;
          overlay.dataset.visible = text ? "true" : "false";
          previousText = text;
        }
        if (cueIndex < cues.length) requestAnimationFrame(render);
      };
      requestAnimationFrame(render);
    };
  }, { css: captionOverlayCss(profile.width, profile.height) });
}

// This reports source limits, not a visual approval. CSS crops/object-fit can make
// a low-resolution warning conservative; keep actual and rendered sizes as evidence.
export async function auditCapturePage(page, profile) {
  await assertDeckPageHealthy(page);
  await page.waitForFunction(({ width, height }) => {
    const box = document.querySelector('.stage')?.getBoundingClientRect();
    return box && Math.abs(box.width - width) < 2 && Math.abs(box.height - height) < 2
      && Math.abs(box.left) < 2 && Math.abs(box.top) < 2;
  }, profile, { timeout: 5000 });
  const limits = await page.evaluate(() => {
    const limits = [];
    for (const element of document.querySelectorAll('.stage img, .stage video, .stage canvas')) {
      const box = element.getBoundingClientRect();
      if (!box.width || !box.height || box.right <= 0 || box.bottom <= 0 || box.left >= innerWidth || box.top >= innerHeight) continue;
      const width = element.naturalWidth || element.videoWidth || (element.tagName === 'CANVAS' ? element.width : 0);
      const height = element.naturalHeight || element.videoHeight || (element.tagName === 'CANVAS' ? element.height : 0);
      if (width < box.width * .95 || height < box.height * .95) limits.push({
        type: element.tagName.toLowerCase(), source: element.getAttribute('src') || null,
        sourceWidth: width, sourceHeight: height,
        renderedWidth: Math.round(box.width), renderedHeight: Math.round(box.height),
      });
    }
    return limits;
  });
  await assertDeckPageHealthy(page);
  return limits;
}

export async function assertDeckPageHealthy(page) {
  const failure = await page.evaluate(() => window.__narrationDeckFailure ?? null);
  if (failure) throw new Error(`3D 촬영 화면 실패: ${failure}`);
}

// React의 fallback은 그림 대신 정상 페이지처럼 보일 수 있다. 첫 draw 전에는
// 촬영을 시작하지 않고, 촬영 중에는 실패를 인코더에 즉시 전파한다.
async function monitorDeckRendering(page, onCaptureFailure) {
  if (onCaptureFailure) {
    await page.exposeFunction("__narrationReportRenderFailure", (message) => {
      onCaptureFailure(new Error(`3D 촬영 화면 실패: ${message}`));
    });
  }
  await page.evaluate(() => {
    window.__narrationDeckFailure = null;
    window.__narrationFrameBaselines = new WeakMap();
    const activeSlide = () => document.querySelector(".stage [data-capture-slide]");
    const fail = (message) => {
      if (window.__narrationDeckFailure) return;
      window.__narrationDeckFailure = message;
      window.__narrationReportRenderFailure?.(message).catch?.(() => {});
    };
    const inspectFallback = () => {
      const slide = activeSlide();
      const fallback = [...(slide?.querySelectorAll("[data-fallback]") ?? [])]
        .find((element) => element.getAttribute("data-fallback") !== "false");
      if (fallback) fail(`${slide.getAttribute("data-capture-slide")}: 3D 대체 화면이 표시됐습니다.`);
    };
    const stage = document.querySelector(".stage");
    const observer = new MutationObserver(inspectFallback);
    observer.observe(stage, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-fallback"] });
    document.addEventListener("webglcontextlost", (event) => {
      const canvas = event.target;
      // 장을 떠날 때 렌더러가 일부러 해제한 컨텍스트는 촬영 오류가 아니다.
      setTimeout(() => {
        if (canvas?.isConnected && activeSlide()?.contains(canvas)) {
          fail(`${activeSlide().getAttribute("data-capture-slide")}: WebGL 컨텍스트가 소실됐습니다.`);
        }
      }, 0);
    }, true);
    inspectFallback();
  });
}

async function rememberFrameSources(page) {
  await page.evaluate((selector) => {
    const slide = document.querySelector(".stage [data-capture-slide]");
    window.__narrationPreviousCanvases = new WeakSet(slide?.querySelectorAll(selector) ?? []);
  }, WORLD_CANVAS_SELECTOR);
}

async function armFrameCheck(page) {
  await page.evaluate((selector) => {
    const slide = document.querySelector(".stage [data-capture-slide]");
    window.__narrationFrameBaselines = new WeakMap(
      [...(slide?.querySelectorAll(selector) ?? [])].map((canvas) => [
        canvas,
        window.__narrationPreviousCanvases?.has(canvas) ? Number(canvas.dataset.frames) || 0 : null,
      ]),
    );
  }, WORLD_CANVAS_SELECTOR);
}

async function waitForRenderedEntry(page, entry, { first = false, requireFresh = !first } = {}) {
  const timeout = first ? FIRST_RENDER_TIMEOUT_MS : TRANSITION_RENDER_TIMEOUT_MS;
  try {
    await page.waitForFunction(({ slideId, requireFresh, selector }) => {
      if (window.__narrationDeckFailure) return true;
      const slide = [...document.querySelectorAll(".stage [data-capture-slide]")]
        .find((element) => element.getAttribute("data-capture-slide") === slideId);
      if (!slide) return false;
      const canvases = [...slide.querySelectorAll(selector)];
      return canvases.every((canvas) => {
        const frames = Number(canvas.dataset.frames);
        const baseline = window.__narrationFrameBaselines?.get(canvas);
        return canvas.dataset.ready === "true" && Number.isFinite(frames) && frames > 0
          && (!requireFresh || baseline === null || baseline === undefined || frames > baseline);
      });
    }, { slideId: entry.slideId, requireFresh, selector: WORLD_CANVAS_SELECTOR }, { timeout });
  } catch (error) {
    await assertDeckPageHealthy(page);
    throw new Error(
      `${entry.key}: 3D 첫 프레임을 ${timeout}ms 안에 확인하지 못했습니다. 빈 화면이나 늦은 장면을 촬영하지 않습니다.`,
      { cause: error },
    );
  }
  await assertDeckPageHealthy(page);
}

// 촬영 화면을 조작할 수 있는 상태로 만든다. 자막 오버레이는 제작 UI와 별개라
// 여기서 지우는 대상이 아니다.
export async function prepareDeckPage(page, profile, { burnCaptions = false, onCaptureFailure = null } = {}) {
  await page.waitForSelector(".stage", { state: "visible" });
  await monitorDeckRendering(page, onCaptureFailure);
  // H 키 상태만 믿으면 첫 장표로 번호 이동하는 동안 HUD가 잠깐 다시 찍힐
  // 수 있다. 녹화 페이지에서는 제작 UI가 존재할 이유가 없으므로 CSS로도
  // 강제 제외한다. goto는 번호 입력 중 뜨는 이동 오버레이다.
  await page.addStyleTag({ content: ".hud, .goto { display: none !important; }" });
  if (burnCaptions) await installCaptionOverlay(page, profile);
  await page.evaluate(() => {
    window.__narrationNav = null;
    const channel = new BroadcastChannel("udemy-deck-sync");
    channel.onmessage = (event) => {
      if (event.data?.type === "nav" && event.data?.deck === "course") {
        window.__narrationNav = event.data.nav;
      }
    };
    window.__narrationChannel = channel;
    channel.postMessage({ type: "hello", deck: "course", from: "narration-capture" });
  });
  await page.waitForFunction(() => window.__narrationNav !== null);
  await assertDeckPageHealthy(page);
}

export function startCaptions(page, captions) {
  return page.evaluate((items) => window.__startNarrationCaptions(items), captions);
}

async function waitForEntry(page, entry) {
  await page.waitForFunction(
    ({ index, step, slideId }) => window.__narrationDeckFailure
      || (window.__narrationNav?.index === index && window.__narrationNav?.step === step
        && [...document.querySelectorAll("[data-capture-slide]")].some((el) => el.getAttribute("data-capture-slide") === slideId)),
    { index: entry.slideNumber - 1, step: entry.step, slideId: entry.slideId },
    { timeout: NAV_TIMEOUT_MS },
  );
  await assertDeckPageHealthy(page);
}

// 초기 상태가 우연히 첫 항목과 같아도 반드시 번호 이동을 수행한다. 첫 장에서
// 이동을 생략하면 React 초기 렌더와 녹화 시작 시점이 경합하고, 첫 장만 빠진 채
// 두 번째 장부터 시작하는 결과가 생길 수 있다.
export async function gotoFirstEntry(page, entry) {
  const previous = await page.evaluate(() => window.__narrationNav);
  const changed = previous?.index !== entry.slideNumber - 1 || previous?.step !== entry.step;
  await rememberFrameSources(page);
  await page.keyboard.press("h");
  for (const digit of String(entry.slideNumber)) await page.keyboard.press(digit);
  await page.keyboard.press("Enter");
  for (let step = 0; step < entry.step; step++) await page.keyboard.press("ArrowRight");
  await waitForEntry(page, entry);
  if (changed) await armFrameCheck(page);
  await page.evaluate(() => document.fonts.ready);
  await waitForRenderedEntry(page, entry, { first: true, requireFresh: changed });
  await sleep(500);
  await assertDeckPageHealthy(page);
}

// 녹화 시작점에서 첫 큐를 다시 재생한다. r은 runKey를 올려 3D 무대를
// 새로 만들기 때문에, 이전 무대의 준비 표시를 재사용해서는 안 된다.
export async function replayFirstEntry(page, entry) {
  const startedAt = performance.now();
  const previous = await page.evaluate(() => window.__narrationNav);
  if (previous?.index !== entry.slideNumber - 1 || previous?.step !== entry.step) {
    throw new Error(`${entry.key}: 첫 장면 재생 전에 촬영 위치가 달라졌습니다.`);
  }
  await rememberFrameSources(page);
  await page.keyboard.press("r");
  await page.waitForFunction(
    ({ index, runKey }) => window.__narrationDeckFailure
      || (window.__narrationNav?.index === index && window.__narrationNav?.step === 0
        && window.__narrationNav?.runKey > runKey),
    { index: entry.slideNumber - 1, runKey: previous.runKey },
    { timeout: NAV_TIMEOUT_MS },
  );
  await assertDeckPageHealthy(page);
  for (let step = 0; step < entry.step; step++) await page.keyboard.press("ArrowRight");
  await waitForEntry(page, entry);
  await armFrameCheck(page);
  await waitForRenderedEntry(page, entry);
  return Math.round(performance.now() - startedAt);
}

export async function advanceToEntry(page, entry, next) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await assertDeckPageHealthy(page);
    await rememberFrameSources(page);
    if (next.chapter !== entry.chapter) {
      for (const digit of String(next.slideNumber)) await page.keyboard.press(digit);
      await page.keyboard.press("Enter");
    } else {
      await page.keyboard.press("ArrowRight");
    }
    try {
      await waitForEntry(page, next);
    } catch (error) {
      await assertDeckPageHealthy(page);
      const actual = await page.evaluate(() => window.__narrationNav);
      const stillCurrent = actual?.index === entry.slideNumber - 1 && actual?.step === entry.step;
      if (!stillCurrent || attempt === 2) {
        throw new Error(
          `화면 전환 실패: ${entry.key} -> ${next.key}, ` +
          `expected=${JSON.stringify({ index: next.slideNumber - 1, step: next.step })}, ` +
          `actual=${JSON.stringify(actual ?? null)}`,
          { cause: error },
        );
      }
      continue;
    }
    await armFrameCheck(page);
    await waitForRenderedEntry(page, next);
    return;
  }
}
