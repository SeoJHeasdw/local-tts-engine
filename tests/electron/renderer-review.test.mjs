import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReviewController } from '../../electron-app/renderer/controllers/review.mjs';
import { voiceQualityFindings } from '../../electron-app/shared/quality.mjs';

import { findingExcerpt, findingKeyOf, findingSeek, findingStatus } from '../../electron-app/renderer/view-utils.mjs';
import {parseRegionTime,formatRegionTime,regionIssue,regionImpact,regionWindow,timeAtFraction} from '../../electron-app/shared/regions.mjs';

function fixture() {
  const elements = new Map();
  const element = () => ({ value:'', textContent:'', disabled:false, currentTime:0, readyState:2, dataset:{}, listeners:{}, children:[], attributes:{},style:{},
    setPointerCapture(){},getBoundingClientRect(){return {left:0,width:1000};},
    classList:{add(){},remove(){},toggle(){}}, append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},
    setAttribute(k,v){this.attributes[k]=v;},getAttribute(k){return this.attributes[k];},removeAttribute(k){delete this.attributes[k];},
    pause(){this.paused=true;}, async play(){this.paused=false;}, click(){},
    addEventListener(name, callback){this.listeners[name]=callback;},
  });
  const $ = key => {if(!elements.has(key)) elements.set(key,element());return elements.get(key);};
  const modes = ['regenerate','mute','replace'].map(mode=>Object.assign(element(),{dataset:{repairMode:mode}}));
  const calls = [];
  const saved = [];
  const context = { $, $$:key=>key==='#review-mode-tabs button'?modes:[],
    document:{createElement:element}, mediaState:{voiceVideo:null, latestEditTarget:null},
    api:{startEdit:async payload=>calls.push(payload), setClearedFindings:async(target,keys)=>saved.push({target,keys})}, setEditBusy(){}, showToast(){},
    findingKeyOf, findingExcerpt, findingSeek, findingStatus,
    parseRegionTime,formatRegionTime,regionIssue,regionImpact,regionWindow,timeAtFraction,
    updateVoicePageMeta(){}, formatDuration:ms=>`${ms}`, voiceFindingReason:()=>'', voiceFindingLabel:()=>'',
    summarizeVoiceFindings:()=>({total:0,title:'',tone:'warning'}), Date, Number, Math,
  };
  const review = createReviewController(context);
  context.testReview = {
    ...review, selection:()=>review.reviewSelection, context:()=>review.pendingCandidateContext,
    queue:review.queueSelectedCandidate, save:review.savePendingFixes, pending:()=>review.pendingFixes,
    visible:review.visibleFindings, clear:review.clearFinding, restore:review.restoreClearedFindings,
    cleared:()=>review.clearedFindings,
  };
  const page1={number:1,slideId:'a',startMs:1300,endMs:33000,text:'첫 페이지'};
  const page2={number:2,slideId:'b',startMs:33750,endMs:50000,text:'다음 페이지'};
  const findings=[
    {slideNumber:1,startMs:1300,endMs:33000,severity:'failed',reasons:['단어 일부 누락']},
    {slideNumber:2,startMs:33750,endMs:50000,severity:'warning',reasons:['단어 발음 확인 필요']},
  ];
  context.testReview.setReviewVideo({token:'original',name:'original.mp4',videoUrl:'file:///original.mp4',pages:[page1,page2],voiceFindings:findings,reviewTarget:{root:'render',name:'original'}});
  return {context,$,modes,calls,saved,page1,page2,findings};
}

test('자동 권장이 없어도 재생 위치의 페이지를 직접 선택한다', () => {
  const {context,$}=fixture();
  $('#review-player').currentTime=35;
  $('#review-select-page').listeners.click();
  assert.equal(context.testReview.selection().number,2);
  assert.equal($('#start-review-button').disabled,false);
  assert.equal($('#voice-start-page').value,'2');
});

