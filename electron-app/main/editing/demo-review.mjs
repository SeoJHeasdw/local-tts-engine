// 앱 데모 결과를 사람이 보고 판단하는 화면. 완성본·편집 계획·대본·검증을 한 쪽에
// 모아 결과 폴더에 `review.html`로 남긴다.
//
// 영상만 따로 열면 "어디가 4배로 감긴 구간인지", "이 확대가 계획의 몇 번째인지"를
// 알 수 없어 피드백이 "빠른 것 같다"에서 멈춘다. 그래서 완성 시각 위에 구간·배율·
// 확대·내레이션을 같이 그리고, 누르면 그 자리로 재생을 옮긴다.
import fs from "node:fs";
import path from "node:path";

const escapeHtml = value => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

// </script>가 데이터 안에 있으면 문서가 거기서 끊긴다.
const embedJson = value => JSON.stringify(value).replaceAll("<", "\\u003c");

const seconds = ms => `${(ms / 1000).toFixed(1)}초`;

/**
 * 결과 폴더에서 화면에 필요한 것만 모은다.
 *
 * 없는 파일은 비워 둔다. 대본을 쓰기 전이나 목소리를 고르기 전에도 화면은 열려야
 * 한다 — 그때 판단할 것이 화면·배율·확대이기 때문이다.
 */
export function collectReview(outDir) {
  const demoDir = path.join(outDir, "demo");
  const read = file => {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  };
  const scenes = read(path.join(demoDir, "scenes.json"));
  const plan = read(path.join(demoDir, "edit-plan.json"));
  const script = read(path.join(demoDir, "script.json"));
  const report = read(path.join(outDir, "validation-report.json"));

  const videos = fs.readdirSync(outDir)
    .filter(name => name.endsWith(".mp4"))
    .sort()
    .map(name => {
      const capture = read(path.join(outDir, `${name}.capture.json`));
      const stat = fs.statSync(path.join(outDir, name));
      return {
        name,
        label: capture?.profile ? `${capture.profile.width}×${capture.profile.height}` : name,
        width: capture?.profile?.width ?? null,
        height: capture?.profile?.height ?? null,
        bytes: stat.size,
        durationMs: capture?.durationMs ?? null,
      };
    })
    .sort((a, b) => (a.width ?? 0) - (b.width ?? 0));

  const texts = new Map((script?.scenes || []).map(scene => [scene.id, scene]));
  const recorded = new Map((scenes?.scenes || []).map(scene => [scene.id, scene]));
  // 후보는 사람이 듣고 고른다. 길이는 후보 기록이 아니라 그 옆의 실제 측정값이다.
  const candidatesOf = scene => (texts.get(scene.id)?.voice?.candidates || []).map(relative => {
    const meta = read(path.join(demoDir, relative.replace(/\.wav$/, ".json")));
    return {
      file: path.join("demo", relative),
      name: path.basename(relative, ".wav"),
      durationMs: meta?.durationMs ?? null,
      seed: meta?.seed ?? null,
      // 영어를 따로 읽은 후보인지 화면에서 보인다. 기록이 아예 없는 예전
      // 후보(undefined)와 영어 구간이 없던 후보(null)는 다른 이야기다.
      voiceRouting: meta ? meta.voiceRouting ?? null : null,
      selected: texts.get(scene.id)?.voice?.selected === relative,
    };
  });
  return {
    name: path.basename(outDir),
    scenario: plan?.scenario || scenes?.scenario || path.basename(outDir),
    generatedAt: report?.generatedAt || new Date().toISOString(),
    sourceMs: scenes?.durationMs ?? null,
    frame: scenes?.frame ?? null,
    capturedFrames: scenes?.frames ?? null,
    plan: plan && {
      durationMs: plan.durationMs, totalFrames: plan.totalFrames, maxSpeed: plan.maxSpeed,
      fps: plan.fps, viewport: plan.viewport, zoom: plan.zoom,
      segments: plan.segments, scenes: plan.scenes,
    },
    videos,
    scenes: (plan?.scenes || []).map(scene => ({
      ...scene,
      text: texts.get(scene.id)?.text || "",
      status: texts.get(scene.id)?.status || "draft",
      selected: texts.get(scene.id)?.voice?.selected || null,
      candidates: candidatesOf(scene),
      screenText: recorded.get(scene.id)?.screenText || "",
      steps: (recorded.get(scene.id)?.steps || []).map(step => ({
        verb: step.verb, startMs: step.startMs, endMs: step.endMs, point: step.point ?? null,
      })),
    })),
    captions: read(path.join(demoDir, "captions.json"))?.cues || [],
    checks: report?.checks || [],
    warnings: report?.warnings || [],
    ok: report?.summary?.ok ?? null,
  };
}

