import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createRecaptureService, readRecaptureTimelineSelection } from '../../electron-app/main/editing/recapture.mjs';
import { createEditingComposeService } from '../../electron-app/main/editing/compose.mjs';
import { createEditingService } from '../../electron-app/main/editing.mjs';
import { createIpcService } from '../../electron-app/main/ipc.mjs';
import { RENDERER_DIR, runtimePaths, dateFolder } from '../../electron-app/main/paths.mjs';
import { rebindDeckTimeline, assertRecaptureScriptContract } from '../../electron-app/main/capture/deck-source.mjs';
import { captureVideoFileName, videoQuality } from '../../electron-app/shared/video-quality.mjs';
import { fileSha256 } from '../../electron-app/main/files.mjs';
import { captureMuxArgs } from '../../electron-app/main/capture/encoding.mjs';

const exec = promisify(execFile);
const run = async (command, args) => (await exec(command, args, { maxBuffer: 3_000_000 })).stdout;
const probe = async file => JSON.parse(await run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]));
const flag = (args, name) => args[args.indexOf(name) + 1];

async function fixture(t, { durationMs = 1510, failCapture = 0, cancelCapture = false, corruptAudio = false, failContract = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'screen-recapture-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'edited');
  const out = path.join(dir, 'new');
  await fs.mkdir(source); await fs.mkdir(out);
  const video = path.join(source, 'latest.mp4');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=blue:s=160x90:r=25:d=${durationMs / 1000}`,
    '-f', 'lavfi', '-i', `sine=frequency=880:sample_rate=48000:duration=${durationMs / 1000}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', video]);
  const timeline = { totalMs: durationMs, preset: { name: 'old' }, provider: { provider: 'original' },
    sourceContract: { fingerprint: 'old-visuals' }, voicePatch: { replacementDurationMs: durationMs },
    entries: [{ slideId: 'a', slideNumber: 1, chapter: 'ch01', step: 0, sourceText: '같은 대본',
      startMs: 0, endMs: durationMs, transitionAtMs: durationMs, alignment: { words: [{ text: '같은', startMs: 100, endMs: 400 }] } }] };
  const captions = [{ text: '현재 수정본의 자막', startMs: 120, endMs: durationMs - 100 }];
  const review = { status: 'approved', clearedFindings: ['1:100'] };
  const findings = [{ slideNumber: 1, startMs: 100, endMs: 500, reasons: ['확인된 발음'] }];
  const record = { path: video, name: 'latest.mp4', timelinePath: path.join(source, 'timeline.json'),
    reportPath: path.join(source, 'validation-report.json') };
  const originalReport = { videoPath: video, audioPath: '/obsolete/never-use.wav', sourceDir: '/obsolete',
    operation: 'voice-pages', review, voiceFindings: findings };
  await fs.writeFile(record.timelinePath, JSON.stringify(timeline));
  await fs.writeFile(record.reportPath, JSON.stringify(originalReport));
  await fs.writeFile(path.join(source, 'captions.json'), JSON.stringify(captions));
  const before = await fileSha256(video);
  const state = { activeJob: { state: 'running', cancelled: false } };
  const calls = [], events = [];
  let captures = 0;
  const dependencies = {
    state, chosenRecord: () => record, emit: e => events.push(e), inspectMedia: probe, ffprobe: probe,
    requireRuntimeTool: name => name === 'node' ? process.execPath : name,
    runProcess: async (stage, command, args) => {
      calls.push({ stage, command, args });
      if (args[0]?.endsWith('prepare-input.mjs')) {
        const options = JSON.parse(args[1]);
        assert.equal(options.build, true);
        assert.equal(options.expectedStartId, 'a');
        await fs.mkdir(path.join(options.destination, 'site'), { recursive: true });
        return '';
      }
      if (args[0]?.endsWith('recapture-timeline.mjs')) {
        if (failContract) throw new Error('대본이 다릅니다');
        const options = JSON.parse(args[1]);
        const value = JSON.parse(await fs.readFile(options.timeline, 'utf8'));
        await fs.writeFile(options.timeline, JSON.stringify({ ...value,
          voiceSourceContract: value.sourceContract, sourceContract: { fingerprint: 'new-visuals' } }));
        await fs.writeFile(options.review, JSON.stringify({ videoFindings: [] }));
        return '';
      }
      if (args[0]?.endsWith('/capture.mjs')) {
        captures++;
        if (cancelCapture) { state.activeJob.cancelled = true; throw new Error('cancelled'); }
        if (captures <= failCapture) throw new Error('capture interrupted');
        const value = JSON.parse(await fs.readFile(flag(args, '--timeline'), 'utf8'));
        const quality = videoQuality(flag(args, '--quality'));
        const file = path.join(out, captureVideoFileName(value.preset.name,
          { videoQuality: quality.id, burnCaptions: args.includes('--burn-captions') }));
        // 브라우저 대신 새 색 화면을 만든다. 트랙 복사·길이·최종 검증은 실제 FFmpeg다.
        let audioFile = flag(args, '--audio-file');
        if (corruptAudio) {
          audioFile = path.join(out, 'damaged.m4a');
          await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
            `sine=frequency=220:sample_rate=48000:duration=${value.totalMs / 1000}`, '-c:a', 'aac', audioFile]);
        }
        const mux = captureMuxArgs({ profile: quality, totalFrames: Math.ceil(value.totalMs / 40), audioFile, output: file });
        await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
          `color=c=red:s=${quality.width}x${quality.height}:r=25:d=${value.totalMs / 1000}`,
          ...mux.slice(mux.indexOf('pipe:0') + 1)]);
        await fs.writeFile(`${file}.capture.json`, JSON.stringify({ file, profile: quality,
          sourceContract: value.sourceContract, fileSha256: await fileSha256(file) }));
        return '';
      }
      return run(command, args);
    },
  };
  const { validateEditVideo } = createEditingComposeService(dependencies);
  const service = createRecaptureService({ ...dependencies, validateEditVideo });
  const options = { name: 'again', operation: 'screen-recapture', videoToken: 'latest',
    videoQuality: 'standard', burnCaptions: true, paths: { outputRoot: path.join(dir, 'output') } };
  async function correctTimeline() {
    const correctedDir = path.join(dir, 'corrected');
    await fs.mkdir(path.join(source, 'audio'));
    await fs.mkdir(path.join(correctedDir, 'audio'), { recursive: true });
    const wav = path.join(source, 'audio/track.wav'), aac = path.join(source, 'audio/track.m4a');
    await run('ffmpeg', ['-v', 'error', '-i', video, '-map', '0:a:0', wav]);
    await run('ffmpeg', ['-v', 'error', '-i', video, '-map', '0:a:0', '-c:a', 'copy', aac]);
    await fs.copyFile(wav, path.join(correctedDir, 'audio/track.wav'));
    await fs.copyFile(aac, path.join(correctedDir, 'audio/track.m4a'));
    const value = { ...structuredClone(timeline), realignment: {
      sourceTimeline: record.timelinePath, sourceAudio: wav, sourceAudioSha256: await fileSha256(wav),
      originalTimelineSha256: await fileSha256(record.timelinePath), originalTotalMs: timeline.totalMs,
      algorithmVersion: 'waveform-v1',
    } };
    value.entries[0].speechStartMs = 80;
    value.entries[0].speechEndMs = 900;
    value.entries[0].alignment.words[0] = { text: '같은', startMs: 80, endMs: 900 };
    const correctedCaptions = [{ text: '교정된 자막', startMs: 80, endMs: 900 }];
    const file = path.join(correctedDir, 'timeline.json');
    await fs.writeFile(file, JSON.stringify(value));
    await fs.writeFile(path.join(correctedDir, 'captions.json'), JSON.stringify(correctedCaptions));
    await fs.writeFile(path.join(correctedDir, 'alignment-quality.json'), JSON.stringify({ status: 'warning', summary: { collapsedWords: 1 } }));
    options.correctedTimeline = await readRecaptureTimelineSelection(file);
    return { value, correctedDir, correctedCaptions, file };
  }
  return { service, options, out, dir, calls, events, record, before, timeline, captions, review, findings,
    state, captures: () => captures, originalReport, correctTimeline };
}

