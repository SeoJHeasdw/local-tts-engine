import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createVoicesService } from "../../electron-app/main/voices.mjs";
import { createOutputsService } from "../../electron-app/main/outputs.mjs";
import { runtimePaths } from "../../electron-app/main/paths.mjs";
import { outputState } from "../../electron-app/renderer/view-utils.mjs";

test("saved voice takes can be revisited and a different take is preserved as a new result", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tts-voice-history-"));
  try {
    const settings = { paths: { outputRoot: root } };
    const studio = runtimePaths(settings.paths);
    const day = "2026-09-27";
    const original = path.join(studio.voiceOutputRoot, day, "sample-voice");
    const candidatesDir = path.join(original, "candidates");
    await fs.mkdir(candidatesDir, { recursive: true });
    await fs.writeFile(path.join(candidatesDir, "candidate-01.wav"), "first audio");
    await fs.writeFile(path.join(candidatesDir, "candidate-02.wav"), "second audio");
    for (const index of [1, 2]) {
      const number = String(index).padStart(2, "0");
      await fs.writeFile(path.join(candidatesDir, `candidate-${number}.json`), JSON.stringify({
        ...(index === 2 ? { schemaVersion: 2,
          audioSha256: crypto.createHash("sha256").update("second audio").digest("hex") } : {}),
        durationMs: 2300,
        qualityReview: { enabled: true, status: index === 1 ? "warning" : "passed" },
      }));
    }
    await fs.writeFile(path.join(original, "index.json"), JSON.stringify({
      schemaVersion: 1, text: "테스트 문장", candidates: [{ index: 1 }, { index: 2 }],
    }));
    const target = { root: "voice", day, name: "sample-voice" };
    const outputs = createOutputsService({ readAppSettings: async () => settings });
    const events = [];
    const voices = createVoicesService({
      emit: (event) => events.push(event),
      inspectMedia: async () => ({ format: { duration: 2.3 } }),
      readAppSettings: async () => settings,
      resolveOutputTarget: outputs.resolveOutputTarget,
      state: { activeJob: null },
    });

    const waiting = await outputs.listOutputs(studio, { includeLegacy: false });
    assert.equal(waiting.find((item) => item.root === "voice")?.awaitingSelection, true);
    const saved = await voices.listTextVoiceCandidates(target);
    assert.deepEqual(saved.candidates.map((item) => item.index), [1, 2]);
    assert.equal(saved.candidates[0].qualityReview.status, "not-checked", "해시 없는 옛 후보의 자동 판정을 재사용하지 않는다");
    assert.equal(saved.candidates[1].qualityReview.status, "passed");

    const report = await voices.selectTextVoiceFromHistory(target, 2);
    assert.equal(report.selectedCandidateIndex, 2);
    assert.deepEqual(report.sourceCandidates, target);
    assert.equal(report.qualityReview.status, "passed");
    assert.equal(await fs.readFile(report.audioPath, "utf8"), "second audio");
    assert.equal(await fs.readFile(path.join(candidatesDir, "candidate-01.wav"), "utf8"), "first audio");
    assert.equal(events.at(-1).type, "text-voice-selected");
    assert.equal(events.at(-1).jobKind, "text-voice", "앱을 다시 열어 활성 작업이 없어도 목소리 화면으로 전달한다");
    const reopened = await voices.listTextVoiceCandidates(report.target);
    assert.deepEqual(reopened.candidates.map((item) => item.index), [1, 2]);
    assert.equal(reopened.selectedCandidateIndex, 2);
    assert.equal((await outputs.listOutputs(studio, { includeLegacy: false })).filter((item) => item.root === "voice").length, 2);
    await assert.rejects(() => voices.listTextVoiceCandidates({ ...target, name: "../bad" }));
    await fs.writeFile(path.join(candidatesDir, "candidate-02.json"), JSON.stringify({
      audioSha256: "0".repeat(64), qualityReview: { enabled: true, status: "passed" },
    }));
    await assert.rejects(() => voices.listTextVoiceCandidates(target), /생성 당시 파일과 달라졌습니다/);
    await fs.writeFile(path.join(candidatesDir, "candidate-02.json"), JSON.stringify({
      schemaVersion: 2, qualityReview: { enabled: true, status: "passed" },
    }));
    await assert.rejects(() => voices.listTextVoiceCandidates(target), /파일 일치 검사 기록이 없습니다/);
    await fs.rm(original, { recursive: true });
    const orphanedSelection = (await outputs.listOutputs(studio, { includeLegacy: false }))
      .find((item) => item.name === report.target.name);
    assert.equal(orphanedSelection?.hasCandidates, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a new text-voice job never overwrites an older result with the same name", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tts-voice-new-job-"));
  try {
    const settings = { paths: { outputRoot: root } };
    const studio = runtimePaths(settings.paths);
    const { dateFolder } = await import("../../electron-app/main/paths.mjs");
    const original = path.join(studio.voiceOutputRoot, dateFolder(), "repeat-name");
    await fs.mkdir(original, { recursive: true });
    await fs.writeFile(path.join(original, "selected.wav"), "approved older voice");
    const state = { activeJob: { kind: "text-voice", options: { name: "repeat-name" } } };
    const voices = createVoicesService({
      state, readAppSettings: async () => settings,
      emit() {}, requireRuntimeTool: () => "/python",
      runProcess: async (_kind, _executable, args) => {
        const valueOf = (flag) => args[args.indexOf(flag) + 1];
        await fs.writeFile(valueOf("--output"), "new voice");
        await fs.writeFile(valueOf("--metadata"), JSON.stringify({ durationMs: 2300, qualityReview: { enabled: true, status: "passed" } }));
      },
      registerSelected: async (files) => files.map((_, index) => ({ token: `take-${index}` })),
    });
    await voices.runTextVoiceCandidates({
      name: "repeat-name", text: "같은 이름으로 새로 만들기", modelId: "qwen3-tts",
      candidateCount: 2, voiceParallelism: 1, voiceMode: "zero", paths: settings.paths,
    });
    assert.equal(await fs.readFile(path.join(original, "selected.wav"), "utf8"), "approved older voice");
    assert.equal(path.basename(state.activeJob.outputDir), "repeat-name-2");
    assert.equal(state.activeJob.options.name, "repeat-name-2");
    assert.ok(JSON.parse(await fs.readFile(path.join(state.activeJob.outputDir, "index.json"), "utf8")).candidates.length === 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a failed take leaves completed takes reopenable while the generation remains failed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tts-voice-partial-"));
  try {
    const settings = { paths: { outputRoot: root } };
    const studio = runtimePaths(settings.paths);
    const state = { activeJob: { kind: "text-voice", options: { name: "partial-voice" }, state: "running" } };
    const events = [];
    const called = [];
    const outputs = createOutputsService({ readAppSettings: async () => settings });
    const voices = createVoicesService({
      state, readAppSettings: async () => settings, resolveOutputTarget: outputs.resolveOutputTarget,
      emit: (event) => events.push(event), requireRuntimeTool: () => "/python",
      runProcess: async (_kind, _executable, args) => {
        const valueOf = (flag) => args[args.indexOf(flag) + 1];
        const audioPath = valueOf("--output");
        called.push(path.basename(audioPath));
        if (audioPath.endsWith("candidate-02.wav")) throw new Error("후보 2 합성 실패");
        await fs.writeFile(audioPath, "completed voice");
        await fs.writeFile(valueOf("--metadata"), JSON.stringify({ durationMs: 2300,
          qualityReview: { enabled: true, status: "passed" } }));
      },
      inspectMedia: async () => ({ format: { duration: 2.3 } }),
    });
    await assert.rejects(voices.runTextVoiceCandidates({
      name: "partial-voice", text: "첫 후보는 완성됩니다", modelId: "qwen3-tts",
      candidateCount: 3, voiceParallelism: 1, voiceMode: "zero", paths: settings.paths,
    }), /후보 2 합성 실패/);
    assert.deepEqual(called, ["candidate-01.wav", "candidate-02.wav"], "공통 오류 뒤 남은 작업을 성공으로 처리하지 않는다");
    assert.equal(events.some((event) => event.type === "text-voices-ready"), false);
    const item = (await outputs.listOutputs(studio, { includeLegacy: false })).find((row) => row.name === "partial-voice");
    assert.ok(item, "완성된 후보가 최근 결과에 보여야 한다");
    const index = JSON.parse(await fs.readFile(path.join(studio.voiceOutputRoot,
      item.day, "partial-voice", "index.json"), "utf8"));
    assert.equal(index.status, "partial");
    assert.equal(index.candidateCount, 3);
    assert.deepEqual(index.candidates.map((item) => item.index), [1]);
    assert.deepEqual(index.failedCandidates.map((item) => item.index), [2]);
    assert.equal(item.awaitingSelection, true);
    assert.equal(item.availableCandidateCount, 1);
    assert.equal(outputState(item).label, "일부 후보 실패");
    const reopened = await voices.listTextVoiceCandidates({ root: "voice", day: item.day, name: item.name });
    assert.deepEqual(reopened.candidates.map((candidate) => candidate.index), [1]);
    state.activeJob.state = "failed"; // IPC preserves the failed job verdict after runTextVoiceCandidates rejects.
    const selected = await voices.selectTextVoiceFromHistory({ root: "voice", day: item.day, name: item.name }, 1);
    assert.equal(await fs.readFile(selected.audioPath, "utf8"), "completed voice");
    assert.equal(index.status, "partial", "선택한 WAV의 성공으로 원래 작업 실패를 바꾸지 않는다");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("candidate registration failure keeps a visible unverified set, not a completed job", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tts-voice-registration-"));
  try {
    const settings = { paths: { outputRoot: root } };
    const studio = runtimePaths(settings.paths);
    const outputs = createOutputsService({ readAppSettings: async () => settings });
    const state = { activeJob: { kind: "text-voice", options: { name: "unverified-voice" }, state: "running" } };
    const voices = createVoicesService({
      state, readAppSettings: async () => settings, emit() {}, requireRuntimeTool: () => "/python",
      runProcess: async (_kind, _executable, args) => {
        const valueOf = (flag) => args[args.indexOf(flag) + 1];
        await fs.writeFile(valueOf("--output"), "candidate bytes");
        await fs.writeFile(valueOf("--metadata"), JSON.stringify({ durationMs: 2300 }));
      },
      registerSelected: async () => { throw new Error("ffprobe failed"); },
    });
    await assert.rejects(voices.runTextVoiceCandidates({
      name: "unverified-voice", text: "검사할 문장", modelId: "qwen3-tts",
      candidateCount: 2, voiceParallelism: 1, voiceMode: "zero", paths: settings.paths,
    }), /ffprobe failed/);
    const item = (await outputs.listOutputs(studio, { includeLegacy: false })).find((row) => row.name === "unverified-voice");
    assert.ok(item);
    assert.equal(item.candidateSetStatus, "registration-failed");
    assert.equal(outputState(item).label, "후보 파일 확인 실패");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
