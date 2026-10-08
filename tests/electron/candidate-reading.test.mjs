import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  candidateReading, englishSpans, heardText, readingMatch, validWords,
} from "../../electron-app/shared/candidate-reading.mjs";
import {
  activeWord, candidateTextElement, isEnglishWord, textPieces, wordStates,
} from "../../electron-app/renderer/candidate-follow.mjs";
import { createVoicesService } from "../../electron-app/main/voices.mjs";
import { createOutputsService } from "../../electron-app/main/outputs.mjs";
import { runtimePaths } from "../../electron-app/main/paths.mjs";

const SOURCE = "오늘은 Bob.\n다음 줄입니다";
const TIMINGS = { status: "ok", words: [[0, 3, 0, 400], [4, 8, 400, 800], [9, 11, 2000, 2300], [12, 16, 2300, 2900]] };
const bound = (extra = {}) => ({ audioSha256: "a".repeat(64), sourceText: SOURCE, wordTimings: TIMINGS, ...extra });

test("단어 시각이 입력 문장과 어긋나면 일부만 쓰지 않고 통째로 버린다", () => {
  assert.equal(validWords(SOURCE, TIMINGS).length, 4);
  assert.equal(validWords(SOURCE, { ...TIMINGS, status: "unavailable" }), null);
  assert.equal(validWords(SOURCE, { status: "ok", words: [[0, 3, 0, 400], [2, 8, 400, 800]] }), null, "겹치는 범위");
  assert.equal(validWords(SOURCE, { status: "ok", words: [[0, 99, 0, 400]] }), null, "문장 밖");
  assert.equal(validWords(SOURCE, { status: "ok", words: [[0, 8, 0, 400]] }), null, "공백을 가로지르는 단어");
  assert.equal(validWords(SOURCE, { status: "ok", words: [[0, 3, 500, 400]] }), null, "끝이 시작보다 빠름");
  assert.equal(validWords(SOURCE, { status: "ok", words: [[0, 3, 400, 500], [4, 8, 100, 200]] }), null, "되감기는 시각");
  assert.equal(validWords(SOURCE, { status: "ok", words: [[0, 3, null, null]] }), null, "읽은 단어가 하나도 없음");
  const partial = validWords(SOURCE, { status: "partial", words: [[0, 3, null, null], [4, 8, 400, 800]] });
  assert.deepEqual(partial.map((word) => word.startMs), [null, 400]);
});

test("일치율은 검수가 쓰는 발음 오차율을 글자 수로 가중하고 틀린 곳이 있으면 100으로 올리지 않는다", () => {
  const chunk = (ttsText, phoneticErrorRate) => ({ ttsText, quality: { phoneticErrorRate } });
  const review = { enabled: true, status: "passed" };
  assert.deepEqual(readingMatch({ audioSha256: "a".repeat(64), qualityReview: review, chunks: [chunk("가나다라", 0)] }),
    { percent: 100, checkedChars: 4 });
  // 8자 중 4자 구간이 10% 틀림 → 전체 5% 오차 → 95%
  assert.equal(readingMatch({ audioSha256: "a".repeat(64), qualityReview: review,
    chunks: [chunk("가나 다라", 0.1), chunk("마바사아", 0)] }).percent, 95);
  assert.equal(readingMatch({ audioSha256: "a".repeat(64), qualityReview: review, chunks: [chunk("가".repeat(1000), 0.0004)] }).percent, 99,
    "99.96%를 100%로 보여 주면 틀린 곳이 없다는 말이 된다");
  assert.equal(readingMatch({ audioSha256: "a".repeat(64), qualityReview: review, chunks: [chunk("가나", 3)] }).percent, 0);
  assert.equal(readingMatch({ audioSha256: "a".repeat(64), qualityReview: { enabled: false }, chunks: [chunk("가", 0)] }), null,
    "검수를 하지 않은 후보");
  assert.equal(readingMatch({ qualityReview: review, chunks: [chunk("가", 0)] }), null, "파일 해시가 없는 옛 기록");
  assert.equal(readingMatch({ audioSha256: "a".repeat(64), qualityReview: review, chunks: [{ ttsText: "가", quality: null }] }), null);
});

