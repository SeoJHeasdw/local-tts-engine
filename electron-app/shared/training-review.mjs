// These are review aids, not a speaker-identity score or listening approval.
export function trainingClipAssessment(clip, text = clip.text) {
  const audio = clip.quality?.audio || null;
  const agreement = Number.isFinite(clip.quality?.transcriptAgreement) ? clip.quality.transcriptAgreement : null;
  const warnings = [...(audio?.warnings || [])];
  if (agreement !== null && agreement < 0.9) {
    warnings.push({ code: 'transcript-disagreement', message: '두 받아쓰기의 차이가 큽니다. 빠진 말·잘못 적힌 말을 듣고 고쳐 주세요.' });
  }
  if (clip.quality?.independentText === '') {
    warnings.push({ code: 'empty-independent-transcript', message: '별도 받아쓰기가 말을 찾지 못했습니다. 실제 음성을 확인하세요.' });
  }
  const hasText = Boolean(String(text || '').trim());
  const referenceLength = clip.durationMs >= 6000 && clip.durationMs <= 12000;
  return { audio, agreement, warnings, hasText, referenceLength,
    trainingLabel: !hasText ? '녹음의 글 필요' : warnings.length ? '경고를 듣고 확인해 주세요' : audio ? '직접 확인하면 학습에 포함 가능' : '자동 녹음 분석 전',
    referenceLabel: !referenceLength ? clip.durationMs < 6000 ? '대표 녹음으로는 짧은 편' : '대표 녹음으로는 긴 편' : warnings.length ? '대표 녹음 선택 전 경고 확인' : '대표 녹음 후보',
    referenceCandidate: hasText && referenceLength && Boolean(audio) && warnings.length === 0 };
}

export function recommendedTrainingReference(clips) {
  return clips.filter(clip => trainingClipAssessment(clip).referenceCandidate).sort((a, b) => {
    const one = trainingClipAssessment(a), two = trainingClipAssessment(b);
    const measured = Number(two.agreement !== null) - Number(one.agreement !== null);
    return measured || (two.agreement ?? 0) - (one.agreement ?? 0)
      || Math.abs(a.durationMs - 8000) - Math.abs(b.durationMs - 8000)
      || a.id.localeCompare(b.id);
  })[0]?.id || null;
}
