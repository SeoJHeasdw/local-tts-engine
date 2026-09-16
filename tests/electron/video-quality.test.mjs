import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileSha256, findVideo } from '../../electron-app/main/files.mjs';
import { pathToFileURL } from 'node:url';
import { VIDEO_QUALITIES, videoQuality, captureVideoFileName, videoFrameRate } from '../../electron-app/shared/video-quality.mjs';
import { normalizeOptions } from '../../electron-app/shared/options.mjs';
import { createProductionService } from '../../electron-app/main/production.mjs';
import { APP_SETTINGS_PATH, dateFolder, runtimePaths } from '../../electron-app/main/paths.mjs';

// sourceProjectRoot의 기본값은 "옆 폴더에 udemy-agent가 있다"는 추측이라, 강의
// 저장소가 다른 자리에 있으면 틀린다. 실제 앱처럼 저장된 설정을 따라가야 어느
// 환경에서도 진짜 강의 저장소 위치를 찾는다.
async function configuredDeckRoot() {
  const stored = await fs.readFile(APP_SETTINGS_PATH, 'utf8').then(JSON.parse).catch(() => ({}));
  return runtimePaths(stored.paths).deckRoot;
}

test('앱의 화질 선택은 CLI의 ID·해상도·프레임률 계약과 일치한다', async () => {
  const deckRoot = await configuredDeckRoot();
  const { CAPTURE_PROFILES } = await import(pathToFileURL(path.join(deckRoot, 'tools/capture-quality.mjs')));
  for (const [id, quality] of Object.entries(VIDEO_QUALITIES)) {
    const profile = CAPTURE_PROFILES[id];
    assert.deepEqual([quality.width, quality.height, quality.fps], [profile.width, profile.height, profile.fps]);
    assert.equal(normalizeOptions({ videoQuality: id }).videoQuality, id);
  }
  assert.equal(normalizeOptions().videoQuality, 'high');
  for (const id of ['4k', '__proto__', '', true]) assert.throws(() => videoQuality(id));
});

for (const quality of Object.values(VIDEO_QUALITIES)) {
  test(`${quality.id}는 제작 재시도·레슨 분할·완료 검증까지 유지된다`, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tts-production-quality-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const name = 'quality-test';
    const sourceDir = path.join(dir, 'tts', dateFolder(), name), renderDir = path.join(dir, 'render', name);
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.mkdir(renderDir, { recursive: true });
    const configPath = path.join(dir, 'narration.config.json');
    const config = { presets: {}, providers: {}, outputRoot: 'original' };
    await fs.writeFile(configPath, JSON.stringify(config));
    const audioPath = path.join(dir, 'track.wav');
    await fs.writeFile(path.join(sourceDir, 'manifest.json'), JSON.stringify({ audioPath, durationMs: 1000,
      entries: [{ chapter: 'ch00', slide_id: 'intro', step: 0 }] }));
    for (const [file, value] of Object.entries({ 'timeline.json': { totalMs: 1000, entries: [] },
      'captions.json': [{ text: '테스트', startMs: 0, endMs: 1000 }], 'lesson-review.json': {}, 'capture-report.json': { profile: quality } })) {
      await fs.writeFile(path.join(renderDir, file), JSON.stringify(value));
    }
    const fileName = captureVideoFileName(name, { videoQuality: quality.id, burnCaptions: true });
    await fs.writeFile(path.join(renderDir, fileName), 'fixture');
    if (quality.id !== 'standard') await fs.writeFile(path.join(renderDir, `${name}-captioned.mp4`), 'stale');
    await fs.writeFile(path.join(renderDir, 'capture-report.json'), JSON.stringify({ profile: quality, file: path.join(renderDir, fileName), fileSha256: await fileSha256(path.join(renderDir, fileName)) }));
    const calls = [];
    const state = { activeJob: { cancelled: false } };
    const studio = { configPath, deckRoot: dir, ttsOutputRoot: path.join(dir, 'tts'), captionOutputRoot: path.join(dir, 'render'), videoOutputRoot: path.join(dir, 'videos') };
    const audio = { codec_type: 'audio', codec_name: 'aac' };
    let wrongResolution = false;
    const service = createProductionService({ state, emit() {}, requireRuntimeTool: () => 'tool',
      ffprobe: async file => ({ format: { duration: '1' }, streams: file === audioPath ? [audio]
        : [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: wrongResolution ? 640 : quality.width, height: quality.height, avg_frame_rate: '25/1' }, audio] }),
      runProcess: async (stage, tool, args) => {
        calls.push({ stage, args });
        if (stage === 'capture' && calls.filter(call => call.stage === 'capture').length === 1) throw new Error('temporary capture failure');
      },
    });
    const options = normalizeOptions({ name, videoQuality: quality.id });
    const report = await service.runPipelineUnit(options, studio, null);
    assert.equal(report.summary.ok, true);
    assert.equal(report.videoQuality.id, quality.id);
    assert.equal(report.capture.profile.width, quality.width);
    assert.equal(calls.filter(call => call.stage === 'capture').length, 2);
    for (const call of calls.filter(call => ['voice', 'capture'].includes(call.stage))) {
      assert.ok(call.args.includes('--no-cache'), `${quality.id} ${call.stage}는 새로 생성해야 한다`);
    }
    for (const call of calls.filter(call => call.stage === 'capture')) assert.equal(call.args[call.args.indexOf('--quality') + 1], quality.id);
    assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')), config);
    const units = service.chapterUnits({ ...options, mode: 'chapter', chapterMode: 'lesson', chapter: 'ch00', startPage: 1, endPage: 2 }, { lessons: [
      { id: 'ch00-l01', chapter: 'ch00', startPage: 1, endPage: 1 }, { id: 'ch00-l02', chapter: 'ch00', startPage: 2, endPage: 2 },
    ] });
    assert.ok(units.every(unit => unit.videoQuality === quality.id));
    // Publish moves the file, so place another candidate to verify rejection.
    await fs.writeFile(path.join(renderDir, fileName), 'bad-resolution');
    await assert.rejects(service.validateResult({ sourceDir, renderDir, options, studio }), /무결성/);
    wrongResolution = true;
    await assert.rejects(service.validateResult({ sourceDir, renderDir, options, studio }), /자동 검증 실패.*영상 크기/);
  });
}