test("받아쓰기가 들은 말과 영어 음성 구간은 해시에 묶인 기록에서만 나온다", () => {
  const metadata = bound({
    qualityReview: { enabled: true },
    chunks: [{ quality: { recognizedText: " 첫째 " } }, { quality: { recognizedText: "" } }, { quality: { recognizedText: "둘째" } }],
    voiceRouting: { segments: [
      { language: "Korean", startMs: 0, durationMs: 500 },
      { language: "English", startMs: 500, durationMs: 1200 },
      { language: "English", startMs: 9, durationMs: 0 },
    ] },
  });
  assert.equal(heardText(metadata), "첫째 둘째");
  assert.deepEqual(englishSpans(metadata), [[500, 1700]]);
  const { audioSha256: _hash, ...unbound } = metadata;
  assert.equal(heardText(unbound), "");
  assert.deepEqual(englishSpans(unbound), []);
  assert.equal(candidateReading(unbound), null);
  const reading = candidateReading(metadata);
  assert.equal(reading.sourceText, SOURCE);
  assert.equal(reading.words.length, 4);
});

test("지금 읽는 단어는 시작한 마지막 단어이고 쉬는 구간에는 꺼진다", () => {
  const words = validWords(SOURCE, TIMINGS);
  assert.equal(activeWord(words, -1), -1);
  assert.equal(activeWord(words, 0), 0);
  assert.equal(activeWord(words, 799), 1);
  assert.equal(activeWord(words, 5000), 3);
  assert.deepEqual(wordStates(words, 100), [2, 0, 0, 0]);
  assert.deepEqual(wordStates(words, 500), [1, 2, 0, 0]);
  assert.deepEqual(wordStates(words, 1500), [1, 1, 0, 0], "문장 사이 쉬는 구간: 읽은 단어는 진하게 남고 강조는 꺼진다");
  assert.deepEqual(wordStates(words, 9000), [1, 1, 1, 1]);
  const withSilent = validWords("가 — 나", { status: "ok", words: [[0, 1, 0, 100], [2, 3, null, null], [4, 5, 200, 300]] });
  assert.deepEqual(wordStates(withSilent, 250), [1, 1, 2], "읽지 않는 단어는 뒤 단어를 읽을 때 읽은 것이 된다");
  assert.equal(activeWord(withSilent, 150), 0);
});

test("문장은 줄바꿈과 띄어쓰기를 그대로 두고 단어마다 따로 칠한다", () => {
  const pieces = textPieces(SOURCE, validWords(SOURCE, TIMINGS));
  assert.equal(pieces.map((piece) => piece.text).join(""), SOURCE);
  assert.deepEqual(pieces.filter((piece) => piece.word !== null).map((piece) => piece.text), ["오늘은", "Bob.", "다음", "줄입니다"]);
  assert.equal(pieces.find((piece) => piece.text === "\n").word, null);
  const [, bob] = validWords(SOURCE, TIMINGS);
  assert.equal(isEnglishWord(bob, [[300, 900]]), true);
  assert.equal(isEnglishWord(bob, [[900, 1200]]), false);
});

function fakeDocument() {
  const element = (tag) => ({
    tag, children: [], dataset: {}, listeners: {}, className: "", textContent: "",
    classes: new Set(),
    classList: null,
    append(...items) { this.children.push(...items); },
    addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); },
  });
  const make = (tag) => {
    const node = element(tag);
    node.classList = {
      add: (name) => node.classes.add(name), contains: (name) => node.classes.has(name),
      toggle: (name, force) => (force ? node.classes.add(name) : node.classes.delete(name)),
    };
    return node;
  };
  return { createElement: make, createTextNode: (text) => ({ text }) };
}

function fakeAudio() {
  const audio = { currentTime: 0, paused: true, ended: false, listeners: {}, played: 0,
    addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); },
    play() { this.paused = false; this.played += 1; } };
  audio.fire = (name) => (audio.listeners[name] || []).forEach((listener) => listener());
  return audio;
}

