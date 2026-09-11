import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { productionFixture } from './helpers/production.mjs';

for (const [mode, chapterMode] of [['lesson', 'single'], ['chapter', 'single'], ['chapter', 'lesson']]) {
  test(`${mode}/${chapterMode}: 사전 누락은 제작 후 검수 목록으로 전달하고 모든 편을 완성한다`, async t => {
    const run = await productionFixture(t, { mode, chapterMode });
    await run.service.runPipeline(run.options);
    assert.equal(run.events.at(-1).type, 'complete');
    assert.equal(run.state.activeJob.state, 'done');
    const report = run.events.at(-1).report;
    const units = report.units || [report];
    assert.equal(units.length, chapterMode === 'lesson' ? 3 : 1);
    assert.ok(units.every(unit => unit.voiceFindings[0].terms[0].term === 'UnknownWidget'));
    assert.ok(units.every(unit => unit.voiceFindings[0].severity === 'warning'));
    assert.ok(units.every(unit => unit.summary.ok));
    assert.equal(run.calls.filter(call => call.stage === 'snapshot').length, 1);
    assert.equal(run.calls[1].stage, 'voice', '입력 준비 후 중복 대본 검사 프로세스를 실행하지 않는다');
    await assert.rejects(fs.access(run.recordPath), { code: 'ENOENT' });
  });
}

test('대본이 없는 실제 입력 오류는 첫 생성 전에 중단한다', async t => {
  const run = await productionFixture(t);
  run.failures.set('snapshot', true);
  await assert.rejects(run.service.runPipeline(run.options), /대본이 없습니다/);
  assert.ok(run.calls.every(call => call.stage === 'snapshot'));
});

test('중간 레슨 실패 후 나머지 제작·부분 완료·실패 레슨 재시작을 모두 보존한다', async t => {
  const run = await productionFixture(t, { quality: 'ultra' });
  run.failures.set('test-ch03-l02', 'voice');
  await run.service.runPipeline(run.options);
  const result = run.events.at(-1);
  assert.equal(result.type, 'partial-complete');
  assert.equal(run.state.activeJob.state, 'partial');
  assert.equal(result.report.summary.ok, false);
  assert.equal(result.report.completedUnits, 2);
  assert.equal(result.report.totalUnits, 3);
  assert.deepEqual(result.report.failedUnits.map(unit => unit.name), ['test-ch03-l02']);
  assert.ok(run.events.some(event => event.type === 'unit-failed' && event.index === 2));
  const record = await run.record();
  assert.deepEqual(record.completed, ['test-ch03-l01', 'test-ch03-l03']);
  await fs.access(path.join(run.project, 'production-input.json'));
  assert.equal(JSON.parse(await fs.readFile(path.join(run.studio.captionOutputRoot, 'test', 'chapter-report.json'))).failedUnits.length, 1);

  run.failures.clear(); run.calls.length = 0;
  run.state.activeJob = { id: 'retry', state: 'running', cancelled: false };
  await run.service.runPipeline({ ...record.options, resumeFrom: record.completed });
  assert.deepEqual(run.calls.filter(call => call.stage === 'voice').map(call => path.basename(call.args[call.args.indexOf('--output-dir') + 1])), ['test-ch03-l02']);
  assert.equal(run.events.at(-1).type, 'complete');
  assert.equal(run.events.at(-1).report.units.length, 3, '이전 완료 레슨도 최종 결과에 포함한다');
  assert.equal(run.events.at(-1).report.failedUnits.length, 0);
  assert.ok(!run.calls.some(call => call.args[0].endsWith('prepare-input.mjs')), '이어하기의 입력을 새로 복사하지 않는다');
  await assert.rejects(fs.access(run.project), { code: 'ENOENT' });
  await assert.rejects(fs.access(run.recordPath), { code: 'ENOENT' });
});

test('모든 레슨이 실패해도 전부 시도하고 성공 영상 없는 실패로 끝낸다', async t => {
  const run = await productionFixture(t);
  for (const n of [1, 2, 3]) run.failures.set(`test-ch03-l0${n}`, 'voice');
  await run.service.runPipeline(run.options);
  assert.equal(run.calls.filter(call => call.stage === 'voice').length, 3);
  assert.equal(run.state.activeJob.state, 'failed');
  const report = run.events.at(-1).report;
  assert.equal(report.completedUnits, 0);
  assert.equal(report.failedUnits.length, 3);
  assert.equal(report.target, null);
  assert.equal(report.summary.ok, false);
  await fs.access(run.project);
});

test('촬영 재시도도 실패하면 그 레슨만 기록하고 다음 레슨에서 다시 촬영한다', async t => {
  const run = await productionFixture(t);
  run.failures.set('test-ch03-l02', 'capture');
  await run.service.runPipeline(run.options);
  assert.equal(run.events.at(-1).report.completedUnits, 2);
  const captures = run.calls.filter(call => call.stage === 'capture');
  assert.equal(captures.length, 4, '성공 2회와 실패 레슨의 기존 2회 시도를 유지한다');
  assert.ok(captures.every(call => call.args.includes('--no-cache')));
  const config = JSON.parse(await fs.readFile(path.join(run.project, 'deck/narration.config.json')));
  assert.deepEqual(config, { presets: {}, providers: {}, outputRoot: 'original' });
});

test('새 제작은 과거 완성 기록이 있어도 모든 레슨을 캐시 없이 다시 생성한다', async t => {
  const run = await productionFixture(t);
  await run.service.runPipeline(run.options);
  run.calls.length = 0;
  run.state.activeJob = { id: 'new-job', state: 'running', cancelled: false };
  await run.service.runPipeline(run.options);
  assert.equal(run.calls.filter(call => call.stage === 'voice').length, 3);
  assert.ok(run.calls.filter(call => ['voice', 'capture'].includes(call.stage)).every(call => call.args.includes('--no-cache')));
  assert.equal(run.events.at(-1).type, 'complete');
});

test('단일 영상의 실제 실패와 사용자 중지는 계속 제작으로 삼키지 않는다', async t => {
  const single = await productionFixture(t, { mode: 'chapter', chapterMode: 'single' });
  single.failures.set('test', 'voice');
  await assert.rejects(single.service.runPipeline(single.options), /voice 테스트 실패/);
  assert.ok(!single.events.some(event => event.type === 'partial-complete'));
  const batch = await productionFixture(t);
  batch.failures.set('test-ch03-l02', 'cancel');
  await assert.rejects(batch.service.runPipeline(batch.options), /사용자가 작업을 중지/);
  assert.equal(batch.calls.filter(call => call.stage === 'voice').length, 2);
  assert.ok(!batch.events.some(event => event.type === 'unit-failed'));
  await batch.service.cleanupCaptureSite(batch.state.activeJob);
  await assert.rejects(fs.access(batch.project), { code: 'ENOENT' });
});
