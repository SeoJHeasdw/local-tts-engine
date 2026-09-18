import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ffmpegErrorText, parseAvfoundationDevices, parseDisplaySize, resolveDevice, screenDevices } from '../../electron-app/main/capture/displays.mjs';
import {
  avfoundationInput, createProgressReader, displayProfile, recordArgs, recordingChecks, recordingWarnings,
  silentTrackArgs, startDisplayRecording,
} from '../../electron-app/main/capture/record-display.mjs';
import { captureEncodingArgs } from '../../electron-app/main/capture/encoding.mjs';

const exec = promisify(execFile);

// M4 Max, macOS 26.7, ffmpeg 8.1.1에서 실제로 받은 출력이다.
const LIST_DEVICES = `[AVFoundation indev @ 0x971020140] AVFoundation video devices:
[AVFoundation indev @ 0x971020140] [0] MacBook Pro 카메라
[AVFoundation indev @ 0x971020140] [1] MacBook Pro 데스크뷰 카메라
[AVFoundation indev @ 0x971020140] [2] Capture screen 0
[AVFoundation indev @ 0x971020140] [3] Capture screen 1
[AVFoundation indev @ 0x971020140] AVFoundation audio devices:
[AVFoundation indev @ 0x971020140] [0] MacBook Pro 마이크
[AVFoundation indev @ 0x971020140] [1] Microsoft Teams Audio
[in#0 @ 0x971020000] Error opening input: Input/output error
Error opening input file .
Error opening input files: Input/output error
`;

const PROBE_STDERR = `Input #0, avfoundation, from '2:none':
  Duration: N/A, start: 109140.109500, bitrate: N/A
  Stream #0:0: Video: rawvideo (BGR[0] / 0x524742), bgr0, 3456x2234, 1000k tbr, 1000k tbn, start 109140.109500
Stream mapping:
  Stream #0:0 -> #0:0 (rawvideo (native) -> mjpeg (native))
Output #0, image2pipe, to 'pipe:1':
  Stream #0:0: Video: mjpeg, yuv444p(pc, progressive), 480x310, q=2-31, 200 kb/s, 1000k fps, 1000k tbn
`;

test('avfoundation 목록에서 화면과 입력 장치를 이름으로 읽는다', () => {
  const devices = parseAvfoundationDevices(LIST_DEVICES);
  assert.deepEqual(devices.audio, [{ index: 0, name: 'MacBook Pro 마이크' }, { index: 1, name: 'Microsoft Teams Audio' }]);
  assert.equal(devices.video.length, 4);
  assert.deepEqual(screenDevices(devices), [{ index: 2, name: 'Capture screen 0' }, { index: 3, name: 'Capture screen 1' }],
    '카메라는 화면 목록에 넣지 않는다');
  assert.equal(resolveDevice(screenDevices(devices), 'Capture screen 1', '화면'), 3);
  assert.equal(resolveDevice(devices.audio, 'MacBook Pro 마이크', '입력 장치'), 0);
  assert.throws(() => resolveDevice(screenDevices(devices), 'Capture screen 2', '화면'), /Capture screen 2.*찾지 못했습니다/);
});

test('1프레임 촬영에서 썸네일이 아닌 원본 크기를 읽는다', () => {
  assert.deepEqual(parseDisplaySize(PROBE_STDERR), { width: 3456, height: 2234 });
  assert.equal(parseDisplaySize('Error opening input'), null);
});

test('화면 입력을 열 때마다 찍히는 objc 경고는 오류 설명에서 뺀다', () => {
  const text = ffmpegErrorText("objc[23817]: class `NSKVONotifying_AVCaptureScreenInput' not linked into application\n진짜 원인\n");
  assert.equal(text, '진짜 원인');
});