test('교정 타임라인의 새 자막·말 시각으로 재촬영하며 선택 영상 AAC를 그대로 보존한다', async t => {
  const f = await fixture(t);
  const corrected = await f.correctTimeline();
  const report = await f.service.runScreenRecapture(f.options, f.out);
  assert.equal(report.summary.ok, true);
  assert.equal(report.recapture.timingPreserved, false);
  assert.equal(report.recapture.sourceAudioHash, report.recapture.outputAudioHash);
  assert.equal(report.alignmentQuality.summary.collapsedWords, 1);
  assert.match(report.warnings[0], /짧게 정렬된 단어 1곳/);
  assert.deepEqual(JSON.parse(await fs.readFile(report.timelinePath, 'utf8')).entries, corrected.value.entries);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.out, 'captions.json'), 'utf8')), corrected.correctedCaptions);
  assert.equal(await fileSha256(f.record.path), f.before);
  assert.equal(f.calls.some(c => c.command.includes('python') || c.stage === 'voice'), false);
});

for (const [label, mutate, expected] of [
  ['선택 뒤 변경', async (f, c) => fs.appendFile(c.file, ' '), /바뀌었/],
  ['다른 WAV', async (f, c) => fs.writeFile(path.join(c.correctedDir, 'audio/track.wav'), 'different'), /음성 해시/],
  ['다른 영상 음성', async (f, c) => {
    await fs.rm(path.join(c.correctedDir, 'audio/track.m4a'));
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1.51',
      '-c:a', 'aac', path.join(c.correctedDir, 'audio/track.m4a')]);
  }, /음성이 다릅니다/],
  ['대본 변경', async (f, c) => {
    c.value.entries[0].sourceText = '다른 대본';
    await fs.writeFile(c.file, JSON.stringify(c.value));
    f.options.correctedTimeline = await readRecaptureTimelineSelection(c.file);
  }, /대본.*순서/],
  ['교정 자막 누락', async (f, c) => fs.rm(path.join(c.correctedDir, 'captions.json')), /ENOENT/],
]) test(`교정본 ${label}은 촬영 전에 거절한다`, async t => {
  const f = await fixture(t);
  const c = await f.correctTimeline();
  await mutate(f, c);
  await assert.rejects(f.service.runScreenRecapture(f.options, f.out), expected);
  assert.equal(f.captures(), 0);
  assert.equal(await fileSha256(f.record.path), f.before);
});