const STYLE = `
:root {
  color-scheme: dark;
  --well:#0b0d09; --bg:#101310; --surface:#171a15; --raised:#1e221a; --float:#262b21;
  --text:#f1f4ec; --text-2:#b7beb0; --text-3:#8d9587; --text-4:#6b7266;
  --line:rgba(238,242,231,.10); --line-2:rgba(238,242,231,.18);
  --lime:#c9ff5b; --ink:#11150d; --aqua:#8debd2; --warn:#ffc05b; --danger:#ff837d;
  --lime-soft:rgba(201,255,91,.10); --lime-edge:rgba(201,255,91,.22);
  --warn-soft:rgba(255,192,91,.11); --warn-edge:rgba(255,192,91,.24);
  --dngr-soft:rgba(255,131,125,.11); --dngr-edge:rgba(255,131,125,.26);
  --sans:Pretendard,-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
}
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font-family:var(--sans);
       font-size:14px; line-height:1.65; -webkit-font-smoothing:antialiased; }
main { max-width:1180px; margin:0 auto; padding:32px 24px 64px; }
h1 { font-size:21px; font-weight:600; letter-spacing:-.01em; margin:0; }
h2 { font-size:16px; font-weight:600; margin:0 0 12px; }
a { color:var(--lime); }
.head { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; margin-bottom:8px; }
.meta { color:var(--text-3); font-size:13px; display:flex; gap:16px; flex-wrap:wrap; margin-bottom:24px; }
.meta b { color:var(--text-2); font-weight:500; }
.badge { font-size:11px; font-family:var(--mono); padding:3px 9px; border-radius:999px;
         border:1px solid var(--line-2); color:var(--text-2); }
.badge.ok { background:var(--lime-soft); border-color:var(--lime-edge); color:var(--lime); }
.badge.bad { background:var(--dngr-soft); border-color:var(--dngr-edge); color:var(--danger); }
.card { background:var(--surface); border:1px solid var(--line); border-radius:14px; padding:20px; margin-bottom:20px; }
video { width:100%; display:block; border-radius:10px; background:#000; }
.picker { display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap; align-items:center; }
button { font:inherit; color:inherit; cursor:pointer; }
.chip { background:var(--raised); border:1px solid var(--line); border-radius:999px;
        padding:6px 14px; font-size:13px; transition:background 160ms, border-color 160ms; }
.chip:hover { background:var(--float); }
.chip[aria-pressed="true"] { background:var(--lime); border-color:var(--lime); color:var(--ink); font-weight:600; }
.hint { color:var(--text-4); font-size:12px; margin-left:auto; font-family:var(--mono); }
.note { color:var(--text-4); font-size:12px; margin:10px 0 0; }
.note code { font-family:var(--mono); color:var(--text-3); }
/* 덱 자막과 같은 모양: 굽지 않은 화면 위에 겹쳐 어떻게 보일지 가늠한다. */
.stage { position:relative; line-height:0; }
.caption { position:absolute; left:50%; bottom:14%; transform:translateX(-50%);
           max-width:78%; text-align:center; white-space:pre-line; pointer-events:none;
           font-size:clamp(14px,2.1vw,26px); font-weight:700; line-height:1.42;
           letter-spacing:-.025em; color:#fff; opacity:0; transition:opacity 100ms linear;
           -webkit-text-stroke:.45px rgba(0,0,0,.92);
           text-shadow:0 2px 3px rgba(0,0,0,.96), 0 0 10px rgba(0,0,0,.82), 0 0 22px rgba(0,0,0,.5); }
.caption[data-on="true"] { opacity:1; }

.track { margin-top:18px; }
.ruler { position:relative; height:16px; margin-bottom:4px; }
.ruler span { position:absolute; transform:translateX(-50%); font-size:11px;
              color:var(--text-4); font-family:var(--mono); }
.bar { position:relative; display:flex; height:46px; border-radius:8px; overflow:hidden;
       border:1px solid var(--line); background:var(--well); }
.seg { border:0; padding:0; background:var(--raised); border-right:1px solid var(--bg);
       display:flex; align-items:center; justify-content:center; font-size:11px;
       font-family:var(--mono); color:var(--text-3); min-width:0; overflow:hidden; white-space:nowrap; }
.seg:last-child { border-right:0; }
.seg.fast { background:var(--lime-soft); color:var(--lime); }
.seg.hold { background:var(--warn-soft); color:var(--warn); }
.seg:hover { outline:1px solid var(--line-2); outline-offset:-1px; }
.scenes-strip { position:relative; display:flex; margin-top:6px; gap:2px; }
.scene-tab { flex:none; border:1px solid var(--line); border-radius:8px; background:var(--raised);
             padding:6px 10px; font-size:12px; text-align:left; overflow:hidden; white-space:nowrap; }
.scene-tab[aria-current="true"] { border-color:var(--lime-edge); background:var(--lime-soft); color:var(--lime); }
.zooms { position:relative; height:24px; margin-top:8px; }
.zooms .zoom { position:absolute; top:0; height:20px; min-width:8px; padding:0 6px;
               border:1px solid rgba(141,235,210,.30); border-radius:6px;
               background:rgba(141,235,210,.10); color:var(--aqua);
               font-size:11px; font-family:var(--mono); overflow:hidden; white-space:nowrap; }
.zooms .zoom:hover { background:rgba(141,235,210,.20); }
.playhead { position:absolute; top:0; bottom:0; width:2px; background:var(--lime);
            pointer-events:none; box-shadow:0 0 8px rgba(201,255,91,.6); }

.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:16px; }
.scene { background:var(--surface); border:1px solid var(--line); border-radius:14px; padding:18px; }
.scene[aria-current="true"] { border-color:var(--lime-edge); }
.scene h3 { margin:0 0 4px; font-size:14px; font-family:var(--mono); color:var(--lime); font-weight:500; }
.scene .when { color:var(--text-4); font-size:12px; font-family:var(--mono); margin-bottom:12px; }
.scene p { margin:0 0 10px; color:var(--text); }
.scene p.empty { color:var(--text-4); font-style:italic; }
.tags { display:flex; gap:6px; flex-wrap:wrap; }
.tag { font-size:11px; font-family:var(--mono); color:var(--text-3);
       border:1px solid var(--line); border-radius:6px; padding:2px 7px; }
.tag.on { color:var(--lime); border-color:var(--lime-edge); }
.tag.off { color:var(--warn); border-color:var(--warn-edge); }
.cands { margin-top:14px; padding-top:12px; border-top:1px solid var(--line); }
.cands-head { font-size:12px; color:var(--text-4); margin-bottom:8px; }
.cand { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:6px 0; }
.cand-name { font-size:12px; font-family:var(--mono); color:var(--text-3); min-width:96px; }
.cand.on .cand-name { color:var(--lime); }
.cand-len { font-size:11px; font-family:var(--mono); color:var(--text-4); }
.cand audio { flex:1 1 200px; height:30px; min-width:180px; }
ul.checks { list-style:none; margin:0; padding:0; }
ul.checks li { display:flex; gap:10px; padding:6px 0; border-bottom:1px solid var(--line); font-size:13px; }
ul.checks li:last-child { border-bottom:0; }
ul.checks .mark { font-family:var(--mono); }
ul.checks .mark.ok { color:var(--lime); }
ul.checks .mark.bad { color:var(--danger); }
ul.checks .detail { color:var(--text-4); font-family:var(--mono); font-size:12px; margin-left:auto; }
.warn { background:var(--warn-soft); border:1px solid var(--warn-edge); border-radius:10px;
        padding:10px 14px; color:var(--warn); font-size:13px; margin-top:12px; }
.ask { display:grid; gap:10px; }
.ask div { display:flex; gap:12px; align-items:baseline; padding:8px 0; border-bottom:1px solid var(--line); }
.ask div:last-child { border-bottom:0; }
.ask .now { font-family:var(--mono); color:var(--lime); font-size:13px; flex:none; min-width:150px; }
.ask .q { color:var(--text-2); font-size:13px; }
@media (max-width:640px) { main { padding:20px 16px 48px; } .hint { display:none; } }
`;

