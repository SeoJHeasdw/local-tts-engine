import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { omissionEvidence } from './renderer/transcript-evidence.mjs';
import { findingExcerpt, findingSeek, findingStatus, voiceFindingReason,
  completionFindings, completionSummary, findingKeyOf } from './renderer/view-utils.mjs';
import { combineChapterReports } from './pipeline-utils.mjs';

const {finding, page} = JSON.parse(fs.readFileSync(new URL('../tests/fixtures/ch02-l04-omission.json', import.meta.url)));
const missing = '다음 요청에서는 개발자 지시와 도구를';

test('기존 L04 보고서만으로 누락 구절과 네 번 미해결을 명시한다', () => {
  const before = JSON.stringify(finding);
  assert.equal(omissionEvidence(finding)[0].text, missing);
  assert.equal(findingExcerpt(finding).term, missing);
  assert.equal(findingStatus(finding), '재생성 필요 · 구절 누락 의심 · 4회 생성 후 미해결');
  assert.equal(voiceFindingReason(finding), `받아쓰기에서 구절 누락: “${missing}”`);
  assert.equal(JSON.stringify(finding), before, '과거 판정과 사용자 확인 키는 변경하지 않는다');
  assert.equal(findingKeyOf(finding), '196:281475');
});

test('누락 구절 클릭은 정상 지시와 대신 문장 문맥으로 이동한다', () => {
  assert.deepEqual(findingSeek(finding, page), {startMs: 290055, endMs: 295415, word: missing, basis: 'sentence-context'});
  assert.ok(page.words.some(word => word.text === '개발자' && word.startMs === word.endMs));
  const noTimes = findingSeek(finding, {...page, words: []});
  assert.equal(noTimes.startMs, finding.startMs);
});

test('순서를 알 수 없는 반복 단어는 첫 번째 등장으로 잘못 이동하지 않는다', () => {
  assert.deepEqual(findingSeek({...finding, recognizedText: '', terms: [{term:'지시와'}]}, page),
    {startMs:finding.startMs, endMs:finding.endMs});
});

test('띄어쓰기와 짧은 오독을 구절 누락이라고 바꾸지 않는다', () => {
  for (const [expectedText, recognizedText] of [
    ['도구를 붙여 볼 수 있습니다.', '도구를 붙여볼 수 있습니다'],
    ['이번 요청에서는 개발자 지시를 불러옵니다.', '이번 요청에서는 기획자 지시를 불러옵니다.'],
    ['영문 문장을 읽습니다. Do my Bots share one computer?', '영문 문장을 읽습니다. Do my Bots share computer?'],
  ]) assert.deepEqual(omissionEvidence({...finding, expectedText, recognizedText}), []);
});

test('여러 레슨의 경고를 합산하고 각 영상으로 연결한다', () => {
  const reports = [
    {name:'l01', displayName:'CH02 L01', durationMs:1000, target:{root:'render',name:'l01'},
      checks:[{label:'파일',ok:true}], voiceQuality:{ok:true,clean:true},voiceFindings:[]},
    {name:'l04', displayName:'CH02 L04', durationMs:2000, target:{root:'render',name:'l04'},
      checks:[{label:'파일',ok:true}], voiceQuality:{ok:false,clean:false},voiceFindings:[finding]},
  ];
  const report = combineChapterReports({name:'ch02',title:'CH02'},reports);
  assert.equal(report.summary.ok,true);
  assert.equal(report.voiceQuality.ok,false);
  assert.equal(report.voiceFindings.length,1);
  const [shown] = completionFindings(report);
  assert.equal(shown.target.name,'l04');
  assert.equal(shown.displayName,'CH02 L04');
  assert.match(completionSummary(report,'3초'), /파일 검사 통과 · 재생성 필요 1곳/);
  assert.doesNotMatch(completionSummary(report,'3초'), /모든 결과 검증 통과|목소리 검수 통과/);
  // 과거 aggregate가 항목을 비워 놓아도 units 안의 원본으로 복구한다.
  assert.equal(completionFindings({...report,voiceFindings:[]}).length,1);
});

test('음성 검사 기록이 없으면 통과를 지어내지 않는다', () => {
  assert.match(completionSummary({summary:{ok:true}},'1초'),/목소리 검수 기록 없음/);
  assert.match(completionSummary({summary:{ok:true},voiceQuality:{clean:true}},'1초'),/목소리 검수 통과/);
});