test('미등록 발음 경고도 기존 확인 완료·페이지 재생성 흐름을 사용한다', async () => {
  const { context, $, saved, page1 } = fixture();
  const [finding] = voiceQualityFindings({ chunks: [{ key: 'clip', startMs: 1300, endMs: 33000 }],
    entries: [{ chunkKey: 'clip', chapter: 'ch03', slide_number: 1, slide_id: 'a',
      tts_text: 'X-9876입니다.', unresolved_tokens: ['X-9876'] }] });
  context.testReview.setReviewVideo({ token: 'new', name: 'new.mp4', videoUrl: 'file:///new.mp4',
    pages: [page1], voiceFindings: [finding], reviewTarget: { root: 'render', name: 'new' } });
  assert.equal(context.testReview.visible().length, 1);
  await context.testReview.clear(finding);
  assert.equal(context.testReview.visible().length, 0);
  assert.deepEqual(saved.at(-1), { target: { root: 'render', name: 'new' }, keys: ['1:1300'] });
  context.testReview.selectReviewPage(page1);
  assert.equal($('#voice-start-page').value, '1');
  assert.equal($('#start-review-button').disabled, false);
});

test('후보 생성 대상은 이후 선택 페이지와 별개로 고정된다', async () => {
  const {context,$,calls,page1,page2}=fixture();
  context.testReview.selectReviewPage(page1);
  $('#voice-candidate-count').value='3';$('#voice-duration-policy').value='match-audio';
  await $('#review-form').listeners.submit({preventDefault(){}});
  context.testReview.selectReviewPage(page2);
  assert.equal(calls[0].videoToken,'original');
  assert.equal(calls[0].startPage,1);
  assert.equal(context.testReview.context().startPage,1);
  assert.equal(context.testReview.context().originalStartMs,1300);
});

test('페이지 타임라인이 없으면 재생성을 막고 구간 무음을 제공한다', () => {
  const {context,$,modes}=fixture();
  context.testReview.setReviewVideo({token:'external',name:'external.mp4',videoUrl:'file:///external.mp4',durationMs:10000,pages:[]});
  assert.equal($('#start-review-button').disabled,true);
  modes[1].listeners.click();
  assert.equal($('#start-review-button').disabled,false);
});

test('영상을 바꾸면 이전 후보 적용 대상이 지워진다', async () => {
  const {context,$,page1}=fixture();context.testReview.selectReviewPage(page1);
  await $('#review-form').listeners.submit({preventDefault(){}});
  context.testReview.setReviewVideo({token:'another',name:'another.mp4',videoUrl:'file:///another.mp4',pages:[]});
  assert.equal(context.testReview.context(),null);
  assert.equal(context.testReview.selection(),null);
});


test('짧은 소리 교체는 파일 선택 뒤에만 저장하고 구간과 파일을 전달한다', async () => {
  const {context,$,modes,calls}=fixture();
  modes[2].listeners.click();
  assert.equal($('#start-review-button').disabled,true);
  context.api.pickAudio=async()=>[{token:'short-audio',name:'짧은 문장.wav',audioUrl:'file:///short.wav',durationMs:800}];
  await $('#pick-region-audio').listeners.click();
  assert.equal($('#start-review-button').disabled,false);
  $('#review-mute-start').value='20.5'; $('#review-mute-end').value='21.5';
  await $('#review-form').listeners.submit({preventDefault(){}});
  assert.equal(calls[0].operation,'replace-region');
  assert.equal(calls[0].audioToken,'short-audio');
  assert.equal(calls[0].muteStart,20.5);
  assert.equal(calls[0].muteEnd,21.5);
});


test('고른 후보는 바로 굽지 않고 교체 대기 목록에 담긴다', async () => {
  // 예전에는 후보를 고르는 즉시 영상 전체를 다시 굽고 새 파일을 남겼다.
  // 확인할 곳이 여럿이면 그 값을 곳마다 치렀다.
  const {context,$,calls,page1}=fixture();
  context.testReview.selectReviewPage(page1);
  await $('#review-form').listeners.submit({preventDefault(){}});
  assert.equal(calls.length,1);
  assert.equal(calls[0].operation,'voice-candidates');

  assert.equal(context.testReview.queue('cand-token','목소리 후보 2'),true);
  assert.equal(calls.length,1, '후보를 고른 것만으로 편집 작업이 실행되면 안 된다');
  assert.equal(context.testReview.pending().size,1);
  assert.equal(context.testReview.pending().get(1).audioToken,'cand-token');
  assert.equal(context.testReview.context(),null,'담은 뒤에는 후보 대상이 남아 있으면 안 된다');
});

