export function summarizeChecks(checks) {
  const failed = checks.filter((item) => !item.ok);
  return {
    ok: failed.length === 0,
    passed: checks.length - failed.length,
    total: checks.length,
    failed: failed.map((item) => item.label),
  };
}

// 시간 정렬 경고는 파일 무결성 실패나 발음 재생성 판정과 분리한다.
export function alignmentWarnings(quality) {
  if (!quality || quality.status === 'passed') return [];
  if (['not-checked', 'failed', 'error'].includes(quality.status)) {
    return [`자막·화면 정렬 검사를 완료하지 못했습니다${quality.error ? `: ${quality.error}` : '.'}`];
  }
  const summary = quality.summary || {};
  const warnings = [
    [summary.alignmentEndBeyond250Ms, '말 끝과 정렬 끝이 0.25초 넘게 어긋난 스텝'],
    [summary.transitions, '목소리 위에 걸린 화면 전환'],
    [summary.earlyCaptionsOver20Ms ?? summary.earlyCaptions, '말보다 먼저 사라진 자막'],
    [summary.collapsedWords, '지나치게 짧게 정렬된 단어'],
    [summary.implausibleWords, '음절 수에 비해 지나치게 짧게 정렬된 단어'],
    [summary.missingCaptionSteps, '자막이 확인되지 않은 스텝'],
    [summary.captionTextIssues, '제 말과 어긋난 자막'],
    [summary.captionTextMismatches, '대본과 대응하지 않는 자막'],
  ].filter(([count]) => Number(count) > 0)
    .map(([count, label]) => `자막·화면 정렬 확인: ${label} ${count}곳`);
  if (!warnings.length && (quality.status === 'warning' || Number(quality.warningCount) > 0)) {
    warnings.push(Number(quality.warningCount) > 0
      ? `자막·화면 정렬 확인: 경고 ${quality.warningCount}곳`
      : '자막·화면 정렬에 확인할 경고가 있습니다.');
  }
  return warnings;
}

