import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createMediaService } from '../../electron-app/main/media.mjs';
import { createEditingComposeService } from '../../electron-app/main/editing/compose.mjs';
import { createEditingPagesService } from '../../electron-app/main/editing/pages.mjs';

const execute = promisify(execFile);
const ffmpeg = args => execute('ffmpeg', ['-v', 'error', ...args], { timeout: 30000 });
const probe = async file => JSON.parse((await execute('ffprobe', [
  '-v', 'error', '-show_format', '-show_streams', '-of', 'json', file,
])).stdout);

function appMethods(records = {}) {
  const calls = [];
  const dependencies = {
    chosenRecord: token => records[token],
    requireRuntimeTool: name => name,
    runUtility: async (command, args) => (await execute(command, args)).stdout,
    runProcess: async (stage, command, args) => {
      calls.push(args);
      await execute(command, args, { timeout: 30000, maxBuffer: 2_000_000 });
    },
    ffprobe: probe,
    emit() {},
  };
  const media = createMediaService(dependencies);
  const compose = createEditingComposeService({ ...dependencies, inspectMedia: media.inspectMedia });
  const pages = createEditingPagesService({ ...dependencies, inspectMedia: media.inspectMedia, validateEditVideo: compose.validateEditVideo });
  return { ...compose, ...pages, calls };
}

