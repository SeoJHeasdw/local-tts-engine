import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { regionIssue } from "../../shared/regions.mjs";
import { replaceRegionPlan, muteRegionFilter, remapPatchedTimestamp } from "../../shared/index.mjs";
const execute=promisify(execFile);

export function regionReplacementPlan(start,end,videoDuration,audioDuration,fit='keep-video', fps='25') {
  const [fpsNumerator, fpsDenominator = 1] = String(fps).split('/').map(Number);
  if (!/^\d+(?:\/\d+|\.\d+)?$/.test(String(fps)) || !(fpsNumerator > 0) || !(fpsDenominator > 0)) throw new Error('프레임률이 올바르지 않습니다.');
  const issue=regionIssue({start,end,duration:videoDuration,audioDuration,fit});if(issue)throw new Error(issue);
  if(fit==='keep-video')return {filter:replaceRegionPlan(start,end,videoDuration,audioDuration,120),
    videoOutput:'0:v:0',audioOutput:'[outa]',videoUnchanged:true,deltaMs:0,replacementDuration:end-start};
  const delta=audioDuration-(end-start),factor=audioDuration/(end-start),parts=[],labels=[];
  const add=(label,filter)=>{parts.push(`${filter}[${label}]`);labels.push(`[${label}]`);};
  const fmt='aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono';
  if(start>0)add('before',`[0:a]atrim=end=${start},asetpts=PTS-STARTPTS,${fmt}`);
  add('replacement',`[1:a]atrim=duration=${audioDuration},asetpts=PTS-STARTPTS,${fmt},afade=t=in:d=0.005,afade=t=out:st=${Math.max(0,audioDuration-.005)}:d=0.005`);
  if(end<videoDuration)add('after',`[0:a]atrim=start=${end},asetpts=PTS-STARTPTS,${fmt}`);
  parts.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1[outa]`);
  const map=`if(lt(PTS*TB,${start}),PTS,if(lt(PTS*TB,${end}),(${start}+(PTS*TB-${start})*${factor})/TB,PTS+${delta}/TB))`;
  parts.push(`[0:v]setpts='${map}',fps=${fps}[outv]`);
  return {filter:parts.join(';'),videoOutput:'[outv]',audioOutput:'[outa]',videoUnchanged:false,
    deltaMs:Math.round(delta*1000),replacementDuration:audioDuration};
}

export function retimeCaptions(captions,startMs,endMs,replacementMs) {
  const factor=replacementMs/(endMs-startMs),delta=replacementMs-(endMs-startMs);
  return captions.map(c=>({...c,startMs:remapPatchedTimestamp(c.startMs,startMs,endMs,factor,delta),
    endMs:remapPatchedTimestamp(c.endMs,startMs,endMs,factor,delta)}));
}

export function editedReviewContext(original,startMs,endMs,replacementMs,operation) {
  const delta=replacementMs-(endMs-startMs),factor=replacementMs/(endMs-startMs);
  const cleared=new Set(original?.review?.clearedFindings || []),clearedFindings=[];
  const voiceFindings=(original?.voiceFindings || []).map(f=>{
    const key=`${f.slideNumber}:${f.startMs}`;
    if(f.startMs<endMs && f.endMs>startMs)return {
      chapter:f.chapter,slideId:f.slideId,slideNumber:f.slideNumber,startMs,endMs:startMs+replacementMs,
      severity:'warning',reasons:[operation==='mute-region'?'무음 처리 후 청취 확인':'교체 후 청취 확인'],
      terms:[],expectedText:'',recognizedText:'',previousFindingKey:key,
    };
    const moved={...f,startMs:remapPatchedTimestamp(f.startMs,startMs,endMs,factor,delta),
      endMs:remapPatchedTimestamp(f.endMs,startMs,endMs,factor,delta)};
    if(cleared.has(key))clearedFindings.push(`${moved.slideNumber}:${moved.startMs}`);
    return moved;
  });
  return {voiceFindings,review:{status:'pending',clearedFindings}};
}

export function captionText(captions,vtt=false) {
  const time=ms=>{const n=Math.max(0,Math.round(ms));return `${String(Math.floor(n/3600000)).padStart(2,'0')}:${String(Math.floor(n/60000)%60).padStart(2,'0')}:${String(Math.floor(n/1000)%60).padStart(2,'0')}${vtt?'.':','}${String(n%1000).padStart(3,'0')}`;};
  return (vtt?'WEBVTT\n\n':'')+captions.map((c,i)=>`${vtt?'':`${i+1}\n`}${time(c.startMs)} --> ${time(c.endMs)}\n${c.text}`).join('\n\n')+'\n';
}

export async function audioEnvelope(ffmpeg,file,start,end) {
  if(![start,end].every(Number.isFinite)||start<0||end<=start||end-start>120.001)throw new Error('파형 범위가 올바르지 않습니다.');
  const {stdout}=await execute(ffmpeg,['-v','error','-ss',String(start),'-i',file,'-t',String(end-start),'-vn','-ac','1','-ar','4000','-f','f32le','pipe:1'],{encoding:'buffer',maxBuffer:3_000_000,timeout:20000});
  const samples=new DataView(stdout.buffer,stdout.byteOffset,stdout.byteLength);
  const count=Math.floor(stdout.length/4),bins=Math.min(1800,count),peaks=[];
  for(let i=0;i<bins;i++){let peak=0;for(let n=Math.floor(i*count/bins);n<Math.floor((i+1)*count/bins);n++)peak=Math.max(peak,Math.abs(samples.getFloat32(n*4,true)));peaks.push(peak);}
  return {start,end,peaks};
}

export async function makeRegionPreview(ffmpeg,video,audio,{start,end,duration,audioDuration,mode,fit,context=.6},directory) {
  const issue=regionIssue({start,end,duration,mode:mode==='mute'?'mute':'replace',audioDuration:mode==='replace'?audioDuration:null,fit});if(issue)throw new Error(issue);
  const from=Math.max(0,start-context),to=Math.min(duration,end+context),output=path.join(directory,'preview.wav');
  const args=['-v','error','-n','-i',video];let filter;
  if(mode==='replace'){
    args.push('-i',audio);
    const plan=regionReplacementPlan(start,end,duration,audioDuration,fit);
    filter=plan.filter.split(';').filter(part=>!part.startsWith('[0:v]')).join(';');
    filter+=`;[outa]atrim=start=${from}:end=${to+plan.deltaMs/1000},asetpts=PTS-STARTPTS[preview]`;
  }else{
    const mute=mode==='mute'?`${muteRegionFilter(start,end,duration)},`:'';
    filter=`[0:a]${mute}atrim=start=${from}:end=${to},asetpts=PTS-STARTPTS[preview]`;
  }
  args.push('-filter_complex',filter,'-map','[preview]','-ar','48000','-ac','1','-c:a','pcm_s24le',output);
  await execute(ffmpeg,args,{timeout:30000,maxBuffer:1_000_000});
  return {file:output,start:from};
}

export async function newPreviewDirectory(){return fs.mkdtemp(path.join(os.tmpdir(),'tts-review-'));}