// 결과 목록과 다듬기는 같은 경고 목록을 읽는다. 파형 검사에서 약한 말끝을
// 단어로 확정하지 않은 경우, 단어 누락으로 단정하지 않고 청취 후보로 남긴다.
export function outputReviewWarnings(report = {}) {
  report ||= {};
  const quality = report.alignmentQuality;
  const findings = quality?.findings || {};
  const rows = value => Array.isArray(value) ? value : [];
  const records = value => rows(value).filter(item => item && typeof item === 'object' && !Array.isArray(item));
  const repairs = records(quality?.repairWarnings);
  const issues = [];
  const finite = value => value != null && Number.isFinite(Number(value)) ? Number(value) : null;
  const add = (key, title, detail, startMs = null, endMs = null, kind = 'alignment') => {
    const start = finite(startMs), end = finite(endMs);
    issues.push({ key, title, detail, kind, startMs: start, endMs: end != null && end > start ? end : start });
  };
  const endFindings = records(findings.alignmentEnd);
  const matchedEnds = new Set();
  for (const [index, warning] of repairs.entries()) {
    const step = quality?.stepMeasurements?.[Number(warning.entry)] || {};
    const start = finite(warning.startMs) ?? finite(warning.atMs) ?? finite(step.startMs);
    const end = finite(warning.endMs) ?? finite(step.endMs) ?? start;
    if (warning.type === 'unassigned-weak-tail') {
      const matchIndex = endFindings.findIndex((finding, candidate) => !matchedEnds.has(candidate)
        && Math.abs(Number(finding.waveformEndMs) - Number(end)) <= 300);
      const match = matchIndex >= 0 ? endFindings[matchIndex] : null;
      if (match) matchedEnds.add(matchIndex);
      const length = start != null && end != null ? Math.round(end - start) : null;
      const delta = finite(match?.endDeltaMs);
      // 어디를 들을지 말한다: 그 스텝 문장의 끝과 약한 소리 바로 앞 단어.
      const word = typeof warning.lastWord === 'string' && warning.lastWord ? `‘${warning.lastWord}’` : '';
      const sentence = typeof warning.sentenceEnd === 'string' && warning.sentenceEnd ? `“${warning.sentenceEnd}” ` : '';
      const detail = `${sentence}${word ? `끝 단어 ${word} 뒤의 ` : '마지막 '}${length ?? '?'}ms 소리는 약해 단어로 확정하지 않았습니다.`
        + (delta != null ? ` 단어 정렬 끝과 파형 끝은 약 ${Math.round(Math.abs(delta))}ms 차이입니다.` : '')
        + ' 실제 발화인지, 자막이 먼저 끝나는지 직접 듣고 확인하세요.';
      add(`alignment:weak-tail:${warning.entry}:${Math.round(start ?? 0)}`,
        word ? `말끝의 약한 소리 확인 · ${word} 뒤` : '말끝의 약한 소리 확인', detail, start, end);
      continue;
    }
    const titles = {
      'missing-transition-words': '화면 전환의 단어 시각 없음',
      'no-nearby-transition-silence': '화면 전환 근처 쉼 없음',
      'missing-words': '정렬된 단어 없음',
      'missing-speech': '말소리 구간 확인 필요',
      'ambiguous-speech-islands': '말소리 구간 배치 확인 필요',
    };
    const title = titles[warning.type] || '정렬 교정 확인 필요';
    add(`alignment:repair:${warning.type}:${warning.entry}:${index}`, title,
      `${Number.isInteger(Number(warning.entry)) ? `${Number(warning.entry) + 1}번째 스텝 · ` : ''}교정 과정에서 자동으로 확정하지 못했습니다. 해당 화면과 음성을 확인하세요.`, start, end);
  }
  for (const [index, finding] of endFindings.entries()) {
    if (matchedEnds.has(index)) continue;
    const aligned = finite(finding.alignmentEndMs), waveform = finite(finding.waveformEndMs);
    const at = aligned != null && waveform != null ? Math.min(aligned, waveform) : finite(finding.startMs);
    const lastWord = typeof finding.lastWord === 'string' && finding.lastWord ? ` 끝 단어 ‘${finding.lastWord}’ 부근을 들어 보세요.` : '';
    add(`alignment:end:${finding.step}:${Math.round(at ?? 0)}`, '말끝 정렬 차이',
      `단어 정렬 끝과 파형 끝이 약 ${Math.round(Math.abs(Number(finding.endDeltaMs) || 0))}ms 차이입니다. 실제 말끝과 자막 끝을 확인하세요.${lastWord}`,
      at, Math.max(aligned ?? at ?? 0, waveform ?? at ?? 0));
  }
  for (const [index, finding] of records(findings.transitions).entries()) {
    add(`alignment:transition:${index}:${Math.round(Number(finding.transitionMs) || 0)}`,
      '목소리 위 화면 전환', '말하는 도중 화면이 넘어갔을 수 있습니다. 전환 앞뒤를 확인하세요.',
      finding.transitionMs, finding.transitionMs);
  }
  for (const [index, finding] of (records(findings.captionCoverage).length ? records(findings.captionCoverage) : records(findings.captions)).entries()) {
    add(`alignment:caption:${finding.step}:${index}:${Math.round(Number(finding.cueEndMs) || 0)}`,
      '자막이 말보다 먼저 사라짐', '말이 끝나기 전에 자막이 사라졌을 수 있습니다. 이 부분을 확인하세요.',
      finding.cueEndMs, finding.cueEndMs);
  }
  const captionTextTitles = {
    'early-end': ['자막이 제 말보다 먼저 사라짐', '이 자막의 말이 끝나기 전에 다음 자막으로 바뀝니다.'],
    'during-previous': ['자막이 앞 문장을 말하는 중에 뜸', '앞 자막의 말이 끝나기 전에 이 자막이 먼저 뜹니다.'],
    'late-start': ['자막이 말보다 늦게 뜸', '이 자막의 말이 시작된 뒤에야 자막이 뜹니다.'],
  };
  for (const [index, finding] of records(findings.captionText).entries()) {
    const [title, detail] = captionTextTitles[finding.type] || ['자막과 말의 시각 확인', '이 자막과 말의 시각을 확인하세요.'];
    add(`alignment:caption-text:${finding.step}:${finding.type}:${index}:${Math.round(Number(finding.cueStartMs) || 0)}`,
      title, `“${finding.text || ''}” — ${detail}`,
      Math.min(Number(finding.cueStartMs), Number(finding.speechStartMs)), Math.max(Number(finding.cueEndMs), Number(finding.speechEndMs)));
  }
  for (const [index, finding] of records(findings.captionTextMismatch).entries()) {
    add(`alignment:caption-text-mismatch:${finding.step}:${index}`, '대본과 대응하지 않는 자막',
      '자막 글이 대본이나 정렬 단어와 맞지 않아 이 뒤의 자막 시각을 검사하지 못했습니다.');
  }
  for (const [kind, title] of [['collapsedWords', '지나치게 짧은 단어 시각'],
    ['implausibleWords', '음절 수에 비해 짧은 단어 시각'], ['missingCaptions', '자막이 없는 스텝']]) {
    for (const [index, finding] of records(findings[kind]).entries()) {
      add(`alignment:${kind}:${finding.step}:${index}:${Math.round(Number(finding.startMs) || 0)}`,
        title, finding.text ? `“${finding.text}”의 자막·말 시각을 확인하세요.` : '이 구간의 자막과 화면을 확인하세요.',
        finding.startMs, finding.endMs);
    }
  }
  const generated = alignmentWarnings(quality);
  if (!issues.length) for (const [index, warning] of generated.entries()) {
    add(`alignment:summary:${index}:${warning}`, warning,
      '정렬 검사에 정확한 구간 기록이 없습니다. 영상과 자막을 직접 확인하세요.');
  }
  for (const [index, warning] of rows(report.warnings).entries()) {
    if (typeof warning !== 'string' || !warning.trim() || generated.includes(warning)) continue;
    add(`result:${index}:${warning}`, warning, '결과 기록에 남은 경고입니다. 해당 영상을 확인하세요.', null, null, 'result');
  }
  return issues.sort((left, right) => (left.startMs ?? Infinity) - (right.startMs ?? Infinity));
}

