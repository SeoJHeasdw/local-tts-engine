// 디스플레이 하나를 원래 해상도 그대로 녹화한다. 사람이 시작·정지하고, 취소는
// 결과를 버린다. 인코딩은 덱 촬영과 같은 encoding.mjs를 쓴다. 그래야 1080p 화면
// 녹화가 덱 1080p 촬영과 스트림 서명이 같아 합치기가 복사로 끝난다.
//
// 두 단계로 만든다. 1단계는 영상만 녹화하고 2단계에서 무음 음성 트랙을 붙인다.
// 편집은 음성 없는 영상을 거절하는데, 무음을 녹화와 동시에 만들면 음성이 영상보다
// 먼저 끊겼다(실측: 영상 8.08초, 음성 5.35초). 음성을 포함하면 고른 입력 장치를
// 함께 녹음하고 2단계는 건너뛴다.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { captureFrameCount } from "../../shared/video-quality.mjs";
import { summarizeChecks } from "../../shared/quality.mjs";
import { fileSha256 } from "../files.mjs";
import { CAPTURE_COLOR_FILTERS, captureCodecArgs, validateCaptureStream, writeCaptureReport } from "./encoding.mjs";
import { ffmpegErrorText, listCaptureDevices, probeDisplay, resolveDevice, screenDevices } from "./displays.mjs";

export const RECORD_FPS = 25;
// 덱 음성·편집기와 같은 AAC LC 48kHz 모노. 스테레오면 합치기가 재인코딩한다.
const AUDIO_ARGS = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "1"];
// AAC 한 프레임이 21ms다. 그보다 크게 어긋나면 한쪽이 먼저 끊긴 것이다.
const AUDIO_TOLERANCE_MS = 100;
const AAC_FRAME_SAMPLES = 1024;
const CANCELLED = "사용자가 녹화를 취소했습니다.";

export function displayProfile({ width, height }) {
  // yuv420p는 짝수 크기만 받는다. 크롭·확대를 하지 않으므로 맞지 않으면 녹화하지 않는다.
  if (!(width > 0 && height > 0) || width % 2 || height % 2) {
    throw new Error(`화면 크기 ${width}×${height}는 원본 그대로 녹화할 수 없습니다. 짝수 크기여야 합니다.`);
  }
  return { id: "display", width, height, fps: RECORD_FPS, crf: 16 };
}

export function avfoundationInput({ screenIndex, audioIndex = null, fps = RECORD_FPS }) {
  return ["-f", "avfoundation", "-capture_cursor", "1", "-pixel_format", "bgr0", "-framerate", String(fps),
    "-i", `${screenIndex}:${audioIndex ?? "none"}`];
}

// 녹화 중 화면 가장자리에 뜨는 빨간 테두리(record-monitor.mjs)를 지운다. 테두리가
// 덮은 폭보다 조금 넓게 바로 안쪽 픽셀로 채운다(smear). 크기·규격은 그대로라 합치기
// 계약도 같다.
//
// 채우는 자리는 색 변환(yuv420p) 뒤다. 변환은 채도를 이웃 픽셀과 섞어 구하므로 빨강이
// 안쪽으로 번지고, 그래서 테두리보다 넓게 채운다. 2026-09-21 회색 바탕 실측: 3px 테두리는
// 4px, 6px 테두리는 10px을 채우면 빨강이 남지 않았다(8px은 2/255). 변환 전 RGB에서
// 채우면 번짐은 없지만 fillborders가 평면 RGB만 받아 ffmpeg가 화면 전체를 한 번 더 바꾸고,
// 3456×2234 인코딩이 9~26% 느려졌다. 실시간 녹화에서는 프레임을 놓치는 쪽이 더 큰 손실이다.
export const EDGE_BLEED_PX = 4;

export function edgeFill(edgeMask = 0) {
  if (!Number.isInteger(edgeMask) || edgeMask < 0) throw new Error(`가장자리 폭이 올바르지 않습니다: ${edgeMask}`);
  return edgeMask ? 2 * Math.ceil(edgeMask / 2) + EDGE_BLEED_PX : 0;
}

