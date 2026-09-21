import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildEditPlan } from '../../electron-app/shared/demo-plan.mjs';
import {
  demoCaptionCues, demoRenderArgs, renderAppDemo, renderChecks, timeWarpExpression, videoFilterChain, zoomFilter,
} from '../../electron-app/main/editing/demo-render.mjs';
import { buildReviewPage, collectReview } from '../../electron-app/main/editing/demo-review.mjs';
import { CAPTURE_COLOR_FILTERS, captureEncodingArgs } from '../../electron-app/main/capture/encoding.mjs';
import { videoQuality } from '../../electron-app/shared/video-quality.mjs';

const exec = promisify(execFile);
const profile = videoQuality('high');

const viewport = { width: 1920, height: 1080, scale: 2 };
const recorded = scenes => ({ schemaVersion: 1, scenario: 'demo', viewport, fps: 25,
  frame: { width: 3840, height: 2160 }, durationMs: scenes.at(-1).endMs, scenes });

const waitPlan = () => buildEditPlan(recorded([
  { id: 'ask', startMs: 0, endMs: 4000, steps: [{ verb: 'click', startMs: 1000, endMs: 1600, point: { x: 600, y: 500 } }] },
  { id: 'wait', startMs: 4000, endMs: 24000, steps: [{ verb: 'waitFor', startMs: 4000, endMs: 24000 }] },
]), { narration: { ask: { durationMs: 2000, file: '/tmp/ask.wav' }, wait: { durationMs: 9000, file: '/tmp/wait.wav' } } });

test('색 경로는 덱 촬영과 같은 문자열 하나를 나눠 쓴다', () => {
  const deck = captureEncodingArgs(profile);
  assert.equal(deck[0], '-vf');
  assert.equal(deck[1], CAPTURE_COLOR_FILTERS);
  assert.ok(videoFilterChain(waitPlan(), profile).endsWith(CAPTURE_COLOR_FILTERS));
});

test('시간축을 접는 식은 구간마다 기울기를 바꾸고 멈출 자리를 건너뛴다', () => {
  const plan = buildEditPlan(recorded([
    { id: 'a', startMs: 0, endMs: 2000, steps: [] },
  ]), { narration: { a: { durationMs: 5000, file: '/tmp/a.wav' } } });
  // 2초 원본 뒤 3.8초 멈춤. 구간이 하나뿐이라 식도 하나다.
  assert.equal(timeWarpExpression(plan), '0+(N-0)*50/50');
  assert.equal(plan.segments[0].holdMs, 3800);
  assert.match(videoFilterChain(plan, profile), /tpad=stop_mode=clone:stop=95/);

  const many = waitPlan();
  const warp = timeWarpExpression(many);
  assert.match(warp, /^if\(lt\(N,100\),0\+\(N-0\)\*100\/100,/, '1배 구간은 기울기가 1이다');
  // 20초 기다림이 내레이션 9.8초에 맞춰 줄어든다. 감은 뒤 프레임 수가 식에 들어간다.
  const fast = many.segments[1];
  assert.ok(warp.includes(`${fast.outFrames}/500`), warp);
  assert.ok(fast.speed > 1 && fast.speed <= many.maxSpeed);
});

test('확대 식은 키프레임을 코사인으로 잇고 화면 밖을 가둔다', () => {
  const filter = zoomFilter(waitPlan(), profile);
  assert.match(filter, /^zoompan=d=1:s=2560x1440:fps=25:/);
  assert.match(filter, /z='[^']*1\+0\.6000000000000001\*\(1-cos\(PI\*\(on-17\)\/15\)\)\/2/);
  // 중심은 CSS px이므로 배율을 곱해 프레임 픽셀로 옮긴다.
  assert.ok(filter.includes('*2-(iw/zoom)/2'), filter);
  // 식 안의 쉼표는 필터 구분자와 섞이지 않게 벗겨 둔다.
  assert.ok(filter.includes('max(0\\,min(iw-iw/zoom\\,'), filter);
  assert.ok(!/[^\\],/.test(filter.slice(filter.indexOf("z='"))), '벗기지 않은 쉼표가 남아 있다');
});

