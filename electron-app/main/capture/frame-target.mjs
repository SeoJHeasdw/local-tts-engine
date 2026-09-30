// Playwright가 프레임으로 잡지 못하는 문서 안의 대상을 DOM으로 찾는다.
//
// VSCode 계열 앱의 webview는 다른 프로세스 iframe(index.html) 안에 같은 출처 iframe
// (active-frame)을 두는데, CDP 연결에서는 바깥만 프레임으로 보이고 안쪽은 빠진다
// (2026-09-30 IBM Bob 측정: contentFrame()이 null). 그래서 첫 iframe은 Playwright로
// 들어가고, 그 안쪽은 contentDocument로 따라가며 좌표를 더한다. 조작은 호출한 쪽이
// 이 좌표에 실제 마우스·키보드 사건으로 보낸다.
//
// locator와 같은 약속을 지킨다: 일치가 하나일 때만 누르고, 보이고·안정되고·활성이고·
// 가려지지 않았을 때만 누른다.
import { demoDelay as sleep } from "./demo-runtime.mjs";

const POLL_MS = 150;

// 페이지 밖에서 실행되는 함수다. 바깥 변수를 쓰지 않는다.
function probeInFrame({ hops, target }) {
  const clean = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const visible = el => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : true;
  };
  const describe = el => `<${el.tagName.toLowerCase()}> "${clean(el.getAttribute("aria-label") || el.innerText).slice(0, 40)}"`;
  let doc = document, x = 0, y = 0;
  for (const selector of hops) {
    const frames = [...doc.querySelectorAll(selector)].filter(visible);
    if (frames.length !== 1) return { error: `iframe "${selector}"이(가) ${frames.length}개와 일치합니다.` };
    const rect = frames[0].getBoundingClientRect();
    x += rect.left + frames[0].clientLeft;
    y += rect.top + frames[0].clientTop;
    doc = frames[0].contentDocument;
    if (!doc) return { error: `iframe "${selector}" 안으로 들어갈 수 없습니다(다른 출처).` };
  }
  const ROLES = {
    button: 'button,[role="button"],input[type="button"],input[type="submit"]',
    link: 'a[href],[role="link"]',
    textbox: 'textarea,input:not([type]),input[type="text"],input[type="search"],[contenteditable="true"],[role="textbox"]',
    option: 'option,[role="option"]',
    menuitem: '[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"]',
    checkbox: 'input[type="checkbox"],[role="checkbox"]',
    tab: '[role="tab"]',
  };
  const named = el => clean(el.getAttribute("aria-label")
    || (el.getAttribute("aria-labelledby") || "").split(/\s+/).map(id => doc.getElementById(id)?.innerText || "").join(" ")
    || el.innerText || el.value || el.getAttribute("title") || el.getAttribute("placeholder"));
  const matches = (value, wanted, exact) => exact
    ? clean(value) === clean(wanted)
    : clean(value).toLowerCase().includes(clean(wanted).toLowerCase());
  let found;
  if (target.kind === "selector") {
    found = [...doc.querySelectorAll(target.selector)];
  } else if (target.kind === "role") {
    found = [...doc.querySelectorAll(ROLES[target.role] || `[role="${target.role}"]`)]
      .filter(el => target.name === null || matches(named(el), target.name, target.exact));
  } else if (target.kind === "placeholder") {
    found = [...doc.querySelectorAll("[placeholder],[data-placeholder],[aria-placeholder]")]
      .filter(el => matches(el.getAttribute("placeholder") ?? el.getAttribute("data-placeholder")
        ?? el.getAttribute("aria-placeholder"), target.value, target.exact));
  } else {
    // getByText처럼 글을 가진 가장 안쪽 요소를 고른다.
    const hits = [...doc.body.querySelectorAll("*")].filter(el => matches(el.innerText, target.value, target.exact));
    found = hits.filter(el => !hits.some(other => other !== el && el.contains(other)));
  }
  found = found.filter(visible);
  if (found.length !== 1) return { count: found.length, candidates: found.slice(0, 3).map(describe) };
  const el = found[0];
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  const hit = doc.elementFromPoint(cx, cy);
  const active = doc.activeElement;
  return {
    count: 1,
    box: { x: x + rect.left, y: y + rect.top, w: rect.width, h: rect.height },
    text: el.innerText,
    disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
    covered: !(hit && (hit === el || el.contains(hit))),
    editable: el.isContentEditable || (["TEXTAREA", "INPUT"].includes(el.tagName) && !el.readOnly),
    focused: !!active && (active === el || el.contains(active)),
  };
}

/** 대상을 한 번 찾아 본다. 페이지 좌표(CSS px)의 상자와 상태를 돌려준다. */
export async function probeFrameTarget(page, target) {
  const [outer, ...hops] = target.frame;
  const frames = page.locator(outer);
  const count = await frames.count();
  if (count !== 1) return { error: `iframe "${outer}"이(가) ${count}개와 일치합니다.` };
  const handle = await frames.elementHandle();
  try {
    const frame = await handle.contentFrame();
    if (!frame) return { error: `iframe "${outer}"의 문서를 열지 못했습니다.` };
    const [left, top] = await handle.evaluate(el => {
      const rect = el.getBoundingClientRect();
      return [rect.left + el.clientLeft, rect.top + el.clientTop];
    });
    const probe = await frame.evaluate(probeInFrame, { hops, target });
    if (probe.box) probe.box = { ...probe.box, x: probe.box.x + left, y: probe.box.y + top };
    return probe;
  } finally { await handle.dispose(); }
}

const sameBox = (a, b) => a && b && ["x", "y", "w", "h"].every(key => Math.abs(a[key] - b[key]) < 1);

/**
 * 대상이 원하는 상태가 될 때까지 기다린다.
 *
 * `visible` 하나가 보인다, `hidden` 하나도 없다, `stable` 보이고 150ms 동안 제자리,
 * `actionable` 안정·활성·가려지지 않음. 여럿과 일치하면 기다리지 않고 바로 멈춘다 —
 * 첫 번째를 임의로 고르지 않는다.
 */
export async function waitFrameTarget(page, target, { state, timeoutMs, signal }) {
  const deadline = Date.now() + timeoutMs;
  let last = null, previous = null;
  for (;;) {
    signal?.throwIfAborted();
    last = await probeFrameTarget(page, target).catch(error => ({ error: error.message }));
    if (last.count > 1) {
      throw new Error(`대상이 ${last.count}개와 일치합니다(${last.candidates.join(", ")}). 첫 번째를 임의로 누르지 않습니다.`);
    }
    if (state === "hidden") {
      if (last.count === 0) return last;
    } else if (last.count === 1) {
      const ready = state === "visible"
        || (sameBox(previous?.box, last.box) && (state === "stable" || (!last.disabled && !last.covered)));
      if (ready) return last;
    }
    previous = last;
    if (Date.now() > deadline) {
      const why = last.error || (last.count === 1
        ? (last.disabled ? "비활성" : last.covered ? "다른 요소에 가려짐" : "움직이는 중")
        : `일치 ${last.count ?? 0}개`);
      throw new Error(`${timeoutMs}ms 안에 대상이 ${state} 상태가 되지 않았습니다(${why}).`);
    }
    await sleep(POLL_MS, signal);
  }
}
