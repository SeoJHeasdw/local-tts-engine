// 목소리 후보 하나가 입력 문장을 어떻게 읽었는지 — 따라 읽기와 일치율에 쓰는 기록.
// 음성 파일 해시에 묶인 기록만 쓴다. 해시가 없는 옛 기록은 어느 음성에 대한 것인지
// 알 수 없으므로 아무것도 보여 주지 않는다.

const isTime = (value) => Number.isFinite(value) && value >= 0;

// [start, end, startMs, endMs] — 입력 문장의 글자 범위와 그 단어를 읽는 시간.
// 읽지 않는 단어(구두점만 있는 낱말)는 시간이 null이다. 어긋난 기록은 통째로 버린다:
// 반쯤 맞는 강조는 아예 없는 것보다 사용자를 더 헷갈리게 한다.
export function validWords(sourceText, wordTimings) {
  if (typeof sourceText !== "string" || !sourceText) return null;
  if (!["ok", "partial"].includes(wordTimings?.status) || !Array.isArray(wordTimings.words)) return null;
  const words = [];
  let cursor = 0;
  let lastMs = 0;
  for (const word of wordTimings.words) {
    if (!Array.isArray(word) || word.length !== 4) return null;
    const [start, end, startMs, endMs] = word;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < cursor || end <= start
      || end > sourceText.length || /\s/.test(sourceText.slice(start, end))) return null;
    const timed = startMs !== null || endMs !== null;
    if (timed && (!isTime(startMs) || !isTime(endMs) || endMs < startMs || startMs < lastMs)) return null;
    if (timed) lastMs = startMs;
    words.push({ start, end, startMs: timed ? startMs : null, endMs: timed ? endMs : null });
    cursor = end;
  }
  return words.some((word) => word.startMs !== null) ? words : null;
}

// 받아쓰기 일치율. 음성 검수가 이미 쓰는 발음 오차율(발음이 같은 표기 차이는 같은 것으로 본다)을
// 청크의 글자 수로 가중 평균한다. 검수를 하지 않은 후보는 null이다. 정확히 0일 때만 100%이고,
// 그 밖에는 올림하지 않는다 — 99.6%를 100%로 보여 주면 틀린 곳이 없다는 말로 읽힌다.
export function readingMatch(metadata) {
  if (!metadata?.audioSha256 || !metadata.qualityReview?.enabled) return null;
  let weight = 0;
  let error = 0;
  for (const chunk of metadata.chunks || []) {
    const rate = chunk?.quality?.phoneticErrorRate;
    if (!Number.isFinite(rate)) continue;
    const size = Math.max(1, String(chunk.ttsText || "").replace(/\s+/g, "").length);
    weight += size;
    error += Math.min(1, Math.max(0, rate)) * size;
  }
  if (!weight) return null;
  const average = error / weight;
  return { percent: average === 0 ? 100 : Math.min(99, Math.floor((1 - average) * 100)), checkedChars: weight };
}

// 검수 모델이 이 음성에서 들은 말. 입력과 다르게 들린 곳을 사용자가 직접 확인하는 근거다.
export function heardText(metadata) {
  if (!metadata?.audioSha256 || !metadata.qualityReview?.enabled) return "";
  return (metadata.chunks || [])
    .map((chunk) => String(chunk?.quality?.recognizedText || "").trim())
    .filter(Boolean)
    .join(" ");
}

// 영어 음성으로 따로 읽은 구간(후보 음성 안의 ms). 어떤 문장이 영어로 갔는지 눈으로 보게 한다.
export function englishSpans(metadata) {
  if (!metadata?.audioSha256) return [];
  return (metadata.voiceRouting?.segments || [])
    .filter((segment) => segment?.language === "English"
      && isTime(segment.startMs) && Number.isFinite(segment.durationMs) && segment.durationMs > 0)
    .map((segment) => [segment.startMs, segment.startMs + segment.durationMs]);
}

export function candidateReading(metadata) {
  if (!metadata?.audioSha256 || typeof metadata.sourceText !== "string") return null;
  return {
    sourceText: metadata.sourceText,
    words: validWords(metadata.sourceText, metadata.wordTimings),
    match: readingMatch(metadata),
    heard: heardText(metadata),
    englishSpans: englishSpans(metadata),
  };
}