test('저장하면 담아 둔 교체를 한 번의 작업으로 함께 보낸다', async () => {
  const {context,$,calls,page1,page2}=fixture();
  $('#voice-duration-policy').value='match-audio';

  context.testReview.selectReviewPage(page1);
  await $('#review-form').listeners.submit({preventDefault(){}});
  context.testReview.queue('token-1','후보 1');
  context.testReview.selectReviewPage(page2);
  await $('#review-form').listeners.submit({preventDefault(){}});
  context.testReview.queue('token-2','후보 2');

  assert.equal(context.testReview.pending().size,2);
  const before = calls.length;
  await context.testReview.save();
  assert.equal(calls.length,before+1,'교체 개수와 무관하게 저장은 한 번이어야 한다');

  const saved = calls.at(-1);
  assert.equal(saved.operation,'voice-pages');
  assert.equal(saved.videoToken,'original');
  assert.equal(saved.durationPolicy,'match-audio');
  // The payload is built inside the vm realm, so compare by value.
  assert.deepEqual(JSON.parse(JSON.stringify(saved.patches)),[
    {startPage:1,endPage:1,audioToken:'token-1'},
    {startPage:2,endPage:2,audioToken:'token-2'},
  ]);
});

test('담아 둔 교체가 없으면 저장이 아무 작업도 보내지 않는다', async () => {
  const {context,calls}=fixture();
  await context.testReview.save();
  assert.equal(calls.length,0);
});

test('다른 영상을 열면 이전 영상의 교체 대기가 따라가지 않는다', async () => {
  const {context,$,page1}=fixture();
  context.testReview.selectReviewPage(page1);
  await $('#review-form').listeners.submit({preventDefault(){}});
  context.testReview.queue('token-1','후보 1');
  assert.equal(context.testReview.pending().size,1);

  context.testReview.setReviewVideo({token:'other',name:'other.mp4',videoUrl:'file:///other.mp4',pages:[]});
  assert.equal(context.testReview.pending().size,0);
});


test('확인 항목은 하나씩 확인 완료로 목록에서 내릴 수 있다', () => {
  // 목록에 남아 있는 것이 곧 남은 일이다. 처리한 항목이 계속 보이면
  // 무엇이 남았는지 목록만 봐서는 알 수 없다.
  const {context,$,findings}=fixture();
  assert.equal(context.testReview.visible().length,2);
  assert.equal($('#review-finding-count').textContent,'2');

  context.testReview.clear(findings[0]);

  assert.equal(context.testReview.visible().length,1);
  assert.equal(context.testReview.visible()[0].slideNumber,2);
  assert.equal($('#review-finding-count').textContent,'1');
});

test('한 페이지의 여러 지적은 한 번의 확인으로 함께 내려간다', () => {
  // 같은 페이지의 지적 둘을 따로 넘어갈 수는 없다. 고치는 단위가 페이지다.
  const {context,$,saved}=fixture();
  const twice=[
    {slideNumber:1,startMs:1300,endMs:9000,severity:'failed',reasons:['단어 일부 누락']},
    {slideNumber:1,startMs:9000,endMs:33000,severity:'warning',reasons:['발음 확인 필요']},
  ];
  context.testReview.setReviewVideo({token:'two',name:'two.mp4',videoUrl:'file:///two.mp4',
    pages:[{number:1,slideId:'a',startMs:1300,endMs:33000,text:'첫 페이지'}],voiceFindings:twice,
    reviewTarget:{root:'render',name:'two'}});
  assert.equal($('#review-finding-count').textContent,'2');
  const before=saved.length;

  const row=context.testReview.renderFindingGroup({number:1,findings:twice});
  const [done]=row.children[0].children[1].children.at(-1).children;
  assert.equal(done.textContent,'이 페이지 확인');
  done.listeners.click();

  assert.equal(context.testReview.visible().length,0);
  assert.equal($('#review-finding-count').textContent,'0');
  assert.equal(saved.length,before+1,'표시 저장은 한 번만 보낸다');
});

