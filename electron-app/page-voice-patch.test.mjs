import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  clipTimeline,
  concatTimelines,
  pageVoicePatchPlan,
  pageVoicePatchesPlan,
  patchedTimeline,
  timeRangeForPages,
} from "./pipeline-utils.mjs";

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

/** Run a batched plan, stream-copying the picture when the plan says it is untouched. */
async function patchAll(directory, plan, video, voices, name) {
  const output = path.join(directory, name);
  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", video, ...voices.flatMap((voice) => ["-i", voice]),
    "-filter_complex", plan.filter,
    "-map", plan.videoOutput, "-map", plan.audioOutput,
    ...(plan.videoUnchanged
      ? ["-c:v", "copy"]
      : ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]),
    "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", output,
  ]);
  return output;
}

/** Hash of the video stream alone, to prove the picture was carried through untouched. */
async function videoStreamHash(file) {
  const { stdout } = await run("ffmpeg", [
    "-v", "error", "-i", file, "-map", "0:v:0", "-c", "copy", "-f", "hash", "-",
  ]);
  return stdout;
}

test("여러 페이지를 한 번에 교체해도 각 구간에만 새 목소리가 들어간다", async () => {
  // Fixing pages one at a time re-encoded the whole lecture once per page. The
  // batch has to land every patch in its own span and leave the gaps alone.
  const video = await makeVideo(path.join(workspace, "multi.mp4"), { seconds: 8 });
  const first = await makeVoice(path.join(workspace, "multi-voice-1.wav"), { seconds: 1 });
  const second = await makeVoice(path.join(workspace, "multi-voice-2.wav"), { seconds: 1 });
  const plan = pageVoicePatchesPlan({
    videoDuration: 8,
    matchAudio: false,
    patches: [
      { targetStart: 2, targetEnd: 3, sourceStart: 0, sourceEnd: 1, input: 1 },
      { targetStart: 5, targetEnd: 6, sourceStart: 0, sourceEnd: 1, input: 2 },
    ],
  });
  const output = await patchAll(workspace, plan, video, [first, second], "multi-out.mp4");

  assert.ok(Math.abs(await ffprobeDuration(output) - 8) < 0.25);
  const patchedOne = await meanVolume(output, 2.2, 0.6);
  const patchedTwo = await meanVolume(output, 5.2, 0.6);
  const gap = await meanVolume(output, 3.6, 0.8);
  const head = await meanVolume(output, 0.4, 1.2);
  const tail = await meanVolume(output, 6.6, 1.0);
  assert.ok(patchedOne > gap + 8, `첫 구간에 새 목소리가 없다 (${patchedOne} vs ${gap})`);
  assert.ok(patchedTwo > gap + 8, `둘째 구간에 새 목소리가 없다 (${patchedTwo} vs ${gap})`);
  assert.ok(patchedOne > head + 8, `앞 구간이 오염됐다 (${patchedOne} vs ${head})`);
  assert.ok(patchedTwo > tail + 8, `뒤 구간이 오염됐다 (${patchedTwo} vs ${tail})`);
  assert.ok(Math.abs(head - gap) < 6, `사이 구간이 원본과 달라졌다 (${gap} vs ${head})`);
});

test("화면 길이를 유지하면 영상 스트림을 다시 굽지 않고 그대로 넘긴다", async () => {
  // The picture is being cut apart and glued back together unchanged, so
  // re-encoding it costs minutes of 1080p x264 and changes nothing. The plan
  // has to say so, and the copied stream has to be bit-identical.
  const video = await makeVideo(path.join(workspace, "copy.mp4"), { seconds: 8 });
  const voice = await makeVoice(path.join(workspace, "copy-voice.wav"), { seconds: 1 });
  const plan = pageVoicePatchesPlan({
    videoDuration: 8,
    matchAudio: false,
    patches: [
      { targetStart: 2, targetEnd: 3, sourceStart: 0, sourceEnd: 1, input: 1 },
      { targetStart: 5, targetEnd: 6, sourceStart: 0, sourceEnd: 1, input: 1 },
    ],
  });

  assert.equal(plan.videoUnchanged, true);
  assert.equal(plan.videoOutput, "0:v:0");
  assert.doesNotMatch(plan.filter, /\[0:v]/);

  const output = await patchAll(workspace, plan, video, [voice], "copy-out.mp4");
  assert.equal(await videoStreamHash(output), await videoStreamHash(video));
});

