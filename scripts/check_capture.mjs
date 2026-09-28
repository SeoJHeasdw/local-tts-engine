#!/usr/bin/env node
// A short real-browser integration check. No TTS, model download or existing output edits.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { captureVideo } from '../electron-app/main/capture/record.mjs';
import { VIDEO_QUALITIES } from '../electron-app/shared/video-quality.mjs';
const exec = promisify(execFile);
const outputIndex = process.argv.indexOf('--output');
if (outputIndex < 0 || !process.argv[outputIndex + 1]) throw new Error('새 결과 폴더를 --output으로 지정하세요.');
const root = path.resolve(process.argv[outputIndex + 1]);
await fs.mkdir(root); // refuse an existing directory
const site = path.join(root, 'site');
await fs.mkdir(site);
const states = [0, 1].map(step => ({ slideId: 'quality-check', slideNumber: 1, chapter: 'ch00', step, sourceText: `촬영 검증 ${step}` }));
await fs.writeFile(path.join(site, 'production-input.json'), JSON.stringify({ states }));
await fs.writeFile(path.join(site, 'index.html'), `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#111827;overflow:hidden} .stage{width:1920px;height:1080px;position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(var(--s));transform-origin:center;background:linear-gradient(125deg,#131a36,#25355c);color:white;font:32px sans-serif}
h1{font-size:64px;margin:150px 150px 50px} p{margin:30px 150px} .move,.raf{position:absolute;left:150px;width:110px;height:110px;background:#b59afa}.move{top:650px;animation:slide 2s linear infinite}.raf{top:780px;background:#7ee0b8}@keyframes slide{to{transform:translateX(900px)}}
#state{position:absolute;right:200px;top:400px;width:240px;height:240px;background:#000}
</style><div class="stage"><section data-capture-slide="quality-check"><h1>한국어 · 선명도 · Capture Quality</h1><p>Observation / permission denied / 가는 글자와 도형</p><p style="font-size:20px">20px 본문 · Aa Bb 0123456789 · 가장자리와 자막 비율 확인</p><div class="move"></div><div class="raf"></div><div id="state"></div></section></div><script>
function fit(){document.documentElement.style.setProperty('--s',Math.min(innerWidth/1920,innerHeight/1080))}fit();addEventListener('resize',fit);
const raf=document.querySelector('.raf');requestAnimationFrame(function move(ts){raf.style.transform='translateX('+(ts%2000)/2000*900+'px)';requestAnimationFrame(move)});
let step=0,runKey=0;const channel=new BroadcastChannel('udemy-deck-sync');function nav(){channel.postMessage({type:'nav',deck:'course',nav:{index:0,step,runKey}})}channel.onmessage=()=>nav();
addEventListener('keydown',event=>{if(event.key==='Enter'||event.key==='r'){step=0;runKey++}if(event.key==='ArrowRight')step=1;document.querySelector('#state').style.background=step?'#fff':'#000';nav()});
</script>`);
const results = [];
for (const profile of Object.values(VIDEO_QUALITIES)) {
  const outDir = path.join(root, profile.id);
  await fs.mkdir(path.join(outDir, 'audio'), { recursive: true });
  await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', path.join(outDir, 'audio/track.wav')]);
  const timeline = { totalMs: 3000, provider: { provider: 'test' }, preset: { name: 'quality-check' },
    entries: states.map((state, i) => ({ ...state, key: `state-${i}`, startMs: i * 1500, endMs: (i + 1) * 1500, transitionAtMs: (i + 1) * 1500 })) };
  const started = Date.now();
  const file = await captureVideo({ timeline, outDir, siteDir: site, quality: profile.id, noCache: true, burnCaptions: true,
    captions: [{ text: '한글 자막의 크기와 위치를 확인합니다.\n두 줄 자막도 같은 비율로 유지합니다.', startMs: 0, endMs: 3000 }] });
  const report = JSON.parse(await fs.readFile(path.join(outDir, 'capture-report.json')));
  assert.equal(report.frames.written, 75);
  assert.equal(report.frames.stepped, true);
  assert.equal(report.frames.clock.pageTimeMaxErrorMs, 0, '칸 k는 정확히 페이지 시각 k/fps여야 한다');
  assert.equal(report.frames.unchanged, 0, '움직이는 화면에서 앞 칸과 같은 그림이 나오면 안 된다');
  // Inspect the square in the decoded video: black -> white at 1.5s ± 2 frames.
  const s = profile.width / 1920;
  const { stdout } = await exec('ffmpeg', ['-v', 'error', '-i', file, '-vf',
    `crop=${Math.round(100*s)}:${Math.round(100*s)}:${Math.round(1500*s)}:${Math.round(440*s)},scale=1:1`,
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { encoding: 'buffer' });
  let transition = -1;
  for (let i = 0; i < stdout.length / 3; i++) if (stdout[i * 3] > 220) { transition = i; break; }
  // 페이지 시계를 멈추고 칸마다 넘기므로 1500ms에 누른 키는 정확히 38번째 칸(1520ms)부터 보인다.
  assert.equal(transition, 38, `전환이 어긋났습니다: ${transition}프레임`);
  // 2초에 900px(CSS 애니메이션·rAF 시각)로 움직이는 두 상자: 칸마다 같은 거리를 가야 한다.
  // 실시간 스크린캐스트에서는 칸이 담는 페이지 시각이 16~70ms로 흔들려 이 거리가 들쭉날쭉했다.
  const expectedStep = 900 / 2000 * (1000 / profile.fps) * s;
  const motion = {};
  for (const [name, top] of [['css', 650], ['raf', 780]]) {
    // yuv420p는 두 줄 단위로만 자른다. 두 줄 중 첫 줄을 쓴다.
    const y = 2 * Math.round((top + 55) * s / 2);
    const row = (await exec('ffmpeg', ['-v', 'error', '-i', file, '-vf', `crop=${profile.width}:2:0:${y}`,
      '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 })).stdout;
    const color = name === 'css' ? [0xb5, 0x9a, 0xfa] : [0x7e, 0xe0, 0xb8];
    const left = [];
    for (let frame = 0; frame < row.length / 6 / profile.width; frame++) {
      let x = -1;
      for (let i = 0; i < profile.width && x < 0; i++) {
        const at = (frame * 2 * profile.width + i) * 3;
        if (color.every((value, c) => Math.abs(row[at + c] - value) < 24)) x = i;
      }
      left.push(x);
    }
    const steps = left.slice(1).map((x, i) => x - left[i]);
    // 한 바퀴(2초)가 끝나 처음으로 돌아가는 칸만 뒤로 간다.
    const irregular = steps.filter(step => step > 0 && Math.abs(step - expectedStep) > 1.5);
    const wraps = steps.filter(step => step <= 0).length;
    assert.ok(!irregular.length && wraps <= 2, `${name} 칸 이동이 고르지 않습니다(기대 ${expectedStep.toFixed(1)}px): ${steps.join(' ')}`);
    motion[name] = { expectedStepPx: +expectedStep.toFixed(2), minStepPx: Math.min(...steps.filter(step => step > 0)),
      maxStepPx: Math.max(...steps.filter(step => step > 0)), wraps };
  }
  results.push({ profile: profile.id, file, elapsedMs: Date.now() - started, transitionFrame: transition, motion, ...report });
}
await fs.writeFile(path.join(root, 'results.json'), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results.map(({ profile, video, frames, elapsedMs, transitionFrame, motion }) => ({ profile, width: video.width, height: video.height,
  frames: { written: frames.written, unchanged: frames.unchanged, pageTimeMaxErrorMs: frames.clock.pageTimeMaxErrorMs, captureRealMs: frames.clock.captureRealMs },
  elapsedMs, transitionFrame, motion })), null, 2));
