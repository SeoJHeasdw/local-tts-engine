// 앱 데모 촬영 진입점. 찍기 → (대본) → 목소리 → 렌더가 각각 따로 돈다. 다시 찍지
// 않고 대본·목소리·계획만 바꿔 렌더만 다시 돌 수 있는 것이 이 나눔의 목적이다.
//
//   npm run demo -- record <시나리오.json> [--name <이름>] [--out-dir <폴더>]
//   npm run demo -- voice  <결과 폴더> [--candidates 3] [--adapter-scale 0.6] [--scene <id>]
//   npm run demo -- render <결과 폴더> [--quality high|ultra|standard] [--max-speed 4] [--no-open]
//
// render는 결과 폴더에 `review.html`(영상·구간·배율·확대·대본·검증을 한 쪽에 모은
// 검수 화면)을 쓰고 열어 준다. `--no-open`이면 쓰기만 한다.
//
// 결과는 `<편집 결과 루트>/<날짜>/<이름>/`에 남는다. 최근 결과·다듬기·합치기가
// 그대로 받는 모양이다(operation: "app-demo").
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ADAPTER, APP_SETTINGS_PATH, ROOT, dateFolder, runtimePaths } from "../paths.mjs";
import { resolveRuntimeTools } from "../runtime-config.mjs";
import { settingsAdapterScale } from "../../shared/index.mjs";
import { parseFlags } from "../capture/cli.mjs";
import { recordAppDemo } from "../capture/record-app.mjs";
import { renderAppDemo } from "../editing/demo-render.mjs";

// 중지는 작업 묶음 전체에 SIGTERM으로 온다. 기본 동작대로 곧장 죽으면 렌더의 임시 파일(.part)과
// 촬영의 작업 폴더·반쯤 쓴 원본·앱 서버를 치우는 finally가 돌지 못한다(2026-09-21 앱에서 굽기를
// 중지했더니 .part가 남았다). 그래서 여기서는 죽지 않고 기다린다 — 같은 신호로 ffmpeg·앱·합성이
// 먼저 끝나 기다리던 일이 실패하고, 그 finally가 치운 뒤 스스로 끝난다. 그래도 남아 있으면
// main의 강제 종료(3초)보다 먼저 나간다. 그때는 이 작업이 만든 임시 것만 직접 치운다 — 촬영을
// 멈췄더니 앱이 먼저 닫혀도 finally가 2.5초 안에 끝나지 못해 원본과 앱 프로필이 남았다(실측).
let sweepDir = null;
function sweepUnfinished() {
  if (!sweepDir) return;
  if (command === "render") {
    for (const name of fs.readdirSync(sweepDir)) {
      if (/\.mp4\.[\w-]+\.part$/.test(name)) fs.rmSync(path.join(sweepDir, name), { force: true });
    }
  } else if (command === "record" && !fs.existsSync(path.join(sweepDir, "demo", "scenes.json"))) {
    fs.rmSync(path.join(sweepDir, "demo", "work"), { recursive: true, force: true });
    fs.rmSync(path.join(sweepDir, "demo", "raw.mkv"), { force: true });
    for (const dir of [path.join(sweepDir, "demo"), sweepDir]) {
      if (fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
    }
  }
}
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    setTimeout(() => {
      try { sweepUnfinished(); } catch { /* 치우지 못해도 나간다. main이 한 번 더 치운다. */ }
      process.exit(130);
    }, 2500).unref();
  });
}

const [command, target, ...rest] = process.argv.slice(2);
if (!["record", "voice", "render"].includes(command)) {
  throw new Error("사용법: demo record <시나리오.json> | demo voice <결과 폴더> | demo render <결과 폴더>");
}
if (!target || target.startsWith("--")) throw new Error(`demo ${command}에는 대상 경로가 필요합니다.`);
const flags = parseFlags(rest);
const tools = await resolveRuntimeTools(ROOT);
const settings = fs.existsSync(APP_SETTINGS_PATH) ? JSON.parse(fs.readFileSync(APP_SETTINGS_PATH, "utf8")) : {};
const studio = runtimePaths(settings.paths);

