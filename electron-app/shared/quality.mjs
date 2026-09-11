export function summarizeChecks(checks) {
  const failed = checks.filter((item) => !item.ok);
  return {
    ok: failed.length === 0,
    passed: checks.length - failed.length,
    total: checks.length,
    failed: failed.map((item) => item.label),
  };
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
      const pauses = [...(selected.prosody?.checks || []), ...(selected.restarts?.checks || [])];
      const onlyPauses = pauses.length > 0 && reasons.every((reason) => ["단어 내부 끊김 확인 필요", "짧은 발음 반복 확인 필요"].includes(reason));
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
    findings.push({
      chapter: entries[0].chapter, slideId: entries[0].slide_id,
      slideNumber: Number(entries[0].slide_number),
      startMs: Number(timing.startMs), endMs: Number(timing.endMs),
      severity: 'warning', kind: 'pronunciation-unresolved', reasons: [reason],
      terms: terms.map(term => ({ term, status: 'unresolved' })),
      expectedText: quality?.selected?.expectedText || entries.map(entry => entry.tts_text || entry.source_text).join(' '),
      recognizedText: quality?.selected?.recognizedText || '',
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
    failedUnits, completedUnits: reports.length, totalUnits: reports.length + failedUnits.length,
    units: reports.map(report => ({name: report.name, displayName: report.displayName,
      durationMs: report.durationMs, videoPath: report.videoPath || null,
      audioPath: report.audioPath || null, target: report.target, summary: report.summary,
      voiceQuality: report.voiceQuality, voiceFindings: report.voiceFindings || []})),
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