test("재생하면 읽는 단어가 따라 칠해지고 단어를 누르면 그 위치부터 재생한다", () => {
  const doc = fakeDocument();
  const audio = fakeAudio();
  const frames = [];
  const reading = { sourceText: SOURCE, words: validWords(SOURCE, TIMINGS), englishSpans: [[300, 900]] };
  const paragraph = candidateTextElement(doc, reading, {
    audio, requestFrame: (callback) => (frames.push(callback), frames.length), cancelFrame() {},
  });
  const spans = paragraph.children.filter((child) => child.tag === "span");
  assert.deepEqual(spans.map((span) => span.textContent), ["오늘은", "Bob.", "다음", "줄입니다"]);
  assert.ok(paragraph.classes.has("followable"));
  assert.ok(spans[1].classes.has("cw-en") && !spans[0].classes.has("cw-en"), "영어 음성으로 읽은 단어만 표시한다");
  const state = () => spans.map((span) => (span.classes.has("current") ? "C" : span.classes.has("spoken") ? "S" : "-")).join("");
  assert.equal(state(), "----", "재생 전에는 모두 흐리게");

  audio.paused = false;
  audio.currentTime = 0.5;
  audio.fire("play");
  assert.equal(state(), "SC--");
  audio.currentTime = 2.1;
  frames.shift()();
  assert.equal(state(), "SS" + "C-");
  audio.currentTime = 9;
  audio.ended = true;
  audio.fire("ended");
  assert.equal(state(), "SSSS");

  let prevented = false;
  spans[2].listeners.click[0]({ preventDefault() { prevented = true; } });
  assert.equal(audio.currentTime, 2);
  assert.equal(audio.played, 1);
  assert.ok(prevented, "단어를 눌러도 카드가 선택되지 않는다");
});

test("읽기 시각이 없는 후보는 글만 보여 주고 따라 읽기는 하지 않는다", () => {
  const doc = fakeDocument();
  const paragraph = candidateTextElement(doc, { sourceText: SOURCE, words: null }, { audio: fakeAudio() });
  assert.equal(paragraph.textContent, SOURCE);
  assert.ok(!paragraph.classes.has("followable"));
});

test("지난 후보를 열어도 해시가 맞는 후보에만 읽기 기록을 준다", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tts-candidate-reading-"));
  try {
    const settings = { paths: { outputRoot: root } };
    const studio = runtimePaths(settings.paths);
    const day = "2026-10-08";
    const original = path.join(studio.voiceOutputRoot, day, "reading-voice");
    const candidatesDir = path.join(original, "candidates");
    await fs.mkdir(candidatesDir, { recursive: true });
    await fs.writeFile(path.join(candidatesDir, "candidate-01.wav"), "first audio");
    await fs.writeFile(path.join(candidatesDir, "candidate-02.wav"), "second audio");
    const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
    await fs.writeFile(path.join(candidatesDir, "candidate-01.json"), JSON.stringify({
      durationMs: 2900, sourceText: SOURCE, wordTimings: TIMINGS,
    }));
    await fs.writeFile(path.join(candidatesDir, "candidate-02.json"), JSON.stringify({
      schemaVersion: 2, audioSha256: sha("second audio"), durationMs: 2900, sourceText: SOURCE, wordTimings: TIMINGS,
      qualityReview: { enabled: true, status: "passed" },
      chunks: [{ ttsText: "오늘은 밥", quality: { phoneticErrorRate: 0, recognizedText: "오늘은 밥" } }],
    }));
    await fs.writeFile(path.join(original, "index.json"), JSON.stringify({
      schemaVersion: 1, text: SOURCE, candidates: [{ index: 1 }, { index: 2 }],
    }));
    const outputs = createOutputsService({ readAppSettings: async () => settings });
    const voices = createVoicesService({
      emit() {}, inspectMedia: async () => ({}), readAppSettings: async () => settings,
      resolveOutputTarget: outputs.resolveOutputTarget, state: { activeJob: null },
    });

    const saved = await voices.listTextVoiceCandidates({ root: "voice", day, name: "reading-voice" });

    assert.equal(saved.candidates[0].reading, null, "해시 없는 옛 후보는 어느 음성의 기록인지 알 수 없다");
    assert.equal(saved.candidates[1].reading.words.length, 4);
    assert.equal(saved.candidates[1].reading.match.percent, 100);
    assert.equal(saved.candidates[1].reading.heard, "오늘은 밥");
    assert.equal(saved.text, SOURCE, "읽기 기록이 없는 후보도 입력 문장은 보여 줄 수 있다");
    assert.equal("metadata" in saved.candidates[1], false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
