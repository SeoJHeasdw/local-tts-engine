import test from 'node:test';
import assert from 'node:assert/strict';

// 창을 닫았다 다시 열면 main은 돌던 작업을 그대로 들고 있고 화면만 새로 뜬다. 앱 데모의
// 목소리·완성본은 다듬기에서 도는 일이라, 다시 뜬 화면이 그 진행을 다듬기에서 되살리고
// 새로 만들기의 시작은 막아야 한다(예전에는 강의 제작 진행으로 잘못 떨어졌다).
// 모듈은 한 번만 불러오므로 이 파일은 이 한 경우만 본다.
test('앱 데모 굽기 중에 창을 다시 열면 다듬기가 진행을 되살리고 다른 시작은 막는다', async t => {
  const elements = new Map();
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
      addEventListener() {}, attributes: {},
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
  const navItems = ['new', 'review'].map(view => {
    const item = query(`.nav-item[data-view="${view}"]`);
    item.dataset.view = view;
    return item;
  });
  const api = {
    onJobEvent() {},
    getStatus: async () => ({
      catalog: { pages: [], lessons: [], totalPages: 0 }, capabilities: { editing: true },
      activeJob: { id: 'job-1', kind: 'demo-render', state: 'running', stage: 'demo-render', startedAt: new Date().toISOString() },
    }),
    getSettings: async () => ({ modelId: 'qwen3-tts', adapterId: 'none', adapterScale: .6, voiceParallelism: 2, adapters: [], paths: {} }),
    listOutputs: async () => [],
    getResumable: async () => null,
  };
  const globals = {
    window: { ttsStudio: api, scrollTo() {}, location: { search: '' } },
    document: {
      querySelector: query, querySelectorAll: selector => (selector === '.nav-item' ? navItems : []), createElement: element,
      documentElement: element(), body: element(), addEventListener() {},
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

  assert.doesNotMatch(query('#job-log').textContent, /초기화 오류/);
  assert.equal(query('#demo-running').classList.contains('hidden'), false, '다듬기의 앱 데모 작업면이 진행을 되살린다');
  assert.match(query('#demo-running-label').textContent, /완성본을 굽고 있습니다/);
  assert.notEqual(query('#job-state').textContent, '실행 중', '강의 제작 진행으로 떨어지지 않는다');
  for (const selector of ['#start-button', '#start-text-voices', '#record-start', '#demo-record-start']) {
    assert.equal(query(selector).inert, true, `${selector}는 앱 데모 굽기가 끝날 때까지 막힌다`);
  }
  assert.equal(query('.nav-item[data-view="review"]').classList.contains('running'), true, '다듬기 메뉴가 도는 표시를 한다');
  assert.match(query('#create-busy-text').textContent, /앱 데모 완성본을 굽는 중/);
});