export function recordFilters(edgeMask = 0) {
  const fill = edgeFill(edgeMask);
  if (!fill) return CAPTURE_COLOR_FILTERS;
  return `${CAPTURE_COLOR_FILTERS},fillborders=left=${fill}:right=${fill}:top=${fill}:bottom=${fill}:mode=smear`;
}

// 진행은 사람이 읽는 -stats 대신 -progress로 받는다. 같은 값(frame·dup·drop)을
// 줄 단위 key=value로 주므로 녹화 중 누락을 바로 알릴 수 있다.
export function recordArgs({ input, profile, withAudio, output, edgeMask = 0 }) {
  return [
    "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1", "-n",
    ...input,
    "-r", String(profile.fps), "-vf", recordFilters(edgeMask), ...captureCodecArgs(profile),
    ...(withAudio ? AUDIO_ARGS : ["-an"]),
    // 확장자가 .part라 컨테이너를 스스로 못 고른다.
    "-f", "mp4", "-movflags", "+faststart", output,
  ];
}

// 영상은 다시 인코딩하지 않는다. 길이는 녹화된 영상에서 읽은 값으로 정확히 맞춘다.
export function silentTrackArgs({ input, durationSeconds, output }) {
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-n",
    "-i", input, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", ...AUDIO_ARGS,
    "-t", durationSeconds.toFixed(3), "-f", "mp4", "-movflags", "+faststart", output,
  ];
}

// -progress는 key=value 줄을 모아 progress=continue|end로 한 묶음을 끝낸다. 파이프는
// 줄 중간에서도 끊겨 오므로 줄을 이어 붙여 읽는다.
export function createProgressReader(onBlock) {
  let pending = "";
  let block = {};
  return chunk => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) {
      const at = line.indexOf("=");
      if (at < 0) continue;
      const key = line.slice(0, at).trim();
      const value = line.slice(at + 1).trim();
      block[key] = value;
      if (key !== "progress") continue;
      onBlock({ frames: Number(block.frame) || 0, dup: Number(block.dup_frames) || 0,
        drop: Number(block.drop_frames) || 0, end: value === "end" });
      block = {};
    }
  };
}

export function recordingChecks(probe, profile, videoMs) {
  const audio = probe.streams?.find(stream => stream.codec_type === "audio");
  let specError = null;
  try { validateCaptureStream(probe, profile, captureFrameCount(videoMs, profile.fps)); }
  catch (error) { specError = error.message; }
  const audioMs = Math.round(Number(audio?.duration) * 1000);
  // 트랙 길이는 마지막 패킷 시각이라 중간에 빠진 소리를 드러내지 않는다. 실제로 담긴
  // 소리는 AAC 프레임 수로 센다. ffmpeg avfoundation은 마이크 버퍼를 한 칸만 두어
  // 이 Mac에서 소리의 13%쯤을 놓쳤다(실측: 10.6초 녹화에 9.19초). 끊긴 트랙에
  // 내레이션을 넣으면 샘플로 섞는 쪽과 시각으로 지우는 쪽이 어긋나 싱크가 밀린다.
  const codedMs = Math.round(Number(audio?.nb_frames) * AAC_FRAME_SAMPLES / Number(audio?.sample_rate) * 1000);
  return [
    { label: `영상 규격 · ${profile.width}×${profile.height} ${profile.fps}fps`, ok: !specError,
      ...(specError ? { detail: specError } : {}) },
    { label: "음성 트랙 · AAC 48kHz 모노", ok: audio?.codec_name === "aac"
      && Number(audio.sample_rate) === 48000 && Number(audio.channels) === 1 },
    { label: "음성 길이 = 영상 길이", ok: Number.isFinite(audioMs) && Math.abs(audioMs - videoMs) <= AUDIO_TOLERANCE_MS,
      detail: `영상 ${videoMs}ms · 음성 ${Number.isFinite(audioMs) ? `${audioMs}ms` : "없음"}` },
    { label: "음성 끊김 없음", ok: Number.isFinite(codedMs) && Math.abs(codedMs - videoMs) <= AUDIO_TOLERANCE_MS,
      detail: `담긴 소리 ${Number.isFinite(codedMs) ? `${codedMs}ms` : "없음"} · 영상 ${videoMs}ms` },
  ];
}

