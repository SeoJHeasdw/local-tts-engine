import test from 'node:test';
import assert from 'node:assert/strict';
import { combineChapterReports } from '../../electron-app/shared/quality.mjs';
import { completionWarnings, renderCompletionWarnings } from '../../electron-app/renderer/view-utils.mjs';

test('챕터 두 번째 레슨의 정렬 경고가 완료 안내까지 보존되며 음성 실패로 합쳐지지 않는다', () => {
  const quality = { status: 'warning', summary: { transitions: 1, earlyCaptionsOver20Ms: 2 } };
  const report = combineChapterReports({ name: 'chapter' }, [
    { name: 'L01', checks: [{ label: '파일', ok: true }], alignmentQuality: { status: 'passed' } },
    { name: 'L02', checks: [{ label: '파일', ok: true }], alignmentQuality: quality },
  ]);
  assert.deepEqual(report.units[1].alignmentQuality, quality);
  assert.deepEqual(report.voiceFindings, []);
  assert.equal(report.summary.ok, true);
  assert.deepEqual(completionWarnings(report), [
    'L02: 자막·화면 정렬 확인: 목소리 위에 걸린 화면 전환 1곳',
    'L02: 자막·화면 정렬 확인: 말보다 먼저 사라진 자막 2곳',
  ]);
});

test('제작·수정 완료 경고 표시는 다음 통과 결과에서 지워지고 미검사도 숨기지 않는다', () => {
  const classes = new Set(['hidden']);
  const element = { textContent: '', classList: { toggle: (name, hidden) => hidden ? classes.add(name) : classes.delete(name) } };
  assert.equal(renderCompletionWarnings(element, { alignmentQuality: { status: 'warning', warningCount: 3 } }), 1);
  assert.match(element.textContent, /자막·화면 정렬.*3곳/);
  assert.equal(classes.has('hidden'), false);
  renderCompletionWarnings(element, { alignmentQuality: { status: 'not-checked' } });
  assert.match(element.textContent, /완료하지 못했/);
  assert.equal(renderCompletionWarnings(element, { alignmentQuality: { status: 'passed' } }), 0);
  assert.equal(element.textContent, '');
  assert.equal(classes.has('hidden'), true);
});

test('저장된 경고와 레슨 기록만 있는 옛 챕터 보고서도 완료 안내에서 읽는다', () => {
  assert.deepEqual(completionWarnings({ warnings: ['정렬 확인', '정렬 확인', ''] }), ['정렬 확인']);
  assert.deepEqual(completionWarnings({ units: [
    { name: 'L01', alignmentQuality: { status: 'passed' } },
    { name: 'L02', warnings: ['전환 확인'] },
  ] }), ['L02: 전환 확인']);
});
