import path from "node:path";
import { RENDERER_DIR } from "./paths.mjs";

// 무엇이 녹화되는지 보이게 한다. 녹화할 화면을 빨간 테두리로 감싸 세고, 녹화하는 동안
// 테두리를 그대로 둔다. 정지·취소를 누르면 걷는다. 테두리가 있으면 녹화 중, 없으면 끝이다.
// 앱 안에서는 그 화면을 미리보기로 비춘다.
//
// 테두리는 녹화에 찍힌다. ffmpeg avfoundation은 화면에 그려진 창을 모두 담고, 공유
// 제외(setContentProtection)를 켠 창도 녹화 가장자리에 그대로 찍혔다(2026-09-21 실측,
// macOS 26.7, 내장 화면·DELL 모두). 그래서 테두리는 가장자리 몇 픽셀에만 그리고, 녹화는
// 그보다 조금 넓게 바로 안쪽 픽셀로 채운다(record-display.mjs의 edgeFill). 크기·규격은 그대로다.
// 세는 동안 뜨는 가운데 숫자는 가장자리가 아니므로 녹화 전에 테두리만 남기고 지운다.
//
// Electron 객체는 실행 진입점에서 주입된다. 없으면(테스트) 테두리·미리보기 없이 세기만 한다.

export const COUNTDOWN_SECONDS = 3;
// 테두리 두께(포인트). 녹화가 가려야 할 폭은 여기에 화면 배율을 곱한 픽셀이다.
export const FRAME_BORDER_CSS = 3;
// 미리보기는 무엇이 찍히는지 보이면 된다. 한 장 뜨는 데 100ms쯤 들고(2026-09-21 측정)
// 녹화 인코딩과 같은 기계를 나눠 쓰므로 1초에 한 장만 뜬다. 그래도 녹화가 프레임을
// 복제·누락하기 시작하면 미리보기를 멈춘다. 같은 날 내장 화면(3456×2234)에 화면 전체가
// 움직이는 창을 띄워 12초씩 잰 두 번 중 한 번은 미리보기 쪽에만 복제 31장이 나왔고
// 한 번은 둘 다 0이었다. 원인을 가르지 못했으므로 녹화 품질 쪽을 지킨다.
export const PREVIEW_INTERVAL_MS = 1000;
const PREVIEW_SIZE = { width: 640, height: 400 };
// 가운데 숫자를 지운 뒤 창 서버가 화면에 반영할 틈. 작업자가 화면을 다시 찾는 데
// 1초 가까이 더 들어 실제 첫 프레임까지는 이보다 넉넉하다.
const CLEAR_MS = 250;
const TICK_MS = 100;
const ENDED = new Set(["record-finishing", "record-complete", "record-failed", "cancelling"]);
const COUNTDOWN_PAGE = path.join(RENDERER_DIR, "record-countdown.html");
// 녹화 중의 빨강(--danger)과 같은 뜻이다. 테마와 무관하게 어느 바탕 위에서도 보이게 고정한다.
const FRAME_COLOR = "#ff453a";
const BADGE_SIZE = { width: 620, height: 200 };

/** 화면 테두리를 이루는 네 막대(위·아래·왼쪽·오른쪽). 모서리는 위·아래 막대가 덮는다. */
export function edgeBounds({ x, y, width, height }, thickness) {
  return [
    { x, y, width, height: thickness },
    { x, y: y + height - thickness, width, height: thickness },
    { x, y: y + thickness, width: thickness, height: height - 2 * thickness },
    { x: x + width - thickness, y: y + thickness, width: thickness, height: height - 2 * thickness },
  ];
}

const centered = ({ x, y, width, height }, size) => ({
  x: Math.round(x + (width - size.width) / 2), y: Math.round(y + (height - size.height) / 2), ...size,
});

const pixelSize = display => ({
  width: Math.round(display.size.width * display.scaleFactor),
  height: Math.round(display.size.height * display.scaleFactor),
});

