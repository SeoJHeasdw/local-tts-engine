// App demo narration is regenerated often while the chosen take is still in use.
// Keep every new batch separate and publish its references only after all scenes finish.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inspectDemoCandidate } from "../demo-voice-integrity.mjs";

/**
 * 이번 실행에만 쓸 목소리를 고른다. 앱의 선택값은 건드리지 않는다.
 *
 * 설정에서 바꾸지 않고 다른 사람의 영상을 만들 때 쓴다. 승인되지 않은 목소리나 강도는
 * 설정의 적용과 같은 이유로 받지 않는다.
 */
export function resolveDemoVoice(settings, voiceId, scale) {
  const adapter = settings.adapters.find(item => item.id === voiceId);
  if (!adapter) {
    throw new Error(`--voice ${voiceId}: 그런 목소리가 없습니다. (${settings.adapters.map(item => item.id).join(", ")})`);
  }
  if (adapter.profileError) throw new Error(`--voice ${voiceId}: ${adapter.profileError}`);
  if (adapter.listeningStatus !== "approved"
      || !adapter.approvedScales?.some(value => Math.abs(Number(value) - scale) < 0.0005)) {
    throw new Error(adapter.approvalError || `--voice ${voiceId}: 강도 ${scale}는 청취 승인된 강도가 아닙니다.`);
  }
  return adapter;
}

function priorVoiceText(scene, sceneDir) {
  if (typeof scene.voice?.text === "string") return scene.voice.text;
  // Older projects recorded the spoken input beside candidate-01.wav.
  try { return fs.readFileSync(path.join(sceneDir, "input.txt"), "utf8").trim(); }
  catch { return null; }
}

function nextCandidateNumber(candidates) {
  return Math.max(0, ...candidates.map(relative =>
    Number(/(?:^|\/)candidate-(\d+)\.wav$/.exec(relative)?.[1] || 0))) + 1;
}

/** Generate into private run folders, then atomically publish the updated script. */
export async function regenerateDemoVoices({ script, scriptSource, scriptFile, demoDir, sceneIds, count, generate }) {
  const next = structuredClone(script);
  const narrationDir = path.join(demoDir, "narration");
  const created = [];
  let temporary = null;
  let committed = false;
  try {
    for (const id of sceneIds) {
      const scene = next.scenes.find(item => item.id === id);
      if (!scene) throw new Error(`장면 ${id}: 대본을 찾지 못했습니다.`);
      const sceneDir = path.resolve(narrationDir, id);
      const relativeScene = path.relative(narrationDir, sceneDir);
      if (!relativeScene || relativeScene.startsWith("..") || path.isAbsolute(relativeScene)) {
        throw new Error(`장면 ID의 경로가 잘못되었습니다: ${id}`);
      }
      fs.mkdirSync(sceneDir, { recursive: true });
      const previous = scene.voice?.candidates || [];
      const currentText = priorVoiceText(scene, sceneDir) === scene.text;
      const retained = currentText ? previous.filter(item => typeof item === "string") : [];
      const selected = currentText && retained.includes(scene.voice?.selected) ? scene.voice.selected : null;
      const firstNumber = nextCandidateNumber(retained);

      const runDir = fs.mkdtempSync(path.join(sceneDir, "run-"));
      created.push(runDir);
      const textFile = path.join(runDir, "input.txt");
      fs.writeFileSync(textFile, `${scene.text}\n`, "utf8");
      const base = crypto.createHash("sha256")
        .update(`${id}\n${scene.text}`)
        .digest().readUInt32BE(0);
      const candidates = [];
      for (let index = 0; index < count; index++) {
        const number = String(firstNumber + index).padStart(2, "0");
        const audioPath = path.join(runDir, `candidate-${number}.wav`);
        const metadataPath = path.join(runDir, `candidate-${number}.json`);
        const seed = (base ^ Math.imul(firstNumber + index, 0x9e3779b1)) >>> 0;
        await generate({ scene, index, count, textFile, audioPath, metadataPath, seed });
        const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
        if ((await inspectDemoCandidate(audioPath, { metadata, expectedText: scene.text })).status !== "verified") {
          throw new Error(`장면 ${id}: 후보 ${index + 1} 파일이 완성되지 않았습니다.`);
        }
        candidates.push(path.relative(demoDir, audioPath));
      }
      scene.voice = {
        ...scene.voice,
        text: scene.text,
        candidates: [...retained, ...candidates],
        selected,
      };
    }
    temporary = path.join(demoDir, `.script-${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    if (fs.readFileSync(scriptFile, "utf8") !== scriptSource) {
      throw new Error("목소리를 만드는 동안 대본이 수정됐습니다. 현재 대본으로 다시 생성해 주세요.");
    }
    fs.renameSync(temporary, scriptFile);
    committed = true;
    return next;
  } finally {
    if (!committed) {
      if (temporary) fs.rmSync(temporary, { force: true });
      for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