export function clearedOutputReviewWarningKeys(report = {}) {
  report ||= {};
  return (report.review?.clearedReviewWarnings || []).map(String);
}

export function withClearedOutputReviewWarnings(report, keys = [], now = new Date()) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('확인 표시를 저장할 결과가 없습니다.');
  const allowed = new Set(outputReviewWarnings(report).map(issue => issue.key));
  const cleared = [...new Set(keys.map(String).filter(key => allowed.has(key)))];
  return { ...report, review: { ...(report.review || {}), clearedReviewWarnings: cleared, updatedAt: now.toISOString() } };
}

export function voiceFindingSeverity(chunk = {}) {
  const recorded = String(chunk.severity || "");
  if (recorded) return recorded;
  // Manifests written before severity existed only knew pass and fail, and a
  // failure then meant the page had to be made again.
  return chunk.selected?.passed === false ? "failed" : "ok";
}

export function voiceQualityFindings(manifest = {}) {
  const timings = new Map(
    (manifest.chunks || []).map((chunk) => [String(chunk.key || ""), chunk]),
  );
  const byChunk = new Map();
  const findings = (manifest.quality?.chunks || [])
    .map((chunk) => ({ chunk, severity: voiceFindingSeverity(chunk) }))
    .filter(({ severity }) => severity === "failed" || severity === "warning")
    .map(({ chunk, severity }) => {
      const timing = timings.get(String(chunk.chunkKey || "")) || {};
      const selected = chunk.selected || {};
      const reasons = [...(selected.failures || []), ...(selected.warnings || [])].map(String);
      const pauses = [...(selected.prosody?.checks || []), ...(selected.restarts?.checks || []), ...(selected.boundaryPauses?.checks || [])];
      const onlyPauses = pauses.length > 0 && reasons.every((reason) => ["단어 내부 끊김 확인 필요", "짧은 발음 반복 확인 필요", "낱말 사이 끊김 확인 필요"].includes(reason));
      const englishChecks = (selected.englishChecks || []).filter(check => !check.passed);
      const onlyEnglish = englishChecks.length > 0 && reasons.every(reason => reason === "영어 구절 받아쓰기 확인 필요");
      const clipStart = Number(timing.startMs || 0);
      const finding = {
        chapter: String(chunk.chapter || ""),
        slideId: String(chunk.slideId || ""),
        slideNumber: Number(chunk.slideNumber || 0),
        startMs: onlyEnglish ? clipStart + Math.min(...englishChecks.map(check => check.startMs)) : onlyPauses ? clipStart + Math.min(...pauses.map((check) => check.startMs)) : clipStart,
        endMs: onlyEnglish ? clipStart + Math.max(...englishChecks.map(check => check.startMs + check.durationMs)) : onlyPauses ? clipStart + Math.max(...pauses.map((check) => check.endMs)) : Number(timing.endMs || timing.startMs || 0),
        severity,
        reasons: reasons.length ? reasons : ["자동 음성 검수 점수 미달"],
        // 어떤 표기로 들렸는지가 곧 판단 근거다. 지정한 발음과 다르게 들렸다면
        // 그 표기를 함께 적어야, 읽어 보지 않고도 무엇을 확인할지 알 수 있다.
        terms: [...(selected.pronunciationChecks || []), ...pauses]
          .filter((check) => check?.status && check.status !== "ok")
          .map((check) => ({ term: String(check.term || ""), status: String(check.status),
            ...(check.heardReading ? { heard: String(check.heardReading) } : {}) })),
        expectedText: String(selected.expectedText || ""),
        recognizedText: String(selected.recognizedText || ""),
        ...(selected.contentChecks?.length ? {contentChecks: selected.contentChecks} : {}),
        ...(englishChecks.length ? {englishChecks} : {}),
        ...(selected.recovery ? {recovery: selected.recovery} : {}),
        selectedAttempt: Number(selected.attempt || 1),
        attempts: Array.isArray(chunk.candidates) ? chunk.candidates.length : 1,
      };
      byChunk.set(String(chunk.chunkKey || ""), finding);
      return finding;
    });
  const entriesByChunk = new Map();
  for (const entry of manifest.entries || []) {
    for (const key of entry.chunkKeys || [entry.chunkKey]) {
      if (!key) continue;
      if (!entriesByChunk.has(key)) entriesByChunk.set(key, []);
      entriesByChunk.get(key).push(entry);
    }
  }
  for (const [key, entries] of entriesByChunk) {
    const unresolved = entries.filter(entry => entry.unresolved_tokens?.length || entry.naturalness_warnings?.length);
    if (!unresolved.length) continue;
    const timing = timings.get(key);
    if (!timing) continue;
    const terms = [...new Set(unresolved.flatMap(entry => entry.unresolved_tokens || []))];
    const reason = "발음 사전 미등록 · 제작 후 읽기 확인";
    const existing = byChunk.get(key);
    if (existing) {
      existing.reasons = [...new Set([...existing.reasons, reason])];
      existing.terms.push(...terms.filter(term => !existing.terms.some(item => item.term === term))
        .map(term => ({ term, status: 'unresolved' })));
      // A narrow ASR warning must not hide another unknown term in the same clip.
      existing.startMs = Math.min(existing.startMs, Number(timing.startMs));
      existing.endMs = Math.max(existing.endMs, Number(timing.endMs));
      continue;
    }
    const quality = (manifest.quality?.chunks || []).find(chunk => chunk.chunkKey === key);
    const finding = {
      chapter: entries[0].chapter, slideId: entries[0].slide_id,
      slideNumber: Number(entries[0].slide_number),
      startMs: Number(timing.startMs), endMs: Number(timing.endMs),
      severity: 'warning', kind: 'pronunciation-unresolved', reasons: [reason],
      terms: terms.map(term => ({ term, status: 'unresolved' })),
      expectedText: quality?.selected?.expectedText || entries.map(entry => entry.tts_text || entry.source_text).join(' '),
      recognizedText: quality?.selected?.recognizedText || '',
    };
    findings.push(finding);
    byChunk.set(key, finding);
  }
  // The delivered normalized track has its own ASR pass. Show only concerns
  // that were not already attached to the selected source clip; the original
  // candidate verdict and a person's listening decision remain separate.
  for (const item of manifest.quality?.finalTrack?.transcript?.chunks || []) {
    const concerns = Array.isArray(item.newConcerns) ? item.newConcerns.map(String).filter(Boolean) : [];
    if (!concerns.length) continue;
    const key = String(item.chunkKey || "");
    const reasons = concerns.map((reason) => `완성 음성 재판독 · ${reason}`);
    const finalTrackEvidence = {
      recognizedText: String(item.recognizedText || ""),
      startMs: Number(item.startMs ?? 0), endMs: Number(item.endMs ?? item.startMs ?? 0),
    };
    const existing = byChunk.get(key);
    if (existing) {
      existing.reasons = [...new Set([...existing.reasons, ...reasons])];
      existing.finalTrackEvidence = finalTrackEvidence;
      continue;
    }
    const timing = timings.get(key) || {};
    findings.push({
      chapter: String(item.chapter || ""), slideId: String(item.slideId || ""),
      slideNumber: Number(item.slideNumber || 0),
      startMs: Number(item.startMs ?? timing.startMs ?? 0),
      endMs: Number(item.endMs ?? timing.endMs ?? item.startMs ?? 0),
      severity: "warning", kind: "final-track-review", reasons, terms: [],
      expectedText: String((manifest.quality?.chunks || []).find((chunk) => chunk.chunkKey === key)?.selected?.expectedText || ""),
      recognizedText: String(item.recognizedText || ""),
      finalTrackEvidence,
    });
  }
  return findings.sort((left, right) => left.startMs - right.startMs || left.slideNumber - right.slideNumber);
}