test("새 음성이 길면 영상을 다시 굽고 늘어난 만큼 전체가 길어진다", async () => {
  const video = await makeVideo(path.join(workspace, "stretch.mp4"), { seconds: 8 });
  const first = await makeVoice(path.join(workspace, "stretch-1.wav"), { seconds: 2 });
  const second = await makeVoice(path.join(workspace, "stretch-2.wav"), { seconds: 2 });
  const plan = pageVoicePatchesPlan({
    videoDuration: 8,
    matchAudio: true,
    patches: [
      { targetStart: 2, targetEnd: 3, sourceStart: 0, sourceEnd: 2, input: 1 },
      { targetStart: 5, targetEnd: 6, sourceStart: 0, sourceEnd: 2, input: 2 },
    ],
  });

  assert.equal(plan.videoUnchanged, false);
  assert.equal(plan.videoOutput, "[vout]");
  // pre, mid0, gap, mid1, post
  assert.match(plan.filter, /concat=n=5:v=1:a=0\[vout]/);

  const output = await patchAll(workspace, plan, video, [first, second], "stretch-out.mp4");
  assert.ok(Math.abs(await ffprobeDuration(output) - 10) < 0.35);
});

test("겹치는 페이지 구간은 조용히 재배열하지 않고 거부한다", () => {
  assert.throws(() => pageVoicePatchesPlan({
    videoDuration: 8,
    patches: [
      { targetStart: 2, targetEnd: 5, sourceStart: 0, sourceEnd: 1, input: 1 },
      { targetStart: 4, targetEnd: 6, sourceStart: 0, sourceEnd: 1, input: 2 },
    ],
  }), /겹칩니다/);
});

