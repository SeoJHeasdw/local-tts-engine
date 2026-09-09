import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('./renderer/app.js', import.meta.url), 'utf8');
const controller = source.slice(source.indexOf('let reviewTarget ='), source.indexOf('function formatDate('));
function fixture() {
  const elements = new Map();
  const element = () => ({ value:'', textContent:'', disabled:false, currentTime:0, readyState:2, dataset:{}, listeners:{},
    classList:{add(){},remove(){},toggle(){}}, append(){},replaceChildren(){},setAttribute(){},removeAttribute(){},
    pause(){this.paused=true;}, async play(){this.paused=false;}, click(){},
    addEventListener(name, callback){this.listeners[name]=callback;},
  });
  const $ = key => {if(!elements.has(key)) elements.set(key,element());return elements.get(key);};
  const modes = ['regenerate','mute','replace'].map(mode=>Object.assign(element(),{dataset:{repairMode:mode}}));
  const calls = [];
  const context = vm.createContext({ $, $$:key=>key==='#review-mode-tabs button'?modes:[],
    document:{createElement:element}, voiceVideo:null, latestEditTarget:null,
    api:{startEdit:async payload=>calls.push(payload)}, setEditBusy(){}, showToast(){},
    updateVoicePageMeta(){}, formatDuration:ms=>`${ms}`, voiceFindingReason:()=>'', voiceFindingLabel:()=>'',
    summarizeVoiceFindings:()=>({total:0,title:'',tone:'warning'}), Date, Number, Math,
  });
  vm.runInContext(controller+`;globalThis.testReview={setReviewVideo,selectReviewPage,currentReviewPage,selection:()=>reviewSelection,context:()=>pendingCandidateContext,queue:queueSelectedCandidate,save:savePendingFixes,pending:()=>pendingFixes};`,context);
  const page1={number:1,slideId:'a',startMs:1300,endMs:33000,text:'첫 페이지'};
  const page2={number:2,slideId:'b',startMs:33750,endMs:50000,text:'다음 페이지'};
  context.testReview.setReviewVideo({token:'original',name:'original.mp4',videoUrl:'file:///original.mp4',pages:[page1,page2]});
  return {context,$,modes,calls,page1,page2};
}

test('자동 권장이 없어도 재생 위치의 페이지를 직접 선택한다', () => {
  const {context,$}=fixture();
  $('#review-player').currentTime=35;
  $('#review-select-page').listeners.click();
  assert.equal(context.testReview.selection().number,2);
  assert.equal($('#start-review-button').disabled,false);
  assert.equal($('#voice-start-page').value,'2');
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
  context.testReview.setReviewVideo({token:'external',name:'external.mp4',videoUrl:'file:///external.mp4',pages:[]});
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
  context.api.pickAudio=async()=>[{token:'short-audio',name:'짧은 문장.wav',audioUrl:'file:///short.wav'}];
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