test('확대가 없으면 크기만 맞춘다', () => {
  const plan = buildEditPlan(recorded([{ id: 'a', startMs: 0, endMs: 2000, steps: [] }]));
  assert.equal(zoomFilter(plan, profile), 'scale=2560:1440:flags=lanczos');
});

test('렌더 인자는 무음 바닥 위에 장면 음성을 제자리에 놓는다', () => {
  const plan = waitPlan();
  const narration = plan.scenes.map(scene => ({ id: scene.id, ...scene.narration }));
  const args = demoRenderArgs({ plan, rawFile: 'raw.mkv', narration, profile, output: 'out.part' });
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /\[2:a\]aresample=48000,adelay=320:all=1\[n0\]/);
  assert.match(graph, new RegExp(`\\[3:a\\]aresample=48000,adelay=${plan.scenes[1].narration.atMs}:all=1\\[n1\\]`));
  assert.match(graph, /\[1:a\]\[n0\]\[n1\]amix=inputs=3:normalize=0:duration=first\[a\]/);
  const seconds = (plan.totalFrames / 25).toFixed(3);
  assert.equal(args[args.indexOf('-t') + 1], seconds, '길이는 프레임 수에서 나온다 — 음성 길이로 자르지 않는다');
  assert.deepEqual(args.slice(-5), ['-f', 'mp4', '-movflags', '+faststart', 'out.part']);
  assert.deepEqual(args.slice(args.indexOf('-c:a'), args.indexOf('-c:a') + 8),
    ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '1'], '덱·화면 녹화와 같은 음성 서명');
});

test('내레이션이 하나도 없어도 음성 트랙을 만든다', () => {
  const plan = buildEditPlan(recorded([{ id: 'a', startMs: 0, endMs: 2000, steps: [] }]));
  const graph = demoRenderArgs({ plan, rawFile: 'raw.mkv', profile, output: 'out.part' })[
    demoRenderArgs({ plan, rawFile: 'raw.mkv', profile, output: 'out.part' }).indexOf('-filter_complex') + 1];
  assert.match(graph, /\[1:a\]amix=inputs=1:normalize=0:duration=first\[a\]/);
});

test('검증은 규격·프레임 수·음성 길이를 따로 본다', () => {
  const plan = waitPlan();
  const video = { codec_type: 'video', width: 2560, height: 1440, codec_name: 'h264', pix_fmt: 'yuv420p',
    avg_frame_rate: '25/1', nb_frames: String(plan.totalFrames), color_space: 'bt709', color_range: 'tv',
    color_primaries: 'bt709', color_transfer: 'bt709' };
  const seconds = plan.totalFrames / 25;
  const audio = { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 1, duration: String(seconds) };
  const narration = plan.scenes.map(scene => ({ id: scene.id, ...scene.narration }));
  const probe = { streams: [video, audio], format: { duration: String(seconds) } };
  assert.ok(renderChecks(probe, profile, plan, narration).every(check => check.ok),
    JSON.stringify(renderChecks(probe, profile, plan, narration)));

  const short = renderChecks({ ...probe, streams: [{ ...video, nb_frames: String(plan.totalFrames - 2) }, audio] },
    profile, plan, narration);
  assert.equal(short.find(check => check.label === '프레임 수 = 계획 길이').ok, false);
  const overflow = renderChecks(probe, profile, plan, [{ file: 'x.wav', atMs: plan.durationMs - 100, durationMs: 4000 }]);
  assert.equal(overflow.find(check => check.label === '내레이션이 영상 안에 들어간다').ok, false);
});

