// 강의 덱 화면을 찍어 음성과 함께 MP4로 굳힌다. 페이지 시계를 멈추고 한 칸(1/fps초)씩
// 넘겨 찍으므로 출력 프레임 k는 정확히 페이지 시각 k/fps초다. 실시간보다 느리게 찍힌다.
// 화면 조작 계약은 deck-page.mjs, 페이지 시계는 page-clock.mjs, 인코더 입력은 recorder.mjs,
// 규격은 encoding.mjs가 소유한다. 이 파일은 그것들을 타임라인 위에 얹는 조립부다.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { captureFrameCount, captureVideoFileName, videoQuality } from "../../shared/video-quality.mjs";
import { fileSha256 } from "../files.mjs";
import { captureMuxArgs, validateCaptureStream, writeCaptureReport } from "./encoding.mjs";
import { holdPageClock, installPageClock } from "./page-clock.mjs";
import { startFrameEncoder } from "./recorder.mjs";
import { createCaptureResourceSampler } from "./resource-metrics.mjs";
import { startCaptureServer, waitForServer } from "./site.mjs";
import { advanceToEntry, auditCapturePage, gotoFirstEntry, prepareDeckPage, replayFirstEntry, startCaptions } from "./deck-page.mjs";

const execFileAsync = promisify(execFile);
// 장면을 올리는 동안(모듈 받기·WebGL 준비) 페이지 시간을 멈춘 채 기다리는 실제 시간의 상한.
// 넘기면 페이지 시간을 넘기며(칸을 찍으며) 기다린다. 그때는 불러오는 화면이 영상에 남는다.
const SETTLE_BUDGET_MS = 5000;
const SETTLE_POLL_MS = 15;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(file, args) {
  try {
    return await execFileAsync(file, args, { maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    const stderr = error?.stderr?.toString().trim();
    throw new Error(`${file} 실행 실패${stderr ? `\n${stderr}` : ""}`);
  }
}

async function durationMs(file) {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration:stream=duration", "-of", "json", file,
  ]);
  const data = JSON.parse(stdout);
  const seconds = Number(data.format?.duration ?? data.streams?.[0]?.duration);
  if (!Number.isFinite(seconds)) throw new Error(`${file} 길이를 읽지 못했습니다.`);
  return Math.round(seconds * 1000);
}

