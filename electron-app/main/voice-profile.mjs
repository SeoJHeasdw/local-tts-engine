import nativeFs from "node:fs/promises";
import path from "node:path";
import crypto from 'node:crypto';
import { fileSha256 } from './files.mjs';

export const VOICE_PROFILE_FILE = "voice-profile.json";

const TRAINING_STATES = new Set(["pending", "complete", "failed", "comparison-candidate"]);
const LISTENING_STATES = new Set(["pending", "approved", "rejected"]);

function profileError(message) {
  const error = new Error(`목소리 프로필: ${message}`);
  error.code = "INVALID_VOICE_PROFILE";
  return error;
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw profileError(`${label}이 잘못됐습니다.`);
  }
  return value.trim();
}

// Run-local profiles keep the speaker name, reference pair and review status
// together. Missing statuses retain compatibility with the first v1 profiles.
export function validateVoiceProfile(raw) {
  if (!raw || Array.isArray(raw) || typeof raw !== "object" || raw.schemaVersion !== 1) {
    throw profileError("지원하지 않는 형식입니다.");
  }
  const trainingStatus = raw.trainingStatus ?? "complete";
  const listeningStatus = raw.listeningStatus ?? "pending";
  if (!TRAINING_STATES.has(trainingStatus) || !LISTENING_STATES.has(listeningStatus)) {
    throw profileError("학습·청취 상태가 잘못됐습니다.");
  }
  return {
    ...raw,
    schemaVersion: 1,
    displayName: requiredText(raw.displayName, "표시 이름"),
    referenceAudioPath: requiredText(raw.referenceAudioPath, "참조 음성 경로"),
    referenceTextPath: requiredText(raw.referenceTextPath, "참조 전사 경로"),
    trainingStatus,
    listeningStatus,
  };
}

export function resolveVoiceProfileReferences(runDirectory, profile) {
  const validated = validateVoiceProfile(profile);
  return {
    referenceAudioPath: path.resolve(runDirectory, validated.referenceAudioPath),
    referenceTextPath: path.resolve(runDirectory, validated.referenceTextPath),
  };
}

export async function readVoiceProfile(runDirectory, { fs = nativeFs } = {}) {
  const source = await fs.readFile(path.join(runDirectory, VOICE_PROFILE_FILE), "utf8");
  let raw;
  try { raw = JSON.parse(source); }
  catch { throw profileError("프로필을 읽지 못했습니다. JSON 형식을 확인해 주세요."); }
  const profile = validateVoiceProfile(raw);
  return { profile, referencePaths: resolveVoiceProfileReferences(runDirectory, profile) };
}

export async function writeVoiceProfile(runDirectory, raw, { fs = nativeFs, exclusive = false } = {}) {
  const profile = validateVoiceProfile(raw);
  await fs.writeFile(path.join(runDirectory, VOICE_PROFILE_FILE), `${JSON.stringify(profile, null, 2)}\n`,
    { encoding: "utf8", flag: exclusive ? "wx" : "w" });
  return profile;
}

export async function voiceInputIdentity(adapterPath, referencePaths, { fs = nativeFs } = {}) {
  const digest = fs === nativeFs ? fileSha256 : async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const [adapterWeightsSha256, adapterConfigSha256, referenceAudioSha256, referenceTextSha256, text] = await Promise.all([
    digest(path.join(adapterPath, 'adapters.safetensors')), digest(path.join(adapterPath, 'adapter_config.json')),
    digest(referencePaths.referenceAudioPath), digest(referencePaths.referenceTextPath), fs.readFile(referencePaths.referenceTextPath, 'utf8'),
  ]);
  return { adapterWeightsSha256, adapterConfigSha256, referenceAudioSha256, referenceTextSha256,
    referenceTextContentSha256: crypto.createHash('sha256').update(text.trim()).digest('hex') };
}

// An old approval may bind the stripped transcript used by course_pilot. New
// samples bind the full file; neither format can acquire approval from new bytes.
export function voiceInputMatches(expected, current) {
  return Boolean(expected && current && ['adapterWeightsSha256', 'adapterConfigSha256', 'referenceAudioSha256']
    .every(key => typeof expected[key] === 'string' && expected[key] === current[key])
    && (typeof expected.referenceTextSha256 === 'string' ? expected.referenceTextSha256 === current.referenceTextSha256
      : typeof expected.referenceTextContentSha256 === 'string' && expected.referenceTextContentSha256 === current.referenceTextContentSha256));
}
