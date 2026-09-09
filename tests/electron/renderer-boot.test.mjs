import test from 'node:test';
import assert from 'node:assert/strict';

test('실제 화면 모듈을 함께 불러와 초기화하고 공통 이벤트까지 연결한다', async t => {
  const elements = new Map();
  const listeners = new Map();
  const element = () => {
    const classes = new Set();
    return {
      value: '', textContent: '', innerHTML: '', dataset: {}, style: { setProperty() {} },
      disabled: false, children: [], currentTime: 0, duration: 0, scrollTop: 0,
      classList: {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        contains: name => classes.has(name),
        toggle(name, force = !classes.has(name)) { force ? classes.add(name) : classes.delete(name); },
      },
      addEventListener() {}, setAttribute() {}, removeAttribute() {},
      append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; },
      querySelector: () => element(), querySelectorAll: () => [], closest() { return this; },
      getBoundingClientRect: () => ({ height: 0, width: 0 }), pause() {}, click() {},
    };
  };
  const query = selector => {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  };
  let jobListener;
  const api = {
    onJobEvent: callback => { jobListener = callback; },
    getStatus: async () => ({ catalog: { pages: [], lessons: [], totalPages: 0 }, capabilities: { editing: true } }),
    getSettings: async () => ({ modelId: 'qwen3-tts', adapterId: 'none', adapterScale: .6, voiceParallelism: 2, adapters: [], paths: {} }),
    listOutputs: async () => [],
  };
  const globals = {
    window: { ttsStudio: api, scrollTo() {}, location: { search: '' } },
    document: {
      querySelector: query, querySelectorAll: () => [], createElement: element,
      documentElement: element(), body: element(),
      addEventListener: (name, callback) => listeners.set(name, callback),
    },
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    localStorage: { getItem: () => null, setItem() {} },
    setInterval: () => 0,
  };
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  t.after(() => {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  await import('../../electron-app/renderer/app.js');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(query('#runtime-label').textContent, '전체 기능 준비됨', query('#job-log').textContent);
  assert.equal(typeof jobListener, 'function');
  assert.equal(typeof listeners.get('play'), 'function', '삭제된 편집 탭 호출이 공통 재생 연결을 막으면 안 된다');
  assert.doesNotMatch(query('#job-log').textContent, /초기화 오류/);
});
