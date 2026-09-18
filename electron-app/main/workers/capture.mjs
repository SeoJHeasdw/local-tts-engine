// 강의 화면을 찍어 음성과 함께 MP4로 남긴다. Electron 본체가 아닌 별도 프로세스로
// 돌아, 중지 버튼이 프로세스 그룹째 끝낼 수 있고 페이지 충돌이 앱을 죽이지 않는다.
//
//   node electron-app/main/workers/capture.mjs
//     --timeline <file> --out-dir <dir> --site-dir <dir> --deck-root <dir>
//     [--quality standard|high|ultra] [--burn-captions] [--no-cache] [--headful]
//     [--max-duration 30] [--url <address>] [--no-source-check]
import fs from "node:fs";
import path from "node:path";
import { buildCaptionCues } from "../../shared/captions.mjs";
import { videoQuality } from "../../shared/video-quality.mjs";
import { parseFlags, requireFlag } from "../capture/cli.mjs";
import { checkDeckContract, reviewDeckTimeline } from "../capture/deck-source.mjs";
import { captureVideo } from "../capture/record.mjs";

const flags = parseFlags(process.argv.slice(2));
const timelineFile = requireFlag(flags, "timeline");
const outDir = path.resolve(requireFlag(flags, "out-dir"));
const siteDir = flags["site-dir"] ? path.resolve(String(flags["site-dir"])) : null;
const url = typeof flags.url === "string" ? flags.url : null;
const quality = flags.quality === undefined ? "standard" : String(flags.quality);
const burnCaptions = flags["burn-captions"] === true;
// 소스 판본 검사를 건너뛰려면 명시해야 한다. 조용히 빠지지 않는다.
const checkSource = flags["no-source-check"] !== true;

videoQuality(quality);
const maxDurationSeconds = flags["max-duration"] === undefined ? null : Number(flags["max-duration"]);
if (maxDurationSeconds !== null && (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0)) {
  throw new Error("--max-duration은 0보다 큰 초 단위 숫자여야 합니다.");
}

const timeline = JSON.parse(fs.readFileSync(timelineFile, "utf8"));

if (checkSource) {
  const deckRoot = path.resolve(requireFlag(flags, "deck-root"));
  if (!siteDir) throw new Error("소스 판본 검사에는 --site-dir이 필요합니다. 건너뛰려면 --no-source-check를 주세요.");
  await reviewDeckTimeline(deckRoot, timeline, path.join(outDir, "lesson-review.json"));
  await checkDeckContract(deckRoot, siteDir, timeline);
}

// 자막 합성 촬영은 현재 타임라인에서 cue를 다시 만들어 오래된 자막을 차단한다.
const file = await captureVideo({
  timeline,
  captions: burnCaptions ? buildCaptionCues(timeline) : [],
  outDir,
  siteDir,
  url,
  headful: flags.headful === true,
  burnCaptions,
  maxDurationMs: maxDurationSeconds === null ? null : Math.round(maxDurationSeconds * 1000),
  noCache: flags["no-cache"] === true,
  quality,
});
console.log(`[video] ${file}`);