test('실제 평균 프레임률이 틀리면 명목 프레임률로 통과시키지 않는다', () => {
  assert.equal(videoFrameRate({ avg_frame_rate: '25/2', r_frame_rate: '25/1' }), 12.5);
  assert.equal(videoFrameRate({ avg_frame_rate: '0/0', r_frame_rate: '25/1' }), 25);
});

test('선택한 화질·자막 파일이 없으면 예전 MP4로 대체하지 않는다', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tts-output-choice-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'sample-captioned.mp4'), 'old');
  await fs.writeFile(path.join(dir, 'unrelated.mp4'), 'newest');
  assert.equal(await findVideo(dir, 'sample', captureVideoFileName('sample', { videoQuality: 'ultra', burnCaptions: true })), null);
  const expected = captureVideoFileName('sample', { videoQuality: 'high', burnCaptions: false });
  await fs.writeFile(path.join(dir, expected), 'selected');
  assert.equal(await findVideo(dir, 'sample', expected), path.join(dir, expected));
});

test('앱과 CLI가 같은 파일명을 사용하고 마지막 음성 프레임을 덮는다', async () => {
  const deckRoot = await configuredDeckRoot();
  const cli = await import(pathToFileURL(path.join(deckRoot, 'tools/capture-quality.mjs')));
  for (const quality of Object.keys(VIDEO_QUALITIES)) for (const captions of [false, true]) {
    assert.equal(captureVideoFileName('lesson', { videoQuality: quality, burnCaptions: captions }),
      cli.captureVideoFileName('lesson', { quality, burnCaptions: captions }));
  }
  assert.equal(cli.captureFrameCount(1001, 25), 26);
  assert.equal(cli.captureFrameCount(1000, 25), 25);
  assert.equal(cli.captureFrameCount(20, 25), 1);
  assert.throws(() => cli.captureFrameCount(NaN, 25));
});

test('이어하기는 파일·화질·판본·해시가 확인되는 완성본만 건너뛴다', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tts-resume-quality-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const folder=path.join(dir,'unit');await fs.mkdir(folder);const file=path.join(dir,'video.mp4');await fs.writeFile(file,'valid');
  const report={summary:{ok:true},videoPath:file,videoQuality:{id:'ultra'},sourceContract:{fingerprint:'source-v1'},capture:{fileSha256:await fileSha256(file)}};
  await fs.writeFile(path.join(folder,'validation-report.json'),JSON.stringify(report));
  const service=createProductionService({}),studio={captionOutputRoot:dir},units=[{name:'unit',videoQuality:'ultra'}];
  assert.deepEqual(await service.finishedUnitNames(units,studio,'source-v1'),['unit']);
  assert.deepEqual(await service.finishedUnitNames(units,studio,'source-v2'),[]);
  assert.deepEqual(await service.finishedUnitNames([{name:'unit',videoQuality:'high'}],studio,'source-v1'),[]);
  await fs.writeFile(file,'changed');assert.deepEqual(await service.finishedUnitNames(units,studio,'source-v1'),[]);
  await fs.unlink(file);assert.deepEqual(await service.finishedUnitNames(units,studio,'source-v1'),[]);
});
