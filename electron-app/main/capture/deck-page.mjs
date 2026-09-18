// 강의 덱 화면을 촬영용으로 다루는 계약. 덱이 소유한 약속(`.stage`,
// `[data-capture-slide]`, `udemy-deck-sync` 채널, 이동 키)을 아는 유일한 파일이다.
// 다른 화면(응용 프로그램 창·디스플레이)을 찍게 되면 이 파일의 형제를 만들고
// recorder·encoding·보고서는 그대로 쓴다.
const NAV_TIMEOUT_MS = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function installCaptionOverlay(page, profile) {
  await page.evaluate(({ width, height }) => {
    const style = document.createElement("style");
    style.textContent = `
      #narration-caption-stage {
        position: fixed; left: 0; top: 0; width: 1920px; height: 1080px;
        transform: scale(${width / 1920}, ${height / 1080});
        transform-origin: top left; pointer-events: none; z-index: 2147483647;
      }
      #narration-caption-overlay {
        position: absolute;
        z-index: 2147483647;
        left: 50%;
        bottom: 72px;
        width: max-content;
        max-width: 1480px;
        transform: translateX(-50%) translateY(6px);
        box-sizing: border-box;
        padding: 0;
        border: 0;
        background: transparent;
        color: #fff;
        font-family: Pretendard, "Apple SD Gothic Neo", sans-serif;
        font-size: 34px;
        font-weight: 700;
        line-height: 1.42;
        letter-spacing: -0.025em;
        text-align: center;
        white-space: pre-line;
        text-wrap: balance;
        -webkit-text-stroke: 0.45px rgba(0, 0, 0, 0.92);
        text-shadow:
          0 2px 3px rgba(0, 0, 0, 0.96),
          0 0 10px rgba(0, 0, 0, 0.82),
          0 0 22px rgba(0, 0, 0, 0.5);
        opacity: 0;
        transition: opacity 100ms linear, transform 100ms ease-out;
        pointer-events: none;
      }
      #narration-caption-overlay[data-visible="true"] {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
    `;
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
  }, profile);
}

// This reports source limits, not a visual approval. CSS crops/object-fit can make
// a low-resolution warning conservative; keep actual and rendered sizes as evidence.
export async function auditCapturePage(page, profile) {
  await page.waitForFunction(({ width, height }) => {
    const box = document.querySelector('.stage')?.getBoundingClientRect();
    return box && Math.abs(box.width - width) < 2 && Math.abs(box.height - height) < 2
      && Math.abs(box.left) < 2 && Math.abs(box.top) < 2;
  }, profile, { timeout: 5000 });
  return page.evaluate(() => {
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
}

// 촬영 화면을 조작할 수 있는 상태로 만든다. 자막 오버레이는 제작 UI와 별개라
// 여기서 지우는 대상이 아니다.
export async function prepareDeckPage(page, profile, { burnCaptions = false } = {}) {
  await page.waitForSelector(".stage", { state: "visible" });
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
}

export function startCaptions(page, captions) {
  return page.evaluate((items) => window.__startNarrationCaptions(items), captions);
}

function waitForEntry(page, entry) {
  return page.waitForFunction(
    ({ index, step, slideId }) => window.__narrationNav?.index === index && window.__narrationNav?.step === step
      && [...document.querySelectorAll("[data-capture-slide]")].some((el) => el.getAttribute("data-capture-slide") === slideId),
    { index: entry.slideNumber - 1, step: entry.step, slideId: entry.slideId },
    { timeout: NAV_TIMEOUT_MS },
  );
}

// 초기 상태가 우연히 첫 항목과 같아도 반드시 번호 이동을 수행한다. 첫 장에서
// 이동을 생략하면 React 초기 렌더와 녹화 시작 시점이 경합하고, 첫 장만 빠진 채
// 두 번째 장부터 시작하는 결과가 생길 수 있다.
export async function gotoFirstEntry(page, entry) {
  await page.keyboard.press("h");
  for (const digit of String(entry.slideNumber)) await page.keyboard.press(digit);
  await page.keyboard.press("Enter");
  for (let step = 0; step < entry.step; step++) await page.keyboard.press("ArrowRight");
  await waitForEntry(page, entry);
  await page.evaluate(() => document.fonts.ready);
  await sleep(500);
}

export async function advanceToEntry(page, entry, next) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (next.chapter !== entry.chapter) {
      for (const digit of String(next.slideNumber)) await page.keyboard.press(digit);
      await page.keyboard.press("Enter");
    } else {
      await page.keyboard.press("ArrowRight");
    }
    try {
      await waitForEntry(page, next);
      return;
    } catch (error) {
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
    }
  }
}