export function combineChapterReports(options, reports, failedUnits = []) {
  const checks = [...reports.flatMap(report => report.checks || []),
    ...failedUnits.map(unit => ({ label: `${unit.title || unit.name} 제작 실패`, ok: false }))];
  const voiceFindings = reports.flatMap(report => (report.voiceFindings || []).map(finding => ({
    ...finding, target: report.target, displayName: report.displayName || report.name,
  })));
  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(), name: options.name,
    displayName: options.title, mode: options.mode, chapterMode: options.chapterMode,
    durationMs: reports.reduce((sum, report) => sum + Number(report.durationMs || 0), 0),
    videoPath: reports.length === 1 ? reports[0].videoPath : null,
    audioPath: reports.length === 1 ? reports[0].audioPath : null,
    target: reports[0]?.target || null,
    voiceQuality: reports.length === 1 ? reports[0].voiceQuality : reports.length && reports.every(report => report.voiceQuality) ? {
      ok: reports.every(report => report.voiceQuality.ok),
      clean: reports.every(report => report.voiceQuality.clean),
    } : null,
    voiceFindings, checks, summary: summarizeChecks(checks),
    alignmentQuality: reports.length === 1 ? reports[0].alignmentQuality ?? null : null,
    warnings: reports.flatMap(report => (report.warnings?.length ? report.warnings : alignmentWarnings(report.alignmentQuality))
      .map(warning => reports.length > 1 ? `${report.displayName || report.name}: ${warning}` : warning)),
    failedUnits, completedUnits: reports.length, totalUnits: reports.length + failedUnits.length,
    units: reports.map(report => ({name: report.name, displayName: report.displayName,
      durationMs: report.durationMs, videoPath: report.videoPath || null,
      audioPath: report.audioPath || null, target: report.target, summary: report.summary,
      voiceQuality: report.voiceQuality, voiceFindings: report.voiceFindings || [],
      alignmentQuality: report.alignmentQuality ?? null, warnings: report.warnings || []})),
  };
}