export async function captureVideo({
  timeline,
  captions = [],
  outDir,
  siteDir = null,
  url = null,
  headful = false,
  burnCaptions = false,
  maxDurationMs = null,
  noCache = false,
  quality = "standard",
  audioFile = null,
  settleBudgetMs = SETTLE_BUDGET_MS,
}) {
  const profile = videoQuality(quality);
  if (!siteDir && !url) throw new Error("촬영할 화면이 없습니다. --site-dir 또는 --url이 필요합니다.");
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error("화면 촬영에는 playwright가 필요합니다. 저장소에서 npm install을 먼저 실행하세요.");
  }

  const captureDurationMs = maxDurationMs
    ? Math.min(timeline.totalMs, maxDurationMs)
    : timeline.totalMs;

  // 영상과 오디오를 한 번에 인코딩하므로 트랙을 촬영 전에 확인한다.
  // 길이가 어긋난 채로 수십 분을 촬영하고 나서야 실패하는 일이 없어진다.
  const importedM4a = path.join(outDir, "audio/track.m4a");
  const trackFile = audioFile || (timeline.provider?.provider === "qwen3-local" && fs.existsSync(importedM4a)
    ? importedM4a
    : path.join(outDir, "audio/track.wav"));
  const trackDurationMs = await durationMs(trackFile);
  if (trackDurationMs + 100 < captureDurationMs) {
    throw new Error(`오디오가 촬영 범위보다 짧습니다: audio=${trackDurationMs}ms, capture=${captureDurationMs}ms`);
  }
  if (maxDurationMs === null && Math.abs(trackDurationMs - timeline.totalMs) > 100) {
    throw new Error(
      `오디오와 타임라인 길이가 다릅니다: audio=${trackDurationMs}ms, timeline=${timeline.totalMs}ms. ` +
      "로컬 TTS export를 다시 실행하세요.",
    );
  }
  const totalFrames = captureFrameCount(captureDurationMs, profile.fps);

  let server = null;
  let requestedUrl = url;
  if (!requestedUrl) {
    const started = await startCaptureServer(siteDir);
    server = started.server;
    requestedUrl = `http://127.0.0.1:${started.port}/#course`;
  }
  const captureUrl = new URL(requestedUrl);
  if (noCache) captureUrl.searchParams.set("ttsStudioFresh", String(Date.now()));
  const baseUrl = captureUrl.toString();
  try {
    await waitForServer(baseUrl.split("#")[0]);
  } catch (error) {
    if (server) server.close();
    throw error;
  }

  const durationSuffix = captureDurationMs < timeline.totalMs
    ? `-${Math.round(captureDurationMs / 1000)}s`
    : "";
  const finalFile = path.join(
    outDir,
    captureVideoFileName(timeline.preset.name, { videoQuality: quality, burnCaptions, durationSuffix }),
  );
  fs.mkdirSync(path.dirname(finalFile), { recursive: true });

  // 인코딩이 촬영과 동시에 돌기 때문에 도중에 실패하면 잘린 mp4가 남는다.
  // 그대로 두면 완성본으로 보이므로 임시 파일에 쓰고 다 끝나야 옮긴다.
  // 실패해도 지난 성공본이 살아남는 이점도 있다.
  const workFile = `${finalFile}.${crypto.randomUUID()}.part`;
  const ffmpegArgs = captureMuxArgs({ profile, totalFrames, audioFile: trackFile, output: workFile });

  let browser = null;
  let context = null;
  let recorder = null;
  let resourceSampler = null;
  let resourceUsage = null;
  let captureCompleted = false;
  const sourceResolutionLimits = [];
  try {
    browser = await chromium.launch({
      headless: !headful,
      args: ["--enable-gpu", "--use-gl=angle", "--use-angle=metal", ...(noCache ? ["--disable-http-cache"] : [])],
    });
    resourceSampler = createCaptureResourceSampler();
    // Playwright Browser does not expose a stable process() API. The sampler
    // can still report worker and system pressure; the diagnostic runner also
    // records the complete child process tree through libproc on macOS.
    resourceSampler.start();
    context = await browser.newContext({
      viewport: { width: profile.width, height: profile.height },
      // 실제 뷰포트를 키워 텍스트·벡터를 해당 해상도로 렌더링한다.
      // DPR만 높이고 1080p 프레임을 확대하는 경로를 쓰지 않는다.
      deviceScaleFactor: 1,
    });

    const page = await context.newPage();
    page.on("crash", () => recorder?.fail(new Error("촬영 페이지가 중단됐습니다.")));
    page.on("close", () => recorder?.fail(new Error("촬영 페이지가 닫혔습니다.")));
    const session = await context.newCDPSession(page);
    try {
      await session.send("Performance.enable");
      resourceSampler.setPageJsHeapReader(async () => {
        const metrics = await session.send("Performance.getMetrics");
        return metrics.metrics?.find(metric => metric.name === "JSHeapUsedSize")?.value ?? null;
      });
    } catch (error) {
      // CDP heap is optional diagnostics; a failed probe cannot invalidate video.
      resourceSampler.setPageHeapError(error);
    }
    if (noCache) {
      await page.setExtraHTTPHeaders({ "Cache-Control": "no-cache", Pragma: "no-cache" });
      await session.send("Network.enable");
      await session.send("Network.setCacheDisabled", { cacheDisabled: true });
    }
    await installPageClock(page);
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    let captureStarted = false;
    let unexpectedNavigation = null;
    page.on("framenavigated", (frame) => {
      if (captureStarted && frame === page.mainFrame()) {
        unexpectedNavigation = frame.url();
        recorder?.fail(new Error("촬영 중 강의 화면이 새로고침되었습니다."));
      }
    });
    const refreshed = () => {
      if (!unexpectedNavigation) return;
      throw new Error(
        `캡처 중 강의 화면이 새로고침되었습니다: ${unexpectedNavigation}. 전용 캡처 서버에서 다시 실행하세요.`,
      );
    };

    await prepareDeckPage(page, profile, {
      burnCaptions,
      onCaptureFailure: error => recorder?.fail(error),
    });

    const first = timeline.entries[0];
    await gotoFirstEntry(page, first);
    sourceResolutionLimits.push({ slideId: first.slideId, step: first.step, assets: await auditCapturePage(page, profile) });

    // 여기서부터 페이지 시간은 우리가 넘길 때만 흐른다. 0ms가 영상의 0프레임이다.
    const frameMs = 1000 / profile.fps;
    recorder = startFrameEncoder({ ffmpegArgs, totalFrames, fps: profile.fps });
    resourceSampler.setEncoderPid(recorder.encoderPid);
    await resourceSampler.sample().catch(() => {});
    const clock = await holdPageClock(page, session, profile);
    const captureStart = performance.now();
    resourceSampler.setPhase("recording");
    captureStarted = true;

    let shot = 0;
    let pageTimeMaxErrorMs = 0;
    // 칸 하나: 페이지 시계를 k/fps초로 넘기고, 그 시각으로 그린 화면을 찍는다.
    const shootNext = async () => {
      recorder.throwIfFailed();
      const at = shot * frameMs;
      await clock.advanceTo(at);
      const drawn = await clock.frame();
      pageTimeMaxErrorMs = Math.max(pageTimeMaxErrorMs, Math.abs(drawn.at - at));
      await recorder.write(await clock.shoot());
      shot++;
    };
    // 장면이 오르기를 기다리는 동안의 걸음. 먼저 페이지 시간을 멈춘 채 다시 그려 보고,
    // 실제 시간 상한을 넘기면 칸을 찍으며(페이지 시간을 넘기며) 기다린다.
    const settles = [];
    const pacer = (label) => {
      const record = { label, atMs: Math.round(clock.elapsedMs), settleRealMs: 0, pageMs: 0 };
      settles.push(record);
      const started = performance.now();
      let pageFrom = null;
      return {
        elapsedMs: () => (pageFrom === null ? 0 : clock.elapsedMs - pageFrom),
        async step() {
          recorder.throwIfFailed();
          if (pageFrom === null && performance.now() - started < settleBudgetMs) {
            await clock.frame();
            await sleep(SETTLE_POLL_MS);
            record.settleRealMs = Math.round(performance.now() - started);
            return;
          }
          pageFrom ??= clock.elapsedMs;
          if (shot < totalFrames) await shootNext();
          else { await clock.advanceTo(clock.elapsedMs + frameMs); await clock.frame(); }
          record.pageMs = Math.round(clock.elapsedMs - pageFrom);
        },
      };
    };

    if (burnCaptions) await startCaptions(page, captions);
    const firstPacer = pacer(first.key);
    const firstReplayRenderMs = await replayFirstEntry(page, first, { pacer: firstPacer });
    const firstSceneReadyAtMs = Math.round(firstPacer.elapsedMs());
    if (Number.isFinite(first.speechStartMs) && firstSceneReadyAtMs > first.speechStartMs) {
      throw new Error(
        `첫 화면이 발화 시작 뒤에 준비됐습니다: 화면 ${firstSceneReadyAtMs}ms, 발화 ${first.speechStartMs}ms. ` +
        "늦은 장면이 포함된 영상을 완료로 남기지 않습니다.",
      );
    }

    const lateTransitions = [];
    for (let i = 0; i < timeline.entries.length; i++) {
      const entry = timeline.entries[i];
      const transitionAtMs = Math.min(entry.transitionAtMs ?? entry.endMs, captureDurationMs);
      // 전환 시각과 같거나 앞선 칸은 이전 화면이다. 키는 정확히 전환 시각에 누른다.
      while (shot < totalFrames && shot * frameMs <= transitionAtMs) await shootNext();
      refreshed();
      const next = timeline.entries[i + 1];
      if (!next || entry.endMs >= captureDurationMs) break;
      if (clock.elapsedMs > transitionAtMs) {
        lateTransitions.push({ key: next.key, lateMs: Math.round(clock.elapsedMs - transitionAtMs) });
      } else {
        await clock.advanceTo(transitionAtMs);
      }
      const nextPacer = pacer(next.key);
      await advanceToEntry(page, entry, next, { pacer: nextPacer });
      sourceResolutionLimits.push({ slideId: next.slideId, step: next.step,
        assets: await auditCapturePage(page, profile, { pacer: nextPacer }) });
    }

    while (shot < totalFrames) await shootNext();
    refreshed();
    const recorded = await recorder.finish();
    const frames = {
      ...recorded,
      clock: {
        mode: "stepped", frameMs, pageTimeMaxErrorMs: +pageTimeMaxErrorMs.toFixed(3),
        captureRealMs: Math.round(performance.now() - captureStart),
        settles: settles.filter(item => item.settleRealMs || item.pageMs),
        lateTransitions,
      },
    };
    recorder = null;
    resourceSampler.setEncoderPid(null);
    resourceSampler.setPhase("finalizing");
    resourceUsage = await resourceSampler.stop().catch(error => ({
      status: "unavailable", error: String(error?.message || error),
    }));
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", workFile]);
    const probe = JSON.parse(stdout);
    const stream = validateCaptureStream(probe, profile, totalFrames);
    const finalDurationMs = Math.round(Number(probe.format?.duration || 0) * 1000);
    if (Math.abs(finalDurationMs - captureDurationMs) > 150) {
      throw new Error(`완성 영상 길이가 타임라인과 다릅니다: video=${finalDurationMs}ms, expected=${captureDurationMs}ms`);
    }
    const digest = await fileSha256(workFile);
    fs.renameSync(workFile, finalFile);
    const captureReport = {
      schemaVersion: 1, profile, frameFormat: "png", encoder: "libx264", preset: "slow",
      frames, durationMs: finalDurationMs, video: stream, file: finalFile, fileSha256: digest,
      firstReplayRenderMs, firstSceneReadyAtMs,
      sourceResolutionLimits: sourceResolutionLimits.filter(state => state.assets.length),
      resourceUsage,
      sourceContract: timeline.sourceContract || null, generatedAt: new Date().toISOString(),
    };
    writeCaptureReport(`${finalFile}.capture.json`, captureReport);
    writeCaptureReport(path.join(outDir, "capture-report.json"), captureReport);
    captureCompleted = true;
    console.log(
      `[capture] ${frames.written}프레임을 ${(frames.clock.frameMs).toFixed(0)}ms 간격으로 기록` +
      ` (페이지 시각 오차 최대 ${frames.clock.pageTimeMaxErrorMs}ms, 촬영 ${(frames.clock.captureRealMs / 1000).toFixed(1)}초)` +
      (frames.clock.lateTransitions.length ? `, 늦은 전환 ${frames.clock.lateTransitions.length}곳` : "") +
      `, 인코더 적체 최대 ${Math.round(frames.peakBacklog / 1024)}KB`,
    );
    await context.close();
    context = null;
  } finally {
    if (resourceSampler && !captureCompleted) {
      if (!resourceUsage) resourceUsage = await resourceSampler.stop().catch(() => null);
      if (resourceUsage) {
        try {
          writeCaptureReport(path.join(outDir, "capture-resource.json"), {
            status: "incomplete", resourceUsage, generatedAt: new Date().toISOString(),
          });
        } catch { /* Diagnostic file failure must not replace the capture error. */ }
      }
    }
    if (recorder) await recorder.abort().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (server) await new Promise((resolve) => server.close(resolve));
    if (!captureCompleted) fs.rmSync(workFile, { force: true });
  }

  return finalFile;
}
