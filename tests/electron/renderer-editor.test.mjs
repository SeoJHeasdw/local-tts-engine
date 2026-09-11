import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorController } from '../../electron-app/renderer/controllers/editor.mjs';

// 영상 편집 화면의 동작을 실제 컨트롤러로 확인한다. 구간 자르기·나누기·순서는
// 굽기 전에 전부 여기서 정해지므로, 여기서 틀리면 몇 분을 기다린 뒤에야 안다.
function fixture() {
  const elements = new Map();
  const element = () => ({
    value: '', textContent: '', disabled: false, currentTime: 0, readyState: 2, paused: true,
    dataset: {}, listeners: {}, children: [], attributes: {}, style: {}, className: '', draggable: false,
    setPointerCapture() {}, releasePointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, width: 1000 }),
    classList: (() => {
      const names = new Set();
      return {
        add: (...values) => values.forEach((value) => names.add(value)),
        remove: (...values) => values.forEach((value) => names.delete(value)),
        contains: (value) => names.has(value),
        toggle(value, force = !names.has(value)) { force ? names.add(value) : names.delete(value); return force; },
      };
    })(),
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(key, value) { this.attributes[key] = value; },
    getAttribute(key) { return this.attributes[key]; },
    removeAttribute(key) { delete this.attributes[key]; },
    closest() { return null; },
    pause() { this.paused = true; },
    async play() { this.paused = false; },
    addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); },
  });
  const $ = (key) => {
    if (!elements.has(key)) elements.set(key, element());
    return elements.get(key);
  };
  const toasts = [];
  const started = [];
  const picked = [];
  const api = {
    pickVideos: async () => picked.shift() || [],
    startEdit: async (payload) => { started.push(payload); },
  };
  const review = { reviewBusy: false };
  const editor = createEditorController({
    $, review, api,
    document: { createElement: element },
    setIconStatus() {},
    showToast: (message, tone) => toasts.push({ message, tone }),
    setEditBusy() {},
    openJobDialog() {},
  });
  const fire = (key, name, event = {}) => ($(key).listeners[name] || []).forEach((callback) => callback(event));
  const video = (name, durationMs) => ({ token: `t-${name}`, name, videoUrl: `file:///${name}`, durationMs });
  return { $, editor, fire, toasts, started, picked, review, video };
}

const KEY = (key, tagName = 'BODY') => ({ key, target: { tagName }, preventDefault() {} });

test('담은 것이 없으면 안내 자리만 남고, 하나라도 담으면 편집 화면이 선다', () => {
  const { $, editor, fire, video } = fixture();
  assert.equal($('#editor-drop').classList.contains('hidden'), false);
  assert.equal($('.editor').classList.contains('hidden'), true, '빈 재생기를 먼저 보여 주지 않는다');
  assert.equal($('.editor-track').classList.contains('hidden'), true);

  editor.addEditorClips([video('a.mp4', 10_000)]);
  assert.equal($('#editor-drop').classList.contains('hidden'), true, '담은 뒤에는 담기 상자가 사라진다');
  assert.equal($('.editor').classList.contains('hidden'), false);
  assert.equal($('#editor-close').disabled, false, '대신 영상 닫기 단추가 선다');

  // 닫으면 다시 안내 자리로 돌아간다.
  fire('#editor-close', 'click');
  assert.equal(editor.clips.length, 0);
  assert.equal($('#editor-drop').classList.contains('hidden'), false);
});

test('담은 클립은 순서대로 목록에 서고 완성 길이를 더한다', () => {
  const { $, editor, video } = fixture();
  editor.addEditorClips([video('a.mp4', 10_000), video('b.mp4', 5_000)]);
  assert.equal(editor.clips.length, 2);
  assert.equal($('#editor-count').textContent, '2');
  assert.equal($('#editor-total').textContent, '0:15');
  assert.equal($('#editor-clips').children.length, 2);
  // 편집기의 0은 '모름'이 아니라 '처음'이다. 공용 formatDuration 은 0을
  // '길이 확인 전'이라고 읽으므로 자리 표시에 그대로 쓰면 안 된다.
  editor.selectEditorClip(0);
  assert.equal($('#editor-clip-time').textContent, '0:00–0:10 · 원본 0:10');
  assert.equal($('#start-edit-label').textContent, '이어서 만들기');
  assert.equal($('#start-edit-button').disabled, false);
});

