import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { outputPathsForRoot } from '../../electron-app/shared/options.mjs';
import { outputReviewWarnings, withClearedOutputReviewWarnings, withOutputReview } from '../../electron-app/shared/quality.mjs';
import { groupOutputs, outputState, visibleOutputReviewWarnings } from '../../electron-app/renderer/view-utils.mjs';
import { createOutputsService } from '../../electron-app/main/outputs.mjs';
import { createMediaService } from '../../electron-app/main/media.mjs';

function weakTailReport() {
  const first = { entry: 3, type: 'unassigned-weak-tail', startMs: 27_107, endMs: 27_192, weakNonSpeechCandidate: true };
  const second = { entry: 5, type: 'unassigned-weak-tail', startMs: 44_093, endMs: 44_187, weakNonSpeechCandidate: true };
  return {
    warnings: ['자막·화면 정렬 확인: 말 끝과 정렬 끝이 0.25초 넘게 어긋난 스텝 2곳'],
    alignmentQuality: { status: 'warning', summary: { alignmentEndBeyond250Ms: 2 },
      repairWarnings: [first, second], findings: { alignmentEnd: [
        { step: 'slide-a:0', alignmentEndMs: 26_920, waveformEndMs: 27_192, endDeltaMs: -272 },
        { step: 'slide-a:2', alignmentEndMs: 43_880, waveformEndMs: 44_187, endDeltaMs: -307 },
      ] } },
  };
}

test('파형의 약한 말끝과 정렬 끝 차이는 같은 두 구간으로 보여 준다', () => {
  const report = weakTailReport();
  const issues = outputReviewWarnings(report);
  assert.equal(issues.length, 2);
  assert.deepEqual(issues.map(issue => issue.startMs), [27_107, 44_093]);
  assert.match(issues[0].detail, /단어로 확정하지 않았습니다/);
  assert.match(issues[0].detail, /272ms/);
  const checked = withClearedOutputReviewWarnings(report, [issues[0].key, 'invented']);
  assert.deepEqual(checked.review.clearedReviewWarnings, [issues[0].key]);
  assert.deepEqual(withOutputReview(checked, 'approved').review.clearedReviewWarnings, [issues[0].key]);
  assert.deepEqual(outputState({ ok: true, reviewWarnings: issues, clearedReviewWarnings: [issues[0].key] }),
    { key: 'attention', label: '정렬 확인 1곳', tone: 'attention' });
  assert.deepEqual(outputState({ ok: true, reviewWarnings: issues,
    clearedReviewWarnings: issues.map(issue => issue.key) }),
    { key: 'ready', label: '경고 확인함', tone: 'ready' });
  assert.equal(visibleOutputReviewWarnings({ reviewWarnings: issues, clearedReviewWarnings: [],
    review: { clearedReviewWarnings: issues.map(issue => issue.key) } }).length, 0);
  const group = groupOutputs([
    { name: 'studio-ch06-lessons-ch06-l01', reviewWarnings: [issues[0]], ok: true },
    { name: 'studio-ch06-lessons-ch06-l02', reviewWarnings: [issues[1]], ok: true },
  ])[0];
  assert.equal(group.attention, 2);
  assert.equal(group.findings, 2, '묶음 머리글에도 실제 남은 정렬 경고 수를 적는다');
});

test('정렬 수치는 통과해도 남은 약한 말끝 후보를 숨기지 않는다', () => {
  const report = { alignmentQuality: { status: 'warning', summary: { alignmentEndBeyond250Ms: 0 },
    findings: { alignmentEnd: [] }, repairWarnings: [{ entry: 24, type: 'unassigned-weak-tail',
      startMs: 189_701.833, endMs: 189_807.812 }] },
    warnings: ['자막·화면 정렬에 확인할 경고가 있습니다.'] };
  const issues = outputReviewWarnings(report);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].startMs, 189_701.833);
  assert.deepEqual(outputReviewWarnings({ alignmentQuality: { status: 'passed', findings: { transitions: {} } },
    warnings: 'old malformed warning' }), [], '오래된 잘못된 경고 필드가 전체 결과 목록을 막지 않는다');
});

test('저장·재열기에서도 경고 위치와 확인 상태가 같은 결과에 남는다', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-warnings-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const studio = outputPathsForRoot(root);
  const target = { root: 'edit', day: '2026-09-27', name: 'ch06-l05-final' };
  const directory = path.join(studio.editOutputRoot, target.day, target.name);
  const videoPath = path.join(directory, `${target.name}.mp4`);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(videoPath, 'video');
  await fs.writeFile(path.join(directory, `${target.name}.timeline.json`), JSON.stringify({
    totalMs: 50_000, entries: [{ slideNumber: 705, slideId: 'slide-a', step: 0,
      startMs: 20_000, endMs: 50_000, sourceText: '대본', alignment: { words: [] } }],
  }));
  const report = { ...weakTailReport(), operation: 'screen-recapture', name: target.name,
    videoPath, summary: { ok: true }, target, review: { status: 'pending' } };
  await fs.writeFile(path.join(directory, 'validation-report.json'), JSON.stringify(report));
  const outputs = createOutputsService({ readAppSettings: async () => ({ paths: { outputRoot: root } }) });
  const issues = outputReviewWarnings(report);
  assert.deepEqual(await outputs.setClearedReviewWarnings(target, [issues[0].key], studio), [issues[0].key]);
  await outputs.setOutputReview(target, 'approved', studio);
  const [listed] = await outputs.listOutputs(studio, { includeLegacy: false });
  assert.deepEqual(listed.clearedReviewWarnings, [issues[0].key]);
  assert.equal(outputState(listed).label, '정렬 확인 1곳');

  const media = createMediaService({ readAppSettings: async () => ({ paths: { outputRoot: root } }),
    requireRuntimeTool: () => 'ffprobe', runUtility: async () => JSON.stringify({
      format: { duration: 50 }, streams: [{ codec_type: 'video', width: 2560, height: 1440 },
        { codec_type: 'audio', codec_name: 'aac' }],
    }) });
  const [opened] = await media.registerSelected([videoPath], 'video');
  assert.equal(opened.reviewWarnings.length, 2);
  assert.deepEqual(opened.clearedReviewWarnings, [issues[0].key]);
  assert.deepEqual(opened.reviewTarget, target);
  assert.equal(opened.pages[0].number, 705);
});
