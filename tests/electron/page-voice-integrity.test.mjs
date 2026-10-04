import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bindPageVoiceCandidate, verifyPageVoiceCandidate } from '../../electron-app/main/page-voice-integrity.mjs';
import { createEditingPagesService } from '../../electron-app/main/editing/pages.mjs';
import { concatTimelines, timeRangeForPages } from '../../electron-app/shared/timeline.mjs';

const execute = promisify(execFile);
const probe = async file => JSON.parse((await execute('ffprobe',
  ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file])).stdout);

async function fixture(t, sourceEndMs = 1000) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tts-page-candidate-integrity-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const audioPath = path.join(directory, 'voice.wav'), manifestPath = path.join(directory, 'manifest.json');
  await execute('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=sample_rate=48000:duration=1', audioPath]);
  const timeline = { totalMs: 2000, entries: [1, 2].map((number, index) => ({
    chapter: 'ch01', slideId: `page-${number}`, slideNumber: number, step: 0,
    sourceText: `대본 ${number}`, startMs: index * 1000, endMs: (index + 1) * 1000,
  })) };
  await fs.writeFile(manifestPath, JSON.stringify({ runId: 'take-1', audioPath,
    entries: [timeline.entries[0]], chunks: [{ startMs: 0, endMs: sourceEndMs }] }));
  const runState = path.join(directory, 'run-state.json');
  await fs.writeFile(runState, JSON.stringify({ runId: 'take-1', status: 'complete' }));
  const generatedVoice = await bindPageVoiceCandidate(audioPath,
    { manifestPath, startPage: 1, endPage: 1, sourceStartMs: 0, sourceEndMs }, timeline);
  return { directory, timeline, manifestPath, runState, record: { path: audioPath, generatedVoice } };
}

test('같은 대본의 완료된 페이지 후보는 현재 바이트와 실제 길이를 확인한다', async t => {
  const f = await fixture(t);
  await verifyPageVoiceCandidate(f.record, f.timeline, await probe(f.record.path));
  const changed = structuredClone(f.timeline); changed.entries[0].sourceText = '고친 대본';
  await assert.rejects(verifyPageVoiceCandidate(f.record, changed, await probe(f.record.path)), /페이지 대본이 달라/);
  await fs.writeFile(f.runState, JSON.stringify({ runId: 'take-2', status: 'running' }));
  await assert.rejects(verifyPageVoiceCandidate(f.record, f.timeline, await probe(f.record.path)), /완료되지 않았거나/);
});

test('페이지 후보 파일을 짧게 바꾸면 무음으로 채운 성공 영상을 만들기 전에 거절한다', async t => {
  const f = await fixture(t), timelinePath = path.join(f.directory, 'timeline.json');
  await fs.writeFile(timelinePath, JSON.stringify(f.timeline));
  await execute('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=sample_rate=48000:duration=0.2', f.record.path]);
  let encodes = 0;
  const pages = createEditingPagesService({ inspectMedia: async file => file === '/lecture.mp4'
    ? { format: { duration: '2' }, streams: [{ codec_type: 'audio' }, { codec_type: 'video' }] } : probe(file),
    requireRuntimeTool: name => name, runProcess: async () => { encodes++; } });
  await assert.rejects(pages.runPageVoicePatch({ path: '/lecture.mp4', timelinePath,
    pageRange: { start: 1, end: 2 } }, f.record,
  { name: 'patched', startPage: 1, endPage: 1, durationPolicy: 'keep-video' }, f.directory), /생성 당시 파일과 달라/);
  assert.equal(encodes, 0);
});

test('해시가 일치해도 후보의 실제 파일 밖에 있는 기록된 구간은 거절한다', async t => {
  const f = await fixture(t, 1400);
  await assert.rejects(verifyPageVoiceCandidate(f.record, f.timeline, await probe(f.record.path)), /실제 길이/);
});

test('후보 생성 기록 변경과 현재 덱의 다른 대본을 모두 거절한다', async t => {
  const f = await fixture(t);
  const manifest = JSON.parse(await fs.readFile(f.manifestPath, 'utf8'));
  manifest.entries[0].sourceText = '새 대본';
  await fs.writeFile(f.manifestPath, JSON.stringify(manifest));
  await assert.rejects(verifyPageVoiceCandidate(f.record, f.timeline, await probe(f.record.path)), /생성 기록이 달라/);
  await assert.rejects(bindPageVoiceCandidate(f.record.path,
    f.record.generatedVoice, f.timeline), /선택한 영상의 페이지 대본이 다릅니다/);
});

test('합치기는 반복 페이지를 보존하되 페이지 교체의 반복·비연속 범위는 거절한다', () => {
  const source = { totalMs: 2000, entries: [1, 2].map((slideNumber, index) => ({
    slideId: `page-${slideNumber}`, slideNumber, step: 0, startMs: index * 1000, endMs: (index + 1) * 1000,
  })) };
  const joined = concatTimelines([{ durationMs: 2000, timeline: source }, { durationMs: 2000, timeline: source }]);
  assert.deepEqual(joined.entries.map(entry => entry.slideNumber), [1, 2, 1, 2]);
  assert.throws(() => timeRangeForPages(joined.entries, 1, 1), /반복되거나 떨어져/);
  assert.throws(() => timeRangeForPages(joined.entries, 1, 2), /반복되거나 떨어져/);
  assert.deepEqual(timeRangeForPages(source.entries, 1, 1), { start: 0, end: 1 });
  const contiguousSteps = [{ slideNumber: 1, slideId: 'page-1', step: 0, startMs: 0, endMs: 500 },
    { slideNumber: 1, slideId: 'page-1', step: 1, startMs: 500, endMs: 1000 }];
  assert.deepEqual(timeRangeForPages(contiguousSteps, 1, 1), { start: 0, end: 1 });
  assert.throws(() => timeRangeForPages([...contiguousSteps,
    ...contiguousSteps.map(entry => ({ ...entry, startMs: entry.startMs + 1000, endMs: entry.endMs + 1000 }))], 1, 1), /반복되거나 떨어져/);
});