test('재촬영은 최신 수정본의 실제 음성·자막·전환·검수를 보존하고 새 화면만 만든다', async t => {
  const f = await fixture(t);
  const report = await f.service.runScreenRecapture(f.options, f.out);
  assert.equal(report.summary.ok, true);
  assert.equal(report.recapture.sourceAudioHash, report.recapture.outputAudioHash);
  assert.equal(await fileSha256(f.record.path), f.before);
  assert.deepEqual(JSON.parse(await fs.readFile(f.record.reportPath, 'utf8')), f.originalReport);
  const next = JSON.parse(await fs.readFile(report.timelinePath, 'utf8'));
  assert.deepEqual(next.entries, f.timeline.entries);
  assert.equal(next.totalMs, f.timeline.totalMs);
  assert.deepEqual(next.voicePatch, f.timeline.voicePatch);
  assert.equal(next.voiceSourceContract.fingerprint, 'old-visuals');
  assert.equal(next.sourceContract.fingerprint, 'new-visuals');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.out, 'captions.json'), 'utf8')), f.captions);
  assert.deepEqual(report.voiceFindings, f.findings);
  assert.deepEqual(report.voiceReview, f.review);
  assert.equal(report.review.status, 'pending', '새 화면의 시청 승인을 자동으로 부여하지 않는다');
  assert.deepEqual(report.review.clearedFindings, f.review.clearedFindings);
  assert.equal(f.calls.some(c => c.command.includes('python') || c.stage === 'voice'), false);
  const capture = f.calls.find(c => c.stage === 'capture');
  assert.ok(capture.args.includes('--no-cache'));
  assert.ok(capture.args.includes('--burn-captions'));
  assert.equal(capture.args.includes('--no-source-check'), false);
  await assert.rejects(fs.access(path.join(f.out, '.production-input')), { code: 'ENOENT' });
});

