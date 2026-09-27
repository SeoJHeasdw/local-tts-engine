// A demo candidate's automated review describes exact audio bytes. Recheck
// that link whenever the app shows, selects or renders an existing candidate.
import nativeFs from "node:fs/promises";
import path from "node:path";
import { fileSha256 } from "./files.mjs";

export function demoCandidatePath(demoDir, relative) {
  return path.isAbsolute(relative) ? relative : path.join(demoDir, relative);
}

const spokenInput = (value) => String(value || "").trim().replace(/\s+/g, " ");

export async function inspectDemoCandidate(audioPath, { fs = nativeFs, metadata, expectedText } = {}) {
  const metadataPath = /\.wav$/i.test(audioPath) ? audioPath.replace(/\.wav$/i, ".json") : null;
  let record = metadata;
  if (record === undefined) {
    record = metadataPath
      ? await fs.readFile(metadataPath, "utf8").then(JSON.parse).catch(() => null)
      : null;
  }
  const stat = await fs.stat(audioPath).catch(() => null);
  if (!stat?.isFile() || stat.size <= 44) return { status: "missing", metadata: record };
  if (record && expectedText !== undefined && typeof record.sourceText === "string"
      && spokenInput(record.sourceText) !== spokenInput(expectedText)) {
    return { status: "text-changed", metadata: record };
  }
  if (Number(record?.schemaVersion) >= 2 && typeof record.sourceText !== "string") {
    return { status: "invalid", metadata: record };
  }
  if (!record || !Object.hasOwn(record, "audioSha256")) {
    return { status: "unverified", metadata: record };
  }
  if (typeof record.audioSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(record.audioSha256)
      || !(Number(record.durationMs) > 0) || record.finalTrack?.status !== "ok") {
    return { status: "invalid", metadata: record };
  }
  const digest = await fileSha256(audioPath).catch(() => null);
  return { status: digest === record.audioSha256.toLowerCase() ? "verified" : "changed", metadata: record };
}

export function demoCandidateUsable(integrity) {
  return integrity?.status === "verified" || integrity?.status === "unverified";
}
