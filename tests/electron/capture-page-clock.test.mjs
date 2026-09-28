import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { holdPageClock, installPageClock } from "../../electron-app/main/capture/page-clock.mjs";

const exec = promisify(execFile);
const W = 400, H = 200;
// 모든 움직임이 4초에 400px(= 칸마다 4px)이다. 줄마다 다른 시계로 움직인다.
const html = `<!doctype html><style>
  body{margin:0;background:#000;width:${W}px;height:${H}px;overflow:hidden}
  .b{position:absolute;left:0;width:8px;height:20px}
  #css{top:0;background:#f00;animation:mv 4s linear infinite}
  #waapi{top:30px;background:#0f0}
  #tr{top:60px;background:#00f;transition:transform 4s linear}
  #tr.go{transform:translateX(400px)}
  canvas{position:absolute;top:90px;left:0}
  @keyframes mv{to{transform:translateX(400px)}}
</style>
<div id=css class=b></div><div id=waapi class=b></div><div id=tr class=b></div><canvas width=${W} height=20></canvas>
<svg width=${W} height=20 style="position:absolute;top:120px;left:0"><rect width=8 height=20 fill="#f0f"><animate attributeName="x" from="0" to="400" dur="4s" repeatCount="indefinite"/></rect></svg>
<script>
  document.getElementById("waapi").animate([{transform:"translateX(0)"},{transform:"translateX(400px)"}],{duration:4000,iterations:Infinity});
  const ctx = document.querySelector("canvas").getContext("2d");
  window.log = { raf: [], timeout: [], interval: [], finish: null };
  const loop = (ts) => {
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, ${W}, 20);
    ctx.fillStyle = "#ff0"; ctx.fillRect((ts % 4000) / 10, 0, 8, 20);
    log.raf.push([ts, performance.now()]);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.arm = () => {
    const t0 = performance.now();
    log.t0 = t0; log.date0 = Date.now();
    setTimeout(() => { log.timeout.push(performance.now() - t0); document.getElementById("tr").classList.add("go"); }, 100);
    const id = setInterval(() => { log.interval.push(performance.now() - t0); if (log.interval.length === 3) clearInterval(id); }, 30);
    const short = document.body.animate([{opacity:1},{opacity:1}], { duration: 100 });
    short.onfinish = () => { log.finish = performance.now() - t0; };
    const marker = document.body.animate([{opacity:1},{opacity:1}], { duration: 10000 });
    marker.startTime = document.timeline.currentTime;
    window.marker = marker;
  };
</script>`;

