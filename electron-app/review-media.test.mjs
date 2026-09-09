import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {parseRegionTime,formatRegionTime,regionIssue,regionImpact,timeAtFraction,regionWindow} from './renderer/region-utils.mjs';
import {regionReplacementPlan,retimeCaptions,captionText,editedReviewContext,audioEnvelope,makeRegionPreview} from './review-media.mjs';
import {patchedTimeline,muteRegionFilter} from './pipeline-utils.mjs';

test('분:초와 밀리초를 정확히 읽고 미완성·잘못된 시각을 0초로 바꾸지 않는다',()=>{
  assert.equal(parseRegionTime('4:55.120'),295.12);
  assert.equal(parseRegionTime('295.120'),295.12);
  assert.equal(parseRegionTime('1:04:55.120'),3895.12);
  for(const text of ['', '4:', '1:60', '1:02:60', 'abc', '-1','1.2.3'])assert.ok(Number.isNaN(parseRegionTime(text)));
  assert.equal(formatRegionTime(59.9996),'1:00.000');
  assert.equal(formatRegionTime(295.12),'4:55.120');
});

test('범위·길이 정책과 밀리초 경계 오류를 저장 전에 판정한다',()=>{
  const r={start:295.12,end:297.35,duration:400,mode:'replace',audioDuration:3};
  assert.equal(regionIssue({...r,fit:'match-audio'}),'');
  assert.match(regionIssue({...r,fit:'keep-video'}),/더 깁니다/);
  assert.match(regionIssue({...r,end:295}),/끝은 시작보다/);
  assert.match(regionIssue({...r,end:401}),/영상 범위/);
  assert.match(regionIssue({...r,mode:'mute'}),/2초까지/);
  assert.match(regionImpact(r.start,r.end,3,'match-audio'),/0.770초 늘어남/);
  assert.doesNotThrow(()=>muteRegionFilter(1.001,1.051,4));
  assert.deepEqual(regionWindow(0,10,4),{start:0,end:4});
  assert.equal(timeAtFraction(.5,{start:295,end:296}),295.5);
});

test('길이가 늘거나 줄면 뒤 타임라인과 자막도 같은 차이로 이동한다',()=>{
  const timeline={totalMs:4000,entries:[{startMs:1000,endMs:1600,transitionAtMs:1600,alignment:{words:[{text:'구절',startMs:1100,endMs:1500}]}},{startMs:1600,endMs:4000}]};
  const p=regionReplacementPlan(1,1.6,4,1.1,'match-audio');
  assert.equal(p.deltaMs,500);assert.equal(p.videoUnchanged,false);
  const moved=patchedTimeline(timeline,1000,1600,1100);
  assert.equal(moved.totalMs,4500);assert.equal(moved.entries[1].startMs,2100);
  const captions=retimeCaptions([{text:'다음 구절',startMs:1700,endMs:2000}],1000,1600,1100);
  assert.deepEqual(captions,[{text:'다음 구절',startMs:2200,endMs:2500}]);
  assert.match(captionText(captions),/00:00:02,200 --> 00:00:02,500/);
  assert.match(captionText(captions,true),/WEBVTT\n\n00:00:02.200/);
  assert.equal(regionReplacementPlan(1,2,4,.5,'match-audio').deltaMs,-500);
  assert.equal(regionReplacementPlan(1,2,4,.5,'keep-video').videoUnchanged,true);
});

test('편집 구간의 옛 받아쓰기를 새 음성의 증거로 표시하지 않는다',()=>{
  const source={review:{clearedFindings:['1:1000','2:3000']},voiceFindings:[
    {slideNumber:1,startMs:1000,endMs:2000,severity:'failed',recognizedText:'이전 잘못된 발화',attempts:4},
    {slideNumber:2,startMs:3000,endMs:4000,severity:'warning'}]};
  const out=editedReviewContext(source,1200,1500,800,'replace-region');
  assert.equal(out.voiceFindings[0].recognizedText,'');assert.equal(out.voiceFindings[0].attempts,undefined);
  assert.equal(out.voiceFindings[0].severity,'warning');assert.equal(out.voiceFindings[0].endMs,2000);
  assert.equal(out.voiceFindings[1].startMs,3500);
  assert.deepEqual(out.review.clearedFindings,['2:3500']);assert.equal(out.review.status,'pending');
  assert.equal(source.voiceFindings[0].recognizedText,'이전 잘못된 발화');
});

