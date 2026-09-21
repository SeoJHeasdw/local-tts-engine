// 편집 계획을 ffmpeg 한 번으로 굳힌다. 빨리 감기·멈춤·확대·내레이션·색 변환이
// 모두 한 사슬 안에서 일어나고, 손실 압축은 여기서 처음이자 마지막으로 한 번 한다.
//
// 설계는 구간마다 trim→setpts→concat을 적었지만, 그렇게 하면 `split`으로 갈라진
// 가지가 자기 차례를 기다리며 프레임을 쌓는다. 4K 무손실에서는 그 버퍼가 기가바이트
// 단위다. 구간이 원본 순서를 그대로 따르므로 여기서는 시간축을 한 번 접는 방식을
// 쓴다: setpts로 각 구간의 기울기를 바꾸고 멈출 자리에 시간을 건너뛴 뒤, fps가 그
// 빈자리를 마지막 화면으로 채운다. 결과는 같고 원본은 한 번만 지나간다.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildSpanCues, captionsToSrt, captionsToVtt } from "../../shared/captions.mjs";
import { buildEditPlan } from "../../shared/demo-plan.mjs";
import { summarizeChecks } from "../../shared/quality.mjs";
import { captureVideoFileName, videoQuality } from "../../shared/video-quality.mjs";
import { CAPTURE_COLOR_FILTERS, captureCodecArgs, validateCaptureStream, writeCaptureReport } from "../capture/encoding.mjs";
import { RAW_FILE, SCENES_FILE } from "../capture/record-app.mjs";
import { writeReviewPage } from "./demo-review.mjs";
import { renderCaptionFrames } from "./demo-captions.mjs";
import { fileSha256 } from "../files.mjs";

const AUDIO_ARGS = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "1"];
const AUDIO_TOLERANCE_MS = 100;
// ffmpeg 식 안에서 쉼표는 필터 구분자다. 식으로 남기려면 벗겨 줘야 한다.
const expr = text => text.replaceAll(",", "\\,");

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-16_384); });
    child.once("error", reject);
    child.once("close", code => code === 0
      ? resolve(stdout)
      : reject(new Error(`${path.basename(executable)} 실행 실패 (종료 ${code})\n${stderr.trim()}`)));
  });
}

/**
 * 시간축을 접는 식. 원본 프레임 번호 N을 완성 영상 프레임 번호로 옮긴다.
 *
 * 멈출 자리에서는 다음 구간의 시작으로 건너뛴다. 그 사이를 `fps`가 마지막 화면으로
 * 채우는 것이 곧 "멈춤"이다.
 */
export function timeWarpExpression(plan) {
  const fps = plan.fps;
  const frame = ms => Math.round(ms * fps / 1000);
  let out = 0;
  const pieces = [];
  for (const segment of plan.segments) {
    const from = frame(segment.srcStartMs);
    const to = frame(segment.srcEndMs);
    const start = out;
    pieces.push({ to, expr: `${start}+(N-${from})*${segment.outFrames}/${to - from}` });
    out += segment.outFrames + frame(segment.holdMs);
  }
  const last = pieces.at(-1);
  return pieces.slice(0, -1).reduceRight(
    (rest, piece) => `if(lt(N,${piece.to}),${piece.expr},${rest})`,
    last.expr,
  );
}

// 키프레임 사이를 코사인으로 잇는 식. shared/demo-plan.mjs의 zoomAt과 같은 값을 낸다.
function keyframeExpression(keys, pick, fps) {
  const at = ms => Math.round(ms * fps / 1000);
  if (keys.length === 1) return String(pick(keys[0]));
  const spans = keys.slice(0, -1).map((key, index) => {
    const next = keys[index + 1];
    const from = at(key.atMs);
    const span = at(next.atMs) - from;
    const a = pick(key);
    const b = pick(next);
    if (a === b || span <= 0) return { until: at(next.atMs), expr: String(b) };
    return { until: at(next.atMs), expr: `${a}+${b - a}*(1-cos(PI*(on-${from})/${span}))/2` };
  });
  const tail = String(pick(keys.at(-1)));
  const body = spans.reduceRight((rest, span) => `if(lt(on,${span.until}),${span.expr},${rest})`, tail);
  return `if(lt(on,${at(keys[0].atMs)}),${pick(keys[0])},${body})`;
}

/**
 * 확대 필터. 없으면 크기만 맞춘다.
 *
 * `zoompan`은 자를 위치와 크기를 입력 픽셀 단위 정수로 내림한다(2026-09-20 측정).
 * 그래서 중심을 가두는 일은 식 안에서 프레임마다 정확히 하고, 이 계획의 확대 전환은
 * 0.6초로 짧게 두어 절단 오차(1440p에서 최대 약 1.2px)가 이동량에 묻히게 한다.
 */
