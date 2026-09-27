import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCaptionCues } from '../../electron-app/shared/captions.mjs';

test('교정한 마지막 자막은 화면 경계까지 남고 다음 페이지에 앞서 뜨지 않는다', () => {
  const timeline = { totalMs: 6200, entries: [
    { sourceText: '계약은 같습니다.', startMs: 1000, endMs: 5000,
      alignment: { correction: { algorithmVersion: 'waveform-constrained-v1' }, words: [
        { text: '계약은', startMs: 3490, endMs: 3912 }, { text: '같습니다', startMs: 3912, endMs: 4475 },
      ] } },
    { sourceText: '다음입니다.', startMs: 5000, endMs: 6200,
      alignment: { correction: { algorithmVersion: 'waveform-constrained-v1' }, words: [
        { text: '다음입니다', startMs: 5035, endMs: 6000 },
      ] } },
  ] };
  const cues = buildCaptionCues(timeline);
  assert.equal(cues[0].startMs, 3430);
  assert.ok(cues[0].endMs >= 4475, '실제 말이 끝나기 전에 없어지지 않는다');
  assert.equal(cues[0].endMs, 4980);
  assert.equal(cues[1].startMs, 5000, '화면 경계 전이면 이전 스텝의 자막으로 잘못 배정된다');
  assert.equal(cues[1].endMs, 6200);
});

test('정렬 단어가 교정된 시각으로 바뀌면 자막도 새 위치를 사용한다', () => {
  const entry = { sourceText: '계약은 같습니다.', startMs: 0, endMs: 5000,
    alignment: { correction: {}, rawWords: [{text: '계약은', startMs: 1760, endMs: 2400}], words: [
      { text: '계약은', startMs: 3490, endMs: 3912 }, { text: '같습니다', startMs: 3912, endMs: 4475 },
    ] } };
  const cues = buildCaptionCues({ totalMs: 5000, entries: [entry] });
  assert.equal(cues[0].startMs, 3430);
  assert.equal(cues[0].endMs, 5000);
});