test('자막은 장면 음성 길이 안에 글자 수 비례로 놓는다', () => {
  const plan = waitPlan();
  const cues = demoCaptionCues(plan, { scenes: [
    { id: 'ask', text: '먼저 하고 싶은 일을 그대로 적습니다. 특별한 명령어는 없습니다.' },
    { id: 'wait', text: '' },
  ] });
  assert.ok(cues.length >= 2, JSON.stringify(cues));
  assert.equal(cues[0].startMs, plan.scenes[0].narration.atMs);
  assert.ok(cues.at(-1).endMs <= plan.scenes[0].narration.atMs + plan.scenes[0].narration.durationMs);
  assert.ok(cues.every(cue => cue.text.split('\n').length <= 2));
});

// 합성 화면·합성 내레이션으로 렌더 전체를 실제 ffmpeg로 돈다. 앱도 목소리 모델도
// 없이 "프레임 수 = 계획 길이"와 음성 자리를 확인할 수 있다.
async function fixtureRecording(t, { scenes, narration }) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'demo-render-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const outDir = path.join(base, '2026-09-20', 'demo-fixture');
  const demoDir = path.join(outDir, 'demo');
  await fs.mkdir(demoDir, { recursive: true });
  const seconds = (scenes.at(-1).endMs / 1000).toFixed(3);
  // 촬영 원본과 같은 모양: RGB 무손실, 25fps.
  await exec('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=25:duration=${seconds}`,
    '-vf', 'format=rgb24', '-c:v', 'libx264rgb', '-qp', '0', '-preset', 'ultrafast',
    '-f', 'matroska', path.join(demoDir, 'raw.mkv')]);
  await fs.writeFile(path.join(demoDir, 'scenes.json'), JSON.stringify({
    schemaVersion: 1, scenario: 'demo-fixture', viewport: { width: 640, height: 360, scale: 1 },
    frame: { width: 640, height: 360 }, fps: 25, durationMs: scenes.at(-1).endMs, scenes,
  }, null, 2));

  const script = { schemaVersion: 1, scenario: 'demo-fixture', scenes: [] };
  for (const scene of scenes) {
    const voice = narration[scene.id];
    if (!voice) {
      script.scenes.push({ id: scene.id, text: '', status: 'draft', voice: { candidates: [], selected: null } });
      continue;
    }
    const sceneDir = path.join(demoDir, 'narration', scene.id);
    await fs.mkdir(sceneDir, { recursive: true });
    const wav = path.join(sceneDir, 'candidate-01.wav');
    await exec('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${(voice.durationMs / 1000).toFixed(3)}`,
      '-ar', '48000', '-ac', '1', wav]);
    script.scenes.push({ id: scene.id, text: voice.text, status: 'approved',
      voice: { candidates: [path.relative(demoDir, wav)], selected: path.relative(demoDir, wav) } });
  }
  await fs.writeFile(path.join(demoDir, 'script.json'), JSON.stringify(script, null, 2));
  return { outDir, demoDir };
}

