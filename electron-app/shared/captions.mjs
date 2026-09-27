// 타임라인에서 자막 cue를 만든다. 순수 계산이라 렌더러도 읽을 수 있다.
// 자막 원문은 sourceText, 발음문은 ttsText다. 여기서 쓰는 쪽은 언제나 sourceText다.

const delimiterPenalty = (line) => {
  let penalty = ((line.match(/"/g) ?? []).length % 2) * 120;
  for (const [open, close] of [["“", "”"], ["‘", "’"], ["(", ")"], ["[", "]"]]) {
    const opens = [...line].filter((char) => char === open).length;
    const closes = [...line].filter((char) => char === close).length;
    if (opens !== closes) penalty += 120;
  }
  return penalty;
};

const semanticBonus = (first, second) => {
  let bonus = 0;
  if (/[,，;:—]$/.test(first)) bonus += 90;
  if (/^(그리고|하지만|그런데|그래서|그러면|다만|대신|반면|즉|또한|먼저|다음으로|결국)(?:\s|$)/.test(second)) {
    bonus += 70;
  }
  const lastWord = first.split(/\s+/).at(-1) ?? "";
  if (/(지만|는데|으며|면서|거나|니까|라서|다면|도록|때문에)$/.test(lastWord)) {
    bonus += 45;
  }
  return bonus;
};

const brokenPhrasePenalty = (first, second) => {
  const firstLast = first.split(/\s+/).at(-1) ?? "";
  const secondFirst = second.split(/\s+/)[0] ?? "";
  let penalty = 0;
  if (/^(한|첫|두|세|네|몇|이|그|저|어떤|같은|이런|그런)$/.test(firstLast)) {
    penalty += 180;
  }
  if (/^(것|건|걸|게|수|뿐|때|중|뒤|위|아래|안|밖|다|하나|문장|손|법|방법|장면|데|동안|승인|정리|이유)/.test(secondFirst)) {
    penalty += 180;
  }
  return penalty;
};

// 한 단어가 한도보다 긴 경우에만 쓰는 대비 경로: 앞에서부터 채우고 넘치는 단어는 글자로 자른다.
function greedyChunks(words, maxChars) {
  const chunks = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && [...candidate].length > maxChars) {
      chunks.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks.flatMap((chunk) => {
    if ([...chunk].length <= maxChars) return [chunk];
    const chars = [...chunk];
    const out = [];
    while (chars.length) out.push(chars.splice(0, maxChars).join(""));
    return out;
  });
}

// 단어 경계에서 parts개로 나누되 조각 길이를 고르게 한다. 쉼표·연결 어미 뒤는 선호하고
// 관형사 뒤·의존 명사 앞은 자르지 않는다. 한도를 넘는 조각이 생기면 null이다.
function balancedChunks(words, parts, maxChars, total) {
  const n = words.length;
  const target = total / parts;
  const text = (from, to) => words.slice(from, to).join(" ");
  const best = Array.from({ length: parts + 1 }, () => new Array(n + 1).fill(Infinity));
  const back = Array.from({ length: parts + 1 }, () => new Array(n + 1).fill(-1));
  best[0][0] = 0;
  for (let part = 1; part <= parts; part++) {
    for (let end = part; end <= n; end++) {
      for (let start = part - 1; start < end; start++) {
        if (best[part - 1][start] === Infinity) continue;
        const chunk = text(start, end);
        const length = [...chunk].length;
        if (length > maxChars) continue;
        let cost = (length - target) ** 2 + Math.max(0, 10 - length) * 100 + delimiterPenalty(chunk);
        if (end < n) {
          const rest = text(end, n);
          cost += brokenPhrasePenalty(chunk, rest) - semanticBonus(chunk, rest);
        }
        if (best[part - 1][start] + cost < best[part][end]) {
          best[part][end] = best[part - 1][start] + cost;
          back[part][end] = start;
        }
      }
    }
  }
  if (best[parts][n] === Infinity) return null;
  const chunks = [];
  for (let part = parts, end = n; part > 0; part--) {
    const start = back[part][end];
    chunks.unshift(text(start, end));
    end = start;
  }
  return chunks;
}

// 긴 문장은 조각 수를 최소로 하되 길이를 고르게 나눈다. 앞에서부터 채우면 문장 끝
// 서술어만 남은 조각(“씁니다.”)이 따로 짧게 뜬다.
function splitLongSentence(sentence, maxChars) {
  const total = [...sentence].length;
  if (total <= maxChars) return [sentence];
  const words = sentence.split(/\s+/).filter(Boolean);
  if (words.some((word) => [...word].length > maxChars)) return greedyChunks(words, maxChars);
  for (let parts = Math.ceil(total / maxChars); parts <= words.length; parts++) {
    const chunks = balancedChunks(words, parts, maxChars, total);
    if (chunks) return chunks;
  }
  return greedyChunks(words, maxChars);
}

function subtitleChunks(text, maxChars) {
  const sentences = text
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?。！？])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return sentences.flatMap((sentence) => splitLongSentence(sentence, maxChars));
}

function wrapSubtitle(text, maxLine) {
  if ([...text].length <= maxLine) return text;
  const words = text.split(/\s+/);
  if (words.length < 2) {
    const chars = [...text];
    return `${chars.slice(0, maxLine).join("")}\n${chars.slice(maxLine).join("")}`;
  }

  let best = null;
  for (let at = 1; at < words.length; at++) {
    const first = words.slice(0, at).join(" ");
    const second = words.slice(at).join(" ");
    const firstLength = [...first].length;
    const secondLength = [...second].length;
    const overflow = Math.max(0, firstLength - maxLine) +
      Math.max(0, secondLength - maxLine);
    const shortLinePenalty =
      Math.max(0, 8 - firstLength) * 30 +
      Math.max(0, 8 - secondLength) * 30;
    // Prefer a naturally filled first line. Equal-looking line lengths are a
    // weak visual preference, not a reason to cut a Korean noun phrase.
    const firstLineRag = Math.max(0, maxLine - firstLength) * 2;
    const score = overflow * 1000 +
      delimiterPenalty(first) +
      delimiterPenalty(second) +
      brokenPhrasePenalty(first, second) +
      shortLinePenalty +
      firstLineRag -
      semanticBonus(first, second);
    if (!best || score < best.score) best = { first, second, score };
  }
  return `${best.first}\n${best.second}`;
}

function srtTime(ms, separator = ",") {
  const value = Math.max(0, Math.round(ms));
  const h = Math.floor(value / 3600000);
  const m = Math.floor((value % 3600000) / 60000);
  const s = Math.floor((value % 60000) / 1000);
  const milli = value % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${separator}${String(milli).padStart(3, "0")}`;
}

export const CAPTION_LIMITS = Object.freeze({ maxCharsPerCue: 46, maxCharsPerLine: 24 });

const alignmentToken = (text) => String(text ?? "").replace(/[^\p{L}\p{N}']/gu, "");
const HANGUL_ONLY = /^[가-힣]+$/;
const HANGUL_TAIL = /[가-힣]+$/;
const MAX_WORDS_PER_TOKEN = 8;

// 대본 토큰을 발음 단어에 대응시킨다. 숫자·영문이 든 토큰은 여러 단어로 읽힌다
// (“30점” → “삼십 점”, “9월 6일에” → “구월 육 일에”). 한글만인 토큰은 같은 단어로, 섞인 토큰은
// 대응한 마지막 단어가 그 토큰의 한글 꼬리(“점과”·“라면”)로 끝나야 싸다.
// 결과는 토큰별 [시작, 끝) 단어 번호이고, 대응할 수 없으면 null이다.
function alignSourceTokens(tokens, spoken) {
  const n = tokens.length;
  const m = spoken.length;
  if (!n || !m) return null;
  const cost = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(Infinity));
  const back = Array.from({ length: n + 1 }, () => new Int8Array(m + 1).fill(-1));
  cost[0][0] = 0;
  for (let i = 0; i < n; i++) {
    const token = tokens[i];
    const pure = HANGUL_ONLY.test(token);
    const tail = pure ? "" : token.match(HANGUL_TAIL)?.[0] ?? "";
    for (let j = 0; j <= m; j++) {
      if (cost[i][j] === Infinity) continue;
      // 읽히지 않은 토큰(k=0)은 발음문이 두 토큰을 한 단어로 합친 드문 경우라 비싸다.
      for (let k = 0; k <= MAX_WORDS_PER_TOKEN && j + k <= m; k++) {
        let step;
        if (k === 0) step = 10;
        else if (pure) step = k === 1 && spoken[j] === token ? 0 : spoken.slice(j, j + k).join("") === token ? 3 * k : 8 * k;
        else if (tail) step = (spoken[j + k - 1].endsWith(tail) ? 0 : 6) + 0.1 * k;
        else step = 0.5 * k;
        if (cost[i][j] + step < cost[i + 1][j + k]) {
          cost[i + 1][j + k] = cost[i][j] + step;
          back[i + 1][j + k] = k;
        }
      }
    }
  }
  if (cost[n][m] === Infinity) return null;
  const spans = new Array(n);
  for (let i = n, j = m; i > 0; i--) {
    const k = back[i][j];
    spans[i - 1] = [j - k, j];
    j -= k;
  }
  return spans;
}

// 대응이 없을 때의 옛 배분: 토큰 수가 단어 수와 같으면 토큰 수, 아니면 글자 수에 비례.
function proportionalWordRanges(chunks, tokens, wordCount) {
  const exactCounts = tokens.map((list) => list.length);
  const exactTotal = exactCounts.reduce((sum, value) => sum + value, 0);
  const weights = exactTotal === wordCount ? exactCounts : chunks.map((chunk) => Math.max(1, [...chunk].length));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const ranges = [];
  let wordStart = 0;
  let cumulativeWeight = 0;
  chunks.forEach((_, index) => {
    cumulativeWeight += weights[index];
    const wordEnd = index === chunks.length - 1
      ? wordCount
      : Math.max(
          wordStart + 1,
          Math.min(wordCount - (chunks.length - index - 1), Math.round((cumulativeWeight / totalWeight) * wordCount)),
        );
    ranges.push([wordStart, wordEnd]);
    wordStart = wordEnd;
  });
  return ranges;
}

// 자막 조각마다 그 글이 실제로 읽히는 단어 범위 [시작, 끝)을 정한다. 글자 수 비례로 나누면
// 숫자·영문이 든 문장에서 경계가 한두 단어 밀려 자막이 말보다 먼저 바뀐다.
function chunkWordRanges(chunks, words) {
  const tokens = chunks.map((chunk) => chunk.split(/\s+/).map(alignmentToken).filter(Boolean));
  const spans = tokens.every((list) => list.length)
    ? alignSourceTokens(tokens.flat(), words.map((word) => alignmentToken(word.text)))
    : null;
  if (spans) {
    let cursor = 0;
    const ranges = tokens.map((list) => {
      const range = [spans[cursor][0], spans[cursor + list.length - 1][1]];
      cursor += list.length;
      return range;
    });
    if (ranges.every(([from, to]) => to > from)) return ranges;
  }
  return proportionalWordRanges(chunks, tokens, words.length);
}

export function buildCaptionCues(timeline, { maxCharsPerCue, maxCharsPerLine } = CAPTION_LIMITS) {
  const cues = [];
  for (const entry of timeline.entries) {
    const chunks = subtitleChunks(entry.sourceText, maxCharsPerCue);
    const words = entry.alignment?.words?.filter((word) =>
      Number.isFinite(word.startMs) && Number.isFinite(word.endMs)
    );

    if (words?.length) {
      const ranges = chunkWordRanges(chunks, words);
      const corrected = Boolean(entry.alignment?.correction);
      chunks.forEach((chunk, index) => {
        const [wordStart, wordEnd] = ranges[index];
        const nextWord = words[wordEnd];
        const startMs = Math.max(0, corrected ? Number(entry.startMs) || 0 : 0, words[wordStart].startMs - 60);
        const endMs = nextWord
          ? Math.max(startMs + 120, nextWord.startMs - 40)
          : Math.min(timeline.totalMs, Math.max(startMs + 120, words[wordEnd - 1].endMs + 100,
              corrected ? Number(entry.endMs) || 0 : 0));
        cues.push({
          startMs: Math.round(startMs),
          endMs: Math.round(endMs),
          text: wrapSubtitle(chunk, maxCharsPerLine),
        });
      });
      continue;
    }

    // Providers without word alignment retain proportional timing as a
    // clearly isolated fallback.
    cues.push(...proportionalCues(chunks, entry.startMs, entry.endMs, maxCharsPerLine));
  }

  return settleCues(cues, timeline.totalMs);
}

// 글자 수에 비례해 놓는다. 단어 정렬이 없는 강의의 대비 경로이자, 정렬할 원문이
// 없는 앱 데모 대본의 기본 경로다.
function proportionalCues(chunks, startMs, endMs, maxCharsPerLine) {
  const weights = chunks.map((chunk) => Math.max(1, [...chunk].length));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const cues = [];
  let cursor = startMs;
  chunks.forEach((chunk, index) => {
    const stopMs = index === chunks.length - 1
      ? endMs
      : cursor + ((endMs - startMs) * weights[index]) / totalWeight;
    cues.push({
      startMs: Math.round(cursor),
      endMs: Math.round(stopMs),
      text: wrapSubtitle(chunk, maxCharsPerLine),
    });
    cursor = stopMs;
  });
  return cues;
}

function settleCues(cues, totalMs) {
  for (let index = 1; index < cues.length; index++) {
    cues[index - 1].endMs = Math.min(
      cues[index - 1].endMs,
      Math.max(cues[index - 1].startMs + 120, cues[index].startMs - 20),
    );
  }

  if (cues.some((cue) => cue.text.split("\n").length > 2)) {
    throw new Error("2줄을 초과한 자막이 있습니다.");
  }
  if (cues.at(-1)?.endMs > totalMs) {
    throw new Error("자막이 영상 타임라인을 벗어났습니다.");
  }
  return cues;
}

/**
 * 말할 구간 목록에서 자막 cue를 만든다.
 *
 * `spans`는 `{ text, startMs, durationMs }`다. 앱 데모는 대본을 화면에 맞춰 쓴 것이
 * 아니라 찍은 뒤에 쓴 것이라 단어 정렬이 없다. 장면 음성 길이 안에서 글자 수에
 * 비례해 놓는다.
 */
export function buildSpanCues(spans, totalMs, { maxCharsPerCue, maxCharsPerLine } = CAPTION_LIMITS) {
  const cues = [];
  for (const span of spans) {
    if (!span.text?.trim() || !(span.durationMs > 0)) continue;
    const chunks = subtitleChunks(span.text, maxCharsPerCue);
    cues.push(...proportionalCues(chunks, span.startMs, span.startMs + span.durationMs, maxCharsPerLine));
  }
  return settleCues(cues, totalMs);
}

export function captionsToSrt(cues) {
  return cues.map((cue, index) => [
    String(index + 1),
    `${srtTime(cue.startMs)} --> ${srtTime(cue.endMs)}`,
    cue.text,
  ].join("\n")).join("\n\n") + "\n";
}

export function captionsToVtt(cues) {
  return "WEBVTT\n\n" + cues.map((cue) => [
    `${srtTime(cue.startMs, ".")} --> ${srtTime(cue.endMs, ".")}`,
    cue.text,
  ].join("\n")).join("\n\n") + "\n";
}