test('개별 촬영 실패는 같은 음성으로 한 번 재시도한다', async t => {
  const f = await fixture(t, { failCapture: 1 });
  assert.equal((await f.service.runScreenRecapture(f.options, f.out)).summary.ok, true);
  assert.equal(f.captures(), 2);
  assert.equal(f.calls.filter(c => c.args.includes('-c:a') && c.stage === 'export').length, 1);
});

for (const [label, options, expected] of [
  ['사용자 중지', { cancelCapture: true }, /중지/],
  ['대본 변경', { failContract: true }, /대본/],
  ['최종 음성 손상', { corruptAudio: true }, /음성 샘플/],
  ['촬영 재시도 소진', { failCapture: 2 }, /capture interrupted/],
]) test(`${label}을 성공으로 표시하지 않고 원본을 보존한다`, async t => {
  const f = await fixture(t, options);
  await assert.rejects(f.service.runScreenRecapture(f.options, f.out), expected);
  assert.equal(await fileSha256(f.record.path), f.before);
  const report = JSON.parse(await fs.readFile(path.join(f.out, 'validation-report.json'), 'utf8'));
  assert.equal(report.summary.ok, false);
  assert.equal(f.captures(), options.failContract ? 0 : options.failCapture || 1);
});

test('기존 재촬영 폴더를 재사용하거나 덮지 않는다', async t => {
  const f = await fixture(t);
  const outputDir = path.join(runtimePaths(f.options.paths).editOutputRoot, dateFolder(), f.options.name);
  await fs.mkdir(outputDir, { recursive: true });
  const sentinel = path.join(outputDir, 'audio.m4a');
  await fs.writeFile(sentinel, 'keep');
  const editing = createEditingService({ state: f.state, emit() {}, runScreenRecapture: () => assert.fail('must not start') });
  await assert.rejects(editing.runVideoEdit(f.options), /새 이름/);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep');
});

test('화면 판본 연결은 덱의 대본 검사와 편집점 검사를 모두 거친다', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rebind-deck-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'tools'));
  const entries = [{ slideId: 'a', slideNumber: 1, chapter: 'ch01', step: 0, sourceText: '대본' }];
  await fs.writeFile(path.join(dir, 'production-input.json'), JSON.stringify({ sourceContract: { fingerprint: 'new' }, states: entries }));
  // 판정 자체를 복제하지 않고, 실제 bridge가 덱의 두 함수를 부르는지 확인한다.
  await fs.writeFile(path.join(dir, 'tools/production.mjs'), `
    export function checkCaptureContract(timeline) {
      if (timeline.sourceContract) throw new Error('explicit rebind required');
      if (timeline.rejectContract) throw new Error('script mismatch');
    }
    export function inspectProductionTimeline({timeline}) {
      if (timeline.rejectTiming) throw new Error('timing mismatch');
      return {videoFindings:[]};
    }
  `);
  const timeline = { sourceContract: { fingerprint: 'old' }, entries };
  const next = await rebindDeckTimeline(dir, dir, timeline);
  assert.equal(next.sourceContract.fingerprint, 'new');
  assert.equal(next.voiceSourceContract.fingerprint, 'old');
  assert.equal(timeline.sourceContract.fingerprint, 'old');
  assert.equal((await rebindDeckTimeline(dir, dir, next)).voiceSourceContract.fingerprint, 'old');
  await assert.rejects(rebindDeckTimeline(dir, dir, { ...timeline, rejectContract: true }), /script mismatch/);
  await assert.rejects(rebindDeckTimeline(dir, dir, { ...timeline, rejectTiming: true }), /timing mismatch/);
});

