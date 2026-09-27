import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPTION_LIMITS, buildCaptionCues, buildSpanCues } from '../../electron-app/shared/captions.mjs';

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

test('숫자·영문이 여러 단어로 읽혀도 cue 경계는 그 글을 읽는 단어에서 나뉜다', () => {
  // “30점” → “삼십 점”처럼 대본 토큰 수와 정렬 단어 수가 다르다. 글자 수 비례로 나누면
  // “29점입니다.”가 “점과”에서 뜨고, 다음 문장 자막이 “점입니다”를 말하는 중에 먼저 뜬다.
  const spoken = [
    ['규칙', 1000, 1300], ['삼십', 1300, 1700], ['점', 1700, 1950], ['에이전트', 2100, 2600], ['하나', 2600, 2900],
    ['사십', 2900, 3250], ['점', 3250, 3500], ['두', 4000, 4200], ['오케스트레이터는', 4200, 5100], ['이십칠', 5100, 5600],
    ['점과', 5600, 6000], ['이십구', 6100, 6400], ['점입니다', 6400, 7000], ['쉬운', 7500, 7800], ['문의에서도', 7800, 8500],
    ['나눈', 8500, 8800], ['쪽이', 8800, 9100], ['규칙보다', 9100, 9600], ['낮았습니다', 9600, 10300],
  ].map(([text, startMs, endMs]) => ({ text, startMs, endMs }));
  const cues = buildCaptionCues({ totalMs: 11000, entries: [{
    sourceText: '규칙 30점, Agent 하나 40점, 두 Orchestrator는 27점과 29점입니다. 쉬운 문의에서도 나눈 쪽이 규칙보다 낮았습니다.',
    startMs: 900, endMs: 10600, alignment: { correction: {}, words: spoken },
  }] });
  const flat = (cue) => cue.text.replace(/\n/g, ' ');
  assert.deepEqual(cues.map(flat), [
    '규칙 30점, Agent 하나 40점,', '두 Orchestrator는 27점과 29점입니다.', '쉬운 문의에서도 나눈 쪽이 규칙보다 낮았습니다.',
  ]);
  const at = (text) => spoken.find((word) => word.text === text);
  // 각 cue는 제 첫 단어 직전에 뜨고, 제 마지막 단어가 끝날 때까지 남는다.
  assert.equal(cues[1].startMs, at('두').startMs - 60);
  assert.ok(cues[0].endMs >= at('사십').endMs + 250, '“40점,”을 말하는 동안 첫 자막이 남는다');
  assert.ok(cues[1].endMs >= at('점입니다').endMs, '“29점입니다”가 끝나기 전에 사라지지 않는다');
  assert.equal(cues[2].startMs, at('쉬운').startMs - 60, '다음 문장 자막은 그 문장을 말할 때 뜬다');
});

test('긴 문장은 고르게 나눠 끝 서술어만 남은 조각을 만들지 않는다', () => {
  const cues = buildSpanCues([{
    text: '9월 6일에 오기로 한 서큘레이터가 아직 안 왔다며, 보상해 주지 않느냐는 문의입니다.', startMs: 0, durationMs: 8000,
  }], 8000);
  const texts = cues.map((cue) => cue.text.replace(/\n/g, ' '));
  assert.deepEqual(texts, ['9월 6일에 오기로 한 서큘레이터가 아직 안 왔다며,', '보상해 주지 않느냐는 문의입니다.']);
  for (const text of texts) assert.ok([...text].length <= CAPTION_LIMITS.maxCharsPerCue && text.replace(/\s/g, '').length > 6);
});

test('나눌 필요 없는 두 문장도 숫자 읽기 때문에 경계가 앞 문장 끝을 빼앗지 않는다', () => {
  const spoken = [['팔십', 500, 900], ['점', 900, 1100], ['만점에', 1100, 1600], ['오십칠', 1600, 2100], ['점입니다', 2100, 2700],
    ['에이전트', 3200, 3700], ['하나에', 3700, 4100], ['이십삼', 4100, 4600], ['점', 4600, 4800], ['졌습니다', 4800, 5400]]
    .map(([text, startMs, endMs]) => ({ text, startMs, endMs }));
  const cues = buildCaptionCues({ totalMs: 6000, entries: [{
    sourceText: '80점 만점에 57점입니다. Agent 하나에 23점 졌습니다.', startMs: 400, endMs: 5800,
    alignment: { correction: {}, words: spoken },
  }] });
  assert.equal(cues.length, 2);
  assert.ok(cues[0].endMs >= 2700, '“점입니다”까지 첫 자막이 남는다');
  assert.equal(cues[1].startMs, 3200 - 60, '둘째 문장은 “에이전트”에서 뜬다');
});
