// 실제 app.js를 브라우저 없이 불러오기 위한 가짜 화면. 선택자마다 요소 하나를 만들어 두고
// 같은 선택자는 같은 요소를 돌려준다. 사이드바 메뉴만 querySelectorAll로 돌려준다 — 실행
// 중 표시를 메뉴에서 읽기 위해서다. 전역은 검사가 끝나면 되돌린다.
export function installRendererGlobals(t, { api, navViews = ['new', 'review'] }) {
  const elements = new Map();
  const listeners = new Map();
  const timers = [];
  const element = () => {
    const classes = new Set();
    return {
      value: '', textContent: '', innerHTML: '', dataset: {}, style: { setProperty() {} },
      disabled: false, inert: false, children: [], currentTime: 0, duration: 0, scrollTop: 0,
      classList: {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        contains: name => classes.has(name),
        toggle(name, force = !classes.has(name)) { force ? classes.add(name) : classes.delete(name); },
      },
      addEventListener() {},
      attributes: {},
      setAttribute(key, value) { this.attributes[key] = value; },
      getAttribute(key) { return this.attributes[key] ?? null; },
      removeAttribute(key) { delete this.attributes[key]; },
      append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; },
      querySelector: () => element(), querySelectorAll: () => [], closest() { return this; },
      getBoundingClientRect: () => ({ height: 0, width: 0 }), pause() {}, click() {}, remove() {},
    };
  };
  const query = selector => {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  };
  const navItems = navViews.map(view => {
    const item = query(`.nav-item[data-view="${view}"]`);
    item.dataset.view = view;
    return item;
  });
  const globals = {
    window: { ttsStudio: api, scrollTo() {}, location: { search: '' } },
    document: {
      querySelector: query, querySelectorAll: selector => (selector === '.nav-item' ? navItems : []), createElement: element,
      documentElement: element(), body: element(),
      addEventListener: (name, callback) => listeners.set(name, callback),
    },
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    localStorage: { getItem: () => null, setItem() {} },
    setInterval: callback => { timers.push(callback); return 0; },
  };
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  t.after(() => {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { query, listeners, timers };
}
