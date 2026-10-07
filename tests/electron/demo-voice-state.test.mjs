import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { regenerateDemoVoices, resolveDemoVoice } from "../../electron-app/main/workers/demo-voice-state.mjs";

async function fixture(t, scenes) {
  const demoDir = await fs.mkdtemp(path.join(os.tmpdir(), "demo-voice-"));
  t.after(() => fs.rm(demoDir, { recursive: true, force: true }));
  const scriptFile = path.join(demoDir, "script.json");
  const script = { schemaVersion: 1, scenes };
  const scriptSource = `${JSON.stringify(script, null, 2)}\n`;
  await fs.writeFile(scriptFile, scriptSource);
  return { demoDir, scriptFile, script, scriptSource };
}

function fakeGenerator(seeds = []) {
  return async ({ textFile, audioPath, metadataPath, seed }) => {
    seeds.push(seed);
    assert.ok((await fs.readFile(textFile, "utf8")).trim());
    const audio = Buffer.alloc(80, seed % 256);
    await fs.writeFile(audioPath, audio);
    await fs.writeFile(metadataPath, JSON.stringify({
      seed, durationMs: 1000, finalTrack: { status: "ok" },
      audioSha256: crypto.createHash("sha256").update(audio).digest("hex"),
    }));
  };
}

async function runVoice(f, sceneIds, count, generate = fakeGenerator()) {
  return regenerateDemoVoices({ ...f, sceneIds, count, generate });
}

test("같은 대본 재생성은 기존 선택 음성을 보존하고 새 시드의 후보를 추가한다", async t => {
  const oldRelative = "narration/open/candidate-01.wav";
  const f = await fixture(t, [{
    id: "open", text: "강의를 시작합니다.", status: "approved",
    voice: { text: "강의를 시작합니다.", candidates: [oldRelative], selected: oldRelative },
  }]);
  const oldFile = path.join(f.demoDir, oldRelative);
  await fs.mkdir(path.dirname(oldFile), { recursive: true });
  await fs.writeFile(oldFile, "approved take");

  const seeds = [];
  const first = await runVoice(f, ["open"], 2, fakeGenerator(seeds));
  assert.equal(first.scenes[0].voice.selected, oldRelative);
  assert.deepEqual(first.scenes[0].voice.candidates.map(item => path.basename(item)),
    ["candidate-01.wav", "candidate-02.wav", "candidate-03.wav"]);
  assert.equal(await fs.readFile(oldFile, "utf8"), "approved take");
  assert.equal((await fs.readFile(f.scriptFile, "utf8")).includes("candidate-03.wav"), true);

  const secondSource = await fs.readFile(f.scriptFile, "utf8");
  const second = await regenerateDemoVoices({
    script: JSON.parse(secondSource), scriptSource: secondSource, scriptFile: f.scriptFile,
    demoDir: f.demoDir, sceneIds: ["open"], count: 1, generate: fakeGenerator(seeds),
  });
  assert.equal(second.scenes[0].voice.selected, oldRelative);
  assert.deepEqual(second.scenes[0].voice.candidates.map(item => path.basename(item)),
    ["candidate-01.wav", "candidate-02.wav", "candidate-03.wav", "candidate-04.wav"]);
  assert.notEqual(path.dirname(second.scenes[0].voice.candidates[1]),
    path.dirname(second.scenes[0].voice.candidates[3]), "재생성마다 별도 폴더를 쓴다");
  assert.equal(new Set(seeds).size, seeds.length, "새 생성은 다른 시드를 쓴다");
  assert.equal(await fs.readFile(oldFile, "utf8"), "approved take");
});

test("대본이 바뀌면 예전 선택은 해제하지만 원본 음성 파일은 남긴다", async t => {
  const oldRelative = "narration/open/candidate-01.wav";
  const f = await fixture(t, [{
    id: "open", text: "새 설명입니다.", status: "approved",
    voice: { text: "옛 설명입니다.", candidates: [oldRelative], selected: oldRelative },
  }]);
  const oldFile = path.join(f.demoDir, oldRelative);
  await fs.mkdir(path.dirname(oldFile), { recursive: true });
  await fs.writeFile(oldFile, "old voice");

  const next = await runVoice(f, ["open"], 1);
  assert.equal(next.scenes[0].voice.selected, null);
  assert.equal(next.scenes[0].voice.text, "새 설명입니다.");
  assert.equal(next.scenes[0].voice.candidates.length, 1);
  assert.notEqual(next.scenes[0].voice.candidates[0], oldRelative);
  assert.equal(await fs.readFile(oldFile, "utf8"), "old voice");
});

