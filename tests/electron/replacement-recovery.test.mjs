import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createVoicesService } from '../../electron-app/main/voices.mjs';

const {finding}=JSON.parse(await fs.readFile(new URL('../fixtures/ch02-l04-omission.json',import.meta.url),'utf8'));

test('실제 페이지 후보 경로는 기존 누락 기록을 Python으로 보내고 후보당 한 번 정책을 유지한다',async()=>{
  const calls=[],written=[];
  const voices=createVoicesService({
    chosenRecord:()=>({voiceFindings:[finding],timelinePath:'/timeline.json',pageRange:{start:196,end:196}}),emit(){},
    requireRuntimeTool:()=>'/python',runProcess:async(stage,python,args)=>calls.push(args),
    registerSelected:async files=>files.map((file,index)=>({token:`candidate-${index}`})),
    fs:{mkdir:async()=>{},writeFile:async(file,text)=>written.push({file,text}),
      readFile:async()=>JSON.stringify({audioPath:'/generated.wav',chunks:[{startMs:1300,endMs:31300}]})},
  });
  await voices.runVoiceCandidates({videoToken:'original',name:'repair',startPage:196,endPage:196,candidateCount:2,
    adapterScale:.6,recoveryFindings:[{expectedText:'caller supplied wrong hint'}]},'/output');
  assert.equal(calls.length,2);
  for(const [index,args] of calls.entries()){
    assert.equal(args[args.indexOf('--quality-attempts')+1],'1');
    assert.equal(args[args.indexOf('--adapter-scale')+1],'0.6');
    const recovery=args[args.indexOf('--recovery-findings')+1];
    assert.equal(recovery,`/output/candidates/candidate-0${index+1}/recovery-findings.json`);
    assert.deepEqual(JSON.parse(written.find(w=>w.file===recovery).text),[finding]);
  }
});

test('읽을 말을 적으면 그 말로 후보를 만들고 대본 재합성을 돌리지 않는다',async()=>{
  // 사전에 없는 식별자는 시드를 바꿔도 같은 자리에서 같게 읽힌다. 그때는
  // 사람이 적어 준 문장이 그 페이지의 발음문이 된다.
  const calls=[],written=[];
  const voices=createVoicesService({
    chosenRecord:()=>({voiceFindings:[finding],timelinePath:'/timeline.json',pageRange:{start:196,end:196}}),emit(){},
    requireRuntimeTool:()=>'/python',runProcess:async(stage,python,args)=>calls.push(args),
    registerSelected:async(files,kind,extras)=>files.map((file,index)=>({token:`spoken-${index}`,...extras[index]})),
    fs:{mkdir:async()=>{},writeFile:async(file,text)=>written.push({file,text}),
      readFile:async()=>JSON.stringify({durationMs:4200})},
  });

  const candidates=await voices.runVoiceCandidates({videoToken:'original',name:'spoken',startPage:196,endPage:196,
    candidateCount:2,adapterScale:.6,overrideText:'주문 에이 이공구일의 환불'},'/output');

  assert.equal(calls.length,2);
  for(const args of calls){
    assert.ok(args.includes('local_tts_engine.text_candidate'));
    assert.ok(!args.includes('--recovery-findings'),'대본 재합성 경로의 복구 힌트를 섞지 않는다');
    const textFile=args[args.indexOf('--text-file')+1];
    assert.equal(written.find(w=>w.file===textFile).text,'주문 에이 이공구일의 환불\n');
  }
  // 만든 음성 전체가 그 페이지의 음성이 된다. 잘라 낼 구간이 없다.
  assert.deepEqual(candidates.map(item=>item.generatedVoice.sourceEndMs),[4200,4200]);
  assert.deepEqual(candidates.map(item=>item.generatedVoice.startPage),[196,196]);
  assert.deepEqual(candidates.map(item=>item.voiceFindings),[[],[]]);
  assert.match(candidates[0].name,/입력한 말/);
});
