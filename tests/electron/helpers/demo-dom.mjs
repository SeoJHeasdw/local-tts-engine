export function fakeDemoDom() {
  const elements = new Map();
  const element = () => {
    const classes = new Set(), handlers = new Map();
    return {
      textContent: '', innerHTML: '', value: '', dataset: {}, style: {}, attributes: {},
      disabled: false, inert: false, checked: false, currentTime: 0, paused: true, muted: false, open: false,
      classList: {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name),
        toggle(name, force = !classes.has(name)) { force ? classes.add(name) : classes.delete(name); },
      },
      addEventListener(type, handler, options = {}) {
        const list = handlers.get(type) || [];
        list.push({ handler, once: options.once }); handlers.set(type, list);
      },
      async fire(type, event = {}) {
        const list = [...(handlers.get(type) || [])];
        handlers.set(type, list.filter(item => !item.once));
        for (const { handler } of list) await handler(event);
      },
      setAttribute(key, value) { this.attributes[key] = value; },
      getAttribute(key) { return this.attributes[key] ?? null; },
      removeAttribute(key) { delete this.attributes[key]; delete this[key]; },
      replaceChildren(...items) { this.children = items; }, append() {}, querySelectorAll: () => [], querySelector: () => null,
      play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; },
      showModal() { this.open = true; }, close() { this.open = false; }, focus() {}, setPointerCapture() {},
      getBoundingClientRect() { return { left: 100, top: 50, width: 640, height: 360 }; },
    };
  };
  const $ = selector => { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); };
  return { $, document: { createElement: element, querySelectorAll: () => [], querySelector: () => null,
    addEventListener() {}, activeElement: null } };
}

export function cameraPreviewData(sceneId = 'loop') {
  return { imageUrl: `data:image/png;base64,${sceneId}`, startMs: 0, endMs: 8000, atMs: 2320, defaultAtMs: 2320,
    fps: 25, maxSpeed: 4, automaticAvailable: true, narration: {}, cameras: {},
    recording: { schemaVersion: 1, viewport: { width: 1920, height: 1080, scale: 2 }, fps: 25, durationMs: 8000,
      scenes: [{ id: sceneId, startMs: 0, endMs: 8000, steps: [
        { verb: 'click', startMs: 2000, endMs: 2600, point: { x: 500, y: 600 } },
      ] }] } };
}