export function zoomFilter(plan, profile) {
  const size = `${profile.width}x${profile.height}`;
  if (!plan.zoom?.length) return `scale=${profile.width}:${profile.height}:flags=lanczos`;
  const scale = plan.viewport.scale || 1;
  const z = keyframeExpression(plan.zoom, key => key.z, plan.fps);
  const cx = keyframeExpression(plan.zoom, key => key.cx, plan.fps);
  const cy = keyframeExpression(plan.zoom, key => key.cy, plan.fps);
  // 중심은 CSS px이다. 프레임 픽셀로 옮긴 뒤 보이는 상자가 화면 밖으로 나가지 않게 가둔다.
  const x = `max(0,min(iw-iw/zoom,(${cx})*${scale}-(iw/zoom)/2))`;
  const y = `max(0,min(ih-ih/zoom,(${cy})*${scale}-(ih/zoom)/2))`;
  return `zoompan=d=1:s=${size}:fps=${plan.fps}:z='${expr(z)}':x='${expr(x)}':y='${expr(y)}'`;
}

export function videoFilterChain(plan, profile, { color = true } = {}) {
  const fps = plan.fps;
  const tail = Math.round((plan.segments.at(-1).holdMs || 0) * fps / 1000);
  return [
    `setpts='(${expr(timeWarpExpression(plan))})/${fps}/TB'`,
    // 건너뛴 자리를 마지막 화면으로 채운다. 이것이 계획의 "멈춤"이다.
    `fps=fps=${fps}`,
    // 마지막 구간 뒤의 멈춤은 다음 프레임이 없어 fps가 채우지 못한다.
    ...(tail ? [`tpad=stop_mode=clone:stop=${tail}`] : []),
    // 계획보다 길게 나온 꼬리는 자른다. 프레임 수 = 계획 길이를 여기서 보장한다.
    `trim=end_frame=${plan.totalFrames}`,
    `setpts=N/${fps}/TB`,
    zoomFilter(plan, profile),
    // 자막을 굽는다면 색 변환 전에 겹친다. 확대 뒤라 자막은 화면에 고정된다.
    ...(color ? [CAPTURE_COLOR_FILTERS] : []),
  ].join(",");
}

/**
 * 렌더 한 번의 ffmpeg 인자.
 *
 * `narration`은 `{ file, atMs }` 목록이다. 무음 바닥 위에 장면 음성을 제자리에
 * 놓고 더한다. 바닥이 있어야 완성본에 음성 트랙이 늘 있고 길이가 계획과 같다.
 * `captions`(`{ list, band }`)를 주면 자막 그림을 확대 뒤·색 변환 전에 겹친다.
 */
export function demoRenderArgs({ plan, rawFile, narration = [], profile, output, captions = null }) {
  const seconds = (plan.totalFrames / plan.fps).toFixed(3);
  const voices = narration.filter(item => item.file);
  const captionInput = voices.length + 2;
  const graph = captions ? [
    `[0:v]${videoFilterChain(plan, profile, { color: false })}[base]`,
    `[${captionInput}:v]format=rgba,fps=${plan.fps}[cap]`,
    `[base][cap]overlay=${captions.band.x}:${captions.band.y}:eof_action=pass:format=auto,${CAPTURE_COLOR_FILTERS}[v]`,
  ] : [`[0:v]${videoFilterChain(plan, profile)}[v]`];
  for (const [index, item] of voices.entries()) {
    graph.push(`[${index + 2}:a]aresample=48000,adelay=${Math.round(item.atMs)}:all=1[n${index}]`);
  }
  graph.push(`[1:a]${voices.map((_, index) => `[n${index}]`).join("")}`
    + `amix=inputs=${voices.length + 1}:normalize=0:duration=first[a]`);
  return [
    "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
    "-i", rawFile,
    "-f", "lavfi", "-t", seconds, "-i", "anullsrc=r=48000:cl=mono",
    ...voices.flatMap(item => ["-i", item.file]),
    ...(captions ? ["-f", "concat", "-safe", "0", "-i", captions.list] : []),
    "-filter_complex", graph.join(";"),
    "-map", "[v]", "-map", "[a]",
    // 프레임 수는 이미 계획과 같다. 길이 상한은 그 프레임 수에서 나온 값이라
    // 마지막 프레임을 자르지 않는다.
    "-t", seconds,
    ...captureCodecArgs(profile), ...AUDIO_ARGS,
    "-f", "mp4", "-movflags", "+faststart", output,
  ];
}

