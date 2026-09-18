import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { VIDEO_QUALITIES, captureFrameCount, videoQuality } from '../../electron-app/shared/video-quality.mjs';
import { captureEncodingArgs, captureMuxArgs, validateCaptureStream } from '../../electron-app/main/capture/encoding.mjs';
import { startScreencastEncoder } from '../../electron-app/main/capture/recorder.mjs';
const exec = promisify(execFile);
const ffmpeg = args => exec('ffmpeg', ['-v', 'error', ...args], { maxBuffer: 16 * 1024 * 1024, encoding: 'buffer' });
class Session extends EventEmitter {
  calls = [];
  async send(method, params) { this.calls.push({ method, params }); }
  frame(data, ts) { this.emit('Page.screencastFrame', { data: data.toString('base64'), metadata: { timestamp: ts / 1000 }, sessionId: 1 }); }
}
async function png(width, height, color) {
  return (await ffmpeg(['-f', 'lavfi', '-i', `color=c=${color}:s=${width}x${height}`, '-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe', '-'])).stdout;
}
function encoderArgs(output, profile) {
  return ['-y', '-v', 'error', '-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(profile.fps), '-i', 'pipe:0', ...captureEncodingArgs(profile), output];
}

// 음성 길이가 한 프레임의 배수인 강의는 드물다. 3초/75프레임 같은 딱 떨어지는
// 검사만으로는 마지막 프레임이 잘리는 것을 영영 못 잡는다. 320150ms는 실제로
// 걸렸던 ch03 레슨의 길이다. 프레임 수를 세는 문제라 해상도는 작게 둔다.
for (const durationMs of [320150, 12150, 1510]) {
  test(`${durationMs}ms 음성도 마지막 프레임까지 남긴다`, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-mux-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const profile = { ...videoQuality('standard'), width: 160, height: 90 };
    const out = path.join(dir, 'video.mp4'), audio = path.join(dir, 'track.wav');
    const totalFrames = captureFrameCount(durationMs, profile.fps);
    assert.ok(totalFrames * 1000 / profile.fps >= durationMs, '올림한 프레임이 음성 끝을 덮어야 한다');
    await ffmpeg(['-y', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${(durationMs / 1000).toFixed(3)}`, audio]);
    const frame = await png(profile.width, profile.height, 'black');
    const encoder = spawn('ffmpeg', ['-xerror', ...captureMuxArgs({ profile, totalFrames, audioFile: audio, output: out })],
      { stdio: ['pipe', 'ignore', 'ignore'] });
    for (let i = 0; i < totalFrames; i++) {
      if (!encoder.stdin.write(frame)) await new Promise(resolve => encoder.stdin.once('drain', resolve));
    }
    encoder.stdin.end();
    assert.equal(await new Promise(resolve => encoder.once('close', resolve)), 0);
    const probe = JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', out])).stdout);
    validateCaptureStream(probe, profile, totalFrames);
    const finalMs = Math.round(Number(probe.format.duration) * 1000);
    assert.ok(Math.abs(finalMs - durationMs) <= 150, `완성 길이 ${finalMs}ms가 음성 ${durationMs}ms에서 너무 멀다`);
  });
}

// 규격만 되풀이하면 어느 항목이 틀렸는지 다시 찾아야 한다.
test('규격 불일치는 어긋난 항목을 짚어 준다', () => {
  const profile = videoQuality('standard');
  const good = { codec_type: 'video', width: 1920, height: 1080, codec_name: 'h264', pix_fmt: 'yuv420p',
    avg_frame_rate: '25/1', nb_frames: '75', color_space: 'bt709', color_range: 'tv',
    color_primaries: 'bt709', color_transfer: 'bt709' };
  assert.equal(validateCaptureStream({ streams: [good] }, profile, 75), good);
  assert.throws(() => validateCaptureStream({ streams: [{ ...good, nb_frames: '74' }] }, profile, 75), /프레임 수 74 \(75 필요\)/);
  assert.throws(() => validateCaptureStream({ streams: [{ ...good, width: 3840 }] }, profile, 75), /크기 3840×1080/);
  assert.throws(() => validateCaptureStream({ streams: [{ ...good, color_transfer: undefined }] }, profile, 75), /전달함수 없음/);
  assert.throws(() => validateCaptureStream({ streams: [] }, profile, 75), /영상 스트림이 없습니다/);
});

// 알 수 없는 화질을 거절하는지는 video-quality.test.mjs가 정본으로 확인한다.

for (const profile of Object.values(VIDEO_QUALITIES)) {
  test(`${profile.id}: PNG 프레임을 실제 H.264로 합성하고 해상도·색·시각을 검증한다`, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-quality-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const out = path.join(dir, 'video.mp4');
    const session = new Session();
    const black = await png(profile.width, profile.height, 'black');
    const white = await png(profile.width, profile.height, 'white');
    const red = await png(profile.width, profile.height, 'red');
    const recorder = startScreencastEncoder({ session, ffmpegArgs: encoderArgs(out, profile), ...profile });
    try {
      const ready = recorder.ready();
      const start = Date.now();
      session.frame(black, start);
      await ready;
      recorder.begin(start, 25);
      session.frame(white, start + 400);
      session.frame(black, start + 480);
      session.frame(red, start + 800);
      const frames = await recorder.finish();
      const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', out]);
      const probe = JSON.parse(stdout);
      validateCaptureStream(probe, profile, 25);
      assert.equal(frames.written, 25);
      assert.ok(frames.duplicated > 0, '정적인 프레임을 복제해도 영상 시계는 유지해야 한다');
      assert.equal(probe.streams[0].color_primaries, 'bt709');
      // Sparse updates must not reveal the future state ahead of its 400ms timestamp.
      const pixels = (await ffmpeg(['-i', out, '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'])).stdout;
      assert.ok(pixels[0] < 5);
      assert.ok(pixels[8 * 3] < 5, "400ms의 미래 화면을 미리 보여 주면 안 된다");
      assert.ok(pixels[10 * 3] > 245);
      assert.ok(pixels[11 * 3] > 245);
      assert.ok(pixels[12 * 3] < 5);
      assert.ok(pixels[15 * 3] < 5);
      assert.ok(pixels[20 * 3] > 240 && pixels[20 * 3 + 1] < 10 && pixels[20 * 3 + 2] < 10, "RGB→BT.709 변환과 재생 색이 일치해야 한다");
      const request = session.calls.find(call => call.method === 'Page.startScreencast').params;
      assert.deepEqual([request.maxWidth, request.maxHeight], [profile.width, profile.height]);
      assert.equal(session.listenerCount('Page.screencastFrame'), 0);
      t.diagnostic(JSON.stringify({ profile: profile.id, width: probe.streams[0].width, height: probe.streams[0].height, frames: frames.written, bytes: Number(probe.format.size) }));
    } finally { await recorder.abort(); }
  });
}

test('1080p 프레임을 4K라고 포장하지 않는다', async () => {
  const profile = videoQuality('ultra'), session = new Session();
  const recorder = startScreencastEncoder({ session, ...profile, ffmpegArgs: ['-v', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-f', 'null', '-'] });
  try {
    const ready = recorder.ready();
    session.frame(await png(160, 90, 'black'), Date.now());
    await assert.rejects(ready, /3840×2160 PNG/);
  } finally { await recorder.abort(); }
});

test('첫 프레임이 오지 않으면 무한 대기하지 않는다', async () => {
  const session = new Session();
  const recorder = startScreencastEncoder({ session, readyTimeoutMs: 30, ffmpegArgs: ['-v', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-f', 'null', '-'] });
  try { await assert.rejects(recorder.ready(), /첫 촬영 프레임/); }
  finally { await recorder.abort(); }
});

test('인코더 적체가 상한을 넘으면 화질을 낮추지 않고 실패를 전달한다', async () => {
  const session = new Session();
  const recorder = startScreencastEncoder({ session, width: 160, height: 90, maxBacklogBytes: 1, ffmpegArgs: ['-v', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-f', 'null', '-'] });
  try {
    const ready = recorder.ready();
    session.frame(await png(160, 90, 'black'), Date.now());
    await ready;
    assert.throws(() => recorder.begin(Date.now(), 10), /실시간 촬영/);
    await assert.rejects(recorder.wait(1000), /실시간 촬영/);
  } finally { await recorder.abort(); }
});

test('FFmpeg의 조기 종료를 잡아 첫 프레임 대기를 중단한다', async () => {
  const recorder = startScreencastEncoder({ session: new Session(), ffmpegArgs: ['-invalid-capture-option'] });
  try { await assert.rejects(recorder.ready(), /ffmpeg 인코딩 실패/); }
  finally { await recorder.abort(); }
});

for (const event of ['Disconnected', 'Inspector.detached', 'Inspector.targetCrashed']) {
  test(`${event}: 마지막 프레임을 복제하는 대신 촬영 실패를 전달한다`, async () => {
    const session = new Session();
    const recorder = startScreencastEncoder({ session, width: 160, height: 90,
      ffmpegArgs: ['-v', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-f', 'null', '-'] });
    try {
      const ready = recorder.ready(); session.frame(await png(160, 90, 'black'), Date.now()); await ready;
      recorder.begin(Date.now(), 25);
      const waiting = recorder.wait(3000);
      session.emit(event);
      await assert.rejects(waiting, /촬영 연결이 끊겼습니다/);
      assert.equal(session.listenerCount('Page.screencastFrame'), 0);
    } finally { await recorder.abort(); }
  });
}

test('ACK 실패도 촬영 실패로 전달한다', async () => {
  const session = new Session();
  session.send = async method => { if (method === 'Page.screencastFrameAck') throw new Error('transport closed'); };
  const recorder = startScreencastEncoder({ session, width: 160, height: 90,
    ffmpegArgs: ['-v', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-f', 'null', '-'] });
  try {
    const ready = recorder.ready(); session.frame(await png(160, 90, 'black'), Date.now());
    await assert.rejects(async () => { await ready; await recorder.wait(1000); }, /수신 확인에 실패/);
  } finally { await recorder.abort(); }
});

for (const stamp of [undefined, 0, NaN, 1000]) {
  test(`신뢰할 수 없는 프레임 시각 ${String(stamp)}를 최신 화면으로 대체하지 않는다`, async () => {
    const session = new Session();
    const recorder = startScreencastEncoder({ session, width: 160, height: 90,
      ffmpegArgs: ['-v', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-f', 'null', '-'] });
    try {
      const ready = recorder.ready(); session.frame(await png(160, 90, 'black'), stamp);
      await assert.rejects(ready, /시각/);
    } finally { await recorder.abort(); }
  });
}

test('프레임 버퍼 초과 시 아직 출력하지 않은 화면을 버리지 않는다', async () => {
  const session = new Session(); const frame = await png(160, 90, 'black');
  const recorder = startScreencastEncoder({ session, width: 160, height: 90, maxBufferedFrames: 1,
    ffmpegArgs: ['-v', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-f', 'null', '-'] });
  try {
    const ready = recorder.ready(), start = Date.now(); session.frame(frame, start); await ready; recorder.begin(start, 25);
    session.frame(frame, start + 400); session.frame(frame, start + 800);
    await assert.rejects(recorder.wait(1000), /버퍼가 가득/);
  } finally { await recorder.abort(); }
});

test('정상 종료 코드라도 촬영 전 인코더가 끝나면 실패다', async () => {
  const recorder = startScreencastEncoder({ session: new Session(), ffmpegArgs: ['-version'] });
  try { await assert.rejects(recorder.ready(), /ffmpeg 인코딩 실패.*code 0/); }
  finally { await recorder.abort(); }
});

test('준비 명령이 응답하지 않아도 중지하면 준비 대기도 즉시 끝난다', { timeout: 3000 }, async () => {
  const session = new Session();
  session.send = method => method === 'Page.enable' ? new Promise(() => {}) : Promise.resolve();
  const recorder = startScreencastEncoder({ session,
    ffmpegArgs: ['-v', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-f', 'null', '-'] });
  const stopped = assert.rejects(recorder.ready(), /중단/);
  await recorder.abort(); await stopped;
});

test('되돌아갈 수 없을 만큼 큰 시각 역전을 탐지한다', async () => {
  const session = new Session(), frame = await png(160, 90, 'black');
  const recorder = startScreencastEncoder({ session, width: 160, height: 90,
    ffmpegArgs: ['-v', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-f', 'null', '-'] });
  try {
    const ready = recorder.ready(), start = Date.now(); session.frame(frame, start); await ready; recorder.begin(start, 25);
    session.frame(frame, start - 1000);
    await assert.rejects(recorder.wait(1000), /역전/);
  } finally { await recorder.abort(); }
});

// 브라우저는 PNG 인코딩을 병렬로 돌려 완료 순서대로 프레임을 보낸다. 1ms도 안 되게
// 떨어진 두 프레임이 뒤바뀌어 도착하는 일이 실제 1440p 촬영에서 나온다.
test('순서가 뒤바뀐 프레임은 도착 순서가 아니라 자기 시각에 놓는다', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-reorder-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'video.mp4');
  const profile = videoQuality('standard'), session = new Session();
  const black = await png(profile.width, profile.height, 'black');
  const white = await png(profile.width, profile.height, 'white');
  const recorder = startScreencastEncoder({ session, ffmpegArgs: encoderArgs(out, profile), ...profile });
  try {
    const ready = recorder.ready(), start = Date.now();
    session.frame(black, start); await ready; recorder.begin(start, 25);
    // 흰 화면이 먼저 도착하지만 실제로는 0.8ms 뒤에 찍혔다.
    session.frame(white, start + 400);
    session.frame(black, start + 399.2);
    const frames = await recorder.finish();
    assert.equal(frames.written, 25);
    assert.equal(frames.reordered, 1, '역전 도착을 실패가 아니라 재정렬로 세어야 한다');
    const pixels = (await ffmpeg(['-i', out, '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'])).stdout;
    assert.ok(pixels[8 * 3] < 5, '400ms의 미래 화면을 미리 보여 주면 안 된다');
    assert.ok(pixels[10 * 3] > 245, '늦게 도착한 옛 프레임이 최신 화면을 되돌리면 안 된다');
    assert.ok(pixels[24 * 3] > 245);
  } finally { await recorder.abort(); }
});

// 브라우저는 확인 응답을 받아야 다음 화면을 잡는다. 바로 응답하면 두세 장을 몰아
// 잡고 인코딩하는 동안 멈춰, 4K에서는 출력 슬롯의 절반이 새 화면 없이 남는다.
test('확인 응답을 한 프레임 간격보다 촘촘하게 보내지 않는다', async () => {
  const session = new Session(), frame = await png(160, 90, 'black');
  const acks = [];
  const send = session.send.bind(session);
  session.send = async (method, params) => { if (method === 'Page.screencastFrameAck') acks.push(performance.now()); return send(method, params); };
  const recorder = startScreencastEncoder({ session, width: 160, height: 90, fps: 25,
    ffmpegArgs: ['-v', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-f', 'null', '-'] });
  try {
    const ready = recorder.ready(), start = Date.now();
    session.frame(frame, start); await ready; recorder.begin(start, 25);
    for (let i = 1; i <= 4; i++) session.frame(frame, start + i);
    await recorder.wait(250);
    assert.equal(acks.length, 5, '몰아 보낸 프레임도 모두 응답해야 한다');
    for (let i = 1; i < acks.length; i++) {
      assert.ok(acks[i] - acks[i - 1] > 25, `${i}번째 응답이 ${(acks[i] - acks[i - 1]).toFixed(1)}ms 만에 나갔다`);
    }
  } finally { await recorder.abort(); }
});

// 시각이 이미 기록한 프레임보다 오래됐다면 어떤 출력 시각도 이길 수 없다.
test('이미 기록한 시각보다 오래된 프레임은 버려도 영상 시계를 지킨다', async () => {
  const session = new Session(), frame = await png(160, 90, 'black');
  const recorder = startScreencastEncoder({ session, width: 160, height: 90,
    ffmpegArgs: ['-v', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-f', 'null', '-'] });
  try {
    const ready = recorder.ready(), start = Date.now();
    session.frame(frame, start); await ready; recorder.begin(start, 5);
    session.frame(frame, start + 50);
    await recorder.wait(300);
    session.frame(frame, start + 25);
    await recorder.wait(60);
    const frames = await recorder.finish();
    assert.equal(frames.written, 5);
    assert.equal(frames.superseded, 1);
    assert.equal(session.calls.filter(call => call.method === 'Page.screencastFrameAck').length, 3,
      '버린 프레임도 확인해 주어야 브라우저가 계속 보낸다');
  } finally { await recorder.abort(); }
});
