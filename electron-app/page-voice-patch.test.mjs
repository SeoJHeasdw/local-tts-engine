import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { pageVoicePatchPlan, patchedTimeline, timeRangeForPages } from "./pipeline-utils.mjs";

const run = promisify(execFile);

// Replacing one page's voice is the operation with the least forgiving failure
// mode: get it wrong and the user's finished lecture comes back with its whole
// soundtrack overwritten. The filter graph is built by a pure function, but
// only ffmpeg can say whether the graph it produces is valid and lands where it
// claims. These run the real encoder on tiny inputs.

async function ffprobeDuration(file) {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "json", file,
  ]);
  return Number(JSON.parse(stdout).format.duration);
}

async function ffprobeStreams(file) {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", file,
  ]);
  return JSON.parse(stdout).streams;
}

/** Six seconds of video whose audio is a steady 300Hz tone. */
async function makeVideo(file, { seconds = 6, tone = 300 } = {}) {
  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `testsrc=size=320x240:rate=25:duration=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=${tone}:duration=${seconds}:sample_rate=48000`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k", "-shortest", file,
  ]);
  return file;
}

/** A replacement voice at a clearly different pitch, so it is identifiable. */
async function makeVoice(file, { seconds = 3, tone = 900 } = {}) {
  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `sine=frequency=${tone}:duration=${seconds}:sample_rate=48000`,
    "-c:a", "pcm_s24le", file,
  ]);
  return file;
}

/** Mean amplitude over one span, used to tell which tone is playing when. */
async function meanVolume(file, start, duration) {
  const { stderr } = await run("ffmpeg", [
    "-hide_banner", "-nostats", "-ss", String(start), "-t", String(duration),
    "-i", file, "-af", "highpass=f=600,volumedetect", "-f", "null", "-",
  ]).catch((error) => error);
  const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(String(stderr));
  return match ? Number(match[1]) : Number.NEGATIVE_INFINITY;
}

async function patch(directory, plan, video, voice) {
  const output = path.join(directory, "patched.mp4");
  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-i", video, "-i", voice,
    "-filter_complex", plan.filter,
    "-map", plan.videoOutput, "-map", plan.audioOutput,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", output,
  ]);
  return output;
}

