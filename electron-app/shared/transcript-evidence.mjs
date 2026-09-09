// Presentation evidence only. Existing reports already carry the verdict and
// transcript; recovering a missing clause here must never invent a new verdict.
export function textWords(text = '') {
  return [...String(text).matchAll(/[가-힣]+|[A-Za-z0-9]+/g)].map(match => ({
    text: match[0], start: match.index, end: match.index + match[0].length,
    key: match[0].toLowerCase().normalize('NFD').replace(/ᅢ/g, 'ᅦ')
      .replace(/ᄁ/g, 'ᄀ').replace(/ᄄ/g, 'ᄃ').replace(/ᄈ/g, 'ᄇ').replace(/ᄊ/g, 'ᄉ').replace(/ᄍ/g, 'ᄌ'),
  }));
}

export function omissionEvidence(finding = {}) {
  const expected = String(finding.expectedText || '');
  const recorded = (finding.contentChecks || []).filter(check => check.kind === 'omission'
    && Number.isInteger(check.expectedStart) && Number.isInteger(check.expectedEnd)
    && check.expectedStart >= 0 && check.expectedEnd > check.expectedStart
    && check.expectedEnd <= expected.length
    && expected.slice(check.expectedStart, check.expectedEnd) === check.text);
  if (recorded.length) return recorded;
  if (!finding.recognizedText || !(finding.reasons || []).some(reason => /누락|불일치|오독|발음/.test(reason))) return [];
  const a = textWords(expected), b = textWords(finding.recognizedText);
  // Reports contain short TTS chunks. Refuse unbounded imported transcripts.
  if (!a.length || !b.length || a.length * b.length > 250_000) return [];
  const dp = Array.from({length: a.length + 1}, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    dp[i][j] = a[i].key === b[j].key ? 1 + dp[i+1][j+1] : Math.max(dp[i+1][j], dp[i][j+1]);
  const edits = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i].key === b[j].key) { i++; j++; continue; }
    const start = i, heardStart = j;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i].key === b[j].key) break;
      if (i < a.length && (j === b.length || dp[i+1][j] >= dp[i][j+1])) i++; else j++;
    }
    // A substitution or space-normalized phrase is not a clean deletion.
    const words = a.slice(start, i);
    if (j !== heardStart || words.length < 3 || words.some(w => !/^[가-힣]+$/.test(w.text))
      || words.reduce((sum, w) => sum + w.text.length, 0) < 10) continue;
    const expectedStart = words[0].start, expectedEnd = words.at(-1).end;
    edits.push({kind: 'omission', expectedStart, expectedEnd, text: expected.slice(expectedStart, expectedEnd),
      reason: '받아쓰기에서 구절 누락', basis: 'saved-transcript'});
  }
  return edits;
}

export function findingStatus(finding = {}) {
  const count = omissionEvidence(finding).length;
  const kind = count ? `${finding.severity === 'failed' ? '재생성 필요 · ' : ''}구절 누락 의심${count > 1 ? ` ${count}곳` : ''}`
    : finding.severity === 'failed' ? '재생성 필요' : '청취 확인 권장';
  return Number(finding.attempts) > 1
    ? `${kind} · ${finding.attempts}회 생성 후 미해결` : kind;
}
