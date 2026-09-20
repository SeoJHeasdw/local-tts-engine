import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startScreencastEncoder } from "../../electron-app/main/capture/recorder.mjs";

const execFileAsync = promisify(execFile);
const FPS = 25;

async function probe(file, entries) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-count_frames", "-show_entries", entries,
    "-of", "json", file,
  ]);
  return JSON.parse(stdout).streams[0];
}

// 촬영은 한 번에 수십 분을 돌기 때문에 잘못되면 대가가 크다. 실제 브라우저와
// ffmpeg를 그대로 써서 스크린캐스트 배관이 살아있는지 짧게 확인한다.
test("스크린캐스트 인코더는 요청한 프레임 수를 정확히 1080p로 남긴다", async (t) => {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    t.skip("playwright가 설치되지 않았습니다.");
    return;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-encoder-"));
  const outFile = path.join(workDir, "out.mp4");
  const totalFrames = 30;

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    // 계속 움직이는 화면이라야 스크린캐스트가 새 프레임을 계속 밀어낸다.
    await page.setContent(`
      <style>
        body { margin: 0; background: #101018; }
        .box { width: 40vw; height: 40vh; margin: 30vh auto; background: #4f7cff;
               animation: spin 900ms linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
      </style>
      <div class="box"></div>
    `);
    const session = await context.newCDPSession(page);

    const recorder = startScreencastEncoder({
      session,
      ffmpegArgs: [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "image2pipe", "-vcodec", "png", "-framerate", String(FPS), "-i", "pipe:0",
        "-vf", "scale=in_range=full:out_range=limited,format=yuv420p",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        outFile,
      ],
    });

    await recorder.ready();
    recorder.begin(Date.now(), totalFrames);
    // 상한을 넘겨 쓰지 않는지 보려고 필요한 시간보다 넉넉히 기다린다.
    await new Promise((resolve) => setTimeout(resolve, (totalFrames / FPS) * 1000 + 400));
    const frames = await recorder.finish();

    assert.equal(frames.written, totalFrames, "요청한 프레임 수와 기록한 수가 같아야 한다");
    assert.ok(frames.duplicated < totalFrames, "모든 프레임이 복제본이면 스크린캐스트가 죽은 것이다");

    const stream = await probe(outFile, "stream=width,height,nb_read_frames");
    assert.equal(stream.width, 1920);
    assert.equal(stream.height, 1080);
    assert.equal(Number(stream.nb_read_frames), totalFrames);
  } finally {
    await browser.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

// 영상 시간축이 벽시계와 어긋나면 대본과 화면이 밀린다. 촬영 중 정해진
// 순간에 화면을 하얗게 번쩍이고, 완성 영상에서 그 프레임이 기대한 자리에
// 있는지 확인한다. 예전 마젠타 마커가 지키던 성질을 그대로 검증한다.
test("영상의 프레임 번호는 촬영 벽시계와 일치한다", async (t) => {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    t.skip("playwright가 설치되지 않았습니다.");
    return;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-sync-"));
  const outFile = path.join(workDir, "sync.mp4");
  const seconds = 4;
  const flashAtMs = 2000;
  const totalFrames = seconds * FPS;

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await page.setContent(`
      <style>
        body { margin: 0; background: #0b0d14; }
        .m { width: 30vw; height: 30vh; margin: 35vh auto; background: #1b2a4a;
             animation: pulse 700ms linear infinite; }
        @keyframes pulse { 50% { opacity: .35; } }
      </style>
      <div class="m"></div>
    `);
    const session = await context.newCDPSession(page);

    const recorder = startScreencastEncoder({
      session,
      ffmpegArgs: [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "image2pipe", "-vcodec", "png", "-framerate", String(FPS), "-i", "pipe:0",
        "-vf", "scale=in_range=full:out_range=limited,format=yuv420p",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20",
        outFile,
      ],
    });

    await recorder.ready();
    const captureStart = Date.now();
    recorder.begin(captureStart, totalFrames);

    const wait = captureStart + flashAtMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    await page.evaluate(() => {
      const flash = document.createElement("div");
      flash.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#fff";
      document.body.appendChild(flash);
      setTimeout(() => flash.remove(), 80);
    });

    const left = captureStart + seconds * 1000 - Date.now();
    if (left > 0) await new Promise((r) => setTimeout(r, left));
    await recorder.finish();

    const { stdout } = await execFileAsync("ffmpeg", ["-v", "error", "-i", outFile,
      "-vf", "signalstats,metadata=print:file=-", "-f", "null", "-"]);
    let index = -1;
    const white = [];
    for (const line of stdout.split("\n")) {
      if (line.includes("pts_time")) index++;
      const avg = line.match(/YAVG=([0-9.]+)/);
      if (avg && Number(avg[1]) > 180) white.push(index);
    }

    assert.ok(white.length > 0, "번쩍인 프레임을 찾지 못했다");
    const expected = (flashAtMs / 1000) * FPS;
    const drift = white[0] - expected;
    assert.ok(Math.abs(drift) <= 2, `번쩍임이 ${drift}프레임 어긋났다 (기대 ${expected}, 실제 ${white[0]})`);
  } finally {
    await browser.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

// 앱 데모는 끝나는 시각을 찍고 나서야 안다. begin에는 넉넉한 상한을 주고 finish에
// 실제 끝 시각을 준다. 상한까지 마지막 화면을 채우면 아무 일도 없는 꼬리가 붙는다.
test("finish({ endAt })는 상한이 아니라 준 시각에서 끝낸다", async (t) => {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    t.skip("playwright가 설치되지 않았습니다.");
    return;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-endat-"));
  const outFile = path.join(workDir, "end.mp4");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.setContent(`
      <style>
        body { margin: 0; background: #101018; }
        .b { width: 30vw; height: 30vh; margin: 35vh auto; background: #4f7cff;
             animation: spin 800ms linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
      </style>
      <div class="b"></div>
    `);
    const session = await context.newCDPSession(page);
    const recorder = startScreencastEncoder({
      session, width: 640, height: 360, fps: FPS,
      ffmpegArgs: [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "image2pipe", "-vcodec", "png", "-framerate", String(FPS), "-i", "pipe:0",
        "-vf", "scale=in_range=full:out_range=limited,format=yuv420p",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", outFile,
      ],
    });
    await recorder.ready();
    // 첫 프레임의 브라우저 시각이 시스템 시계보다 몇 ms 앞설 수 있다. 시작 시각을
    // 그 프레임보다 확실히 뒤에 두고 시작한다.
    await new Promise(resolve => setTimeout(resolve, 150));
    const startedAt = Date.now();
    recorder.begin(startedAt, 60 * FPS);
    await recorder.wait(2000);
    const endAt = Date.now();
    const frames = await recorder.finish({ endAt });

    const expected = Math.ceil((endAt - startedAt) * FPS / 1000);
    assert.equal(frames.written, expected, `${frames.written}프레임 (기대 ${expected})`);
    assert.ok(frames.written < 60 * FPS, "상한까지 채우지 않는다");
    const stream = await probe(outFile, "stream=nb_read_frames");
    assert.equal(Number(stream.nb_read_frames), expected);
  } finally {
    await browser.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("finish({ endAt })는 시작보다 앞선 시각을 받지 않는다", async (t) => {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    t.skip("playwright가 설치되지 않았습니다.");
    return;
  }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-endat-bad-"));
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 320, height: 180 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.setContent('<style>body{margin:0;background:#222}div{width:50vw;height:50vh;background:#7af;animation:s .5s linear infinite}@keyframes s{to{opacity:.2}}</style><div></div>');
    const session = await context.newCDPSession(page);
    const recorder = startScreencastEncoder({
      session, width: 320, height: 180, fps: FPS,
      ffmpegArgs: ["-y", "-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-vcodec", "png",
        "-framerate", String(FPS), "-i", "pipe:0", "-f", "null", "-"],
    });
    await recorder.ready();
    await new Promise(resolve => setTimeout(resolve, 150));
    const startedAt = Date.now();
    recorder.begin(startedAt, 10 * FPS);
    await recorder.wait(300);
    await assert.rejects(recorder.finish({ endAt: startedAt - 1 }), /종료 시각이 시작보다 뒤여야/);
    await recorder.abort();
  } finally {
    await browser.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