test('교체를 담으면 그 페이지의 확인 항목도 함께 내려간다', async () => {
  const {context,$}=fixture();
  context.testReview.selectReviewPage(context.testReview.selection()||undefined);
  const page1={number:1,slideId:'a',startMs:1300,endMs:33000,text:'첫 페이지'};
  context.testReview.selectReviewPage(page1);
  await $('#review-form').listeners.submit({preventDefault(){}});
  context.testReview.queue('token-1','후보 1');

  assert.equal(context.testReview.visible().length,1,'담은 페이지의 항목이 남아 있으면 안 된다');
  assert.equal(context.testReview.visible()[0].slideNumber,2);
});

test('확인 완료는 결과에 적혀 다음에 열어도 남는다', () => {
  // 세션 안에서만 사라지면 최근 결과에는 그대로 남고, 그 버튼은 아무것도 하지
  // 않은 것이 된다. 누르는 즉시 결과에 적는다.
  const {context,saved,findings}=fixture();
  context.testReview.clear(findings[0]);

  assert.equal(saved.length,1,'확인 완료를 눌렀는데 저장하지 않았다');
  assert.deepEqual(JSON.parse(JSON.stringify(saved[0].keys)),['1:1300']);
  assert.deepEqual(JSON.parse(JSON.stringify(saved[0].target)),{root:'render',name:'original'});
});

test('되돌리면 저장된 표시도 함께 지운다', () => {
  const {context,saved,findings}=fixture();
  context.testReview.clear(findings[0]);
  context.testReview.restore();

  assert.equal(saved.length,2);
  assert.deepEqual(JSON.parse(JSON.stringify(saved.at(-1).keys)),[]);
  assert.equal(context.testReview.cleared().size,0);
});

test('영상을 열 때 결과에 적힌 확인 표시를 불러온다', () => {
  const {context,$}=fixture();
  context.testReview.setReviewVideo({
    token:'saved',name:'saved.mp4',videoUrl:'file:///saved.mp4',pages:[],
    voiceFindings:[
      {slideNumber:5,startMs:1000,endMs:2000,severity:'warning',reasons:[]},
      {slideNumber:9,startMs:3000,endMs:4000,severity:'failed',reasons:[]},
    ],
    clearedFindings:['5:1000'],
    reviewTarget:{root:'render',name:'saved'},
  });

  assert.equal(context.testReview.visible().length,1,'저장된 표시가 반영되지 않았다');
  assert.equal(context.testReview.visible()[0].slideNumber,9);
  assert.equal($('#review-finding-count').textContent,'1');
});

test('다른 영상을 열면 앞 영상의 표시가 따라가지 않는다', () => {
  const {context,findings}=fixture();
  context.testReview.clear(findings[0]);
  assert.equal(context.testReview.cleared().size,1);

  context.testReview.setReviewVideo({token:'other',name:'other.mp4',videoUrl:'file:///other.mp4',pages:[],voiceFindings:[]});
  assert.equal(context.testReview.cleared().size,0);
});

test('실제 L04 항목은 누락 구절·미해결 횟수를 보이고 해당 문장부터 재생한다', async () => {
  const {finding,page}=JSON.parse(await fs.readFile(new URL('../fixtures/ch02-l04-omission.json',import.meta.url),'utf8'));
  const {context,$}=fixture();
  context.testReview.setReviewVideo({token:'l04',name:'L04.mp4',videoUrl:'file:///l04.mp4',pages:[{...page,text:finding.expectedText,slideId:'defaults-org-now'}],voiceFindings:[finding]});
  const item=context.testReview.renderVoiceFindingRow(finding);
  const [status,,line]=item.children;
  assert.equal(status.textContent,'재생성 필요 · 구절 누락 의심 · 4회 생성 후 미해결');
  assert.equal(line.children[1].textContent,'다음 요청에서는 개발자 지시와 도구를');

  // 펼치는 것과 그 자리를 듣는 것은 한 동작이다.
  const row=context.testReview.renderFindingGroup({number:Number(finding.slideNumber),findings:[finding]});
  const details=row.children[0];
  details.open=true;
  details.listeners.toggle();
  assert.equal($('#review-player').currentTime,290.055);
  assert.match($('#polish-diff-note').textContent,/구절 누락 의심 · 4회 생성 후 미해결/);
});

