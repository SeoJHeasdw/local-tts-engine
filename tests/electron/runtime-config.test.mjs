import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  defaultSourceProjectRoot,
  executableCandidates,
  ffmpegBuildProfile,
  firstExecutable,
  resolveRuntimeTools,
} from "../../electron-app/main/runtime-config.mjs";


test("강의 소스 기본값은 사용자 홈이 아니라 프로젝트의 형제 폴더다", () => {
  const projectRoot = "/workspace/local-tts-engine";
  assert.equal(defaultSourceProjectRoot(projectRoot, {}), "/workspace/udemy-agent");
  assert.equal(
    defaultSourceProjectRoot(projectRoot, { TTS_STUDIO_SOURCE_PROJECT: "/courses/my-channel" }),
    "/courses/my-channel",
  );
});


test("GUI의 제한된 PATH에서도 Apple Silicon 도구 위치를 확인한다", () => {
  const candidates = executableCandidates("ffmpeg", { PATH: "/custom/bin" });
  assert.equal(candidates[0], "/custom/bin/ffmpeg");
  assert.ok(candidates.includes("/opt/homebrew/bin/ffmpeg"));
});


test("실제로 실행 가능한 첫 도구만 선택한다", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tts-runtime-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "tool");
  await fs.writeFile(executable, "#!/bin/sh\n", "utf8");
  await fs.chmod(executable, 0o755);
  assert.equal(await firstExecutable([path.join(directory, "missing"), executable]), executable);
});


test("실행 도구 경로를 환경 변수로 재정의할 수 있다", async () => {
  const seen = [];
  const access = async (candidate) => { seen.push(candidate); };
  const tools = await resolveRuntimeTools("/workspace/local-tts-engine", {
    PATH: "",
    TTS_STUDIO_BASE_PYTHON: "/runtime/base-python",
    TTS_STUDIO_TRAIN_PYTHON: "/runtime/train-python",
    TTS_STUDIO_NODE: "/runtime/node",
    TTS_STUDIO_FFMPEG: "/runtime/ffmpeg",
    TTS_STUDIO_FFPROBE: "/runtime/ffprobe",
  }, access);
  assert.deepEqual(tools, {
    basePython: "/runtime/base-python",
    trainPython: "/runtime/train-python",
    node: "/runtime/node",
    ffmpeg: "/runtime/ffmpeg",
    ffprobe: "/runtime/ffprobe",
  });
  assert.equal(seen.length, 5);
});


test("배포하면 안 되는 GPL FFmpeg 빌드 플래그를 감지한다", () => {
  assert.deepEqual(
    ffmpegBuildProfile("configuration: --enable-shared --enable-gpl --enable-libx264"),
    { gplEnabled: true, nonfreeEnabled: false, libx264Enabled: true },
  );
});
