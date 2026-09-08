// Keep state changes synchronous; only the presentation takes time to settle.
const resizing = new WeakMap();
const activeResizes = new Set();
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let pageTransition;

export function animateLayout(element, update) {
  if (!element) return update();
  const before = element.getBoundingClientRect().height;
  resizing.get(element)?.cancel();
  element.classList.remove("motion-resizing");
  const result = update();
  const after = element.getBoundingClientRect().height;
  if (reducedMotion.matches || !before || !after || Math.abs(after - before) < 1) return result;
  element.classList.add("motion-resizing");
  const animation = element.animate([{ height: `${before}px` }, { height: `${after}px` }], {
    duration: 220, easing: "cubic-bezier(.2,.7,.2,1)",
  });
  resizing.set(element, animation);
  activeResizes.add(animation);
  animation.finished.catch(() => {}).finally(() => {
    activeResizes.delete(animation);
    if (resizing.get(element) !== animation) return;
    resizing.delete(element);
    element.classList.remove("motion-resizing");
  });
  return result;
}

export function transitionPage(update) {
  pageTransition?.skipTransition();
  if (reducedMotion.matches || !document.startViewTransition) return update();
  pageTransition = document.startViewTransition(update);
  // A hidden window or another transition can skip the visual effect.
  pageTransition.ready.catch(() => {});
}

export function dismissToast(toast) {
  if (reducedMotion.matches) return toast.remove();
  const animation = toast.animate([
    { opacity: 1, transform: "translateY(0)" },
    { opacity: 0, transform: "translateY(-4px)" },
  ], { duration: 160, easing: "ease-out" });
  animation.finished.catch(() => {}).finally(() => toast.remove());
}

export function appendFollowingLog(log, text) {
  const following = log.scrollHeight - log.clientHeight - log.scrollTop < 32;
  const previousTop = log.scrollTop;
  log.textContent = `${log.textContent}${text}`.slice(-30000);
  log.scrollTop = following ? log.scrollHeight : previousTop;
}

reducedMotion.addEventListener("change", () => {
  if (!reducedMotion.matches) return;
  pageTransition?.skipTransition();
  for (const animation of activeResizes) animation.finish();
});