const SCRIPT = `
const data = window.__review;
const video = document.getElementById('player');
const picker = document.getElementById('picker');
const bar = document.getElementById('bar');
const head = document.getElementById('playhead');
const total = data.plan ? data.plan.durationMs : 0;

picker?.addEventListener('click', event => {
  const button = event.target.closest('button[data-src]');
  if (!button) return;
  const at = video.currentTime, playing = !video.paused;
  for (const chip of picker.querySelectorAll('button')) chip.setAttribute('aria-pressed', String(chip === button));
  video.src = button.dataset.src;
  video.currentTime = at;
  if (playing) video.play();
});

const seek = ms => {
  video.currentTime = Math.max(0, Math.min(ms / 1000, video.duration || ms / 1000));
  video.play();
};
for (const element of document.querySelectorAll('[data-at]')) {
  element.addEventListener('click', () => seek(Number(element.dataset.at)));
}

const caption = document.getElementById('caption');
const cc = document.getElementById('cc');
let captionsOn = true;
cc?.addEventListener('click', () => {
  captionsOn = !captionsOn;
  cc.setAttribute('aria-pressed', String(captionsOn));
  if (!captionsOn) caption.dataset.on = 'false';
});

video.addEventListener('timeupdate', () => {
  const ms = video.currentTime * 1000;
  const cue = captionsOn ? data.captions.find(item => ms >= item.startMs && ms < item.endMs) : null;
  if (caption.textContent !== (cue ? cue.text : '')) caption.textContent = cue ? cue.text : '';
  caption.dataset.on = String(Boolean(cue));
  if (total > 0) head.style.left = (ms / total * 100).toFixed(3) + '%';
  const current = data.scenes.find(scene => ms >= scene.outStartMs && ms < scene.outEndMs);
  for (const element of document.querySelectorAll('[data-scene]')) {
    element.setAttribute('aria-current', String(element.dataset.scene === (current ? current.id : '')));
  }
});

addEventListener('keydown', event => {
  if (event.target.matches('input, textarea')) return;
  if (event.code === 'Space') { event.preventDefault(); video.paused ? video.play() : video.pause(); }
  else if (event.key === 'ArrowLeft') video.currentTime = Math.max(0, video.currentTime - 2);
  else if (event.key === 'ArrowRight') video.currentTime += 2;
  else if (/^[1-9]$/.test(event.key)) {
    const scene = data.scenes[Number(event.key) - 1];
    if (scene) seek(scene.outStartMs);
  }
});
`;

