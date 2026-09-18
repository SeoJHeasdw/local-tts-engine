// 촬영 전에 강의 소스를 검사하는 유일한 통로. 대본·장표·편집점의 판정은 그것을
// 소유한 덱 저장소가 내리므로, 얼려 둔 입력의 `tools/production.mjs`를 불러 쓴다.
// 같은 판정을 이쪽에 베껴 두면 두 벌이 말없이 갈라진다.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function deckTools(deckRoot) {
  return import(pathToFileURL(path.join(deckRoot, "tools/production.mjs")).href);
}

// 음성의 ID·대본·순서가 촬영할 화면과 같은 판본인지 확인한다.
export async function checkDeckContract(deckRoot, siteDir, timeline) {
  const contractFile = path.join(siteDir, "production-input.json");
  if (!fs.existsSync(contractFile)) {
    throw new Error(`촬영 사이트에 소스 계약이 없습니다: ${contractFile}`);
  }
  const { checkCaptureContract } = await deckTools(deckRoot);
  checkCaptureContract(timeline, JSON.parse(fs.readFileSync(contractFile, "utf8")));
}

// 생성된 음성의 실제 시각으로 편집점을 재검사한다. 리듬 후보는 보고서에만 남기고
// 잘못된 소스 계약·영상 편집점만 촬영 전에 멈춘다.
export async function reviewDeckTimeline(deckRoot, timeline, output) {
  const { inspectProductionTimeline } = await deckTools(deckRoot);
  return inspectProductionTimeline({ root: deckRoot, timeline, output });
}