test('녹화 명령은 덱 촬영 규격을 소스 크기 그대로 쓰고 음성 포함 여부만 바꾼다', () => {
  const profile = displayProfile({ width: 1920, height: 1080 });
  assert.deepEqual(profile, { id: 'display', width: 1920, height: 1080, fps: 25, crf: 16 });
  assert.throws(() => displayProfile({ width: 1921, height: 1080 }), /짝수/);

  const silent = recordArgs({ input: avfoundationInput({ screenIndex: 3 }), profile, withAudio: false, output: 'x.part' });
  assert.equal(silent[silent.indexOf('-i') + 1], '3:none');
  assert.ok(silent.includes('-an'));
  assert.equal(silent[silent.indexOf('-pixel_format') + 1], 'bgr0', 'RGB full → BT.709 limited 변환이 덱과 같아야 한다');
  const encoding = captureEncodingArgs(profile);
  assert.deepEqual(silent.slice(silent.indexOf(encoding[0]), silent.indexOf(encoding[0]) + encoding.length), encoding);
  assert.deepEqual(silent.slice(-5), ['-f', 'mp4', '-movflags', '+faststart', 'x.part']);

  const voiced = recordArgs({ input: avfoundationInput({ screenIndex: 3, audioIndex: 0 }), profile, withAudio: true, output: 'x.part' });
  assert.equal(voiced[voiced.indexOf('-i') + 1], '3:0');
  assert.ok(!voiced.includes('-an'));
  assert.deepEqual(voiced.slice(voiced.indexOf('-c:a'), voiced.indexOf('-c:a') + 8), ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '1']);

  const mux = silentTrackArgs({ input: 'v.part', durationSeconds: 5.04, output: 'a.part' });
  assert.equal(mux[mux.indexOf('-t') + 1], '5.040');
  assert.equal(mux[mux.indexOf('-c:v') + 1], 'copy', '무음을 붙이며 영상을 다시 인코딩하지 않는다');
});

test('진행 기록은 줄 중간에서 끊겨 와도 묶음 단위로 읽는다', () => {
  const blocks = [];
  const read = createProgressReader(block => blocks.push(block));
  const text = 'frame=0\ndup_frames=0\ndrop_frames=0\nprogress=continue\nframe=126\nfps=24.42\ndup_frames=2\ndrop_frames=1\nprogress=end\n';
  for (let i = 0; i < text.length; i += 7) read(text.slice(i, i + 7));
  assert.deepEqual(blocks, [{ frames: 0, dup: 0, drop: 0, end: false }, { frames: 126, dup: 2, drop: 1, end: true }]);
});

test('누락·조기 종료는 완료로 두되 경고로 남긴다', () => {
  assert.deepEqual(recordingWarnings({ dup: 0, drop: 0, stoppedByUser: true }), []);
  assert.match(recordingWarnings({ dup: 3, drop: 1, stoppedByUser: true })[0], /복제 3 · 누락 1/);
  assert.match(recordingWarnings({ stoppedByUser: false })[0], /정지하기 전에/);
});

test('음성이 먼저 끊긴 녹화는 검사에서 걸린다', () => {
  const profile = displayProfile({ width: 320, height: 180 });
  const video = { codec_type: 'video', width: 320, height: 180, codec_name: 'h264', pix_fmt: 'yuv420p',
    avg_frame_rate: '25/1', nb_frames: '202', color_space: 'bt709', color_range: 'tv', color_primaries: 'bt709', color_transfer: 'bt709' };
  const audio = (seconds, frames = Math.ceil(seconds * 48000 / 1024) + 1) => ({ codec_type: 'audio', codec_name: 'aac',
    sample_rate: '48000', channels: 1, duration: String(seconds), nb_frames: String(frames) });
  const check = (checks, label) => checks.find(item => item.label === label);
  assert.ok(recordingChecks({ streams: [video, audio(8.08)] }, profile, 8080).every(item => item.ok));
  const cut = recordingChecks({ streams: [video, audio(5.35)] }, profile, 8080);
  assert.equal(check(cut, '음성 길이 = 영상 길이').ok, false);
  assert.match(check(cut, '음성 길이 = 영상 길이').detail, /영상 8080ms · 음성 5350ms/);
});

// 트랙 길이는 맞는데 중간 소리가 빠진 녹음. 이 Mac의 마이크 녹음에서 실제로 나온 값이다:
// 10.6초 영상, 음성 트랙 10.609초, AAC 431프레임(9.19초 분량).
test('중간에 소리가 빠진 녹음은 트랙 길이가 맞아도 걸린다', () => {
  const profile = displayProfile({ width: 1920, height: 1080 });
  const video = { codec_type: 'video', width: 1920, height: 1080, codec_name: 'h264', pix_fmt: 'yuv420p',
    avg_frame_rate: '25/1', nb_frames: '265', color_space: 'bt709', color_range: 'tv', color_primaries: 'bt709', color_transfer: 'bt709' };
  const mic = { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 1, duration: '10.609000', nb_frames: '431' };
  const checks = recordingChecks({ streams: [video, mic] }, profile, 10600);
  assert.equal(checks.find(item => item.label === '음성 길이 = 영상 길이').ok, true);
  const gaps = checks.find(item => item.label === '음성 끊김 없음');
  assert.equal(gaps.ok, false);
  assert.equal(gaps.detail, '담긴 소리 9195ms · 영상 10600ms');
  // 무음 트랙을 붙인 실제 녹음(10.6초, 498프레임)은 통과한다.
  const silent = { ...mic, duration: '10.600000', nb_frames: '498' };
  assert.ok(recordingChecks({ streams: [video, silent] }, profile, 10600).every(item => item.ok));
});