function englishParts(routing) {
  const count = (routing?.segments || []).filter(part => part.language === "English").length;
  return count ? ` · 영어 ${count}구간` : "";
}

function candidateList(scene) {
  if (!scene.candidates.length) return "";
  return `<div class="cands">
    <div class="cands-head">목소리 후보 ${scene.candidates.length}개 — 듣고 고른다</div>
    ${scene.candidates.map(item => `<div class="cand${item.selected ? " on" : ""}">
      <span class="cand-name">${escapeHtml(item.name)}${item.selected ? " · 쓰는 중" : ""}</span>
      <span class="cand-len">${item.durationMs ? seconds(item.durationMs) : ""}${englishParts(item.voiceRouting)}</span>
      <audio controls preload="none" src="${escapeHtml(item.file)}"></audio>
    </div>`).join("")}
  </div>`;
}

function sceneCard(scene) {
  const narration = scene.narration
    ? `<span class="tag on">내레이션 ${seconds(scene.narration.durationMs)} · ${seconds(scene.narration.atMs)}부터</span>`
    : '<span class="tag off">내레이션 없음</span>';
  const status = scene.status === "approved"
    ? '<span class="tag on">대본 확정</span>'
    : '<span class="tag off">대본 초안</span>';
  const hold = scene.holdMs ? `<span class="tag">끝 화면 멈춤 ${seconds(scene.holdMs)}</span>` : "";
  return `<article class="scene" data-scene="${escapeHtml(scene.id)}" data-at="${scene.outStartMs}">
    <h3>${escapeHtml(scene.id)}</h3>
    <div class="when">완성 ${seconds(scene.outStartMs)}–${seconds(scene.outEndMs)}
      · 원본 ${seconds(scene.srcStartMs)}–${seconds(scene.srcEndMs)}</div>
    <p class="${scene.text ? "" : "empty"}">${escapeHtml(scene.text || "대본을 아직 쓰지 않았습니다.")}</p>
    <div class="tags">${status}${narration}${hold}</div>
    ${candidateList(scene)}
  </article>`;
}