export function withOutputReview(report, status, now = new Date()) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("청취 검수 기록을 저장할 결과가 없습니다.");
  }
  if (!["approved", "pending"].includes(status)) {
    throw new Error("지원하지 않는 청취 검수 상태입니다.");
  }
  return {
    ...report,
    review: {
      ...(report.review || {}),
      status,
      updatedAt: now.toISOString(),
    },
  };
}

// 확인 완료 표시는 세션이 아니라 결과에 붙어야 한다. 눌러도 최근 결과에 그대로
// 남는다면 그 버튼은 아무것도 하지 않는 것과 같다. 청취 승인과 같은 자리에
// 적어, 결과가 옮겨 다녀도 표시가 따라간다.
export function voiceFindingKey(finding = {}) {
  return `${finding.slideNumber ?? ""}:${finding.startMs ?? ""}`;
}

export function withClearedFindings(report, keys = [], now = new Date()) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("확인 표시를 저장할 결과가 없습니다.");
  }
  const cleared = [...new Set(keys.map(String).filter(Boolean))];
  return {
    ...report,
    review: { ...(report.review || {}), clearedFindings: cleared, updatedAt: now.toISOString() },
  };
}

export function clearedFindingKeys(report) {
  return (report?.review?.clearedFindings || []).map(String);
}