const log = text => console.log(`[demo] ${text}`);
const announce = event => {
  if (event.phase === "log") return log(event.text);
  if (event.phase === "scene") return log(`장면 ${event.scene}`);
  if (event.phase === "recording") return log(`녹화 시작 · 장면 ${event.scenes}개`);
  if (event.phase === "recorded") return log(`녹화 ${(event.durationMs / 1000).toFixed(1)}초 · ${event.frames}프레임 (복제 ${event.duplicated})`);
  if (event.phase === "rendering") return log(`렌더 ${(event.durationMs / 1000).toFixed(1)}초 · 내레이션 ${event.narration}장면`);
  if (event.phase === "rendered") return log(`완성 ${(event.durationMs / 1000).toFixed(1)}초`);
};

// macOS 기본 앱으로 연다. 실패해도 결과는 이미 남아 있으므로 알리고 넘어간다.
function openFile(file) {
  return new Promise(resolve => {
    const child = spawn("open", [file], { stdio: "ignore" });
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });
}

function requireDir(dir) {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(path.join(resolved, "demo", "scenes.json"))) {
    throw new Error(`앱 데모 결과 폴더가 아닙니다(demo/scenes.json 없음): ${resolved}`);
  }
  return resolved;
}

// 제작 경로(runtime.mjs)와 같은 환경으로 Python을 띄운다. src를 PYTHONPATH에
// 넣지 않으면 local_tts_engine을 찾지 못한다.
function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: ROOT,
      env: { ...process.env, PYTHONPATH: path.join(ROOT, "src"), PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stdout.on("data", () => {});
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-16_384); });
    child.once("error", reject);
    child.once("close", code => code === 0
      ? resolve()
      : reject(new Error(`${path.basename(executable)} 실행 실패 (종료 ${code})\n${stderr.trim()}`)));
  });
}

