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

test('짧은 소리 제거는 선택 음성만 무음 처리하고 영상 스트림을 보존한다', async () => {
  const {muteRegionFilter} = await import('./pipeline-utils.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'tts-mute-test-'));
  try {
    const input = await makeVideo(path.join(dir,'input.mp4'), {seconds:3});
    const output = path.join(dir,'output.mp4');
    await run('ffmpeg',['-v','error','-i',input,'-map','0:v:0','-map','0:a:0','-c:v','copy','-af',muteRegionFilter(1,1.2,3),'-c:a','aac','-b:a','192k',output]);
    const hash = async file => (await run('ffmpeg',['-v','error','-i',file,'-map','0:v:0','-c','copy','-f','hash','-'])).stdout;
    assert.equal(await hash(input),await hash(output));
    assert(Math.abs(await ffprobeDuration(input)-await ffprobeDuration(output)) <= .025);
    const pcm = path.join(dir,'audio.f32');
    await run('ffmpeg',['-v','error','-i',output,'-vn','-f','f32le','-ac','1','-ar','48000',pcm]);
    const samples=await fs.readFile(pcm);
    const rms=(start,end)=>{
      let sum=0,count=0;
      for(let index=Math.round(start*48000);index<Math.round(end*48000);index++){sum+=samples.readFloatLE(index*4)**2;count++;}
      return Math.sqrt(sum/count);
    };
    assert(rms(1.03,1.17)<.0001);
    assert(rms(.8,.95)>.01 && rms(1.3,1.5)>.01);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});


test('짧은 소리 교체는 지정한 구간에만 새 음성을 넣고 나머지를 보존한다', async () => {
  const {replaceRegionPlan}=await import('./pipeline-utils.mjs');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tts-region-test-'));
  try {
    const input=await makeVideo(path.join(dir,'in.mp4'),{seconds:3});
    const voice=await makeVoice(path.join(dir,'voice.wav'),{seconds:.4});
    const output=path.join(dir,'out.mp4');
    await run('ffmpeg',['-v','error','-i',input,'-i',voice,'-filter_complex',replaceRegionPlan(1,2,3,.4),'-map','0:v:0','-map','[outa]','-c:v','copy','-c:a','aac','-b:a','192k',output]);
    assert(Math.abs(await ffprobeDuration(input)-await ffprobeDuration(output))<=.025);
    const hash=async file=>(await run('ffmpeg',['-v','error','-i',file,'-map','0:v:0','-c','copy','-f','hash','-'])).stdout;
    assert.equal(await hash(input),await hash(output));
    const inside=await meanVolume(output,1.05,.25);
    const outside=await meanVolume(output,.2,.4);
    const after=await meanVolume(output,2.2,.4);
    const padding=await meanVolume(output,1.6,.2);
    assert(inside>outside+10 && inside>after+10);
    assert(padding< -70);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