async function decode(png) {
  const child = execFile("ffmpeg", ["-v", "error", "-f", "png_pipe", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
  const done = new Promise((resolve, reject) => {
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg ${code}`))));
  });
  child.stdin.end(png);
  const raw = await done;
  // 줄마다 그 색이 처음 나오는 x
  const at = (y, [r, g, b]) => {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      if (Math.abs(raw[i] - r) < 60 && Math.abs(raw[i + 1] - g) < 60 && Math.abs(raw[i + 2] - b) < 60) return x;
    }
    return -1;
  };
  return { css: at(10, [255, 0, 0]), waapi: at(40, [0, 255, 0]), tr: at(70, [0, 0, 255]), raf: at(100, [255, 255, 0]),
    smil: at(130, [255, 0, 255]) };
}

test("멈춘 페이지 시계는 칸마다 모든 시계를 정확히 한 칸씩 넘긴다", { timeout: 60000 }, async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    if (/MachPortRendezvousServer[\s\S]*Permission denied/.test(error.message)) {
      t.skip("현재 macOS 작업 샌드박스가 Chromium 실행을 막습니다.");
      return;
    }
    throw error;
  }
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  await installPageClock(page);
  await page.route("http://127.0.0.1:48124/", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
  await page.goto("http://127.0.0.1:48124/");
  await page.waitForTimeout(300);

  const clock = await holdPageClock(page, session, { width: W, height: H });
  await page.evaluate(() => { window.arm(); window.log.raf.length = 0; });
  const shots = [];
  for (let k = 0; k < 12; k++) {
    await clock.advanceTo(k * 40);
    const drawn = await clock.frame();
    assert.equal(drawn.at, k * 40);
    shots.push(await decode(await clock.shoot()));
  }
  const log = await page.evaluate(() => ({ ...window.log, marker: window.marker.currentTime,
    date: Date.now() - window.log.date0, now: performance.now() - window.log.t0 }));

  // 칸마다 4px. 합성기에서 도는 transform 애니메이션도, 캔버스도 같은 시각을 그린다.
  for (const name of ["css", "waapi", "raf", "smil"]) {
    const steps = shots.slice(1).map((shot, i) => shot[name] - shots[i][name]);
    assert.ok(steps.every((step) => step === 4), `${name} 칸 이동: ${steps.join(" ")}`);
  }
  // 100ms 타이머가 붙인 전환은 그 순간부터 같은 속도로 간다(120ms 칸에서 0.2칸 → 160ms 칸부터 4px씩).
  const transition = shots.map((shot) => shot.tr);
  assert.deepEqual(transition.slice(0, 3), [0, 0, 0]);
  assert.ok(transition.slice(4).every((x, i, all) => i === 0 || x - all[i - 1] === 4), `전환: ${transition.join(" ")}`);

  const ts = log.raf.map(([stamp]) => stamp);
  assert.deepEqual(ts.slice(1).map((stamp, i) => stamp - ts[i]), Array(11).fill(40));
  assert.ok(log.raf.every(([stamp, now]) => stamp === now), "rAF 시각과 performance.now가 같아야 한다");
  assert.deepEqual(log.timeout, [100]);
  assert.deepEqual(log.interval, [30, 60, 90]);
  // 끝남 이벤트는 브라우저가 다음 화면 갱신에서 보낸다. 멈춘 시계에서는 끝난 시각과 그 다음 칸 사이다.
  assert.ok(log.finish >= 100 && log.finish <= 120, `onfinish ${log.finish}ms`);
  assert.equal(log.now, 440);
  assert.ok(Math.abs(log.date - 440) <= 1, `Date.now 경과 ${log.date}ms`);
  // 페이지가 문서 타임라인 시각으로 startTime을 맞춘 애니메이션은 0에서 시작한다.
  // 멈춘 타임라인 시각이 정수가 아니어서 소수 끝자리 오차가 남는다.
  assert.ok(Math.abs(log.marker - 440) < 1e-6, `marker ${log.marker}`);
});

test("페이지 시계는 설치 없이 멈추지 않는다", { timeout: 30000 }, async (t) => {
  let browser;
  try { browser = await chromium.launch({ headless: true }); } catch { t.skip("Chromium을 띄울 수 없습니다."); return; }
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  await page.setContent("<p>clock</p>");
  await assert.rejects(holdPageClock(page, session, { width: W, height: H }), /페이지 시계가 설치되지 않았습니다/);
});

// 영상은 멈춰 두고 칸마다 그 시각으로 옮긴다. 원본(30fps)의 흰 막대는 초당 300px로 간다.
test("멈춘 페이지 시계는 영상을 칸마다 그 시각으로 옮긴다", { timeout: 60000 }, async (t) => {
  let browser;
  try { browser = await chromium.launch({ headless: true }); } catch { t.skip("Chromium을 띄울 수 없습니다."); return; }
  t.after(() => browser.close());
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "page-clock-video-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "clip.mp4");
  await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x40:r=30:d=4",
    "-f", "lavfi", "-i", "color=c=white:s=6x40:r=30:d=4", "-filter_complex", "[0][1]overlay=x='n*10':y=0",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-movflags", "+faststart", file]);
  const clip = await fs.readFile(file);
  const context = await browser.newContext({ viewport: { width: 320, height: 40 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  await installPageClock(page);
  // 영상을 옮기려면 서버가 범위 요청을 받아야 한다(촬영 사이트 서버처럼).
  await page.route("http://127.0.0.1:48125/clip.mp4", (route) => {
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? "");
    if (!range) return route.fulfill({ status: 200, contentType: "video/mp4", headers: { "Accept-Ranges": "bytes" }, body: clip });
    const start = Number(range[1]), end = range[2] ? Number(range[2]) : clip.length - 1;
    return route.fulfill({ status: 206, contentType: "video/mp4", body: clip.subarray(start, end + 1),
      headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${clip.length}` } });
  });
  await page.route("http://127.0.0.1:48125/", (route) => route.fulfill({ status: 200, contentType: "text/html",
    body: "<style>body{margin:0;background:#000}video{display:block;width:320px;height:40px}</style><video src=clip.mp4 muted playsinline></video>" }));
  await page.goto("http://127.0.0.1:48125/");
  await page.evaluate(() => new Promise((resolve) => {
    const video = document.querySelector("video");
    if (video.readyState >= 2) resolve(); else video.addEventListener("loadeddata", resolve, { once: true });
  }));
  const clock = await holdPageClock(page, session, { width: 320, height: 40 });
  // 멈춘 뒤에 재생을 시작한다: 영상 0초가 페이지 시간 0ms다.
  await page.evaluate(() => document.querySelector("video").play());
  const seen = [];
  for (let k = 0; k < 10; k++) {
    await clock.advanceTo(k * 40);
    await clock.frame();
    const png = await clock.shoot();
    const child = execFile("ffmpeg", ["-v", "error", "-f", "png_pipe", "-i", "pipe:0", "-vf", "crop=320:2:0:20", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
      { encoding: "buffer" });
    const raw = await new Promise((resolve, reject) => {
      const chunks = [];
      child.stdout.on("data", (chunk) => chunks.push(chunk));
      child.once("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg ${code}`))));
      child.stdin.end(png);
    });
    const x = raw.subarray(0, 320).findIndex((value) => value > 128);
    seen.push({ x, time: await page.evaluate(() => document.querySelector("video").currentTime), paused: await page.evaluate(() => document.querySelector("video").paused) });
  }
  assert.deepEqual(seen.map(({ time }) => Math.round(time * 1000)), seen.map((_, k) => k * 40));
  assert.ok(seen.every(({ paused }) => paused === false), "페이지에는 재생 중으로 보여야 한다");
  // 칸 k에는 원본의 floor(k·1.2)번째 프레임이 보인다. 막대는 원본 프레임마다 10px씩 간다.
  assert.deepEqual(seen.map(({ x }) => Math.round((x - seen[0].x) / 10)), seen.map((_, k) => Math.floor(k * 1.2 + 1e-9)));
});

