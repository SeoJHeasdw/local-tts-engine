import crypto from "node:crypto";
import nativeFs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, dateFolder, runtimePaths } from "./paths.mjs";
import { normalizeEditName } from "../shared/index.mjs";
import { normalizeScenario } from "../shared/demo-scenario.mjs";
import { cameraSetting } from "../shared/demo-camera.mjs";
import { createDemoCameraPreview } from "./editing/demo-camera-preview.mjs";
import { collectReview } from "./editing/demo-review.mjs";
import { isRetryableDemoFailure } from "./capture/record-app.mjs";

// 앱 데모 촬영을 화면에서 돌린다. 세 단계(촬영 → 목소리 → 렌더)는 CLI와 같은
// 작업자(`workers/demo.mjs`)를 별도 프로세스로 실행한다. 한 가지 일에 두 벌의
// 구현을 두지 않기 위해서다 — 화면과 CLI가 같은 결과 폴더를 읽고 쓴다.
//
// 대본과 고른 후보는 결과 폴더의 `demo/script.json`이 소유한다. 화면은 그 파일을
// 읽어 보여 주고 고친 것을 그대로 돌려 쓴다.
export function createAppDemoService({
  dialog,
  emit,
  fs = nativeFs,
  jobSnapshot,
  readAppSettings,
  requireRuntimeTool,
  runProcess,
  state,
}) {
  const WORKER = path.join(ROOT, "electron-app/main/workers/demo.mjs");
  const previewCamera = createDemoCameraPreview({
    ffmpeg: () => requireRuntimeTool("ffmpeg", "FFmpeg"), ffprobe: () => requireRuntimeTool("ffprobe", "FFprobe"),
  });
  async function readDemoCameraPreview(options) {
    assertIdle();
    return previewCamera(options);
  }

  const busy = () => state.activeJob && ["running", "cancelling"].includes(state.activeJob.state);

  function assertIdle() {
    if (busy()) throw new Error("이미 실행 중인 작업이 있습니다.");
  }

  /** 시나리오 파일을 고른다. 읽는 시점에 검증해 동사 오타를 촬영 전에 잡는다. */
  async function pickDemoScenario() {
    const result = await dialog.showOpenDialog(state.mainWindow ?? undefined, {
      title: "앱 데모 시나리오 고르기",
      properties: ["openFile"],
      filters: [{ name: "시나리오", extensions: ["json"] }],
    });
    const file = result.canceled ? null : result.filePaths[0] ?? null;
    return file ? readDemoScenario(file) : null;
  }

  /** 시나리오 파일 하나를 읽어 화면에 보여 줄 만큼만 돌려준다. */
  async function readDemoScenario(file) {
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    // 자리표시자는 촬영 시점에 풀린다. 여기서는 모양만 본다.
    const scenario = normalizeScenario(JSON.parse(
      JSON.stringify(raw).replace(/\{(scenario|work)\}/g, "."),
    ));
    return {
      file,
      name: scenario.name,
      scenes: scenario.scenes.map(scene => ({
        id: scene.id,
        steps: scene.steps.length,
        timeScale: scene.timeScale,
      })),
      budgetMs: scenario.budgetMs,
    };
  }

  /**
   * 고를 수 있는 시나리오를 찾아 온다.
   *
   * 시나리오는 그 앱의 저장소가 가진다(`<저장소>/demo/scenarios/*.json`). 그래서 이
   * 작업 폴더의 형제 저장소들을 한 겹만 훑는다 — 엔진이 어느 앱인지 아는 것이 아니라
   * "옆에 있는 저장소가 내놓은 시나리오"를 줍는 것이다. 읽으면서 검증하므로 동사
   * 오타는 목록에서 바로 드러난다. 그 밖의 자리는 파일 고르기로 연다.
   */
  async function listDemoScenarios({ limit = 40 } = {}) {
    const neighbourhood = path.resolve(ROOT, "../..");
    const found = [];
    const orgs = await fs.readdir(neighbourhood, { withFileTypes: true }).catch(() => []);
    for (const org of orgs.filter(entry => entry.isDirectory() && !entry.name.startsWith("."))) {
      const repos = await fs.readdir(path.join(neighbourhood, org.name), { withFileTypes: true }).catch(() => []);
      for (const repo of repos.filter(entry => entry.isDirectory() && !entry.name.startsWith("."))) {
        const dir = path.join(neighbourhood, org.name, repo.name, "demo", "scenarios");
        const files = await fs.readdir(dir).catch(() => []);
        for (const name of files.filter(file => file.endsWith(".json")).sort()) {
          if (found.length >= limit) return found;
          const file = path.join(dir, name);
          try {
            found.push({ ...await readDemoScenario(file), from: `${org.name}/${repo.name}` });
          } catch (error) {
            found.push({ file, from: `${org.name}/${repo.name}`, name, scenes: [], error: error.message });
          }
        }
      }
    }
    return found;
  }

  /** 이미 있는 결과 폴더를 이어 받는다. CLI로 찍은 것도 화면에서 그대로 잇는다. */
  async function pickDemoProject() {
    const settings = await readAppSettings();
    const result = await dialog.showOpenDialog(state.mainWindow ?? undefined, {
      title: "앱 데모 결과 폴더 고르기",
      defaultPath: runtimePaths(settings.paths).editOutputRoot,
      properties: ["openDirectory"],
    });
    const dir = result.canceled ? null : result.filePaths[0] ?? null;
    return dir ? readDemoProject(dir) : null;
  }

  async function demoOutputDir(name) {
    const settings = await readAppSettings();
    return path.join(runtimePaths(settings.paths).editOutputRoot, dateFolder(), name);
  }

  /**
   * 결과 폴더의 촬영 기록·대본·후보·완성본·편집 계획을 다듬기 화면이 쓸 모양으로 모은다.
   *
   * 편집 계획·자막·검증은 CLI 검수 페이지(review.html)와 같은 것을 같은 함수로 읽는다.
   * 완성본이 없으면 비어 있다 — 대본을 쓰기 전에도 화면은 열려야 한다.
   */
  async function readDemoProject(outDir) {
    const demoDir = path.join(outDir, "demo");
    const read = async file => {
      try { return JSON.parse(await fs.readFile(path.join(demoDir, file), "utf8")); } catch { return null; }
    };
    const scenes = await read("scenes.json");
    const script = await read("script.json");
    if (!scenes) throw new Error("촬영 기록(demo/scenes.json)이 없습니다.");
    const texts = new Map((script?.scenes || []).map(scene => [scene.id, scene]));
    const metas = new Map();
    for (const scene of script?.scenes || []) {
      for (const relative of scene.voice?.candidates || []) {
        try {
          metas.set(relative, JSON.parse(await fs.readFile(path.join(demoDir, relative.replace(/\.wav$/, ".json")), "utf8")));
        } catch { metas.set(relative, null); }
      }
    }
    // 후보가 어느 대본을 읽었는지. 대본을 고친 뒤 후보를 다시 만들지 않았으면 화면이 알린다.
    // 예전 기록에는 voice.text가 없어 작업자가 남긴 입력 글로 갈음한다.
    const voicedTexts = new Map();
    for (const scene of script?.scenes || []) {
      if (!scene.voice?.candidates?.length) continue;
      const input = await fs.readFile(path.join(demoDir, "narration", scene.id, "input.txt"), "utf8").catch(() => null);
      voicedTexts.set(scene.id, scene.voice.text ?? input?.trim() ?? null);
    }
    const review = collectReview(outDir);
    return {
      outDir,
      name: path.basename(outDir),
      scenario: scenes.scenario,
      durationMs: scenes.durationMs,
      frame: review.frame,
      viewport: scenes.viewport,
      videos: review.videos.map(video => {
        const url = pathToFileURL(path.join(outDir, video.name));
        url.searchParams.set("v", video.revision);
        return { ...video, url: url.href };
      }),
      plan: review.plan,
      captions: review.captions,
      checks: review.checks,
      warnings: review.warnings,
      ok: review.ok,
      scenes: scenes.scenes.map(scene => {
        const text = texts.get(scene.id);
        return {
          id: scene.id,
          startMs: scene.startMs,
          endMs: scene.endMs,
          timeScale: scene.timeScale ?? 1,
          camera: text?.camera ?? null,
          cameraModifiedAt: text?.cameraModifiedAt ?? null,
          recordedCamera: scene.camera ?? "auto",
          // 대본 초안의 근거다. 찍은 화면의 글을 그대로 보여 준다.
          screenText: scene.screenText || "",
          text: text?.text || "",
          status: text?.status || "draft",
          selected: text?.voice?.selected || null,
          voicedText: voicedTexts.get(scene.id) ?? null,
          candidates: (text?.voice?.candidates || []).map(relative => ({
            file: relative,
            name: path.basename(relative, ".wav"),
            url: pathToFileURL(path.join(demoDir, relative)).href,
            // 후보를 고를 때 길이를 함께 본다. 장면보다 길면 편집이 덜 되돌린다.
            durationMs: metas.get(relative)?.durationMs ?? null,
            // 영어를 따로 읽은 후보인지 보인다. 기록이 없는 예전 후보(undefined)와
            // 영어 구간이 없던 후보(null)는 다른 이야기다.
            voiceRouting: metas.get(relative) ? metas.get(relative).voiceRouting ?? null : undefined,
          })),
        };
      }),
    };
  }

  /**
   * 화면에서 고친 대본과 고른 후보를 `script.json`에 돌려 쓴다.
   *
   * 후보 목록은 만든 쪽(`demo voice`)이 소유한다. 화면은 글과 상태, 고른 것만 바꾼다.
   */
  async function saveDemoScript(outDir, scenes) {
    const file = path.join(outDir, "demo", "script.json");
    const script = JSON.parse(await fs.readFile(file, "utf8"));
    const recording = JSON.parse(await fs.readFile(path.join(outDir, "demo", "scenes.json"), "utf8"));
    const edits = new Map((scenes || []).map(scene => [String(scene.id), scene]));
    for (const scene of script.scenes) {
      const edit = edits.get(scene.id);
      if (!edit) continue;
      if (typeof edit.text === "string") scene.text = edit.text.trim();
      if (edit.status === "approved" || edit.status === "draft") scene.status = edit.status;
      if (Object.hasOwn(edit, "camera")) {
        const camera = cameraSetting(edit.camera, recording.viewport);
        if (JSON.stringify(scene.camera ?? null) !== JSON.stringify(camera)) scene.cameraModifiedAt = new Date().toISOString();
        scene.camera = camera;
      }
      if (edit.selected === null || typeof edit.selected === "string") {
        const candidates = scene.voice?.candidates || [];
        if (edit.selected && !candidates.includes(edit.selected)) {
          throw new Error(`장면 ${scene.id}: 그 후보가 없습니다.`);
        }
        scene.voice = { ...scene.voice, candidates, selected: edit.selected };
      }
    }
    await fs.writeFile(file, `${JSON.stringify(script, null, 2)}\n`, "utf8");
    return readDemoProject(outDir);
  }

  function startJob(kind, options) {
    // 시나리오·설정을 읽는 await 사이에 다른 화면이 시작했을 수 있다.
    assertIdle();
    state.activeJob = {
      id: crypto.randomUUID(),
      kind,
      options,
      state: "running",
      stage: kind,
      children: new Set(),
      cancelled: false,
      startedAt: new Date().toISOString(),
    };
    return state.activeJob;
  }

  async function runDemoWorker(job, args, done) {
    try {
      const node = requireRuntimeTool("node", "Node.js");
      await runProcess("demo", node, [WORKER, ...args]);
      if (state.activeJob !== job) return;
      if (job.cancelled) throw new Error("작업을 중지했습니다.");
      const result = await done();
      if (state.activeJob !== job) return;
      if (job.cancelled) throw new Error("작업을 중지했습니다.");
      job.state = "done";
      job.stage = "done";
      emit({ type: "demo-complete", step: job.kind, ...result });
    } catch (error) {
      if (state.activeJob !== job) return;
      // 굽다 멈춘 임시 파일은 작업자가 치우지만, 강제 종료까지 가면 남는다. 결과 폴더에 반쪽
      // 영상이 쌓이지 않게 한 번 더 치운다. 임시 파일 이름은 `<완성본>.mp4.<id>.part`다.
      if (job.cancelled && job.kind === "demo-render" && job.options?.outDir) {
        const names = await fs.readdir(job.options.outDir).catch(() => []);
        await Promise.all(names.filter(name => /\.mp4\.[\w-]+\.part$/.test(name))
          .map(name => fs.rm(path.join(job.options.outDir, name), { force: true }).catch(() => {})));
      }
      // 촬영은 비어 있거나 없던 폴더에만 시작한다(startDemoRecord). 끝까지 가지 못한 촬영의 폴더는
      // 이번 촬영이 만든 것뿐이라 통째로 치운다. 남기면 같은 이름으로 다시 찍지도 못한다.
      if (job.cancelled && job.kind === "demo-record" && job.options?.outDir
          && !await fs.stat(path.join(job.options.outDir, "demo", "scenes.json")).catch(() => null)) {
        await fs.rm(job.options.outDir, { recursive: true, force: true }).catch(() => {});
      }
      job.state = job.cancelled ? "cancelled" : "failed";
      job.error = error.message;
      emit({ type: "demo-failed", step: job.kind, cancelled: job.cancelled, message: error.message });
    }
  }

  /** 촬영. 결과 폴더는 CLI와 같은 자리에 같은 이름 규칙으로 만든다. */
  async function startDemoRecord(raw = {}) {
    assertIdle();
    const scenarioFile = String(raw.scenarioFile || "").trim();
    if (!scenarioFile) throw new Error("시나리오 파일을 골라 주세요.");
    const scenario = await readDemoScenario(scenarioFile);
    const name = normalizeEditName(raw.name || scenario.name);
    const outDir = await demoOutputDir(name);
    if ((await fs.readdir(outDir).catch(() => []))?.length && !await isRetryableDemoFailure(outDir, fs)) {
      throw new Error("같은 이름의 촬영이 이미 있습니다. 다른 이름을 쓰거나 예전 결과를 옮겨 주세요.");
    }
    const job = startJob("demo-record", { name, scenarioFile, outDir });
    const snapshot = jobSnapshot();
    emit({ type: "demo-started", step: "demo-record", job: snapshot, outDir, name });
    void runDemoWorker(job, ["record", scenarioFile, "--name", name, "--out-dir", outDir],
      async () => ({ project: await readDemoProject(outDir) }));
    return snapshot;
  }

  /** 확정한 대본으로 장면마다 목소리 후보를 만든다. 고르는 것은 사람이다. */
  async function startDemoVoice(raw = {}) {
    assertIdle();
    const outDir = String(raw.outDir || "").trim();
    if (!outDir) throw new Error("촬영 결과 폴더가 필요합니다.");
    const count = Math.min(8, Math.max(1, Math.round(Number(raw.candidates ?? 3))));
    const args = ["voice", outDir, "--candidates", String(count)];
    // 장면 하나(scene) 또는 여럿(scenes). 비우면 확정한 장면 모두다.
    const scenes = [raw.scene, ...(Array.isArray(raw.scenes) ? raw.scenes : [])]
      .map(id => String(id ?? "").trim()).filter(Boolean);
    if (scenes.some(id => id.includes(","))) throw new Error("장면 이름에 쉼표를 쓸 수 없습니다.");
    if (scenes.length) args.push("--scene", scenes.join(","));
    const job = startJob("demo-voice", { outDir, candidates: count, scenes });
    const snapshot = jobSnapshot();
    emit({ type: "demo-started", step: "demo-voice", job: snapshot, outDir, scenes });
    void runDemoWorker(job, args, async () => ({ project: await readDemoProject(outDir) }));
    return snapshot;
  }

  /** 렌더. 화질마다 다른 파일로 나가므로 여러 벌을 나란히 둘 수 있다. */
  async function startDemoRender(raw = {}) {
    assertIdle();
    const outDir = String(raw.outDir || "").trim();
    if (!outDir) throw new Error("촬영 결과 폴더가 필요합니다.");
    const quality = ["standard", "high", "ultra"].includes(raw.quality) ? raw.quality : "high";
    const args = ["render", outDir, "--quality", quality, "--no-open"];
    if (raw.maxSpeed) args.push("--max-speed", String(Number(raw.maxSpeed)));
    // 자막은 기본으로 파일만 만든다. 켜면 완성본에 구운 것을 따로(-captioned) 낸다.
    const burnCaptions = raw.burnCaptions === true;
    if (burnCaptions) args.push("--burn-captions");
    const job = startJob("demo-render", { outDir, quality, burnCaptions });
    const snapshot = jobSnapshot();
    emit({ type: "demo-started", step: "demo-render", job: snapshot, outDir, quality, burnCaptions });
    void runDemoWorker(job, args, async () => ({ project: await readDemoProject(outDir) }));
    return snapshot;
  }

  return {
    listDemoScenarios, pickDemoScenario, pickDemoProject, readDemoScenario, readDemoProject, readDemoCameraPreview, saveDemoScript,
    startDemoRecord, startDemoVoice, startDemoRender,
  };
}