// 키프레임 넷이 확대 한 번이다. 하나씩 찍으면 같은 글자가 겹쳐 무엇이 몇 번인지
// 알 수 없다. 1배를 벗어나 있는 동안을 한 칸으로 묶는다.
export function zoomSpans(plan) {
  const spans = [];
  let open = null;
  for (const key of plan.zoom || []) {
    if (key.z > 1.01 && open === null) open = key.atMs;
    else if (key.z <= 1.01 && open !== null) { spans.push({ fromMs: open, toMs: key.atMs }); open = null; }
  }
  if (open !== null) spans.push({ fromMs: open, toMs: plan.durationMs });
  return spans;
}

function segmentBlocks(plan) {
  const parts = [];
  for (const segment of plan.segments) {
    const played = segment.outFrames * 1000 / plan.fps;
    if (played > 0) {
      parts.push({ ms: played, at: segment.outStartMs, kind: segment.speed > 1.01 ? "fast" : "",
        label: segment.speed > 1.01 ? `${segment.speed.toFixed(1)}배` : "1배" });
    }
    if (segment.holdMs > 0) {
      parts.push({ ms: segment.holdMs, at: segment.outStartMs + played, kind: "hold", label: "멈춤" });
    }
  }
  return parts;
}

// 가장 긴 기다림 한 곳을 실제 값으로 말한다. "빠른 것 같다"에서 멈추지 않게.
function longestWait(plan) {
  const slowed = plan.segments.filter(segment => segment.kind === "slowed");
  const restored = slowed.length
    ? ` 느리게 찍은 장면 ${slowed.length}개는 ${(slowed[0].speed).toFixed(1)}배로 되돌렸다.`
    : "";
  const waits = plan.segments.filter(segment => segment.speed > 1.01 && segment.kind !== "slowed");
  if (!waits.length) return `감은 기다림이 없다. 화면이 계속 움직였다.${restored}`;
  const longest = waits.reduce((best, segment) =>
    segment.srcEndMs - segment.srcStartMs > best.srcEndMs - best.srcStartMs ? segment : best);
  return `기다림을 감는 배율. 가장 긴 기다림은 ${seconds(longest.srcEndMs - longest.srcStartMs)}를 `
    + `${seconds(longest.outFrames * 1000 / plan.fps)}로 줄였다.${restored}`;
}