export function renderChecks(probe, profile, plan, narration) {
  const video = probe.streams?.find(stream => stream.codec_type === "video");
  const audio = probe.streams?.find(stream => stream.codec_type === "audio");
  let specError = null;
  try { validateCaptureStream(probe, profile, plan.totalFrames); }
  catch (error) { specError = error.message; }
  const durationMs = Math.round(Number(probe.format?.duration || 0) * 1000);
  const audioMs = Math.round(Number(audio?.duration) * 1000);
  const last = narration.filter(item => item.file).at(-1);
  return [
    { label: `영상 규격 · ${profile.width}×${profile.height} ${plan.fps}fps`, ok: !specError,
      ...(specError ? { detail: specError } : {}) },
    { label: "프레임 수 = 계획 길이", ok: Number(video?.nb_frames) === plan.totalFrames,
      detail: `실제 ${video?.nb_frames ?? "없음"} · 계획 ${plan.totalFrames}` },
    { label: "음성 길이 = 영상 길이", ok: Number.isFinite(audioMs) && Math.abs(audioMs - durationMs) <= AUDIO_TOLERANCE_MS,
      detail: `영상 ${durationMs}ms · 음성 ${Number.isFinite(audioMs) ? `${audioMs}ms` : "없음"}` },
    { label: "내레이션이 영상 안에 들어간다",
      ok: !last || last.atMs + last.durationMs <= plan.durationMs + AUDIO_TOLERANCE_MS,
      detail: last ? `마지막 내레이션 끝 ${Math.round(last.atMs + last.durationMs)}ms · 영상 ${plan.durationMs}ms` : "내레이션 없음" },
  ];
}

/**
 * 장면 대본과 실제 음성 길이로 자막을 만든다.
 *
 * 앱 데모 대본은 찍은 뒤에 쓴 글이라 단어 정렬이 없다. 장면 음성 길이 안에서
 * 글자 수에 비례해 놓는다(설계 8절). 기본은 파일뿐이고 영상에 굽지 않는다.
 */
export function demoCaptionCues(plan, script) {
  const texts = new Map((script?.scenes || []).map(scene => [scene.id, scene.text || ""]));
  const spans = plan.scenes
    .filter(scene => scene.narration && texts.get(scene.id)?.trim())
    .map(scene => ({ text: texts.get(scene.id), startMs: scene.narration.atMs, durationMs: scene.narration.durationMs }));
  return buildSpanCues(spans, plan.durationMs);
}

// 대본이 확정(approved)되고 목소리를 고른 장면만 내레이션을 넣는다. 길이는 고른
// 파일에서 직접 잰다 — 후보 기록의 값이 아니라 실제 오디오다.
async function resolveNarration(scenes, script, demoDir, ffprobe) {
  const chosen = new Map((script?.scenes || [])
    .filter(scene => scene.status === "approved" && scene.voice?.selected)
    .map(scene => [scene.id, scene.voice.selected]));
  const narration = {};
  for (const scene of scenes.scenes) {
    const selected = chosen.get(scene.id);
    if (!selected) continue;
    const file = path.isAbsolute(selected) ? selected : path.join(demoDir, selected);
    if (!fs.existsSync(file)) throw new Error(`장면 ${scene.id}의 고른 음성을 찾지 못했습니다: ${file}`);
    const probe = JSON.parse(await run(ffprobe, ["-v", "error", "-show_format", "-show_streams", "-of", "json", file]));
    const seconds = Number(probe.format?.duration ?? probe.streams?.[0]?.duration);
    if (!(seconds > 0)) throw new Error(`장면 ${scene.id}의 음성 길이를 읽지 못했습니다: ${file}`);
    narration[scene.id] = { file, durationMs: Math.round(seconds * 1000) };
  }
  return narration;
}

/**
 * 촬영 기록·대본·고른 목소리로 완성 영상을 만든다.
 *
 * 다시 찍지 않는다. 대본·목소리·계획만 바뀌면 이 단계만 다시 돌면 된다.
 * 검증에 실패한 결과는 지우지 않고 보고서에 남긴다 — 무엇이 어긋났는지가 근거다.
 */
