import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {pathToFileURL} from 'node:url';
import {voiceQualityFindings} from './pipeline-utils.mjs';

const source=await fs.readFile(new URL('./main.mjs',import.meta.url),'utf8');
const methods=source.slice(source.indexOf('async function generateReplacementVoice('),source.indexOf('async function runTextVoiceCandidates('));
const {finding}=JSON.parse(await fs.readFile(new URL('../tests/fixtures/ch02-l04-omission.json',import.meta.url),'utf8'));

test('실제 페이지 후보 경로는 기존 누락 기록을 Python으로 보내고 후보당 한 번 정책을 유지한다',async()=>{
  const calls=[],written=[];
  const context=vm.createContext({path,crypto,pathToFileURL,voiceQualityFindings,
    DEFAULT_QUALITY_ATTEMPTS:4,ADAPTER:'approved-adapter',
    runtimePaths:()=>({sourceProjectRoot:'/source',referenceAudioPath:'/ref.wav',referenceTextPath:'/ref.txt'}),
    chosenRecord:()=>({voiceFindings:[finding]}),assertPageReplaceable(){},emit(){},
    requireRuntimeTool:()=>'/python',runProcess:async(stage,python,args)=>calls.push(args),
    registerSelected:async files=>files.map((file,index)=>({token:`candidate-${index}`})),
    fs:{mkdir:async()=>{},writeFile:async(file,text)=>written.push({file,text}),
      readFile:async()=>JSON.stringify({audioPath:'/generated.wav',chunks:[{startMs:1300,endMs:31300}]})},
  });
  vm.runInContext(methods+';globalThis.make=runVoiceCandidates;',context);
  await context.make({videoToken:'original',name:'repair',startPage:196,endPage:196,candidateCount:2,
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
