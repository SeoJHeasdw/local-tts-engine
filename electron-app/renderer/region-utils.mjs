export function parseRegionTime(value) {
  const text=String(value??'').trim();
  if (!/^\d+(?:\.\d{1,3})?$/.test(text) && !/^\d+:\d{1,2}(?:\.\d{1,3})?$/.test(text)
      && !/^\d+:\d{1,2}:\d{1,2}(?:\.\d{1,3})?$/.test(text)) return NaN;
  const parts=text.split(':').map(Number);
  if(parts.length>1 && parts.slice(1).some(n=>n>=60)) return NaN;
  return Math.round(parts.reduce((sum,n)=>sum*60+n,0)*1000)/1000;
}

export function formatRegionTime(value) {
  const ms=Math.round(Math.max(0,Number(value)||0)*1000),seconds=Math.floor(ms/1000);
  const h=Math.floor(seconds/3600),m=Math.floor(seconds/60)%60;
  return `${h?`${h}:${String(m).padStart(2,'0')}`:m}:${String(seconds%60).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`;
}

export function regionIssue({start,end,duration,mode='replace',audioDuration=null,fit='match-audio'}) {
  if(![start,end].every(Number.isFinite))return '시간은 4:55.120 또는 295.120처럼 입력하세요.';
  if(!Number.isFinite(duration)||!(duration>0))return '영상 길이를 읽고 있습니다.';
  if(start<0 || end>duration+.001)return `영상 범위 0:00.000–${formatRegionTime(duration)} 안에서 선택하세요.`;
  if(end<=start)return '끝은 시작보다 뒤여야 합니다.';
  const span=Math.round((end-start)*1000),maximum=mode==='mute'?2:120;
  if(span<50)return '최소 0.050초를 선택하세요.';
  if(span>maximum*1000)return `${mode==='mute'?'짧은 소리 제거는':'구간 음성 교체는'} ${maximum}초까지 선택할 수 있습니다.`;
  if(mode==='replace' && audioDuration!=null){
    if(!(audioDuration>0))return '교체 음성의 길이를 읽고 있습니다.';
    if(audioDuration>120)return '교체 음성은 120초 이하 파일을 선택하세요.';
    if(fit==='keep-video' && audioDuration>end-start+.001)return '교체 음성이 더 깁니다. ‘새 음성 길이에 맞춤’을 선택하세요.';
  }
  return '';
}

export function regionImpact(start,end,audioDuration,fit) {
  if(![start,end,audioDuration].every(Number.isFinite)||end<=start||audioDuration<=0)return '';
  const span=end-start,delta=audioDuration-span;
  if(fit==='keep-video')return `원본 ${span.toFixed(3)}초 · 교체 ${audioDuration.toFixed(3)}초 · ${Math.abs(delta).toFixed(3)}초 ${delta>0?'초과':'무음 채움'}`;
  return `원본 ${span.toFixed(3)}초 → 교체 ${audioDuration.toFixed(3)}초 · 영상 ${Math.abs(delta).toFixed(3)}초 ${delta>=0?'늘어남':'줄어듦'}`;
}

export function regionWindow(center,span,duration) {
  const width=Math.min(Math.max(.5,span),Math.max(.5,duration),120);
  const start=Math.max(0,Math.min(center-width/2,Math.max(0,duration-width)));
  return {start,end:Math.min(duration,start+width)};
}

export function timeAtFraction(fraction,window) {
  return Math.round((window.start+Math.max(0,Math.min(1,fraction))*(window.end-window.start))*1000)/1000;
}