async function workspace(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tts-edit-regression-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('앱에서 규격이 맞는 전체 영상은 합칠 때 재인코딩하지 않는다', async t => {
  const directory = await workspace(t);
  const input = path.join(directory, 'lecture.mp4');
  await ffmpeg([
    '-f', 'lavfi', '-i', 'color=c=blue:s=1920x1080:r=25:d=0.4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', input,
  ]);
  const app = appMethods({ video: { path: input, name: 'lecture.mp4' } });
  const out = path.join(directory, 'out');
  await fs.mkdir(out);
  const report = await app.runComposeEdit({ name: 'joined', clips: [{ videoToken: 'video' }] }, out);
  assert.equal(report.videoReencoded, false);
  assert.equal(app.calls.length, 0, '전체 클립 하나는 원본 파일 복사로 끝나야 한다');
  assert.deepEqual(await fs.readFile(report.videoPath), await fs.readFile(input));
  const mergedOut = path.join(directory, 'merged');
  await fs.mkdir(mergedOut);
  const merged = await app.runComposeEdit({
    name: 'joined', clips: [{ videoToken: 'video' }, { videoToken: 'video' }],
  }, mergedOut);
  assert.equal(merged.videoReencoded, false);
  assert.equal(app.calls.length, 1, '두 전체 클립은 스트림 복사로 한 번만 이어 붙인다');
  assert.equal(app.calls[0][app.calls[0].indexOf('-c') + 1], 'copy');
  assert.ok(Math.abs(merged.durationMs - 800) < 50);
});

for (const hasAudio of [false, true]) {
test(`음성 트랙 ${hasAudio ? '있는' : '없는'} 영상도 지정한 시작 프레임에서 자른다`, async t => {
  const directory = await workspace(t);
  const input = path.join(directory, 'silent.mp4');
  await ffmpeg([
    '-f', 'lavfi', '-i', "color=c=red:s=160x90:r=25:d=2,drawbox=color=blue:t=fill:enable='gte(t,1)'",
    ...(hasAudio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2'] : []),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', input,
  ]);
  const output = path.join(directory, 'cut.mp4');
  await appMethods().normalizeMergeSegment(input, output, { startSeconds: 1, durationSeconds: 0.4 });
  const { stdout: pixel } = await execute('ffmpeg', [
    '-v', 'error', '-i', output, '-frames:v', '1', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1',
  ], { encoding: 'buffer' });
  assert.ok(pixel[2] > pixel[0] + 100, `1초의 파란 프레임이어야 함: ${[...pixel]}`);
  const media = await probe(output);
  assert.ok(media.streams.some(stream => stream.codec_type === 'audio'));
  assert.ok(Math.abs(Number(media.format.duration) - 0.4) < 0.05);
});
}

for (const [mode, fit] of [['single', 'match-audio'], ['batch', 'match-audio'], ['single', 'keep-video'], ['batch', 'keep-video']]) {
  test(`페이지 음성 교체(${mode}, ${fit})는 다른 구간의 검수·확인 표시·자막을 보존한다`, async t => {
    const directory = await workspace(t);
    const input = path.join(directory, 'lecture.mp4');
    const audio = path.join(directory, 'voice.wav');
    await ffmpeg([
      '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=25:d=6',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', input,
    ]);
    await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=1.4', audio]);
    const timeline = { totalMs: 6000, entries: Array.from({ length: 6 }, (_, i) => ({
      slideNumber: i + 1, startMs: i * 1000, endMs: (i + 1) * 1000,
    })) };
    const original = {
      videoPath: input,
      voiceFindings: [
        { slideNumber: 1, startMs: 100, endMs: 500, severity: 'warning', reasons: ['앞쪽 경고'] },
        { slideNumber: 2, startMs: 1100, endMs: 1500, severity: 'failed', recognizedText: '옛 받아쓰기' },
        { slideNumber: 4, startMs: 3100, endMs: 3500, severity: 'failed', recognizedText: '옛 받아쓰기' },
        { slideNumber: 6, startMs: 5100, endMs: 5500, severity: 'warning', reasons: ['뒤쪽 경고'] },
      ],
      review: { status: 'approved', clearedFindings: ['1:100', '2:1100', '6:5100'] },
    };
    const captions = [
      { startMs: 100, endMs: 500, text: '첫 문장' },
      { startMs: 1200, endMs: 1600, text: '둘째 문장' },
      { startMs: 3200, endMs: 3600, text: '넷째 문장' },
      { startMs: 5200, endMs: 5600, text: '끝 문장' },
    ];
    const timelinePath = path.join(directory, 'timeline.json');
    const reportPath = path.join(directory, 'validation-report.json');
    await fs.writeFile(timelinePath, JSON.stringify(timeline));
    await fs.writeFile(reportPath, JSON.stringify(original));
    await fs.writeFile(path.join(directory, 'captions.json'), JSON.stringify(captions));
    const records = {
      video: { path: input, name: 'lecture.mp4', timelinePath, reportPath, pageRange: { start: 1, end: 6 } },
      first: { path: audio, generatedVoice: { startPage: 2, endPage: 2, sourceStartMs: 0, sourceEndMs: fit === 'keep-video' ? 800 : 1400 } },
      second: { path: audio, generatedVoice: { startPage: 4, endPage: 4, sourceStartMs: 0, sourceEndMs: 800 } },
    };
    const app = appMethods(records);
    const out = path.join(directory, 'out');
    await fs.mkdir(out);
    const report = mode === 'single'
      ? await app.runPageVoicePatch(records.video, records.first, { name: 'patched', startPage: 2, endPage: 2, durationPolicy: fit }, out)
      : await app.runPageVoicePatchBatch({ name: 'patched', videoToken: 'video', durationPolicy: fit, patches: [
        { audioToken: 'second', startPage: 4, endPage: 4 },
        { audioToken: 'first', startPage: 2, endPage: 2 },
      ] }, out);
    const delta = fit === 'keep-video' ? 0 : mode === 'single' ? 400 : 200;
    assert.equal(report.voiceFindings?.length, 4, '교체하지 않은 페이지의 경고가 사라지면 안 된다');
    assert.equal(report.voiceFindings[0].startMs, 100);
    assert.equal(report.voiceFindings[3].startMs, 5100 + delta);
    assert.equal(report.voiceFindings[3].reasons[0], '뒤쪽 경고');
    assert.equal(report.voiceFindings[1].reasons[0], '교체 후 청취 확인');
    assert.equal(report.voiceFindings[1].recognizedText, '');
    if (mode === 'batch') {
      assert.equal(report.voiceFindings[2].startMs, fit === 'keep-video' ? 3000 : 3400);
      assert.equal(report.voiceFindings[2].endMs, fit === 'keep-video' ? 4000 : 4200);
      assert.equal(report.voiceFindings[2].recognizedText, '');
    }
    assert.equal(report.review.status, 'pending');
    assert.deepEqual(Array.from(report.review.clearedFindings), ['1:100', `6:${5100 + delta}`]);
    const savedCaptions = JSON.parse(await fs.readFile(path.join(out, 'captions.json')));
    assert.deepEqual(savedCaptions.map(c => c.text), captions.map(c => c.text));
    assert.equal(savedCaptions[1].startMs, fit === 'keep-video' ? 1200 : 1280);
    assert.equal(savedCaptions[3].startMs, 5200 + delta);
    assert.match(await fs.readFile(path.join(out, 'captions.srt'), 'utf8'), fit === 'keep-video' ? /00:00:01,200/ : /00:00:01,280/);
    assert.match(await fs.readFile(path.join(out, 'captions.vtt'), 'utf8'), fit === 'keep-video' ? /00:00:01\.200/ : /00:00:01\.280/);
    assert.equal(JSON.parse(await fs.readFile(path.join(out, 'timeline.json'))).totalMs, 6000 + delta);
    assert.deepEqual(JSON.parse(await fs.readFile(reportPath)), original);
    assert.deepEqual(JSON.parse(await fs.readFile(timelinePath)), timeline);
  });
}