test("옮길 수 없는 영상은 멈춘 화면으로 찍지 않고 실패한다", { timeout: 60000 }, async (t) => {
  let browser;
  try { browser = await chromium.launch({ headless: true }); } catch { t.skip("Chromium을 띄울 수 없습니다."); return; }
  t.after(() => browser.close());
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "page-clock-video-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "clip.mp4");
  await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=160x40:r=30:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file]);
  const clip = await fs.readFile(file);
  const context = await browser.newContext({ viewport: { width: 160, height: 40 } });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  await installPageClock(page);
  await page.route("http://127.0.0.1:48126/clip.mp4", (route) => route.fulfill({ status: 200, contentType: "video/mp4", body: clip }));
  await page.route("http://127.0.0.1:48126/", (route) => route.fulfill({ status: 200, contentType: "text/html",
    body: "<video src=clip.mp4 muted playsinline></video>" }));
  await page.goto("http://127.0.0.1:48126/");
  await page.evaluate(() => new Promise((resolve) => {
    const video = document.querySelector("video");
    if (video.readyState >= 2) resolve(); else video.addEventListener("loadeddata", resolve, { once: true });
  }));
  const clock = await holdPageClock(page, session, { width: 160, height: 40 });
  await page.evaluate(() => document.querySelector("video").play());
  await clock.frame();
  await clock.advanceTo(40);
  await assert.rejects(clock.frame(), /옮기지 못했습니다/);
});