test('확인 항목의 재생성은 그 페이지로 후보 생성을 바로 건다', async () => {
  const {context,$,calls,modes,findings}=fixture();
  const row=context.testReview.renderFindingGroup({number:2,findings:[findings[1]]});
  // 넘어가기와 다시 만들기, 그리고 읽는 말 고치기가 한 줄에 나란히 선다.
  const tools=row.children[0].children[1].children.at(-1);
  const [done,again,rewrite]=tools.children;
  assert.equal(done.textContent,'확인');
  assert.equal(again.textContent,'재생성');
  assert.equal(rewrite.textContent,'읽는 말 바꿔 재생성');
  await again.listeners.click();
  assert.equal(calls.length,1);
  assert.equal(calls[0].operation,'voice-candidates');
  assert.equal(calls[0].startPage,2);
  assert.equal(calls[0].endPage,2);
  // 몇 번이고 다시 누를 수 있다. 후보가 별로면 그 자리에서 또 만든다.
  await again.listeners.click();
  assert.equal(calls.length,2);
  assert.equal(calls[1].startPage,2);
  // 구간 탭에 있었더라도 재생성 탭으로 되돌리고 시작한다.
  modes[1].listeners.click();
  await again.listeners.click();
  assert.equal(calls.at(-1).operation,'voice-candidates');
});

function longReview(context) {
  context.testReview.setReviewVideo({token:'long',name:'lesson.mp4',videoUrl:'file:///lesson.mp4',durationMs:400000,pages:[]});
}

test('구간 탭은 0초가 아니라 현재 듣는 위치에서 시작한다',()=>{
  const {context,$,modes}=fixture();longReview(context);$('#review-player').currentTime=295.12;
  modes[2].listeners.click();
  assert.equal($('#review-mute-start').value,'4:55.120');
  assert.equal($('#review-mute-end').value,'4:57.120');
  assert.equal($('#review-region-duration').textContent,'선택 길이 2.000초');
});

test('분:초 입력과 다른 길이의 음성이 저장 요청에 정확하게 전달된다',async()=>{
  const {context,$,modes,calls}=fixture();longReview(context);modes[2].listeners.click();
  context.api.pickAudio=async()=>[{token:'replacement',name:'voice.wav',audioUrl:'file:///voice.wav',durationMs:3000}];
  await $('#pick-region-audio').listeners.click();
  $('#review-mute-start').value='4:55.120';$('#review-mute-end').value='297.350';
  $('#review-mute-end').listeners.input();
  assert.equal($('#start-review-button').disabled,false);
  assert.match($('#review-region-impact').textContent,/0.770초 늘어남/);
  await $('#review-form').listeners.submit({preventDefault(){}});
  assert.equal(calls.at(-1).muteStart,295.12);assert.equal(calls.at(-1).muteEnd,297.35);
  assert.equal(calls.at(-1).durationPolicy,'match-audio');
});

test('불완전한 시각과 역전된 구간은 저장을 시작하지 않는다',async()=>{
  const {context,$,modes,calls}=fixture();longReview(context);modes[1].listeners.click();
  $('#review-mute-start').value='4:';$('#review-mute-start').listeners.input();
  assert.equal($('#start-review-button').disabled,true);
  await $('#review-form').listeners.submit({preventDefault(){}});assert.equal(calls.length,0);
  $('#review-mute-start').value='5';$('#review-mute-end').value='4';$('#review-mute-end').listeners.input();
  assert.match($('#review-region-error').textContent,/끝은 시작보다/);
  await $('#review-form').listeners.submit({preventDefault(){}});assert.equal(calls.length,0);
});

test('0.01초 조정은 분 경계에서도 오차 없이 이어진다',()=>{
  const {context,$,modes}=fixture();longReview(context);modes[2].listeners.click();
  $('#review-mute-start').value='1:59.995';$('#review-mute-end').value='2:01.000';
  $('#review-start-next').listeners.click();assert.equal($('#review-mute-start').value,'2:00.005');
  $('#review-start-back').listeners.click();assert.equal($('#review-mute-start').value,'1:59.995');
});

