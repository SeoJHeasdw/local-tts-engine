// 타임라인에서 자막 cue를 만든다. 순수 계산이라 렌더러도 읽을 수 있다.
// 자막 원문은 sourceText, 발음문은 ttsText다. 여기서 쓰는 쪽은 언제나 sourceText다.

function splitLongSentence(sentence, maxChars) {
  if ([...sentence].length <= maxChars) return [sentence];
  const words = sentence.split(/\s+/);
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

export function buildCaptionCues(timeline, { maxCharsPerCue, maxCharsPerLine } = CAPTION_LIMITS) {
  const cues = [];
  for (const entry of timeline.entries) {
    const chunks = subtitleChunks(entry.sourceText, maxCharsPerCue);
    const words = entry.alignment?.words?.filter((word) =>
      Number.isFinite(word.startMs) && Number.isFinite(word.endMs)
    );

    if (words?.length) {
      const tokenCount = (text) => text
        .split(/\s+/)
        .map((token) => token.replace(/[^\p{L}\p{N}']/gu, ""))
        .filter(Boolean)
        .length;
      const exactCounts = chunks.map(tokenCount);
      const exactTotal = exactCounts.reduce((sum, value) => sum + value, 0);
      const weights = exactTotal === words.length
        ? exactCounts
        : chunks.map((chunk) => Math.max(1, [...chunk].length));
      const totalWeight = weights.reduce((sum, value) => sum + value, 0);
      let wordStart = 0;
      let cumulativeWeight = 0;

      chunks.forEach((chunk, index) => {
        cumulativeWeight += weights[index];
        const wordEnd = index === chunks.length - 1
          ? words.length
          : Math.max(
              wordStart + 1,
              Math.min(
                words.length - (chunks.length - index - 1),
                Math.round((cumulativeWeight / totalWeight) * words.length),
              ),
            );
        const nextWord = words[wordEnd];
        const startMs = Math.max(0, words[wordStart].startMs - 60);
        const endMs = nextWord
          ? Math.max(startMs + 120, nextWord.startMs - 40)
          : Math.max(startMs + 120, words[wordEnd - 1].endMs + 100);
        cues.push({
          startMs: Math.round(startMs),
          endMs: Math.round(endMs),
          text: wrapSubtitle(chunk, maxCharsPerLine),
        });
        wordStart = wordEnd;
      });
      continue;
    }

    // Providers without word alignment retain proportional timing as a
    // clearly isolated fallback.
    const weights = chunks.map((chunk) => Math.max(1, [...chunk].length));
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    let cursor = entry.startMs;
    chunks.forEach((chunk, index) => {
      const endMs = index === chunks.length - 1
        ? entry.endMs
        : cursor + ((entry.endMs - entry.startMs) * weights[index]) / totalWeight;
      cues.push({
        startMs: Math.round(cursor),
        endMs: Math.round(endMs),
        text: wrapSubtitle(chunk, maxCharsPerLine),
      });
      cursor = endMs;
    });
  }

  for (let index = 1; index < cues.length; index++) {
    cues[index - 1].endMs = Math.min(
      cues[index - 1].endMs,
      Math.max(cues[index - 1].startMs + 120, cues[index].startMs - 20),
    );
  }

  if (cues.some((cue) => cue.text.split("\n").length > 2)) {
    throw new Error("2줄을 초과한 자막이 있습니다.");
  }
  if (cues.at(-1)?.endMs > timeline.totalMs) {
    throw new Error("자막이 영상 타임라인을 벗어났습니다.");
  }
  return cues;
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
