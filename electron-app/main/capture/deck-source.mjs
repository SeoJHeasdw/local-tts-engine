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

// 덱의 map 기반 검사는 개별 상태를 판정한다. 재촬영은 누락·추가·재배열도
// 허용하지 않으므로, 그 검사에 넘기는 선택 상태를 원래 순서대로 1:1 연결한다.
export function assertRecaptureScriptContract(entries, states) {
  const fields = ['slideId', 'step', 'chapter', 'slideNumber', 'sourceText'];
  if (!Array.isArray(entries) || !entries.length || !Array.isArray(states)
    || entries.length !== states.length) throw new Error('재촬영 대본의 페이지·스텝 수가 다릅니다.');
  for (let index = 0; index < entries.length; index++) {
    if (fields.some(field => entries[index][field] !== states[index][field])) {
      throw new Error(`${entries[index].slideId}:${entries[index].step}: 재촬영 대본·페이지·스텝 순서가 다릅니다.`);
    }
  }
}

// 명시적인 화면 재촬영만 새 화면 판본에 연결한다. 대본·순서·실제 편집점은
// 여전히 덱의 두 검사로 확인하고, 음성을 만든 판본은 별도로 보존한다.
export async function rebindDeckTimeline(deckRoot, siteDir, timeline, output) {
  const contract = JSON.parse(fs.readFileSync(path.join(siteDir, "production-input.json"), "utf8"));
  const { checkCaptureContract } = await deckTools(deckRoot);
  checkCaptureContract({ ...timeline, sourceContract: null }, contract);
  assertRecaptureScriptContract(timeline.entries, contract.states);
  await reviewDeckTimeline(deckRoot, { ...timeline, sourceContract: null }, output);
  return {
    ...timeline,
    voiceSourceContract: timeline.voiceSourceContract ?? timeline.sourceContract ?? null,
    sourceContract: contract.sourceContract,
  };
}