let workspace;
test.before(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "voice-patch-"));
});
test.after(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

test("교체 구간만 새 목소리로 바뀌고 앞뒤 원본은 그대로다", async () => {
  const video = await makeVideo(path.join(workspace, "lecture.mp4"));
  const voice = await makeVoice(path.join(workspace, "voice.wav"), { seconds: 2 });
  const plan = pageVoicePatchPlan({
    videoDuration: 6, targetStart: 2, targetEnd: 4,
    sourceStart: 0, sourceEnd: 2, matchAudio: true,
  });
  const output = await patch(workspace, plan, video, voice);

  assert.equal(plan.replacementDuration, 2);
  assert.ok(Math.abs(await ffprobeDuration(output) - 6) < 0.25);

  // The 900Hz replacement passes a 600Hz highpass; the 300Hz original is
  // attenuated by it. AAC leaks a little, so the margin is read, not assumed.
  const before = await meanVolume(output, 0.4, 1.2);
  const middle = await meanVolume(output, 2.4, 1.2);
  const after = await meanVolume(output, 4.4, 1.2);
  assert.ok(middle > before + 8, `교체 구간에 새 목소리가 없다 (${middle} vs ${before})`);
  assert.ok(middle > after + 8, `교체 구간 뒤가 오염됐다 (${middle} vs ${after})`);
  assert.ok(Math.abs(before - after) < 6, `교체하지 않은 앞뒤가 달라졌다 (${before} vs ${after})`);
});

test("새 목소리가 더 길면 영상 전체가 그만큼 길어진다", async () => {
  const video = await makeVideo(path.join(workspace, "lecture-2.mp4"));
  const voice = await makeVoice(path.join(workspace, "voice-2.wav"), { seconds: 3 });
  const plan = pageVoicePatchPlan({
    videoDuration: 6, targetStart: 2, targetEnd: 4,
    sourceStart: 0, sourceEnd: 3, matchAudio: true,
  });
  const output = await patch(workspace, plan, video, voice);

  assert.equal(plan.replacementDuration, 3);
  assert.ok(Math.abs(await ffprobeDuration(output) - 7) < 0.3);
  const streams = await ffprobeStreams(output);
  assert.ok(streams.some((stream) => stream.codec_type === "video"));
  assert.ok(streams.some((stream) => stream.codec_type === "audio"));
});

test("화면 길이 유지를 고르면 영상 길이가 변하지 않는다", async () => {
  const video = await makeVideo(path.join(workspace, "lecture-3.mp4"));
  const voice = await makeVoice(path.join(workspace, "voice-3.wav"), { seconds: 1 });
  const plan = pageVoicePatchPlan({
    videoDuration: 6, targetStart: 2, targetEnd: 4,
    sourceStart: 0, sourceEnd: 1, matchAudio: false,
  });
  const output = await patch(workspace, plan, video, voice);

  assert.equal(plan.replacementDuration, 2);
  assert.ok(Math.abs(await ffprobeDuration(output) - 6) < 0.25);
});

test("첫 페이지를 교체해도 앞 구간 없이 그래프가 성립한다", async () => {
  const video = await makeVideo(path.join(workspace, "lecture-4.mp4"));
  const voice = await makeVoice(path.join(workspace, "voice-4.wav"), { seconds: 2 });
  const plan = pageVoicePatchPlan({
    videoDuration: 6, targetStart: 0, targetEnd: 2,
    sourceStart: 0, sourceEnd: 2, matchAudio: true,
  });
  assert.doesNotMatch(plan.filter, /\[vpre\]/);
  const output = await patch(workspace, plan, video, voice);
  assert.ok(Math.abs(await ffprobeDuration(output) - 6) < 0.25);
});

test("마지막 페이지를 교체해도 뒤 구간 없이 그래프가 성립한다", async () => {
  const video = await makeVideo(path.join(workspace, "lecture-5.mp4"));
  const voice = await makeVoice(path.join(workspace, "voice-5.wav"), { seconds: 2 });
  const plan = pageVoicePatchPlan({
    videoDuration: 6, targetStart: 4, targetEnd: 6,
    sourceStart: 0, sourceEnd: 2, matchAudio: true,
  });
  assert.doesNotMatch(plan.filter, /\[vpost\]/);
  const output = await patch(workspace, plan, video, voice);
  assert.ok(Math.abs(await ffprobeDuration(output) - 6) < 0.25);
});

test("교체한 길이만큼 이후 타임라인이 밀린다", () => {
  // The timeline the next edit reads has to agree with the video ffmpeg made.
  const timeline = {
    totalMs: 6_000,
    entries: [
      { slideNumber: 1, startMs: 0, endMs: 2_000, transitionAtMs: 2_000, speechStartMs: 100, speechEndMs: 1_900, alignment: { words: [{ startMs: 100, endMs: 1_900 }] } },
      { slideNumber: 2, startMs: 2_000, endMs: 4_000, transitionAtMs: 4_000, speechStartMs: 2_100, speechEndMs: 3_900, alignment: { words: [{ startMs: 2_100, endMs: 3_900 }] } },
      { slideNumber: 3, startMs: 4_000, endMs: 6_000, transitionAtMs: 6_000, speechStartMs: 4_100, speechEndMs: 5_900, alignment: { words: [{ startMs: 4_100, endMs: 5_900 }] } },
    ],
  };
  const target = timeRangeForPages(timeline.entries, 2, 2);
  assert.deepEqual(target, { start: 2, end: 4 });

  const patched = patchedTimeline(timeline, 2_000, 4_000, 3_000);
  assert.equal(patched.totalMs, 7_000);
  assert.deepEqual(patched.entries.map((entry) => [entry.startMs, entry.endMs]), [
    [0, 2_000], [2_000, 5_000], [5_000, 7_000],
  ]);
  assert.equal(patched.entries[2].alignment.words[0].startMs, 5_100);
  assert.deepEqual(patched.voicePatch, {
    startMs: 2_000, endMs: 4_000, replacementDurationMs: 3_000, deltaMs: 1_000,
  });
});