// 한 영상의 가운데를 들어내는 일은 편집에서 가장 흔한 손짓인데, 구간 하나짜리
// 클립으로는 표현할 수 없었다. 나누면 앞뒤가 각각 클립이 되고, 가운데를 빼는
// 것은 그중 하나를 지우는 일이 된다.
test('재생 위치에서 나누면 앞뒤 두 클립이 되고 합은 원본과 같다', () => {
  const { $, editor, video } = fixture();
  editor.addEditorClips([video('a.mp4', 10_000)]);
  $('#editor-player').currentTime = 4;
  assert.equal(editor.splitClip(), true);
  assert.equal(editor.clips.length, 2);
  assert.deepEqual(editor.clips.map((clip) => [clip.inMs, clip.outMs]), [[0, 4000], [4000, 10_000]]);
  assert.equal(editor.activeIndex, 1, '나눈 뒤에는 뒷 조각을 고른 채 둔다');
  assert.equal(editor.clips[0].token, editor.clips[1].token, '같은 원본을 가리킨다');

  // 시작·끝에 붙은 자리에서 나누면 길이 0인 클립이 생긴다. 그 자리에서는 막는다.
  $('#editor-player').currentTime = 4;
  assert.equal(editor.splitClip(), false);
  assert.equal($('#editor-split').disabled, true);
});

test('시작과 끝은 서로를 넘지 않고 원본 길이 안에 머문다', () => {
  const { $, editor, fire, video } = fixture();
  editor.addEditorClips([video('a.mp4', 10_000)]);
  $('#editor-player').currentTime = 3;
  fire('#editor-mark-in', 'click');
  assert.equal(editor.clips[0].inMs, 3000);

  // 끝을 시작보다 앞으로 끌어도 뒤집히지 않는다.
  $('#editor-player').currentTime = 1;
  fire('#editor-mark-out', 'click');
  assert.equal(editor.clips[0].outMs, 3001);

  // 원본보다 뒤를 가리켜도 원본에서 멈춘다.
  $('#editor-out').value = '00:00:99.000';
  fire('#editor-out', 'change');
  assert.equal(editor.clips[0].outMs, 10_000);

  fire('#editor-reset-clip', 'click');
  assert.deepEqual([editor.clips[0].inMs, editor.clips[0].outMs], [0, 10_000]);
});

test('구간 막대 손잡이를 끌면 그 자리가 시작이 된다', () => {
  const { $, editor, video } = fixture();
  editor.addEditorClips([video('a.mp4', 10_000)]);
  // 자의 폭은 1000px, 클립은 10초다. 250px 자리는 2.5초다.
  $('#editor-trim-in').listeners.pointerdown.forEach((callback) => callback({ pointerId: 1 }));
  $('#editor-trim-in').listeners.pointermove.forEach((callback) => callback({ pointerId: 1, clientX: 250 }));
  assert.equal(editor.clips[0].inMs, 2500);
  assert.equal($('#editor-trim-band').style.left, '25%');
  assert.equal($('#editor-player').paused, true, '끄는 동안에는 재생을 멈춘다');
});

test('화살표로 클립 순서를 한 칸씩 옮긴다', () => {
  const { editor, video } = fixture();
  editor.addEditorClips([video('a.mp4', 1000), video('b.mp4', 1000), video('c.mp4', 1000)]);
  editor.moveClip(2, 0);
  assert.deepEqual(editor.clips.map((clip) => clip.name), ['c.mp4', 'a.mp4', 'b.mp4']);
  assert.equal(editor.activeIndex, 0, '옮긴 클립을 고른 채로 둔다');
  editor.moveClip(0, -1);
  assert.deepEqual(editor.clips.map((clip) => clip.name), ['c.mp4', 'a.mp4', 'b.mp4'], '목록 밖으로는 나가지 않는다');
});

