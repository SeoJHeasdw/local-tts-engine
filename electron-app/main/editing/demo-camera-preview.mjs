import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildEditPlan } from "../../shared/demo-plan.mjs";
import { sourceTimeAt } from "../../shared/demo-camera.mjs";
import { loadDemoRenderInput } from "./demo-render.mjs";

const exec = promisify(execFile);

// 완성본은 이미 잘린 영상일 수 있다. 구도 편집은 항상 무손실 원본에서 프레임을
// 읽는다. 연속 요청은 하나씩 실행하며 오래된 디코딩만 취소한다.
export function createDemoCameraPreview({ ffmpeg = () => "ffmpeg", ffprobe = () => "ffprobe" } = {}) {
  let ticket = 0, queue = Promise.resolve(), decoding = null;
  return options => {
    const mine = ++ticket;
    decoding?.abort();
    const task = queue.then(async () => {
      const current = () => { if (mine !== ticket) throw new Error("다른 구도를 불러오는 중입니다."); };
      current();
      const { scenes, narration, cameras, plan, rawFile } = await loadDemoRenderInput({
        outDir: options.outDir, ffprobe: ffprobe(),
      });
      current();
      const scene = plan.scenes.find(item => item.id === options.sceneId);
      if (!scene) throw new Error("미리 볼 장면을 찾지 못했습니다.");
      const automatic = buildEditPlan(scenes, { narration, cameras: { ...cameras, [scene.id]: "auto" },
        options: { fps: plan.fps, maxSpeed: plan.maxSpeed } });
      const keys = automatic.zoom.filter(key => key.atMs >= scene.outStartMs && key.atMs < scene.outEndMs && key.z > 1.01);
      const defaultAtMs = keys[0]?.atMs ?? (scene.outStartMs + scene.outEndMs) / 2;
      const requested = options.atMs == null ? defaultAtMs : Number(options.atMs);
      if (!Number.isFinite(requested)) throw new Error("미리보기 시각이 올바르지 않습니다.");
      const atMs = Math.max(scene.outStartMs, Math.min(scene.outEndMs - 1000 / plan.fps, requested));
      const sourceAtMs = sourceTimeAt(plan, atMs);
      decoding = new AbortController();
      const { stdout } = await exec(ffmpeg(), ["-v", "error", "-nostdin", "-ss", (sourceAtMs / 1000).toFixed(6),
        "-i", rawFile, "-frames:v", "1", "-vf", "scale=1280:-2:flags=lanczos", "-f", "image2pipe", "-vcodec", "png", "-"],
      { encoding: "buffer", maxBuffer: 12 * 1024 * 1024, timeout: 15000, signal: decoding.signal });
      current();
      if (!stdout.length) throw new Error("이 시각의 원본 화면을 읽지 못했습니다.");
      return {
        imageUrl: `data:image/png;base64,${stdout.toString("base64")}`, atMs, sourceAtMs, defaultAtMs,
        startMs: scene.outStartMs, endMs: scene.outEndMs, automaticAvailable: keys.length > 0,
        recording: { schemaVersion: 1, viewport: scenes.viewport, fps: scenes.fps, durationMs: scenes.durationMs,
          scenes: scenes.scenes.map(({ id, startMs, endMs, timeScale, camera, steps }) =>
            ({ id, startMs, endMs, timeScale, camera, steps })) },
        narration: Object.fromEntries(Object.entries(narration).map(([id, value]) => [id, { durationMs: value.durationMs }])),
        cameras, fps: plan.fps, maxSpeed: plan.maxSpeed,
      };
    });
    queue = task.catch(() => {});
    return task;
  };
}