/** 검수 화면 한 쪽. 데이터만 받아 문자열을 낸다. */
export function buildReviewPage(data) {
  const plan = data.plan;
  const total = plan?.durationMs || 1;
  const blocks = plan ? segmentBlocks(plan) : [];
  const marks = Array.from({ length: Math.floor(total / 5000) + 1 }, (_, index) => index * 5000);
  const zooms = plan ? zoomSpans(plan) : [];
  const videos = data.videos;
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(data.scenario)} 데모 검수</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <div class="head">
    <h1>${escapeHtml(data.scenario)}</h1>
    ${data.ok === null ? "" : `<span class="badge ${data.ok ? "ok" : "bad"}">${data.ok ? "검증 통과" : "검증 실패"}</span>`}
  </div>
  <div class="meta">
    ${data.sourceMs ? `<span>원본 <b>${seconds(data.sourceMs)}</b> → 완성 <b>${seconds(total)}</b></span>` : ""}
    ${data.frame ? `<span>촬영 <b>${data.frame.width}×${data.frame.height}</b></span>` : ""}
    ${plan ? `<span>최대 배율 <b>${plan.maxSpeed}배</b></span>` : ""}
    ${plan ? `<span>확대 <b>${zooms.length ? `${zooms.length}곳` : "없음"}</b></span>` : ""}
    <span>${escapeHtml(data.generatedAt.slice(0, 16).replace("T", " "))}</span>
  </div>

  <section class="card">
    <div class="picker" id="picker">
      ${videos.map((video, index) => `<button class="chip" data-src="${escapeHtml(video.name)}"
        aria-pressed="${index === 0}">${escapeHtml(video.label)} · ${(video.bytes / 1048576).toFixed(1)}MB</button>`).join("")}
      ${data.captions.length ? `<button class="chip" id="cc" aria-pressed="true">자막</button>` : ""}
      <span class="hint">space 재생 · ←→ 2초 · 1~9 장면</span>
    </div>
    <div class="stage">
      <video id="player" controls preload="metadata" src="${escapeHtml(videos[0]?.name ?? "")}"></video>
      <div id="caption" class="caption" aria-live="off"></div>
    </div>
    ${data.captions.length ? `<p class="note">자막 ${data.captions.length}줄을 여기서 겹쳐 보여 준다.
      영상에는 굽지 않는다 — 파일(<code>demo/captions.srt</code>)로 유튜브에 따로 올린다.</p>` : ""}

    ${plan ? `<div class="track">
      <div class="ruler">${marks.map(ms =>
        `<span style="left:${(ms / total * 100).toFixed(3)}%">${Math.round(ms / 1000)}s</span>`).join("")}</div>
      <div class="bar" id="bar">
        ${blocks.map(block => `<button class="seg ${block.kind}" data-at="${Math.round(block.at)}"
          style="flex:0 0 ${(block.ms / total * 100).toFixed(4)}%"
          title="${escapeHtml(block.label)} · ${seconds(block.ms)}">${escapeHtml(block.label)}</button>`).join("")}
        <div class="playhead" id="playhead" style="left:0"></div>
      </div>
      <div class="scenes-strip">
        ${data.scenes.map(scene => `<button class="scene-tab" data-scene="${escapeHtml(scene.id)}"
          data-at="${scene.outStartMs}"
          style="flex:0 0 ${((scene.outEndMs - scene.outStartMs) / total * 100).toFixed(4)}%"
          >${escapeHtml(scene.id)}</button>`).join("")}
      </div>
      <div class="zooms">
        ${zooms.map(span => `<button class="zoom" data-at="${Math.round(span.fromMs)}"
          style="left:${(span.fromMs / total * 100).toFixed(3)}%;width:${((span.toMs - span.fromMs) / total * 100).toFixed(3)}%"
          title="확대 ${seconds(span.toMs - span.fromMs)}">확대</button>`).join("")}
      </div>
    </div>` : ""}
  </section>

  <section>
    <h2>장면과 대본</h2>
    <div class="grid">${data.scenes.map(sceneCard).join("")}</div>
  </section>

  ${data.checks.length ? `<section class="card" style="margin-top:20px">
    <h2>자동 검증</h2>
    <ul class="checks">
      ${data.checks.map(check => `<li>
        <span class="mark ${check.ok ? "ok" : "bad"}">${check.ok ? "✓" : "✕"}</span>
        <span>${escapeHtml(check.label)}</span>
        ${check.detail ? `<span class="detail">${escapeHtml(check.detail)}</span>` : ""}
      </li>`).join("")}
    </ul>
    ${data.warnings.map(warning => `<div class="warn">${escapeHtml(warning)}</div>`).join("")}
    <div class="warn" style="background:none;border-color:var(--line);color:var(--text-4)">
      자동 검증은 파일 규격과 길이를 본 것이다. 화면과 소리의 판단은 이 영상을 직접 본 사람이 한다.
    </div>
  </section>` : ""}

  ${plan ? `<section class="card">
    <h2>정할 것</h2>
    <div class="ask">
      <div><span class="now">${plan.maxSpeed}배</span><span class="q">${longestWait(plan)}</span></div>
      <div><span class="now">1.6배 · 0.6초</span><span class="q">클릭 지점 확대의 세기와 들어가고 나오는 시간.</span></div>
      <div><span class="now">${videos.map(v => v.label).join(" / ") || "—"}</span><span class="q">출력 해상도. 위에서 같은 자리를 두 벌로 비교한다.</span></div>
      <div><span class="now">${data.scenes.every(s => s.status === "approved") ? "확정" : "초안"}</span><span class="q">장면별 대본. 고치고 <code>status</code>를 approved로 바꾸면 목소리를 만든다.</span></div>
    </div>
  </section>` : ""}
</main>
<script>window.__review = ${embedJson(data)};</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

/** 결과 폴더에 `review.html`을 쓰고 그 경로를 돌려준다. */
export function writeReviewPage(outDir) {
  const data = collectReview(outDir);
  const file = path.join(outDir, "review.html");
  fs.writeFileSync(file, buildReviewPage(data), "utf8");
  return file;
}
