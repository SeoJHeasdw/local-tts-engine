// 앱 데모 촬영 한 번. 앱을 띄우고 시나리오를 실행하며 RGB 무손실로 받아
// `demo/raw.mkv`와 `demo/scenes.json`을 남긴다.
//
// 손실 압축은 한 번뿐이다(설계 7절). 여기서는 색 변환도 하지 않는다. 색 변환과
// H.264 인코딩은 편집을 모두 적용한 뒤 `demo-render.mjs`가 한 번만 한다.
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { normalizeScenario, resolvePlaceholders } from "../../shared/demo-scenario.mjs";
import { launchDemoApp, runScenes } from "./app-page.mjs";
import { startScreencastEncoder } from "./recorder.mjs";
import { writeCaptureReport } from "./encoding.mjs";

export const RAW_FILE = "raw.mkv";
export const SCENES_FILE = "scenes.json";
// 촬영이 제한 시간을 다 쓰고도 끝나지 않는 일을 대비한 상한. 프레임 수는 상한일
// 뿐이라 실제 길이는 finish({ endAt })가 정한다.
const BUDGET_MARGIN_MS = 60_000;

export function losslessRecordArgs({ fps, output }) {
  return [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "image2pipe", "-vcodec", "png", "-framerate", String(fps), "-i", "pipe:0",
    // RGB 그대로 무손실. 다시 찍지 않고 고칠 수 있게 결과 폴더에 남긴다.
    "-c:v", "libx264rgb", "-qp", "0", "-preset", "veryfast",
    "-f", "matroska", output,
  ];
}

/**
 * 장면을 빈틈없이 잇는다.
 *
 * 장면이 끝나고 화면 글을 읽는 동안에도 녹화는 돈다. 그 몇십 ms를 어느 장면에도
 * 넣지 않으면 편집 계획이 원본의 일부를 버린다. 보이는 화면은 앞 장면의 끝이므로
 * 앞 장면에 붙인다.
 */
export function stitchScenes(scenes, durationMs) {
  return scenes.map((scene, index) => ({
    ...scene,
    startMs: index === 0 ? 0 : scene.startMs,
    endMs: index === scenes.length - 1 ? durationMs : scenes[index + 1].startMs,
  }));
}

/**
 * 시나리오 파일을 읽어 자리표시자를 풀고 검증한다.
 *
 * `{scenario}`는 시나리오 파일이 있는 폴더, `{work}`는 이번 촬영의 작업 폴더다.
 * 검증을 자리표시자보다 먼저 하면 경로가 비어 있는 채로 통과한다. 그래서 순서가
 * 풀기 → 검증이다.
 */
export function readScenario(file, workDir) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const resolved = resolvePlaceholders(raw, {
    scenario: path.dirname(path.resolve(file)),
    work: path.resolve(workDir),
  });
  return normalizeScenario(resolved);
}

/**
 * 앱 데모를 찍는다. 성공하면 결과 폴더의 `demo/`에 무손실 원본과 촬영 기록을 남긴다.
 *
 * 끝내지 못한 원본은 지운다. 잘린 mkv가 다음 렌더의 입력으로 읽히면 안 된다.
 * 그 밖의 기록은 남긴다 — 어디까지 갔는지가 다음 시도의 근거다. 앱 화면에서
 * 취소로 결과 폴더째 버리는 길은 화면 메뉴를 만들 때 함께 붙인다.
 */
export async function recordAppDemo({ scenarioFile, outDir, name, fps = 25, onEvent = () => {}, signal = null }) {
  const demoDir = path.join(outDir, "demo");
  const workDir = path.join(demoDir, "work");
  fs.mkdirSync(workDir, { recursive: true });
  const scenario = readScenario(scenarioFile, workDir);
  const { frame } = scenario.viewport;
  const rawFile = path.join(demoDir, RAW_FILE);

  onEvent({ phase: "launching", scenario: scenario.name });
  const app = await launchDemoApp(scenario, { workDir, onLog: text => onEvent({ phase: "log", text }) });
  let recorder = null;
  let finished = false;
  try {
    signal?.throwIfAborted();
    recorder = startScreencastEncoder({
      session: app.session,
      ffmpegArgs: losslessRecordArgs({ fps, output: rawFile }),
      width: frame.width, height: frame.height, fps,
    });
    await recorder.ready();
    // 첫 프레임의 브라우저 시각이 시스템 시계보다 몇 ms 앞설 수 있다. 바로 시작하면
    // 시작 시각 이전의 프레임이 없어 촬영이 그 자리에서 멈춘다.
    await new Promise(resolve => setTimeout(resolve, 150));
    const startedAt = Date.now();
    const startedMono = performance.now();
    recorder.begin(startedAt, Math.ceil((scenario.budgetMs + BUDGET_MARGIN_MS) * fps / 1000));
    onEvent({ phase: "recording", scenario: scenario.name, scenes: scenario.scenes.length });

    const clock = () => Math.round(performance.now() - startedMono);
    const recorded = await runScenes(app.page, scenario, { clock, onEvent });
    const endAt = Date.now();
    const frames = await recorder.finish({ endAt });
    recorder = null;
    finished = true;

    const durationMs = Math.round(frames.written * 1000 / fps);
    const scenes = stitchScenes(recorded, durationMs);
    const record = {
      schemaVersion: 1,
      scenario: scenario.name,
      viewport: { width: scenario.viewport.width, height: scenario.viewport.height, scale: scenario.viewport.scale },
      frame,
      fps,
      durationMs,
      // 인코더가 실시간을 못 따라가면 촬영이 중단된다. 성공한 촬영도 얼마나
      // 여유가 있었는지 남겨야 다음 촬영 길이를 근거로 정할 수 있다.
      frames: { written: frames.written, duplicated: frames.duplicated, received: frames.received,
        longestStall: frames.longestStall, reordered: frames.reordered,
        peakBacklogBytes: frames.peakBacklog, peakBufferedBytes: frames.peakBufferedBytes },
      raw: rawFile,
      scenes,
      generatedAt: new Date().toISOString(),
    };
    writeCaptureReport(path.join(demoDir, SCENES_FILE), record);
    onEvent({ phase: "recorded", durationMs, frames: frames.written, duplicated: frames.duplicated });
    return record;
  } finally {
    if (recorder) await recorder.abort().catch(() => {});
    await app.close();
    // 작업 폴더는 이번 촬영의 앱 데이터다. 결과에 남길 이유가 없다.
    fs.rmSync(workDir, { recursive: true, force: true });
    if (!finished) fs.rmSync(rawFile, { force: true });
  }
}
