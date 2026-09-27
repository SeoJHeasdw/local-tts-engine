import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProductionService } from '../../electron-app/main/production.mjs';
import { dateFolder } from '../../electron-app/main/paths.mjs';
import { alignmentWarnings } from '../../electron-app/shared/quality.mjs';

async function fixture(t, { auditError = null, cancelAudit = false, omitAuditReport = false, manifestQuality = null } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tts-alignment-report-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const options = {
    name: 'alignment-review', title: '정렬 검수', deliverable: 'captions',
    voiceMode: 'base', targetSeconds: 30, startPage: 1, endPage: 1,
  };
  const studio = {
    ttsOutputRoot: path.join(directory, 'voice'), captionOutputRoot: path.join(directory, 'render'),
    sourceProjectRoot: '/unused-deck', referenceAudioPath: '/unused-reference.wav', referenceTextPath: '/unused-reference.txt',
  };
  const sourceDir = path.join(studio.ttsOutputRoot, dateFolder(), options.name);
  const renderDir = path.join(studio.captionOutputRoot, options.name);
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(renderDir, { recursive: true });
  const manifest = {
    audioPath: path.join(sourceDir, 'voice.wav'), durationMs: 1000,
    entries: [{ chapter: 'ch01', slide_id: 'sample', slide_number: 1, step: 0,
      source_text: '정렬입니다.', tts_text: '정렬입니다.' }],
    alignmentQuality: manifestQuality,
  };
  await fs.writeFile(path.join(sourceDir, 'manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(renderDir, 'timeline.json'), JSON.stringify({ totalMs: 1000, entries: [] }));
  await fs.writeFile(path.join(renderDir, 'captions.json'), JSON.stringify([{ startMs: 0, endMs: 900, text: '정렬입니다.' }]));
  const quality = { status: 'warning', blocksAudioGeneration: false,
    summary: { alignmentEndBeyond250Ms: 1, transitions: 2, earlyCaptions: 0, earlyCaptionsOver20Ms: 3, collapsedWords: 4 } };
  const calls = [], events = [];
  const state = { activeJob: { state: 'running', cancelled: false } };
  const service = createProductionService({
    state, fs, emit: event => events.push(event), requireRuntimeTool: key => key,
    ffprobe: async () => ({ format: { duration: '1' }, streams: [{ codec_type: 'audio' }] }),
    runProcess: async (stage, executable, args) => {
      calls.push({ stage, executable, args });
      if (stage !== 'verify') return;
      if (cancelAudit) { state.activeJob.cancelled = true; throw new Error('사용자가 작업을 중지했습니다.'); }
      if (auditError) throw new Error(auditError);
      if (omitAuditReport) return;
      await fs.writeFile(args[args.indexOf('--report') + 1], JSON.stringify(quality));
    },
  });
  return { service, options, studio, sourceDir, renderDir, quality, calls, events, state };
}

test('정렬 경고를 별도 보고서에 보존하고 파일 검증 성공을 바꾸지 않는다', async t => {
  const run = await fixture(t, { manifestQuality: { status: 'passed' } });
  await fs.writeFile(path.join(run.renderDir, 'alignment-quality.json'), JSON.stringify(run.quality));
  const report = await run.service.validateResult(run);
  assert.deepEqual(report.alignmentQuality, run.quality);
  assert.equal(report.summary.ok, true);
  assert.equal(report.warnings.length, 4);
  assert.match(report.warnings[2], /먼저 사라진 자막 3곳/);
  assert.ok(report.checks.every(check => check.ok));
  assert.equal(run.events.filter(event => event.stream === 'stderr').length, 4);
  const saved = JSON.parse(await fs.readFile(path.join(run.renderDir, 'validation-report.json'), 'utf8'));
  assert.deepEqual(saved.alignmentQuality, run.quality);
  assert.deepEqual(saved.warnings, report.warnings);
});

test('80ms 이상이어도 음절당 정렬 길이가 지나치게 짧으면 별도 경고한다', () => {
  const warnings = alignmentWarnings({ status: 'warning', summary: { tinyWords: 0, implausibleWords: 2 } });
  assert.deepEqual(warnings, ['자막·화면 정렬 확인: 음절 수에 비해 지나치게 짧게 정렬된 단어 2곳']);
});

test('과거 결과에 정렬 보고서가 없어도 기존 검증과 호환된다', async t => {
  const run = await fixture(t);
  const report = await run.service.validateResult(run);
  assert.equal(report.alignmentQuality, null);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.summary.ok, true);
});

test('자막 뒤 파형 검사를 호출하고 검사 경고 때문에 목소리를 재생성하지 않는다', async t => {
  const run = await fixture(t);
  const report = await run.service.runPipelineUnit(run.options, run.studio);
  assert.deepEqual(run.calls.map(call => call.stage), ['voice', 'export', 'captions', 'verify']);
  const audit = run.calls.at(-1);
  assert.equal(audit.executable, 'basePython');
  assert.deepEqual(audit.args, [
    '-m', 'local_tts_engine.realign_course', '--audit-only',
    '--timeline', path.join(run.renderDir, 'timeline.json'),
    '--audio', path.join(run.renderDir, 'audio', 'track.wav'),
    '--captions', path.join(run.renderDir, 'captions.json'),
    '--report', path.join(run.renderDir, 'alignment-quality.json'),
  ]);
  assert.equal(report.summary.ok, true);
  assert.deepEqual(report.alignmentQuality, run.quality);
});

test('파형 검사 실행 실패를 미완료 경고로 남기고 옛 통과 보고서를 재사용하지 않는다', async t => {
  const run = await fixture(t, { auditError: 'FFmpeg silence detection failed' });
  await fs.writeFile(path.join(run.renderDir, 'alignment-quality.json'), JSON.stringify({ status: 'passed' }));
  const report = await run.service.runPipelineUnit(run.options, run.studio);
  assert.equal(report.alignmentQuality.status, 'not-checked');
  assert.match(report.warnings[0], /검사를 완료하지 못했습니다.*FFmpeg/);
  assert.equal(report.summary.ok, true);
  assert.equal(run.calls.filter(call => call.stage === 'voice').length, 1);
});

test('파형 검사 중 사용자 중지를 경고로 삼키지 않는다', async t => {
  const run = await fixture(t, { cancelAudit: true });
  await assert.rejects(run.service.runPipelineUnit(run.options, run.studio), /사용자가 작업을 중지/);
  await assert.rejects(fs.access(path.join(run.renderDir, 'validation-report.json')), { code: 'ENOENT' });
});

test('새 제작 검사 프로세스가 보고서를 안 쓰면 통과로 표시하지 않는다', async t => {
  const run = await fixture(t, { omitAuditReport: true, manifestQuality: { status: 'passed' } });
  const report = await run.service.runPipelineUnit(run.options, run.studio);
  assert.equal(report.alignmentQuality.status, 'not-checked');
  assert.match(report.warnings[0], /검사를 완료하지 못했습니다/);
  assert.equal(report.summary.ok, true);
});

test('음성만 제작할 때 manifest 정렬 경고를 보존하고 자막 검사 프로세스는 돌리지 않는다', async t => {
  const quality = { status: 'warning', summary: { collapsedWords: 2 } };
  const run = await fixture(t, { manifestQuality: quality });
  const report = await run.service.runPipelineUnit({ ...run.options, deliverable: 'audio' }, run.studio);
  assert.deepEqual(run.calls.map(call => call.stage), ['voice']);
  assert.deepEqual(report.alignmentQuality, quality);
  assert.match(report.warnings[0], /단어 2곳/);
  assert.equal(report.summary.ok, true);
  assert.equal(report.renderDir, null);
});

test('깨진 정렬 보고서를 조용히 통과시키지 않고 읽기 실패 경고로 기록한다', async t => {
  const run = await fixture(t, { manifestQuality: { status: 'passed' } });
  await fs.writeFile(path.join(run.renderDir, 'alignment-quality.json'), '{invalid');
  const report = await run.service.validateResult(run);
  assert.equal(report.alignmentQuality.status, 'not-checked');
  assert.match(report.warnings[0], /정렬 검사 결과를 읽지 못했습니다/);
  assert.equal(report.summary.ok, true);
});