test("여러 구간을 교체해도 타임라인은 뒤에서부터 접어 원래 좌표를 지킨다", () => {
  // Each patch shifts everything after it, so applying them back-to-front keeps
  // the earlier patches' original coordinates valid.
  const timeline = {
    totalMs: 8_000,
    entries: [
      { slideNumber: 1, startMs: 0, endMs: 2_000, transitionAtMs: 2_000, speechStartMs: 100, speechEndMs: 1_900, alignment: { words: [] } },
      { slideNumber: 2, startMs: 2_000, endMs: 3_000, transitionAtMs: 3_000, speechStartMs: 2_100, speechEndMs: 2_900, alignment: { words: [] } },
      { slideNumber: 3, startMs: 3_000, endMs: 5_000, transitionAtMs: 5_000, speechStartMs: 3_100, speechEndMs: 4_900, alignment: { words: [] } },
      { slideNumber: 4, startMs: 5_000, endMs: 6_000, transitionAtMs: 6_000, speechStartMs: 5_100, speechEndMs: 5_900, alignment: { words: [] } },
      { slideNumber: 5, startMs: 6_000, endMs: 8_000, transitionAtMs: 8_000, speechStartMs: 6_100, speechEndMs: 7_900, alignment: { words: [] } },
    ],
  };
  const patches = [
    { startMs: 2_000, endMs: 3_000, replacementMs: 2_000 },
    { startMs: 5_000, endMs: 6_000, replacementMs: 2_000 },
  ];
  let patched = timeline;
  for (const patch of [...patches].reverse()) {
    patched = patchedTimeline(patched, patch.startMs, patch.endMs, patch.replacementMs);
  }
  assert.equal(patched.totalMs, 10_000);
  assert.deepEqual(patched.entries.map((entry) => [entry.startMs, entry.endMs]), [
    [0, 2_000], [2_000, 4_000], [4_000, 6_000], [6_000, 8_000], [8_000, 10_000],
  ]);
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

// A lecture split into lessons is joined back into a chapter, and a chapter is
// trimmed down to a range. Both used to throw the page boundaries away, which
// silently ended the video's life as something the app could repair.
function lessonTimeline(pages, msPerPage, firstPage) {
  return {
    totalMs: pages * msPerPage,
    entries: Array.from({ length: pages }, (_, index) => ({
      slideNumber: firstPage + index,
      startMs: index * msPerPage,
      endMs: (index + 1) * msPerPage,
      transitionAtMs: (index + 1) * msPerPage,
      speechStartMs: index * msPerPage + 100,
      speechEndMs: (index + 1) * msPerPage - 100,
      alignment: { words: [{ startMs: index * msPerPage + 100, endMs: index * msPerPage + 400 }] },
    })),
  };
}

test("레슨 영상을 이어 붙이면 페이지 경계가 이어져 계속 다듬을 수 있다", () => {
  const joined = concatTimelines([
    { timeline: lessonTimeline(3, 2_000, 1), durationMs: 6_000 },
    { timeline: lessonTimeline(2, 2_000, 4), durationMs: 4_000 },
    { timeline: lessonTimeline(2, 2_000, 6), durationMs: 4_000 },
  ]);

  assert.equal(joined.totalMs, 14_000);
  assert.deepEqual(joined.entries.map((entry) => entry.slideNumber), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(
    joined.entries.map((entry) => [entry.startMs, entry.endMs]),
    [[0, 2_000], [2_000, 4_000], [4_000, 6_000], [6_000, 8_000], [8_000, 10_000], [10_000, 12_000], [12_000, 14_000]],
  );
  // 이어 붙인 뒤에도 각 페이지의 시각이 실제 영상 위치를 가리켜야 교체가 맞는
  // 자리에 들어간다.
  assert.equal(joined.entries[3].speechStartMs, 6_100);
  assert.equal(joined.entries[3].alignment.words[0].startMs, 6_100);
});

test("타임라인이 없는 영상이 섞여도 뒤 영상의 시각이 밀리지 않는다", () => {
  const joined = concatTimelines([
    { timeline: null, durationMs: 5_000 },
    { timeline: lessonTimeline(2, 2_000, 1), durationMs: 4_000 },
  ]);

  assert.equal(joined.totalMs, 9_000);
  assert.deepEqual(joined.entries.map((entry) => [entry.startMs, entry.endMs]), [[5_000, 7_000], [7_000, 9_000]]);
});

test("자른 영상은 남은 구간의 페이지만 0부터 다시 센다", () => {
  const clipped = clipTimeline(lessonTimeline(5, 2_000, 10), 4_000, 8_000);

  assert.equal(clipped.totalMs, 4_000);
  assert.deepEqual(clipped.entries.map((entry) => entry.slideNumber), [12, 13]);
  assert.deepEqual(clipped.entries.map((entry) => [entry.startMs, entry.endMs]), [[0, 2_000], [2_000, 4_000]]);
});

test("경계에 걸친 페이지는 버리지 않고 남는 만큼으로 줄인다", () => {
  // 페이지 한가운데를 자르면 그 페이지는 잘린 채로라도 남아야, 대본과 화면이
  // 있는 구간이 타임라인에서 사라지지 않는다.
  const clipped = clipTimeline(lessonTimeline(4, 2_000, 1), 1_000, 5_000);

  assert.deepEqual(clipped.entries.map((entry) => entry.slideNumber), [1, 2, 3]);
  assert.deepEqual(clipped.entries.map((entry) => [entry.startMs, entry.endMs]), [[0, 1_000], [1_000, 3_000], [3_000, 4_000]]);
  assert.equal(clipped.totalMs, 4_000);
});

test("남는 구간에 페이지가 하나도 없으면 타임라인을 만들지 않는다", () => {
  assert.equal(clipTimeline(lessonTimeline(2, 2_000, 1), 9_000, 10_000), null);
  assert.equal(clipTimeline({ entries: [] }, 0, 1_000), null);
  assert.equal(concatTimelines([{ timeline: null, durationMs: 1_000 }]), null);
});

// 클립 하나에 구간을 주면 자르기, 여럿을 구간 없이 담으면 합치기다. 편집기와
// 다듬기의 간단 기능이 같은 경로를 쓰므로, 원본을 그대로 복사한 구간과 잘라서
// 다시 구운 구간이 한 파일로 이어 붙는지가 이 모델 전체의 전제다.
test("자른 클립과 그대로 쓰는 클립을 섞어도 한 영상으로 이어 붙는다", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compose-"));
  try {
    const spec = (file, seconds, tone) => run("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `testsrc=size=320x240:rate=25:duration=${seconds}`,
      "-f", "lavfi", "-i", `sine=frequency=${tone}:duration=${seconds}:sample_rate=48000`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "96k", "-ar", "48000", "-shortest", file,
    ]).then(() => file);

    const whole = await spec(path.join(dir, "whole.mp4"), 4, 300);
    const source = await spec(path.join(dir, "source.mp4"), 6, 900);

    // 잘라 쓰는 클립만 다시 굽는다. -ss 를 -i 뒤에 두어 정확한 프레임에서 자른다.
    const cut = path.join(dir, "cut.mp4");
    await run("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error", "-i", source, "-ss", "2.000",
      "-map", "0:v:0", "-map", "0:a:0",
      "-vf", "scale=320:240,fps=25,format=yuv420p", "-af", "aresample=48000",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-b:a", "96k", "-ar", "48000",
      "-t", "2.000", "-movflags", "+faststart", cut,
    ]);

    const concatPath = path.join(dir, "concat.txt");
    await fs.writeFile(concatPath, `file '${whole}'\nfile '${cut}'\n`, "utf8");
    const output = path.join(dir, "out.mp4");
    await run("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "concat", "-safe", "0", "-i", concatPath,
      "-c", "copy", "-movflags", "+faststart", output,
    ]);

    assert.ok(Math.abs(await ffprobeDuration(output) - 6) < 0.3, "통클립 4초 + 자른 클립 2초");
    const streams = await ffprobeStreams(output);
    assert.ok(streams.some((stream) => stream.codec_type === "video"));
    assert.ok(streams.some((stream) => stream.codec_type === "audio"));

    // 앞은 원본 300Hz, 뒤는 잘라 온 900Hz 여야 순서가 맞다.
    const head = await meanVolume(output, 1.0, 1.5);
    const tail = await meanVolume(output, 4.5, 1.0);
    assert.ok(tail > head + 8, `클립 순서가 어긋났다 (${head} vs ${tail})`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