/**
 * avfoundation의 "Capture screen N"을 Electron 화면으로 옮긴다.
 *
 * N은 CGGetActiveDisplayList 순서이고 Electron 목록도 같은 순서다(주 화면이 먼저).
 * 순서만 믿지 않고 원본 크기로 한 번 더 맞춘다. 어긋나면 크기가 같은 화면이 하나뿐일
 * 때만 그 화면으로 본다. 그래도 모르면 null이다 — 엉뚱한 화면을 감싸느니 감싸지 않는다.
 */
export function matchDisplay(name, size, displays = []) {
  const index = /^Capture screen (\d+)$/.exec(String(name || ""))?.[1];
  const fits = display => {
    const pixels = pixelSize(display);
    return pixels.width === size?.width && pixels.height === size?.height;
  };
  const byOrder = index === undefined ? null : displays[Number(index)] || null;
  if (byOrder && (!size || fits(byOrder))) return byOrder;
  const bySize = size ? displays.filter(fits) : [];
  return bySize.length === 1 ? bySize[0] : null;
}

export function createRecordMonitorService({
  BrowserWindow = null,
  screen = null,
  desktopCapturer = null,
  emit,
  state,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  setInterval = globalThis.setInterval,
  clearInterval = globalThis.clearInterval,
}) {
  // 녹화 중인 Electron 화면과 그 테두리 창. 세기에서 정하고 정지·취소·끝에서 걷는다.
  let target = null;
  let frame = null;
  let previewTimer = null;

  function electronDisplay(name, size) {
    try { return screen ? matchDisplay(name, size, screen.getAllDisplays()) : null; }
    catch { return null; }
  }

  // "Capture screen 1"로는 어느 모니터인지 모른다. 고르는 목록에 모니터 이름을 붙인다.
  function describe(displays = []) {
    return displays.map(display => {
      const found = display.error ? null : electronDisplay(display.name, display);
      return found?.label ? { ...display, label: found.label } : display;
    });
  }

  // 클릭을 받지 않고 초점도 뺏지 않는다. panel은 전체 화면 앱 위에도, 모든 데스크톱에도 뜬다.
  function overlay(bounds, options = {}) {
    const panel = new BrowserWindow({
      ...bounds, type: "panel", show: false, frame: false, hasShadow: false, roundedCorners: false,
      focusable: false, resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, enableLargerThanScreen: true, ...options,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    panel.setIgnoreMouseEvents(true);
    panel.setAlwaysOnTop(true, "screen-saver");
    return panel;
  }

  // 만들 때 준 크기는 메뉴 막대 아래로 밀릴 수 있다. 띄우기 직전에 한 번 더 맞춘다.
  function place(panel, bounds) {
    panel.setBounds(bounds);
    panel.showInactive();
  }

  // 테두리는 가장자리 네 개의 불투명 막대다. 페이지를 싣지 않고 창 바탕색만 쓴다.
  // 가운데 숫자는 세는 동안만 뜨는 작은 창이다. 녹화 중에 남는 것은 막대뿐이라 창 서버가
  // 가장자리 몇 픽셀만 합성하면 된다.
  async function showFrame(display, seconds) {
    if (!BrowserWindow || !display) return null;
    const shown = { edges: [], badge: null };
    try {
      for (const bounds of edgeBounds(display.bounds, FRAME_BORDER_CSS)) {
        const edge = overlay(bounds, { backgroundColor: FRAME_COLOR });
        shown.edges.push(edge);
        place(edge, bounds);
      }
      const badgeBounds = centered(display.bounds, BADGE_SIZE);
      shown.badge = overlay(badgeBounds, { transparent: true });
      await shown.badge.loadFile(COUNTDOWN_PAGE, { query: { seconds: String(seconds), label: display.label || "" } });
      place(shown.badge, badgeBounds);
      return shown;
    } catch {
      closeWindows(shown);
      return null;
    }
  }

  function closeWindows({ edges = [], badge = null } = {}) {
    for (const panel of [...edges, badge]) if (panel && !panel.isDestroyed()) panel.destroy();
  }

  function closeFrame() {
    if (frame) closeWindows(frame);
    frame = null;
  }

  /**
   * 녹화 직전에 센다. 녹화할 화면을 눈으로 확인하고 그 화면으로 옮겨 갈 틈이다.
   * 다 세면 가운데 숫자를 걷고 테두리만 남긴다. 취소하면 곧바로 멈추고 테두리를 걷는다.
   *
   * ready는 녹화를 시작해도 되는지, edgeMask는 녹화가 채워야 할 가장자리 폭(픽셀)이다.
   * 테두리를 띄우지 못했으면 0이다 — 채울 것이 없는데 화면 가장자리를 지우지 않는다.
   */
  async function countdown(job, { display, size = null } = {}, seconds = COUNTDOWN_SECONDS) {
    closeFrame();
    target = electronDisplay(display, size);
    frame = await showFrame(target, seconds);
    const shown = () => Boolean(frame);
    for (let remaining = seconds; remaining > 0 && !job.cancelled; remaining--) {
      emit({ type: "record-countdown", remaining, label: target?.label || null, framed: shown() });
      for (let tick = 0; tick < 1000 / TICK_MS && !job.cancelled; tick++) await wait(TICK_MS);
    }
    if (job.cancelled) {
      closeFrame();
      return { ready: false, edgeMask: 0 };
    }
    if (frame) {
      // 숫자는 가장자리가 아니라 녹화에서 지울 수 없다. 녹화 전에 걷는다.
      closeWindows({ badge: frame.badge });
      frame.badge = null;
      await wait(CLEAR_MS);
    }
    // 0은 다 셌다는 뜻이다. 작업자가 화면을 다시 찾는 동안 화면은 '시작하는 중'을 보인다.
    emit({ type: "record-countdown", remaining: 0, label: target?.label || null, framed: shown() });
    return { ready: true, edgeMask: frame ? Math.ceil(FRAME_BORDER_CSS * target.scaleFactor) : 0 };
  }

  // 앱 창이 녹화하는 화면 위에 있으면 창도 함께 찍힌다. 미리보기가 그 사실을 알린다.
  function appOnTarget(display) {
    const window = state.mainWindow;
    if (!screen || !window || window.isDestroyed() || !window.isVisible() || window.isMinimized()) return false;
    return screen.getDisplayMatching(window.getBounds()).id === display.id;
  }

  function stopPreview() {
    if (previewTimer !== null) clearInterval(previewTimer);
    previewTimer = null;
  }

  function startPreview() {
    stopPreview();
    const display = target;
    if (!desktopCapturer || !display) return;
    let busy = false;
    const shoot = async () => {
      if (busy) return;
      busy = true;
      try {
        const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: PREVIEW_SIZE });
        const source = sources.find(item => item.display_id === String(display.id));
        if (!source || source.thumbnail.isEmpty() || previewTimer === null || target !== display) return;
        emit({
          type: "record-preview",
          image: `data:image/jpeg;base64,${source.thumbnail.toJPEG(72).toString("base64")}`,
          mirrored: appOnTarget(display),
        });
      } catch {
        // 미리보기를 못 떠도 녹화는 계속된다. 다음 번에 다시 뜬다.
      } finally {
        busy = false;
      }
    };
    previewTimer = setInterval(shoot, PREVIEW_INTERVAL_MS);
    void shoot();
  }

  // 녹화 사건을 따라 미리보기를 켜고 끈다. 사건은 모두 emit 한 길목을 지난다.
  function watch(event) {
    if (event.type === "record-phase" && event.phase === "recording") startPreview();
    else if (ENDED.has(event.type) || (event.type === "record-phase" && event.phase === "finishing")) {
      // 정지·취소를 누른 순간 테두리를 걷는다. 녹화가 스스로 끝나거나 실패해도 같다.
      stopPreview();
      closeFrame();
    }
    else if (event.type === "record-phase" && event.phase === "progress" && (event.dup || event.drop) && previewTimer !== null) {
      stopPreview();
      emit({ type: "record-preview-paused" });
    }
    if (event.type === "record-complete" || event.type === "record-failed") target = null;
  }

  function stop() {
    stopPreview();
    closeFrame();
  }

  return { describe, countdown, watch, stop };
}