// 화면 대신 실시간 합성 영상을 넣고 녹화 경로 전체를 실제 ffmpeg로 돈다.
// 화면 기록 권한이 없어도 정지·무음 트랙·검증·보고서·임시 파일 정리를 확인할 수 있다.
function syntheticSource(extra = {}) {
  return async () => ({
    input: ['-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25,format=bgr0'],
    profile: displayProfile({ width: 320, height: 180 }), withAudio: false,
    display: { name: 'Capture screen 9', width: 320, height: 180 }, audioDevice: null, ...extra,
  });
}

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'record-display-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return path.join(root, '2026-09-18', 'bob-demo');
}

test('정지하면 영상 길이에 맞춘 무음 트랙을 붙여 결과와 보고서를 남긴다', { timeout: 30_000 }, async t => {
  const outDir = await workspace(t);
  const events = [];
  const session = startDisplayRecording({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', outDir, name: 'bob-demo',
    prepare: syntheticSource(), onEvent: event => {
      events.push(event.phase);
      if (event.phase === 'recording') setTimeout(session.stop, 1500);
    } });
  const report = await session.done;
  assert.deepEqual(events, ['recording', 'finishing']);
  assert.equal(report.operation, 'record-display');
  assert.equal(report.summary.ok, true, JSON.stringify(report.checks));
  assert.deepEqual(report.target, { root: 'edit', day: '2026-09-18', name: 'bob-demo' });
  assert.deepEqual(report.warnings, []);
  assert.equal(report.frames.stoppedByUser, true);
  assert.ok(report.durationMs >= 1000, `${report.durationMs}ms`);
  assert.deepEqual((await fs.readdir(outDir)).sort(), ['bob-demo.mp4', 'bob-demo.mp4.capture.json', 'validation-report.json'],
    '임시 .part 파일이 남지 않는다');
  const probe = JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', report.videoPath])).stdout);
  const [video, audio] = ['video', 'audio'].map(type => probe.streams.find(stream => stream.codec_type === type));
  assert.equal(Number(video.nb_frames), report.durationMs / 40);
  assert.equal(audio.duration, video.duration, '무음 트랙이 영상과 같은 길이에서 끝난다');
  const capture = JSON.parse(await fs.readFile(`${report.videoPath}.capture.json`, 'utf8'));
  assert.match(capture.fileSha256, /^[0-9a-f]{64}$/);
  assert.equal(capture.profile.id, 'display');
});

test('취소하면 이번 녹화가 만든 파일을 모두 지운다', { timeout: 30_000 }, async t => {
  const outDir = await workspace(t);
  const session = startDisplayRecording({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', outDir, name: 'bob-demo',
    prepare: syntheticSource(), onEvent: event => { if (event.phase === 'recording') setTimeout(session.cancel, 800); } });
  await assert.rejects(session.done, /녹화를 취소/);
  assert.deepEqual(await fs.readdir(outDir), []);
  assert.equal(session.stop(), false, '취소한 녹화는 정지할 수 없다');
});

test('정해 둔 길이가 되면 스스로 정지한다', { timeout: 30_000 }, async t => {
  const outDir = await workspace(t);
  const session = startDisplayRecording({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', outDir, name: 'bob-demo',
    prepare: syntheticSource(), maxDurationMs: 1000 });
  const report = await session.done;
  assert.equal(report.summary.ok, true);
  assert.equal(report.frames.stoppedByUser, true);
});

test('같은 이름의 녹화가 있으면 덮어쓰지 않는다', { timeout: 30_000 }, async t => {
  const outDir = await workspace(t);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'bob-demo.mp4'), 'previous');
  const session = startDisplayRecording({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', outDir, name: 'bob-demo', prepare: syntheticSource() });
  await assert.rejects(session.done, /이미 있습니다/);
  assert.equal(await fs.readFile(path.join(outDir, 'bob-demo.mp4'), 'utf8'), 'previous');
});
