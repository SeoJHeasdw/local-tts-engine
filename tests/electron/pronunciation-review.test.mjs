import test from 'node:test';
import assert from 'node:assert/strict';
import { voiceQualityFindings, withClearedFindings, combineChapterReports } from '../../electron-app/shared/quality.mjs';
import { completionSummary, visibleVoiceFindings, findingKeyOf, findingStatus } from '../../electron-app/renderer/view-utils.mjs';

function manifest() {
  return {
    entries: [{ chunkKey: 'clip', chapter: 'ch03', slide_id: 'refund', slide_number: 335,
      source_text: 'UnknownTerm과 X-9876을 확인합니다.', tts_text: 'UnknownTerm과 X-9876을 확인합니다.',
      unresolved_tokens: ['UnknownTerm', 'X-9876'], naturalness_warnings: ['X-9876: 읽기 확인'] }],
    chunks: [{ key: 'clip', startMs: 2000, endMs: 6000 }],
    quality: { enabled: true, summary: { clean: true }, chunks: [{ chunkKey: 'clip', severity: 'ok', selected: {
      passed: true, expectedText: 'UnknownTerm과 X-9876을 확인합니다.', recognizedText: '언노운 텀과 엑스 구팔칠육을 확인합니다.',
    } }] },
  };
}

test('자동 판독이 통과해도 사전 미등록 용어는 실제 구간의 청취 확인으로 남는다', () => {
  const m = manifest(), original = JSON.stringify(m);
  const findings = voiceQualityFindings(m);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'warning');
  assert.deepEqual([findings[0].startMs, findings[0].endMs], [2000, 6000]);
  assert.equal(findings[0].recognizedText, m.quality.chunks[0].selected.recognizedText);
  assert.deepEqual(findings[0].terms.map(item => item.term), ['UnknownTerm', 'X-9876']);
  assert.equal(findingStatus(findings[0]), '청취 확인 권장');
  const report = withClearedFindings({ voiceFindings: findings }, [findingKeyOf(findings[0])]);
  assert.equal(visibleVoiceFindings(report.voiceFindings, report.review.clearedFindings).length, 0);
  assert.equal(JSON.stringify(m), original);
  assert.match(completionSummary({ voiceFindings: findings, voiceQuality: { clean: true }, summary: { ok: true } }, '6초'), /확인 권장 1곳/);
});

test('발음 사전 경고를 기존 오독과 합쳐도 실패 판정·실제 범위·받아쓰기를 잃지 않는다', () => {
  const m = manifest();
  Object.assign(m.quality.chunks[0], { chapter: 'ch03', slideNumber: 335, slideId: 'refund', severity: 'failed' });
  Object.assign(m.quality.chunks[0].selected, { passed: false, failures: ['받아쓰기 불일치'] });
  const findings = voiceQualityFindings(m);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'failed');
  assert.ok(findings[0].reasons.includes('받아쓰기 불일치'));
  assert.ok(findings[0].reasons.some(reason => reason.includes('발음 사전 미등록')));
  assert.equal(findings[0].terms.length, 2);
});

test('판독을 끈 제작도 미등록 용어를 표시하고 등록된 용어는 경고하지 않는다', () => {
  const m = manifest(); delete m.quality;
  assert.equal(voiceQualityFindings(m).length, 1);
  m.entries[0].unresolved_tokens = []; m.entries[0].naturalness_warnings = [];
  assert.equal(voiceQualityFindings(m).length, 0);
});

test('부분 완료와 전부 실패를 성공 문구나 잘못된 영상 수로 표시하지 않는다', () => {
  const failure = { name: 'l02', title: 'L02', message: '파일 생성 실패' };
  const report = combineChapterReports({ name: 'chapter' }, [{ name: 'l01', durationMs: 1000,
    target: { name: 'l01' }, checks: [{ label: '파일', ok: true }] }], [failure]);
  assert.match(completionSummary(report, '1초'), /2개 레슨 중 1개 완료 · 1개 실패/);
  const failed = combineChapterReports({ name: 'chapter' }, [], [failure]);
  assert.equal(failed.summary.ok, false);
  assert.equal(failed.voiceQuality, null);
  assert.equal(completionSummary(failed, '0초'), '1개 레슨 제작 실패 · 완성된 영상 없음');
});
