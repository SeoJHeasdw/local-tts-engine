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
  let probeCalls = 0;
  const dependencies = {
    chosenRecord: token => records[token],
    requireRuntimeTool: name => name,
    runUtility: async (command, args) => { probeCalls++; return (await execute(command, args)).stdout; },
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
  return { ...compose, ...pages, calls, probeCalls: () => probeCalls };
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
  const out = path.join(directory, 'cut');
  await fs.mkdir(out);
  const app = appMethods({ video: { path: input, name: 'source.mp4' } });
  const report = await app.runComposeEdit({ name: 'cut', clips: [{ videoToken: 'video', inMs: 1000, outMs: 1400 }] }, out);
  const output = report.videoPath;
  assert.equal(app.probeCalls(), 1, '분석한 입력의 정보를 정규화할 때 다시 조회하지 않는다');
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
    assert.equal(report.operation, mode === 'single' ? 'voice-page' : 'voice-pages');
    if (mode === 'single') assert.deepEqual(report.pageRange, { start: 2, end: 2 });
    else assert.deepEqual(report.pages, [{ startPage: 2, endPage: 2 }, { startPage: 4, endPage: 4 }]);
    if (fit === 'keep-video') {
      const args = app.calls[0];
      assert.equal(args[args.indexOf('-c:v') + 1], 'copy', '화면 길이가 같으면 단일·복수 교체 모두 영상 스트림을 복사해야 한다');
      const hash = async file => (await execute('ffmpeg', [
        '-v', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'hash', '-',
      ])).stdout;
      assert.equal(await hash(report.videoPath), await hash(input));
    }
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

for (const height of [1440, 2160]) {
  test(`${height}p는 전체 복사·정확한 자르기·1080p와 합치기 후에도 해상도를 유지한다`, async t => {
    const directory = await workspace(t);
    const high = path.join(directory, 'high.mp4'), low = path.join(directory, 'low.mp4');
    for (const [file, h, color] of [[high, height, 'red'], [low, 1080, 'blue']]) {
      await ffmpeg(['-f', 'lavfi', '-i', `color=c=${color}:s=${h * 16 / 9}x${h}:r=25:d=0.8`,
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.8',
        '-vf', 'setparams=range=limited:colorspace=bt709:color_primaries=bt709:color_trc=bt709',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
    }
    const app = appMethods({ high: { path: high, name: 'high.mp4' }, low: { path: low, name: 'low.mp4' } });
    for (const [name, clips, reencoded] of [
      ['copy', [{ videoToken: 'high' }], false],
      ['trim', [{ videoToken: 'high', inMs: 200, outMs: 600 }], true],
      ['mixed', [{ videoToken: 'low' }, { videoToken: 'high' }], true],
    ]) {
      const out = path.join(directory, name); await fs.mkdir(out);
      const report = await app.runComposeEdit({ name, clips }, out);
      assert.equal(report.videoReencoded, reencoded);
      const media = await probe(report.videoPath), video = media.streams.find(s => s.codec_type === 'video');
      assert.equal(video.height, height);
      assert.equal(video.width, height * 16 / 9);
      assert.equal(video.color_space, 'bt709');
      assert.equal(video.color_primaries, 'bt709');
      assert.equal(video.color_transfer, 'bt709');
      if (name === 'mixed') {
        const pixels = (await execute('ffmpeg', ['-v', 'error', '-i', report.videoPath,
          '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { encoding: 'buffer' })).stdout;
        assert.ok(pixels[2] > pixels[0] + 100, '처음은 저해상도 파란 클립');
        assert.ok(pixels.at(-3) > pixels.at(-1) + 100, '끝은 고해상도 빨간 클립');
        assert.ok(Math.abs(Number(media.format.duration) - 1.6) < 0.1);
      }
    }
  });
}

test('성공한 편집의 중간 MP4만 정리하고 원본은 그대로 남긴다', async t => {
  const directory = await workspace(t), input = path.join(directory, 'input.mp4');
  await ffmpeg(['-f','lavfi','-i','testsrc2=size=320x180:rate=25:duration=1',
    '-f','lavfi','-i','sine=sample_rate=48000:duration=1','-c:v','libx264','-c:a','aac',input]);
  const original = await fs.readFile(input), app = appMethods({video:{path:input,name:'input.mp4'}});
  const out = path.join(directory,'out'); await fs.mkdir(out);
  const report = await app.runComposeEdit({name:'cut',clips:[{videoToken:'video',inMs:200,outMs:800}]},out);
  assert.ok(report.intermediateBytes > 0);
  assert.ok(!(await fs.readdir(out)).some(name=>name.startsWith('work-')));
  assert.deepEqual(await fs.readFile(input), original);
  assert.ok((await fs.stat(report.videoPath)).size > 0);
  await assert.rejects(app.runComposeEdit({name:'cut',clips:[{videoToken:'video'}]},out), /EEXIST/);
});

test('10비트 영상의 전체 MP4 복사는 무손실이고 자르기의 암묵적 8비트 변환은 거절한다', async t => {
  const directory = await workspace(t), input = path.join(directory,'ten-bit.mp4');
  await ffmpeg(['-f','lavfi','-i','testsrc2=size=160x90:rate=25:duration=1',
    '-f','lavfi','-i','sine=sample_rate=48000:duration=1','-pix_fmt','yuv420p10le','-c:v','libx264','-c:a','aac',input]);
  const app = appMethods({video:{path:input,name:'ten-bit.mp4'}});
  const copy = path.join(directory,'copy'); await fs.mkdir(copy);
  const report = await app.runComposeEdit({name:'copy',clips:[{videoToken:'video'}]},copy);
  assert.deepEqual(await fs.readFile(report.videoPath),await fs.readFile(input));
  assert.equal(report.videoReencoded,false);
  const cut=path.join(directory,'cut');await fs.mkdir(cut);
  await assert.rejects(app.runComposeEdit({name:'cut',clips:[{videoToken:'video',inMs:200,outMs:800}]},cut),/HDR·색심도/);
  assert.equal(app.calls.length,0,'지원하지 않는 색 형식은 인코딩 전에 거절');
});

test('비정방형 픽셀을 편집해도 화면 비율이 늘어나지 않는다', async t => {
  const directory = await workspace(t), input=path.join(directory,'anamorphic.mp4');
  await ffmpeg(['-f','lavfi','-i','color=red:s=720x480:r=25:d=1','-f','lavfi','-i','sine=sample_rate=48000:duration=1',
    '-vf','setsar=8/9','-c:v','libx264','-c:a','aac',input]);
  const app=appMethods({video:{path:input,name:'anamorphic.mp4'}}),out=path.join(directory,'out');await fs.mkdir(out);
  const result=await app.runComposeEdit({name:'cut',clips:[{videoToken:'video',inMs:200,outMs:800}]},out);
  const video=(await probe(result.videoPath)).streams.find(s=>s.codec_type==='video');
  assert.equal(video.sample_aspect_ratio,'1:1');
  const {stdout:pixel}=await execute('ffmpeg',['-v','error','-i',result.videoPath,'-vf','format=rgb24,crop=2:2:200:540,scale=1:1','-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','-'],{encoding:'buffer'});
  assert.ok(pixel[0]<10 && pixel[1]<10 && pixel[2]<10,'4:3 콘텐츠 바깥의 검은 여백이어야 한다');
});
