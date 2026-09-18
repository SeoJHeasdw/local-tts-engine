// 타임라인에서 자막을 만들어 결과 폴더에 남긴다.
//   node electron-app/main/workers/captions.mjs --timeline <file> --out-dir <dir>
//     [--max-chars-per-cue 46] [--max-chars-per-line 24]
import fs from "node:fs";
import path from "node:path";
import { CAPTION_LIMITS, buildCaptionCues, captionsToSrt, captionsToVtt } from "../../shared/captions.mjs";
import { parseFlags, requireFlag } from "../capture/cli.mjs";

const flags = parseFlags(process.argv.slice(2));
const timelineFile = requireFlag(flags, "timeline");
const outDir = path.resolve(requireFlag(flags, "out-dir"));
const limit = (key, fallback) => {
  if (flags[key] === undefined) return fallback;
  const value = Number(flags[key]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`--${key}는 0보다 큰 정수여야 합니다.`);
  return value;
};

const timeline = JSON.parse(fs.readFileSync(timelineFile, "utf8"));
const cues = buildCaptionCues(timeline, {
  maxCharsPerCue: limit("max-chars-per-cue", CAPTION_LIMITS.maxCharsPerCue),
  maxCharsPerLine: limit("max-chars-per-line", CAPTION_LIMITS.maxCharsPerLine),
});

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "captions.srt"), captionsToSrt(cues));
fs.writeFileSync(path.join(outDir, "captions.vtt"), captionsToVtt(cues));
fs.writeFileSync(path.join(outDir, "captions.json"), `${JSON.stringify(cues, null, 2)}\n`);
console.log(`[captions] ${cues.length} cues`);