test('합성 촬영을 렌더해 계획 길이와 음성 자리를 확인한다', { timeout: 180_000 }, async t => {
  const { outDir, demoDir } = await fixtureRecording(t, {
    scenes: [
      { id: 'ask', startMs: 0, endMs: 4000, steps: [{ verb: 'click', startMs: 1200, endMs: 1800, point: { x: 320, y: 180 } }] },
      { id: 'wait', startMs: 4000, endMs: 20000, steps: [{ verb: 'waitGone', startMs: 4000, endMs: 20000 }] },
      { id: 'result', startMs: 20000, endMs: 22000, steps: [{ verb: 'pause', startMs: 20000, endMs: 22000 }] },
    ],
    narration: {
      ask: { durationMs: 2500, text: '먼저 하고 싶은 일을 그대로 적습니다.' },
      wait: { durationMs: 6000, text: '계획을 세우고 승인을 기다립니다. 화면은 그대로입니다.' },
      result: { durationMs: 8000, text: '결과가 실제 폴더에 남습니다. 여기까지가 한 번의 흐름입니다.' },
    },
  });

  const report = await renderAppDemo({ outDir, name: 'demo-fixture', quality: 'standard' });
  assert.equal(report.operation, 'app-demo');
  assert.equal(report.summary.ok, true, JSON.stringify(report.checks));
  assert.deepEqual(report.target, { root: 'edit', day: '2026-09-20', name: 'demo-fixture' });
  assert.deepEqual(report.warnings, []);

  const plan = JSON.parse(await fs.readFile(path.join(demoDir, 'edit-plan.json'), 'utf8'));
  // 16초 기다림은 내레이션 6초에 맞춰 줄고, 2초 원본은 8초 내레이션 뒤로 멈춰 늘어난다.
  assert.ok(plan.segments.some(segment => segment.speed > 1), JSON.stringify(plan.segments));
  assert.ok(plan.segments.some(segment => segment.holdMs > 0));
  assert.equal(report.plannedMs, plan.durationMs);

  const probe = JSON.parse((await exec('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format',
    '-of', 'json', report.videoPath])).stdout);
  const [video, audio] = ['video', 'audio'].map(type => probe.streams.find(stream => stream.codec_type === type));
  assert.equal(Number(video.nb_read_frames), plan.totalFrames, '프레임 수 = 계획 길이');
  assert.equal(video.width, 1920);
  assert.equal(video.height, 1080);
  assert.equal(video.pix_fmt, 'yuv420p');
  assert.equal(video.color_space, 'bt709');
  assert.equal(audio.codec_name, 'aac');
  assert.equal(Number(audio.sample_rate), 48000);
  assert.equal(Number(audio.channels), 1);

  // 내레이션이 실제로 계획한 자리에 있는가. 무음 구간과 사인파 구간을 음량으로 가른다.
  const { stdout } = await exec('ffmpeg', ['-v', 'error', '-i', report.videoPath, '-af',
    'astats=metadata=1:reset=10,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-', '-f', 'null', '-']);
  const levels = [...stdout.matchAll(/pts_time:([0-9.]+)[\s\S]*?RMS_level=(-?[0-9.]+|-inf)/g)]
    .map(match => ({ atMs: Number(match[1]) * 1000, rms: Number(match[2]) }));
  const loudAt = ms => levels.filter(level => Math.abs(level.atMs - ms) < 300).some(level => level.rms > -60);
  for (const scene of plan.scenes) {
    assert.ok(loudAt(scene.narration.atMs + 500), `${scene.id} 내레이션이 ${scene.narration.atMs}ms에 없다`);
  }
  const lastEnd = Math.max(...plan.scenes.map(scene => scene.narration.atMs + scene.narration.durationMs));
  assert.ok(levels.filter(level => level.atMs > lastEnd + 300).every(level => !(level.rms > -60)),
    `마지막 내레이션(${Math.round(lastEnd)}ms) 뒤는 조용해야 한다`);

  const captions = await fs.readFile(path.join(demoDir, 'captions.srt'), 'utf8');
  assert.match(captions, /00:00:00,320 --> /, '첫 자막은 첫 내레이션 자리에서 시작한다');
  assert.ok((await fs.readdir(outDir)).every(entry => !entry.endsWith('.part')), '임시 파일이 남지 않는다');

  // 검수 화면은 렌더가 끝나면 늘 함께 남는다.
  const page = await fs.readFile(report.reviewPath, 'utf8');
  assert.equal(report.reviewPath, path.join(outDir, 'review.html'));
  assert.match(page, /<video id="player" controls[^>]*src="demo-fixture\.mp4"/);
  for (const scene of plan.scenes) assert.ok(page.includes(`data-scene="${scene.id}"`), scene.id);
  assert.ok(page.includes(`window.__review = {`), '화면이 읽을 자료를 함께 넣는다');
});