export async function renderAppDemo({
  outDir, name, quality = "high", options = {}, burnCaptions = false,
  ffmpeg = "ffmpeg", ffprobe = "ffprobe", onEvent = () => {},
}) {
  const profile = videoQuality(quality);
  const demoDir = path.join(outDir, "demo");
  const scenes = JSON.parse(fs.readFileSync(path.join(demoDir, SCENES_FILE), "utf8"));
  const scriptFile = path.join(demoDir, "script.json");
  const script = fs.existsSync(scriptFile) ? JSON.parse(fs.readFileSync(scriptFile, "utf8")) : null;
  const rawFile = path.join(demoDir, RAW_FILE);
  if (!fs.existsSync(rawFile)) throw new Error(`무손실 원본이 없습니다: ${rawFile}`);

  const narration = await resolveNarration(scenes, script, demoDir, ffprobe);
  const plan = buildEditPlan(scenes, { narration, options: { ...options, fps: scenes.fps ?? 25 } });
  writeCaptureReport(path.join(demoDir, "edit-plan.json"), plan);
  const placed = plan.scenes.filter(scene => scene.narration)
    .map(scene => ({ id: scene.id, ...scene.narration }));
  onEvent({ phase: "rendering", durationMs: plan.durationMs, scenes: plan.scenes.length, narration: placed.length });
  const cues = demoCaptionCues(plan, script);
  const warnings = plan.scenes.filter(scene => !scene.narration).map(scene => `장면 ${scene.id}에 내레이션이 없습니다.`);
  if (burnCaptions && !cues.length) warnings.push("구울 자막이 없습니다. 목소리를 고른 장면이 없어 자막 없이 구웠습니다.");

  // 화질마다 다른 이름이다. 같은 이름이면 1440p를 내고 4K를 내는 순간 앞의 것이
  // 사라져, 검수 화면이 준비해 둔 해상도 비교를 할 수가 없다. 이름 규칙은 촬영과 같다.
  // 자막을 구운 것도 따로 남는다(-captioned). 굽지 않은 것과 나란히 견준다.
  const burned = burnCaptions && cues.length > 0;
  const finalFile = path.join(outDir, captureVideoFileName(name, { videoQuality: profile.id, burnCaptions: burned }));
  const workFile = `${finalFile}.${crypto.randomUUID()}.part`;
  const frameDir = path.join(demoDir, `caption-frames-${crypto.randomUUID()}`);
  let done = false;
  try {
    const captions = burned ? await renderCaptionFrames({ cues, profile, dir: frameDir, totalMs: plan.durationMs }) : null;
    if (captions) onEvent({ phase: "log", text: `자막 ${captions.count}줄을 그림으로 떴습니다` });
    await run(ffmpeg, demoRenderArgs({ plan, rawFile, narration: placed, profile, output: workFile, captions }));
    const probe = JSON.parse(await run(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", workFile]));
    const checks = renderChecks(probe, profile, plan, placed);
    const summary = summarizeChecks(checks);
    const digest = await fileSha256(workFile);
    const durationMs = Math.round(Number(probe.format?.duration || 0) * 1000);
    fs.renameSync(workFile, finalFile);
    done = true;

    if (cues.length) {
      fs.writeFileSync(path.join(demoDir, "captions.srt"), captionsToSrt(cues), "utf8");
      fs.writeFileSync(path.join(demoDir, "captions.vtt"), captionsToVtt(cues), "utf8");
      writeCaptureReport(path.join(demoDir, "captions.json"), { schemaVersion: 1, cues });
    }

    const video = probe.streams.find(stream => stream.codec_type === "video");
    const audio = probe.streams.find(stream => stream.codec_type === "audio") || null;
    const generatedAt = new Date().toISOString();
    writeCaptureReport(`${finalFile}.capture.json`, {
      schemaVersion: 1, profile, source: { scenario: scenes.scenario, raw: rawFile, frame: scenes.frame },
      encoder: "libx264", preset: "slow", frames: { written: Number(video?.nb_frames) || 0 }, burnCaptions: burned,
      durationMs, video, audio, file: finalFile, fileSha256: digest, plan: {
        totalFrames: plan.totalFrames, maxSpeed: plan.maxSpeed,
        segments: plan.segments.length, zoomKeyframes: plan.zoom.length,
      }, generatedAt,
    });
    const report = {
      schemaVersion: 1, generatedAt, name: path.basename(outDir), operation: "app-demo", displayName: name,
      inputs: [rawFile], videoPath: finalFile, durationMs, video,
      scenario: scenes.scenario, plannedMs: plan.durationMs,
      scenes: plan.scenes.map(scene => ({ id: scene.id, outStartMs: scene.outStartMs, outEndMs: scene.outEndMs,
        holdMs: scene.holdMs, narrationMs: scene.narration?.durationMs ?? 0 })),
      captions: cues.length ? { srt: path.join(demoDir, "captions.srt"), cues: cues.length, burned } : null,
      warnings,
      checks, summary,
      target: { root: "edit", day: path.basename(path.dirname(outDir)), name: path.basename(outDir) },
    };
    writeCaptureReport(path.join(outDir, "validation-report.json"), report);
    // 검수 화면은 검증 실패에도 남긴다. 무엇이 어긋났는지 보려면 영상을 봐야 한다.
    report.reviewPath = writeReviewPage(outDir);
    onEvent({ phase: "rendered", durationMs, ok: summary.ok, review: report.reviewPath });
    if (!summary.ok) {
      const failed = checks.filter(check => !check.ok).map(check => check.detail ? `${check.label} (${check.detail})` : check.label);
      throw new Error(`완성 영상 검증 실패: ${failed.join(", ")}`);
    }
    return report;
  } finally {
    if (!done) fs.rmSync(workFile, { force: true });
    fs.rmSync(frameDir, { recursive: true, force: true });
  }
}
