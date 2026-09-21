// 디스플레이 하나를 녹화한다. Electron 본체가 아닌 별도 프로세스로 돌아, 앱의
// 중지가 프로세스 그룹째 끝낼 수 있다.
//
//   node electron-app/main/workers/record-display.mjs
//     --display "Capture screen 1" --out-dir <dir> --name <name>
//     --ffmpeg <file> --ffprobe <file> [--audio "<입력 장치 이름>"] [--max-duration 10]
//     [--edge-mask 6]
//
// --edge-mask는 녹화하는 동안 화면 가장자리에 띄운 테두리의 폭(픽셀)이다. 녹화는 그
// 폭을 바로 안쪽 픽셀로 채워 테두리를 지운다.
//
// SIGUSR1은 정상 정지다. 녹화를 마무리하고 결과를 남긴다. SIGTERM·SIGINT는 취소다.
// 이번 녹화가 만든 파일을 지운다. 앱은 정지 신호를 이 프로세스에만 보낸다 — ffmpeg는
// SIGUSR1을 받으면 파일을 마무리하지 못하고 죽는다.
//
// 진행은 `[record] {"phase":…}` 한 줄 JSON으로 알린다.
import path from "node:path";
import { parseFlags, requireFlag } from "../capture/cli.mjs";
import { startDisplayRecording } from "../capture/record-display.mjs";

const flags = parseFlags(process.argv.slice(2));
const maxDurationSeconds = flags["max-duration"] === undefined ? null : Number(flags["max-duration"]);
if (maxDurationSeconds !== null && !(maxDurationSeconds > 0)) {
  throw new Error("--max-duration은 0보다 큰 초 단위 숫자여야 합니다.");
}
const edgeMask = flags["edge-mask"] === undefined ? 0 : Number(flags["edge-mask"]);
if (!Number.isInteger(edgeMask) || edgeMask < 0) throw new Error("--edge-mask는 0 이상의 정수 픽셀이어야 합니다.");

const session = startDisplayRecording({
  ffmpeg: requireFlag(flags, "ffmpeg"),
  ffprobe: requireFlag(flags, "ffprobe"),
  display: requireFlag(flags, "display"),
  audioDevice: typeof flags.audio === "string" ? flags.audio : null,
  outDir: path.resolve(requireFlag(flags, "out-dir")),
  name: requireFlag(flags, "name"),
  maxDurationMs: maxDurationSeconds === null ? null : Math.round(maxDurationSeconds * 1000),
  edgeMask,
  onEvent: event => console.log(`[record] ${JSON.stringify(event)}`),
});
process.on("SIGUSR1", session.stop);
process.on("SIGTERM", session.cancel);
process.on("SIGINT", session.cancel);

try {
  const report = await session.done;
  console.log(`[video] ${report.videoPath}`);
  for (const warning of report.warnings) console.error(`[경고] ${warning}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