test('검수 화면은 영상·구간·대본을 한 쪽에 모으고 없는 것은 비워 둔다', async t => {
  const { outDir, demoDir } = await fixtureRecording(t, {
    scenes: [
      { id: 'ask', startMs: 0, endMs: 4000, steps: [{ verb: 'click', startMs: 1000, endMs: 1600, point: { x: 320, y: 180 } }] },
      { id: 'wait', startMs: 4000, endMs: 20000, steps: [{ verb: 'waitFor', startMs: 4000, endMs: 20000 }] },
    ],
    narration: { ask: { durationMs: 2000, text: '<script>가 들어와도 문서가 끊기지 않는다' } },
  });
  // 렌더 전에도 열려야 한다. 그때 판단할 것이 화면·배율·확대이기 때문이다.
  const early = collectReview(outDir);
  assert.equal(early.plan, null);
  assert.deepEqual(early.videos, []);
  assert.ok(buildReviewPage(early).startsWith('<!doctype html>'));

  const report = await renderAppDemo({ outDir, name: 'demo-fixture', quality: 'standard' });
  const data = collectReview(outDir);
  assert.equal(data.videos.length, 1);
  assert.equal(data.videos[0].width, 1920);
  assert.equal(data.sourceMs, 20000);
  assert.equal(data.plan.durationMs, report.plannedMs);
  assert.deepEqual(data.scenes.map(scene => [scene.id, scene.status]), [['ask', 'approved'], ['wait', 'draft']]);

  const page = buildReviewPage(data);
  // file://에서 <track>은 CORS로 막힌다. cue를 문서에 넣고 직접 그린다.
  assert.ok(!page.includes('<track'), '자막을 바깥 파일로 불러오지 않는다');
  assert.ok(data.captions.length > 0);
  assert.ok(page.includes('id="caption"'));
  assert.ok(page.includes(`"startMs":${data.captions[0].startMs}`), '자막 시각이 문서 안에 있다');
  assert.ok(page.includes('가 들어와도'), '자막 글이 문서 안에 있다');
  assert.ok(!page.includes('<script>가 들어와도'), '대본의 꺾쇠는 문서를 끊지 않는다');
  assert.ok(page.includes('&lt;script&gt;가 들어와도'));
  assert.ok(!page.includes('"<script>가'), '함께 넣는 자료에서도 태그를 닫지 못하게 한다');
  assert.match(page, /장면 wait에 내레이션이 없습니다/, '경고를 숨기지 않는다');
  assert.equal(page.match(/<video/g).length, 1);
});

test('고른 음성 파일이 없으면 어느 장면인지 말하고 멈춘다', { timeout: 120_000 }, async t => {
  const { demoDir, outDir } = await fixtureRecording(t, {
    scenes: [{ id: 'ask', startMs: 0, endMs: 2000, steps: [] }],
    narration: { ask: { durationMs: 1500, text: '한 문장' } },
  });
  const scriptFile = path.join(demoDir, 'script.json');
  const script = JSON.parse(await fs.readFile(scriptFile, 'utf8'));
  script.scenes[0].voice.selected = 'narration/ask/candidate-09.wav';
  await fs.writeFile(scriptFile, JSON.stringify(script, null, 2));
  await assert.rejects(renderAppDemo({ outDir, name: 'demo-fixture', quality: 'standard' }),
    /장면 ask의 고른 음성을 찾지 못했습니다/);
});

test('화질마다 다른 파일로 내보내 1440p와 4K를 나란히 둔다', { timeout: 300_000 }, async t => {
  const { outDir } = await fixtureRecording(t, {
    scenes: [{ id: 'ask', startMs: 0, endMs: 3000, steps: [] }],
    narration: { ask: { durationMs: 1200, text: '한 문장' } },
  });
  const high = await renderAppDemo({ outDir, name: 'demo-fixture', quality: 'high' });
  const ultra = await renderAppDemo({ outDir, name: 'demo-fixture', quality: 'ultra' });
  assert.equal(path.basename(high.videoPath), 'demo-fixture-high.mp4');
  assert.equal(path.basename(ultra.videoPath), 'demo-fixture-ultra.mp4');
  // 뒤에 낸 화질이 앞의 것을 지우지 않는다. 검수 화면은 둘을 함께 받는다.
  const files = (await fs.readdir(outDir)).filter(name => name.endsWith('.mp4')).sort();
  assert.deepEqual(files, ['demo-fixture-high.mp4', 'demo-fixture-ultra.mp4']);
  assert.equal(collectReview(outDir).videos.length, 2);
});