// 자르고 듣고 다시 자르는 동안 손이 자판을 떠나지 않아야 한다.
test('자판으로 시작·끝 지정, 나누기, 클립 이동과 빼기를 한다', () => {
  const { $, editor, video } = fixture();
  editor.addEditorClips([video('a.mp4', 10_000), video('b.mp4', 10_000)]);
  editor.selectEditorClip(0);

  $('#editor-player').currentTime = 2;
  editor.editorShortcut(KEY('i'));
  assert.equal(editor.clips[0].inMs, 2000);
  $('#editor-player').currentTime = 8;
  editor.editorShortcut(KEY('o'));
  assert.equal(editor.clips[0].outMs, 8000);

  $('#editor-player').currentTime = 5;
  editor.editorShortcut(KEY('s'));
  assert.equal(editor.clips.length, 3, 'S 는 재생 위치에서 나눈다');

  editor.editorShortcut(KEY(']'));
  assert.equal(editor.activeIndex, 2);
  editor.editorShortcut(KEY('['));
  assert.equal(editor.activeIndex, 1);

  editor.editorShortcut(KEY('Delete'));
  assert.equal(editor.clips.length, 2);
});

test('글자를 치는 중에는 편집 단축키가 새지 않는다', () => {
  const { editor, video } = fixture();
  editor.addEditorClips([video('a.mp4', 10_000)]);
  for (const tagName of ['INPUT', 'TEXTAREA', 'BUTTON', 'SUMMARY']) {
    editor.editorShortcut({ key: 's', target: { tagName }, preventDefault() {} });
    editor.editorShortcut({ key: 'Delete', target: { tagName }, preventDefault() {} });
  }
  assert.equal(editor.clips.length, 1);
});

// 굽기 전에 이음매를 확인할 길이 없으면, 몇 분을 기다린 뒤에야 순서가 틀렸다는
// 것을 안다.
test('이어서 미리보기는 클립 끝에서 다음 클립으로 넘어가고 마지막에서 멈춘다', () => {
  const { $, editor, fire, video } = fixture();
  editor.addEditorClips([video('a.mp4', 10_000), video('b.mp4', 10_000)]);
  editor.togglePreviewAll();
  assert.equal(editor.previewingAll, true);
  assert.equal(editor.activeIndex, 0);

  $('#editor-player').currentTime = 10;
  fire('#editor-player', 'timeupdate');
  assert.equal(editor.activeIndex, 1, '앞 클립이 끝나면 다음 클립으로 간다');
  assert.equal(editor.previewingAll, true);

  $('#editor-player').currentTime = 10;
  fire('#editor-player', 'timeupdate');
  assert.equal(editor.previewingAll, false, '마지막 클립에서는 멈춘다');
  assert.equal($('#editor-player').paused, true);
});

test('만들기는 담긴 순서와 구간 그대로 compose 로 보낸다', async () => {
  const { $, editor, fire, started, video } = fixture();
  editor.addEditorClips([video('a.mp4', 10_000), video('b.mp4', 6_000)]);
  editor.selectEditorClip(0);
  $('#editor-player').currentTime = 1;
  fire('#editor-mark-in', 'click');
  $('#edit-name').value = '이어붙임-1';

  fire('#start-edit-button', 'click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.length, 1);
  assert.equal(started[0].operation, 'compose');
  assert.equal(started[0].name, '이어붙임-1');
  assert.deepEqual(started[0].clips, [
    { videoToken: 't-a.mp4', inMs: 1000, outMs: 10_000 },
    { videoToken: 't-b.mp4', inMs: 0, outMs: 6_000 },
  ]);
});

test('작업이 도는 동안에는 편집 손잡이를 함께 잠근다', () => {
  const { $, editor, review, video } = fixture();
  editor.addEditorClips([video('a.mp4', 10_000)]);
  review.reviewBusy = true;
  editor.renderEditorTrack();
  editor.selectEditorClip(0);
  assert.equal($('#start-edit-button').disabled, true);
  assert.equal($('#editor-trim-in').disabled, true);
  assert.equal($('#editor-preview-all').disabled, true);
  editor.editorShortcut(KEY('Delete'));
  assert.equal(editor.clips.length, 1, '잠긴 동안에는 자판으로도 지워지지 않는다');
});