test('파형 손잡이를 끌어 구간을 선택하고 키보드로 미세 조정한다',()=>{
  const {context,$,modes}=fixture();longReview(context);$('#review-player').currentTime=295;modes[2].listeners.click();
  const handle=$('#review-wave-start');handle.listeners.pointerdown({pointerId:1});
  handle.listeners.pointermove({pointerId:1,clientX:500});handle.listeners.pointerup({});
  assert.equal($('#review-mute-start').value,'4:56.000');
  handle.listeners.keydown({key:'ArrowRight',preventDefault(){}});
  assert.equal($('#review-mute-start').value,'4:56.010');
});

test('정밀 미리듣기는 실제 선택 범위를 잘라 요청하고 바뀐 선택의 옛 응답을 버린다',async()=>{
  const {context,$,modes}=fixture();longReview(context);$('#review-player').currentTime=295;modes[1].listeners.click();
  let finish;const requests=[];
  context.api.reviewPreview=payload=>{requests.push(payload);return new Promise(resolve=>{finish=resolve;});};
  const pending=$('#review-range-exact').listeners.click();
  assert.equal(requests[0].start,295);assert.equal(requests[0].end,295.2);assert.equal(requests[0].context,0);
  $('#review-mute-end').value='295.3';$('#review-mute-end').listeners.input();
  finish({audioUrl:'file:///old-selection.wav'});await pending;
  assert.notEqual($('#review-preview-player').src,'file:///old-selection.wav');
});

test('교체 전 미리듣기는 길이 정책을 넘기며 아직 편집본을 저장하지 않는다',async()=>{
  const {context,$,modes,calls}=fixture();longReview(context);modes[2].listeners.click();
  context.api.pickAudio=async()=>[{token:'voice',name:'voice.wav',audioUrl:'file:///voice.wav',durationMs:3000}];
  await $('#pick-region-audio').listeners.click();
  const requests=[];context.api.reviewPreview=async payload=>{requests.push(payload);return {audioUrl:'file:///after.wav'};};
  await $('#review-result-play').listeners.click();
  assert.equal(requests[0].mode,'replace');assert.equal(requests[0].durationPolicy,'match-audio');
  assert.equal($('#review-preview-player').src,'file:///after.wav');assert.equal(calls.length,0);
  assert.match($('#review-preview-note').textContent,/아직 저장하지 않았습니다/);
});


test('읽는 말을 적으면 그 말로 후보를 만들고, 누르기만 해서는 생성하지 않는다', async () => {
  // 몇 번을 다시 만들어도 같게 읽히는 자리가 있다. 그때는 사람이 읽을 말을 적는다.
  const {context,$,calls,findings,page2}=fixture();
  const row=context.testReview.renderFindingGroup({number:2,findings:[findings[1]]});
  const [,,rewrite]=row.children[0].children[1].children.at(-1).children;

  rewrite.listeners.click();
  assert.equal(calls.length,0,'입력칸만 열고 생성을 걸지는 않는다');
  assert.equal($('#voice-override-text').value,page2.text,'대본을 그대로 채워 고쳐 쓰게 한다');
  assert.equal($('#voice-script-override').open,true);

  $('#voice-override-text').value='주문 에이 이공구일의 환불';
  $('#voice-override-text').listeners.input();
  assert.equal($('#start-review-label').textContent,'입력한 말로 후보 만들기');

  $('#review-form').listeners.submit({preventDefault(){}});
  await Promise.resolve();
  assert.equal(calls.at(-1).operation,'voice-candidates');
  assert.equal(calls.at(-1).overrideText,'주문 에이 이공구일의 환불');
  assert.equal(calls.at(-1).startPage,2);
});

test('적어 둔 읽는 말은 그 페이지에만 쓰인다', async () => {
  const {context,$,calls,page1}=fixture();
  $('#review-player').currentTime=35;
  $('#review-select-page').listeners.click();
  $('#voice-override-text').value='이 페이지에만 쓰는 말';
  $('#voice-override-text').listeners.input();

  context.testReview.selectReviewPage(page1);

  assert.equal($('#voice-override-text').value,'','다른 페이지로 옮기면 앞 페이지의 말을 물려주지 않는다');
  $('#review-form').listeners.submit({preventDefault(){}});
  await Promise.resolve();
  assert.equal(calls.at(-1).overrideText,'');
});