test('재촬영 대본 계약은 누락·추가·재배열·원문 변경을 모두 거절한다', () => {
  const entries = [0, 1].map(step => ({ slideId: 'a', step, chapter: 'ch01', slideNumber: 1, sourceText: `말 ${step}` }));
  assert.doesNotThrow(() => assertRecaptureScriptContract(entries, structuredClone(entries)));
  assert.throws(() => assertRecaptureScriptContract(entries, entries.slice(1)), /수가 다릅니다/);
  assert.throws(() => assertRecaptureScriptContract(entries, entries.toReversed()), /순서가 다릅니다/);
  assert.throws(() => assertRecaptureScriptContract(entries, entries.concat(entries[1])), /수가 다릅니다/);
  assert.throws(() => assertRecaptureScriptContract(entries, entries.map(e => ({ ...e, sourceText: e.sourceText + ' ' }))), /대본/);
});

test('타임라인 선택 IPC는 로컬 선택 token만 허용하고 다른 영상에는 재사용하지 않는다', async t => {
  const f = await fixture(t);
  const corrected = await f.correctTimeline();
  const handlers = new Map(), state = { activeJob: null }, edits = [];
  createIpcService({ state, ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    chosenRecord: () => f.record, requireRuntimeTool() {},
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [corrected.file] }) },
    readAppSettings: async () => ({ paths: {} }), applyVoiceSettings: options => options,
    jobSnapshot: () => ({}), emit() {}, runVideoEdit: async options => edits.push(options),
  }).registerIpc();
  const event = { senderFrame: { url: pathToFileURL(path.join(RENDERER_DIR, 'index.html')).href } };
  const pick = handlers.get('studio:pick-recapture-timeline');
  await assert.rejects(pick({ senderFrame: { url: 'https://example.com' } }, 'latest'), /허용되지/);
  const selected = await pick(event, 'latest');
  assert.equal(selected.path, undefined);
  const start = handlers.get('studio:start-edit');
  await assert.rejects(start(event, { ...f.options, videoToken: 'other', correctedTimelineToken: selected.token }), /다시 선택/);
  await assert.rejects(start(event, { ...f.options, correctedTimelineToken: 'invented' }), /다시 선택/);
  await start(event, { ...f.options, correctedTimelineToken: selected.token, correctedTimeline: { path: '/injected' } });
  assert.equal(edits[0].correctedTimeline.path, corrected.file);
  state.activeJob = null;
  await start(event, { ...f.options, correctedTimeline: { path: '/injected' } });
  assert.equal(edits[1].correctedTimeline, undefined);
});

test('IPC 재촬영은 합성 모델 없이 시작하며 일시정지한 기존 작업도 보호한다', async () => {
  const handlers = new Map(), state = { activeJob: null }, calls = [];
  createIpcService({ state, ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    chosenRecord: () => ({ timelinePath: '/timeline.json' }), requireRuntimeTool: name => calls.push(name),
    readAppSettings: async () => ({ paths: {} }), applyVoiceSettings: (options, settings) => ({ ...options, paths: settings.paths }),
    assertRuntime: () => assert.fail('must not load voice runtime'),
    jobSnapshot: () => ({ kind: 'edit' }), emit() {}, runVideoEdit: async options => calls.push(options),
  }).registerIpc();
  const event = { senderFrame: { url: pathToFileURL(path.join(RENDERER_DIR, 'index.html')).href } };
  const options = { operation: 'screen-recapture', videoToken: 'latest', name: 'recapture', videoQuality: 'ultra' };
  await handlers.get('studio:start-edit')(event, options);
  assert.equal(calls.at(-1).videoQuality, 'ultra');
  assert.deepEqual(calls.slice(0, 3), ['ffmpeg', 'node', 'ffprobe']);
  state.activeJob.state = 'paused';
  await assert.rejects(handlers.get('studio:start-edit')(event, options), /실행 중인 작업/);
});