// 완료로 두되 숨기지 않는다. 일부 프레임이 비었다는 사실은 결과와 함께 남는다.
export function recordingWarnings({ dup = 0, drop = 0, stoppedByUser = true } = {}) {
  const warnings = [];
  if (dup || drop) warnings.push(`프레임 복제 ${dup} · 누락 ${drop}. 인코딩이 화면 변화를 따라가지 못한 구간이 있을 수 있습니다.`);
  if (!stoppedByUser) warnings.push("정지하기 전에 녹화가 끝났습니다. 화면 연결이 바뀌었는지 확인해 주세요.");
  return warnings;
}

// 녹화 직전에 목록을 다시 읽는다. 사람은 이름으로 골랐고 번호는 그사이 바뀔 수 있다.
export async function prepareDisplay({ ffmpeg, display, audioDevice = null }) {
  const devices = await listCaptureDevices(ffmpeg);
  const screenIndex = resolveDevice(screenDevices(devices), display, "화면");
  const audioIndex = audioDevice ? resolveDevice(devices.audio, audioDevice, "입력 장치") : null;
  const { width, height } = await probeDisplay(ffmpeg, screenIndex);
  const profile = displayProfile({ width, height });
  return {
    input: avfoundationInput({ screenIndex, audioIndex, fps: profile.fps }),
    profile, withAudio: audioIndex !== null,
    display: { name: display, width, height }, audioDevice: audioDevice || null,
  };
}

/**
 * 녹화를 시작하고 곧바로 조종 손잡이를 돌려준다.
 *
 * stop()은 정상 정지다. ffmpeg에 q를 보내 파일을 마무리하게 한다. SIGINT로도 파일은
 * 남지만 종료 코드가 255라 실패와 구별할 수 없다. cancel()은 취소다. 이번 녹화가
 * 만든 파일을 모두 지운다. done은 검증 보고서로 끝나고, 검증에 실패하면 영상과
 * 보고서를 남긴 채 거절한다 — 다시 찍기 어려운 녹화를 검사 하나로 지우지 않는다.
 */