test('실제 미디어: 길이 증가·감소·정밀 미리듣기·무음·파형',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tts-region-test-'));
  const run=args=>execFileSync('ffmpeg',['-v','error',...args],{maxBuffer:8_000_000});
  const samples=file=>{const buffer=run(['-i',file,'-vn','-ar','48000','-ac','1','-f','f32le','pipe:1']);return new Float32Array(buffer.buffer,buffer.byteOffset,buffer.length/4);};
  const power=(audio,from,to,hz)=>{let x=0,y=0;for(let n=Math.round(from*48000);n<Math.round(to*48000);n++){x+=audio[n]*Math.cos(2*Math.PI*hz*n/48000);y+=audio[n]*Math.sin(2*Math.PI*hz*n/48000);}return Math.hypot(x,y);};
  try{
    const video=path.join(dir,'original.mkv'),long=path.join(dir,'long.wav'),short=path.join(dir,'short.wav');
    run(['-f','lavfi','-i','testsrc2=size=160x90:rate=25:duration=4','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=4','-c:v','libx264','-preset','ultrafast','-c:a','pcm_s16le',video]);
    for(const [file,duration] of [[long,1.1],[short,.3]])run(['-f','lavfi','-i',`sine=frequency=880:sample_rate=48000:duration=${duration}`,'-c:a','pcm_s24le',file]);
    for(const [file,duration] of [[long,1.1],[short,.3]]){
      const plan=regionReplacementPlan(1,1.6,4,duration,'match-audio'),output=path.join(dir,`edited-${duration}.mkv`);
      run(['-i',video,'-i',file,'-filter_complex',plan.filter,'-map',plan.videoOutput,'-map',plan.audioOutput,'-c:v','libx264','-preset','ultrafast','-c:a','pcm_s24le',output]);
      const pcm=samples(output);assert.ok(Math.abs(pcm.length/48000-(4+duration-.6))<.025);
      assert.ok(power(pcm,.2,.5,440)>20*power(pcm,.2,.5,880));
      assert.ok(power(pcm,1.05,1+duration-.05,880)>20*power(pcm,1.05,1+duration-.05,440));
      assert.ok(power(pcm,2+duration,2.2+duration,440)>20*power(pcm,2+duration,2.2+duration,880));
    }
    const exactDir=path.join(dir,'exact');await fs.mkdir(exactDir);
    const exact=await makeRegionPreview('ffmpeg',video,null,{start:1.125,end:1.175,duration:4,mode:'original',context:0},exactDir);
    assert.equal(samples(exact.file).length,2400,'50ms exactly, without video timeupdate overshoot');
    const previewDir=path.join(dir,'replacement');await fs.mkdir(previewDir);
    const preview=await makeRegionPreview('ffmpeg',video,long,{start:1,end:1.6,duration:4,audioDuration:1.1,mode:'replace',fit:'match-audio',context:.2},previewDir);
    assert.equal(samples(preview.file).length,72000);
    const muteDir=path.join(dir,'mute');await fs.mkdir(muteDir);
    const muted=await makeRegionPreview('ffmpeg',video,null,{start:1,end:1.2,duration:4,mode:'mute',context:.1},muteDir);
    assert.ok(Math.max(...samples(muted.file).slice(6000,12000).map(Math.abs))<1e-6);
    const envelope=await audioEnvelope('ffmpeg',video,.9,1.3);
    assert.ok(envelope.peaks.length>100);assert.ok(envelope.peaks.some(p=>p>.05));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
