import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import { createEditingRegionsService } from '../../electron-app/main/editing/regions.mjs';

test('앱의 실제 구간 저장 경로가 새 영상·타임라인·자막·검수 기록을 함께 만든다',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tts-region-pipeline-'));
  const run=args=>execFileSync('ffmpeg',['-v','error',...args],{maxBuffer:2_000_000});
  const probe=file=>JSON.parse(execFileSync('ffprobe',['-v','error','-show_format','-show_streams','-of','json',file],{encoding:'utf8'}));
  try{
    const original=path.join(directory,'original.mkv'),audio=path.join(directory,'replacement.wav');
    run(['-f','lavfi','-i','testsrc2=size=160x90:rate=25:duration=4','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=4','-c:v','libx264','-preset','ultrafast','-c:a','pcm_s16le',original]);
    run(['-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=1.1',audio]);
    const timeline={totalMs:4000,entries:[{startMs:0,endMs:1000,slideNumber:1},{startMs:1000,endMs:1600,slideNumber:2},{startMs:1600,endMs:4000,slideNumber:3}]};
    const timelinePath=path.join(directory,'timeline.json'),reportPath=path.join(directory,'validation-report.json');
    await fs.writeFile(timelinePath,JSON.stringify(timeline));
    await fs.writeFile(reportPath,JSON.stringify({voiceFindings:[{slideNumber:3,startMs:3000,endMs:3500,severity:'warning'}],review:{clearedFindings:['3:3000']}}));
    await fs.writeFile(path.join(directory,'captions.json'),JSON.stringify([{startMs:1700,endMs:2000,text:'다음 문장'}]));
    const records={video:{path:original,name:'lesson.mkv',timelinePath,reportPath},audio:{path:audio,name:'voice.wav'}};
    const edits=createEditingRegionsService({
      chosenRecord:(token,kind)=>{assert.equal(token,kind);return records[kind];},
      inspectMedia:async file=>probe(file),requireRuntimeTool:()=> 'ffmpeg',
      runProcess:async(stage,command,args)=>execFileSync(command,args,{maxBuffer:2_000_000}),
      safeStat:async file=>fs.stat(file).catch(()=>null),
      validateEditVideo:async(file,operation,inputs,out)=>({videoPath:file,operation,inputs,durationMs:Math.round(Number(probe(file).format.duration)*1000),checks:[{label:'파일',ok:true}],summary:{ok:true}}),
    });
    const out=path.join(directory,'edit');await fs.mkdir(out);
    const result=await edits.runRegionReplaceEdit({videoToken:'video',audioToken:'audio',name:'repair',muteStart:1,muteEnd:1.6,durationPolicy:'match-audio'},out);
    assert.equal(result.summary.ok,true);assert.equal(result.repair.deltaMs,500);
    assert.equal(JSON.parse(await fs.readFile(path.join(out,'timeline.json'))).totalMs,4500);
    assert.match(await fs.readFile(path.join(out,'captions.srt'),'utf8'),/00:00:02,200/);
    assert.equal(result.voiceFindings[0].startMs,3500);
    assert.deepEqual(JSON.parse(JSON.stringify(result.review.clearedFindings)),['3:3500']);
    assert.equal(result.review.status,'pending');
    const removed=path.join(directory,'mute');await fs.mkdir(removed);
    const muted=await edits.runMuteEdit({videoToken:'video',name:'quiet',muteStart:1.125,muteEnd:1.175},removed);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(removed,'timeline.json'))),timeline);
    assert.equal(muted.voiceFindings[0].startMs,3000);
    assert.equal(JSON.parse(await fs.readFile(timelinePath)).totalMs,4000,'원본 타임라인 보존');
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
