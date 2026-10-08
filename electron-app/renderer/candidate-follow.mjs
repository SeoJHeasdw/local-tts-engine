// 후보 음성을 재생하는 동안 입력 문장을 단어 단위로 따라가며 칠하는 화면 조각.
// 읽은 단어는 진하게, 지금 읽는 단어는 강조색, 아직 안 읽은 단어는 흐리게 둔다.

// 읽는 단어가 끝난 뒤에도 잠깐은 '지금 읽는 단어'로 둔다. 정렬 모델이 짧게 잡은 단어에서
// 강조가 깜빡이지 않게 하고, 쉬는 구간에서는 강조를 꺼서 숨 쉬는 곳이 보이게 한다.
export const HOLD_MS = 300;

// 시간이 있는 단어(읽는 단어)의 번호 목록.
export function timedIndexes(words) {
  return words.flatMap((word, index) => (word.startMs === null ? [] : [index]));
}

// ms 시점에 이미 시작한 마지막 단어의 번호. 아직 아무것도 시작하지 않았으면 -1.
export function activeWord(words, ms, timed = timedIndexes(words)) {
  let low = 0;
  let high = timed.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (words[timed[middle]].startMs <= ms) { found = timed[middle]; low = middle + 1; } else high = middle - 1;
  }
  return found;
}

// 각 단어의 상태: 0 아직, 1 읽음, 2 지금. 시간 없는 단어는 뒤에 오는 단어를 읽을 때 읽은 것이 된다.
export function wordStates(words, ms, timed = timedIndexes(words)) {
  const states = new Array(words.length).fill(0);
  const active = activeWord(words, ms, timed);
  if (active < 0) return states;
  states.fill(1, 0, active + 1);
  if (ms <= words[active].endMs + HOLD_MS) states[active] = 2;
  return states;
}

// 입력 문장을 단어 span과 공백 글자로 쪼갠다. 줄바꿈과 띄어쓰기는 입력 그대로 둔다.
export function textPieces(sourceText, words) {
  const pieces = [];
  let cursor = 0;
  words.forEach((word, index) => {
    if (word.start > cursor) pieces.push({ text: sourceText.slice(cursor, word.start), word: null });
    pieces.push({ text: sourceText.slice(word.start, word.end), word: index });
    cursor = word.end;
  });
  if (cursor < sourceText.length) pieces.push({ text: sourceText.slice(cursor), word: null });
  return pieces;
}

export function isEnglishWord(word, spans) {
  if (word.startMs === null || !spans.length) return false;
  const middle = (word.startMs + word.endMs) / 2;
  return spans.some(([start, end]) => middle >= start && middle < end);
}

// 긴 글에서 읽는 단어가 목록 밖으로 나가면 그 단어가 보이게 스크롤한다. 보이는 동안에는 건드리지 않아
// 사용자가 직접 스크롤하는 것과 싸우지 않는다.
function keepInView(node) {
  const frame = node?.closest?.("#candidate-list");
  if (!frame) return;
  const word = node.getBoundingClientRect();
  const view = frame.getBoundingClientRect();
  if (word.top < view.top + 8 || word.bottom > view.bottom - 8) {
    node.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

// audio를 재생하는 동안 nodes(단어 span)의 상태를 맞춘다.
export function followAudio({ audio, nodes, words, requestFrame, cancelFrame }) {
  const timed = timedIndexes(words);
  let frame = null;
  let painted = null;
  const paint = () => {
    // 한 번도 재생하지 않은(또는 처음으로 되감은) 정지 상태에서는 첫 단어가 0초에 시작해도 칠하지 않는다.
    const ms = audio.paused && audio.currentTime === 0 ? -1 : audio.currentTime * 1000;
    const states = wordStates(words, ms, timed);
    const key = states.join("");
    if (key === painted) return;
    painted = key;
    states.forEach((state, index) => {
      nodes[index].classList.toggle("spoken", state === 1);
      nodes[index].classList.toggle("current", state === 2);
    });
    if (!audio.paused) keepInView(nodes[states.indexOf(2)]);
  };
  const loop = () => {
    paint();
    frame = audio.paused || audio.ended ? null : requestFrame(loop);
  };
  const start = () => { paint(); if (frame === null) frame = requestFrame(loop); };
  const stop = () => {
    if (frame !== null) cancelFrame(frame);
    frame = null;
    paint();
  };
  audio.addEventListener("play", start);
  audio.addEventListener("playing", start);
  audio.addEventListener("pause", stop);
  audio.addEventListener("ended", stop);
  audio.addEventListener("seeked", paint);
  paint();
}

// 후보 카드에 들어갈 문장 요소. words가 없으면(정렬 실패·옛 후보) 따라 읽기 없이 글만 보인다.
export function candidateTextElement(doc, reading, { audio, requestFrame, cancelFrame }) {
  const paragraph = doc.createElement("p");
  paragraph.className = "candidate-text";
  if (!reading?.words) {
    paragraph.textContent = reading?.sourceText ?? "";
    return paragraph;
  }
  const nodes = [];
  const parts = textPieces(reading.sourceText, reading.words).map((piece) => {
    if (piece.word === null) return doc.createTextNode(piece.text);
    const word = reading.words[piece.word];
    const span = doc.createElement("span");
    span.className = "cw";
    span.textContent = piece.text;
    if (isEnglishWord(word, reading.englishSpans || [])) span.classList.add("cw-en");
    if (word.startMs !== null) {
      span.dataset.startMs = String(word.startMs);
      // 단어를 누르면 거기서부터 읽는다. 카드를 고르는 동작과는 따로다.
      span.addEventListener("click", (event) => {
        event.preventDefault();
        audio.currentTime = word.startMs / 1000;
        audio.play?.();
      });
    }
    nodes[piece.word] = span;
    return span;
  });
  paragraph.append(...parts);
  paragraph.classList.add("followable");
  followAudio({ audio, nodes, words: reading.words, requestFrame, cancelFrame });
  return paragraph;
}