if (command === "record") {
  const scenarioFile = path.resolve(target);
  // 이름을 정하려면 시나리오를 먼저 읽어야 한다. 자리표시자는 작업 폴더가 정해진
  // 뒤에 풀리므로 여기서는 이름만 본다.
  const name = String(flags.name || JSON.parse(fs.readFileSync(scenarioFile, "utf8")).name || "app-demo");
  const outDir = path.resolve(String(flags["out-dir"] || path.join(studio.editOutputRoot, dateFolder(), name)));
  sweepDir = outDir;
  if (fs.existsSync(path.join(outDir, "demo", "raw.mkv"))) {
    throw new Error(`같은 이름의 촬영이 이미 있습니다: ${outDir}`);
  }
  log(`촬영 ${scenarioFile} → ${outDir}`);
  const record = await recordAppDemo({ scenarioFile, outDir, name, onEvent: announce });

  // 대본은 여기서 쓰지 않는다. 장면마다 빈 칸과 화면 글(근거)만 놓아 둔다.
  const scriptFile = path.join(outDir, "demo", "script.json");
  if (!fs.existsSync(scriptFile)) {
    fs.writeFileSync(scriptFile, `${JSON.stringify({
      schemaVersion: 1,
      scenario: record.scenario,
      scenes: record.scenes.map(scene => ({
        id: scene.id, text: "", status: "draft",
        screenText: scene.screenText, sourceMs: scene.endMs - scene.startMs,
        voice: { candidates: [], selected: null },
      })),
    }, null, 2)}\n`, "utf8");
  }
  log(`대본 초안 자리: ${scriptFile}`);
  log(`다음: 대본을 쓰고 status를 approved로 바꾼 뒤 demo voice ${outDir}`);
} else if (command === "voice") {
  const outDir = requireDir(target);
  const scriptFile = path.join(outDir, "demo", "script.json");
  const script = JSON.parse(fs.readFileSync(scriptFile, "utf8"));
  const count = Number(flags.candidates ?? 3);
  // 명령줄 값은 적은 그대로 쓰고, 앱 설정은 앱과 같은 규칙(0.01 단위)으로 읽는다.
  const adapterScale = flags["adapter-scale"] !== undefined
    ? Number(flags["adapter-scale"])
    : settingsAdapterScale(settings.adapterScale);
  if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error("--candidates는 1~8이어야 합니다.");
  if (!tools.trainPython) throw new Error("음성 생성 Python(.venv-train)을 찾지 못했습니다.");
  // 한 문장만 고쳐 쓰는 일이 잦다. 그때 나머지 장면까지 다시 합성하지 않는다.
  // 여러 장면은 쉼표로 잇는다(--scene loop,capabilities).
  const only = typeof flags.scene === "string" ? flags.scene.split(",").map(id => id.trim()).filter(Boolean) : null;
  const unknown = (only || []).filter(id => !script.scenes.some(scene => scene.id === id));
  if (unknown.length) {
    throw new Error(`--scene ${unknown.join(",")}: 그런 장면이 없습니다. (${script.scenes.map(scene => scene.id).join(", ")})`);
  }
  const ready = script.scenes.filter(scene => scene.status === "approved" && scene.text?.trim()
    && (!only || only.includes(scene.id)));
  if (!ready.length) {
    throw new Error(only
      ? `장면 ${only.join(", ")}의 대본이 확정되지 않았습니다.`
      : "확정(approved)된 대본이 없습니다. 대본을 쓰고 status를 approved로 바꿔 주세요.");
  }

  for (const scene of ready) {
    const sceneDir = path.join(outDir, "demo", "narration", scene.id);
    fs.mkdirSync(sceneDir, { recursive: true });
    const textFile = path.join(sceneDir, "input.txt");
    fs.writeFileSync(textFile, `${scene.text}\n`, "utf8");
    const base = crypto.createHash("sha256").update(`${scene.id}\n${scene.text}`).digest().readUInt32BE(0);
    const candidates = [];
    for (let index = 0; index < count; index++) {
      const number = String(index + 1).padStart(2, "0");
      const audioPath = path.join(sceneDir, `candidate-${number}.wav`);
      const metadataPath = path.join(sceneDir, `candidate-${number}.json`);
      const seed = (base ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
      log(`장면 ${scene.id} 후보 ${index + 1}/${count}`);
      await run(tools.trainPython, [
        "-m", "local_tts_engine.text_candidate",
        "--model", settings.modelId || "qwen3-tts",
        "--text-file", textFile,
        "--reference", studio.referenceAudioPath,
        "--reference-text", studio.referenceTextPath,
        "--output", audioPath,
        "--metadata", metadataPath,
        "--seed", String(seed),
        "--adapter", ADAPTER,
        "--adapter-scale", String(adapterScale),
      ]);
      candidates.push(path.relative(path.join(outDir, "demo"), audioPath));
    }
    // 말이 바뀌면 예전에 고른 후보는 다른 말을 읽고 있다. 고르기를 비운다. 후보 파일
    // 이름(candidate-01…)은 다시 만들어도 같아서 이름으로는 가를 수 없다 — 후보를 만든
    // 대본(voice.text)과 견준다. 예전 기록에는 그 대본이 없으니 바뀐 것으로 본다.
    const changed = scene.voice?.text !== scene.text;
    scene.voice = { ...scene.voice, text: scene.text, candidates, selected: changed ? null : scene.voice?.selected ?? null };
  }
  fs.writeFileSync(scriptFile, `${JSON.stringify(script, null, 2)}\n`, "utf8");
  // 고르는 것은 사람이다. 자동 검사는 청취 승인을 대신하지 않는다.
  log("후보를 들어 보고 script.json의 voice.selected에 고른 파일을 적어 주세요.");
} else {
  const outDir = requireDir(target);
  sweepDir = outDir;
  const maxSpeed = flags["max-speed"] === undefined ? undefined : Number(flags["max-speed"]);
  if (maxSpeed !== undefined && !(maxSpeed >= 1)) throw new Error("--max-speed는 1 이상이어야 합니다.");
  const report = await renderAppDemo({
    outDir,
    name: String(flags.name || path.basename(outDir)),
    quality: flags.quality === undefined ? "high" : String(flags.quality),
    burnCaptions: flags["burn-captions"] === true,
    options: maxSpeed === undefined ? {} : { maxSpeed },
    ffmpeg: tools.ffmpeg || "ffmpeg",
    ffprobe: tools.ffprobe || "ffprobe",
    onEvent: announce,
  });
  console.log(`[video] ${report.videoPath}`);
  // 브라우저가 바로 여는 주소로 적는다. 편집기에서 경로를 누르면 HTML 원본이 열린다.
  console.log(`[review] ${pathToFileURL(report.reviewPath).href}`);
  for (const warning of report.warnings) console.error(`[경고] ${warning}`);
  // 만들고 끝내지 않고 사람이 볼 수 있게 연다. 자동 검증은 시청을 대신하지 않는다.
  if (flags["no-open"] !== true) await openFile(report.reviewPath);
}