test("후보 하나나 뒤 장면에서 실패해도 대본을 바꾸지 않고 새 폴더를 치운다", async t => {
  const scenes = ["open", "finish"].map(id => ({
    id, text: `${id} 설명`, status: "approved", voice: { candidates: [], selected: null },
  }));
  const f = await fixture(t, scenes);
  let calls = 0;
  await assert.rejects(runVoice(f, ["open", "finish"], 1, async args => {
    calls++;
    if (calls === 2) throw new Error("synthesis failed");
    await fakeGenerator()(args);
  }), /synthesis failed/);
  assert.equal(await fs.readFile(f.scriptFile, "utf8"), f.scriptSource);
  for (const id of ["open", "finish"]) {
    const entries = await fs.readdir(path.join(f.demoDir, "narration", id));
    assert.equal(entries.some(name => name.startsWith("run-")), false);
  }
});

test("생성 중 사람이 대본을 고치면 수정본을 덮지 않는다", async t => {
  const f = await fixture(t, [{
    id: "open", text: "첫 대본", status: "approved", voice: { candidates: [], selected: null },
  }]);
  const edited = f.scriptSource.replace("첫 대본", "수정한 대본");
  await assert.rejects(runVoice(f, ["open"], 1, async args => {
    await fakeGenerator()(args);
    await fs.writeFile(f.scriptFile, edited);
  }), /대본이 수정됐습니다/);
  assert.equal(await fs.readFile(f.scriptFile, "utf8"), edited);
  assert.deepEqual(await fs.readdir(path.join(f.demoDir, "narration", "open")), []);
});

test("오디오와 검수 기록이 맞지 않는 후보는 선택 목록에 공개하지 않는다", async t => {
  const f = await fixture(t, [{
    id: "open", text: "후보 검사", status: "approved", voice: { candidates: [], selected: null },
  }]);
  await assert.rejects(runVoice(f, ["open"], 1, async args => {
    await fakeGenerator()(args);
    await fs.appendFile(args.audioPath, "tampered");
  }), /후보 1 파일이 완성되지 않았습니다/);
  assert.equal(await fs.readFile(f.scriptFile, "utf8"), f.scriptSource);
  assert.deepEqual(await fs.readdir(path.join(f.demoDir, "narration", "open")), []);
});

test("검사 기록이 다른 대본을 가리키면 WAV 해시가 맞아도 후보를 공개하지 않는다", async t => {
  const f = await fixture(t, [{ id: "open", text: "현재 대본", status: "approved",
    voice: { candidates: [], selected: null } }]);
  await assert.rejects(runVoice(f, ["open"], 1, async args => {
    await fakeGenerator()(args);
    const metadata = JSON.parse(await fs.readFile(args.metadataPath, "utf8"));
    await fs.writeFile(args.metadataPath, JSON.stringify({ ...metadata, schemaVersion: 2, sourceText: "옛 대본" }));
  }), /후보 1 파일이 완성되지 않았습니다/);
  assert.equal(await fs.readFile(f.scriptFile, "utf8"), f.scriptSource);
});

test("옛 프로젝트의 input.txt가 같은 대본이면 선택 후보를 유지한다", async t => {
  const oldRelative = "narration/open/candidate-01.wav";
  const f = await fixture(t, [{
    id: "open", text: "옛 프로젝트", status: "approved",
    voice: { candidates: [oldRelative], selected: oldRelative },
  }]);
  const sceneDir = path.join(f.demoDir, "narration", "open");
  await fs.mkdir(sceneDir, { recursive: true });
  await fs.writeFile(path.join(sceneDir, "input.txt"), "옛 프로젝트\n");
  await fs.writeFile(path.join(sceneDir, "candidate-01.wav"), "old voice");
  const next = await runVoice(f, ["open"], 1);
  assert.equal(next.scenes[0].voice.selected, oldRelative);
  assert.equal(next.scenes[0].voice.candidates.length, 2);
});

test("이번 실행에만 쓸 목소리는 청취 승인된 강도만 받는다", () => {
  const settings = { adapters: [
    { id: "a/approved", listeningStatus: "approved", approvedScales: [0.6], referencePaths: { referenceAudioPath: "r.wav" } },
    { id: "a/pending", listeningStatus: "pending", approvedScales: [] },
    { id: "a/broken", profileError: "목소리 프로필이 없습니다." },
  ] };
  assert.equal(resolveDemoVoice(settings, "a/approved", 0.6).referencePaths.referenceAudioPath, "r.wav");
  assert.throws(() => resolveDemoVoice(settings, "a/approved", 0.7), /승인된 강도가 아닙니다/);
  assert.throws(() => resolveDemoVoice(settings, "a/pending", 0.6), /승인된 강도가 아닙니다/);
  assert.throws(() => resolveDemoVoice(settings, "a/broken", 0.6), /프로필이 없습니다/);
  assert.throws(() => resolveDemoVoice(settings, "a/none", 0.6), /그런 목소리가 없습니다/);
});