export function startDisplayRecording({
  ffmpeg, ffprobe, display, audioDevice = null, outDir, name,
  maxDurationMs = null, edgeMask = 0, onEvent = () => {},
  // 녹화할 입력을 정한다. 테스트는 화면 대신 합성 영상을 넣는다.
  prepare = () => prepareDisplay({ ffmpeg, display, audioDevice }),
}) {
  const id = crypto.randomUUID();
  const finalFile = path.join(outDir, `${name}.mp4`);
  const videoPart = path.join(outDir, `${name}.${id}.video.part`);
  const muxPart = path.join(outDir, `${name}.${id}.part`);
  const children = new Set();
  let recorder = null;
  let stopTimer = null;
  let stopRequested = false;
  let cancelled = false;
  let finished = false;

  function stop() {
    if (cancelled || finished) return false;
    stopRequested = true;
    if (recorder?.stdin.writable) recorder.stdin.write("q");
    return true;
  }

  function cancel() {
    if (cancelled || finished) return false;
    cancelled = true;
    clearTimeout(stopTimer);
    for (const child of children) child.kill("SIGTERM");
    return true;
  }

  function run(executable, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
      children.add(child);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-16_384); });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        children.delete(child);
        if (cancelled) return reject(new Error(CANCELLED));
        if (code === 0) return resolve(stdout);
        reject(new Error(`${path.basename(executable)} 실행 실패 (종료 ${signal || code})\n${ffmpegErrorText(stderr)}`));
      });
    });
  }

  const probe = async file => JSON.parse(await run(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]));

  function record(source) {
    return new Promise((resolve, reject) => {
      // stdin은 정지 신호(q)를 보내는 길이다. 터미널 stdin을 물려받으면 SIGTTIN으로 멈춘다.
      const child = spawn(ffmpeg, recordArgs({ ...source, edgeMask, output: videoPart }), { stdio: ["pipe", "pipe", "pipe"] });
      recorder = child;
      children.add(child);
      let stderr = "";
      let last = null;
      let reported = "0/0";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", createProgressReader(block => {
        if (!last) {
          onEvent({ phase: "recording" });
          if (maxDurationMs) stopTimer = setTimeout(stop, maxDurationMs);
        }
        last = block;
        const signature = `${block.dup}/${block.drop}`;
        if (signature === reported) return;
        reported = signature;
        onEvent({ phase: "progress", frames: block.frames, dup: block.dup, drop: block.drop });
      }));
      child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-16_384); });
      // ffmpeg가 먼저 죽으면 q 쓰기가 EPIPE로 돌아온다. 원인은 종료 코드가 말한다.
      child.stdin.on("error", () => {});
      child.once("error", reject);
      child.once("close", (code, signal) => {
        children.delete(child);
        recorder = null;
        clearTimeout(stopTimer);
        if (cancelled) return reject(new Error(CANCELLED));
        if (code !== 0) {
          return reject(new Error(`화면 녹화가 실패했습니다. (종료 ${signal || code})\n${ffmpegErrorText(stderr)}`));
        }
        resolve({ written: last?.frames ?? 0, dup: last?.dup ?? 0, drop: last?.drop ?? 0, stoppedByUser: stopRequested });
      });
      if (stopRequested) child.stdin.write("q");
    });
  }

  const done = (async () => {
    try {
      const source = await prepare();
      if (cancelled) throw new Error(CANCELLED);
      if (fs.existsSync(finalFile)) throw new Error(`같은 이름의 녹화가 이미 있습니다: ${finalFile}`);
      fs.mkdirSync(outDir, { recursive: true });
      const frames = await record(source);

      onEvent({ phase: "finishing" });
      const videoStream = (await probe(videoPart)).streams?.find(stream => stream.codec_type === "video");
      const videoSeconds = Number(videoStream?.duration);
      if (!(videoSeconds > 0)) throw new Error("녹화된 영상 프레임이 없습니다.");
      const videoMs = Math.round(videoSeconds * 1000);
      let workFile = videoPart;
      if (!source.withAudio) {
        await run(ffmpeg, silentTrackArgs({ input: videoPart, durationSeconds: videoSeconds, output: muxPart }));
        workFile = muxPart;
      }
      const result = await probe(workFile);
      const checks = recordingChecks(result, source.profile, videoMs);
      const warnings = recordingWarnings(frames);
      const digest = await fileSha256(workFile);
      if (cancelled) throw new Error(CANCELLED);

      // 여기부터 끝까지 동기다. 취소 신호가 옮긴 파일과 보고서 사이에 끼어들 수 없다.
      fs.renameSync(workFile, finalFile);
      const video = result.streams.find(stream => stream.codec_type === "video");
      const audio = result.streams.find(stream => stream.codec_type === "audio") || null;
      // 가장자리를 채웠으면 그 폭을 남긴다. 그 픽셀은 화면 그대로가 아니다.
      const sourceInfo = { display: source.display, audio: source.withAudio ? "device" : "silent", audioDevice: source.audioDevice,
        ...(edgeMask ? { edgeFill: edgeFill(edgeMask) } : {}) };
      const generatedAt = new Date().toISOString();
      writeCaptureReport(`${finalFile}.capture.json`, {
        schemaVersion: 1, profile: source.profile, source: sourceInfo, encoder: "libx264", preset: "slow",
        frames, durationMs: videoMs, video, audio, file: finalFile, fileSha256: digest, warnings, generatedAt,
      });
      // 편집 결과와 같은 모양이라 최근 결과·이름 바꾸기·편집 담기가 그대로 된다.
      const report = {
        schemaVersion: 1, generatedAt, name: path.basename(outDir), operation: "record-display", displayName: name,
        inputs: [], videoPath: finalFile, durationMs: videoMs, video, source: sourceInfo, frames, warnings,
        checks, summary: summarizeChecks(checks),
        target: { root: "edit", day: path.basename(path.dirname(outDir)), name: path.basename(outDir) },
      };
      writeCaptureReport(path.join(outDir, "validation-report.json"), report);
      finished = true;
      if (!report.summary.ok) {
        const failed = checks.filter(check => !check.ok).map(check => check.detail ? `${check.label} (${check.detail})` : check.label);
        throw new Error(`녹화 파일 검증 실패: ${failed.join(", ")}`);
      }
      return report;
    } finally {
      clearTimeout(stopTimer);
      for (const file of [videoPart, muxPart]) fs.rmSync(file, { force: true });
    }
  })();

  return { stop, cancel, done };
}
