export function sameVoiceScale(first, second) {
  return Number.isFinite(Number(first)) && Number.isFinite(Number(second))
    && Math.abs(Number(first) - Number(second)) < 0.0005;
}

export function voiceProfileView(settings, draft = settings) {
  const adapter = draft.modelId === 'qwen3-tts'
    ? settings?.adapters?.find(item => item.id === draft.adapterId) || null : null;
  const missing = draft.modelId === 'qwen3-tts' && draft.adapterId !== 'none' && !adapter;
  const approved = Boolean(adapter && !adapter.profileError && adapter.listeningStatus === 'approved'
    && (adapter.approvedScales || [adapter.approvedScale]).some(value => sameVoiceScale(draft.adapterScale, value)));
  const previewMatches = Boolean(adapter?.previewUrl && sameVoiceScale(draft.adapterScale, adapter.previewScale));
  const label = adapter?.displayName || adapter?.label || (missing ? '찾을 수 없는 목소리'
    : draft.modelId === 'chatterbox-v3' ? 'Chatterbox V3' : '녹음으로 기본 복제');
  const scaleLabel = adapter ? ` · 반영 강도 ${Number(draft.adapterScale).toFixed(2)}` : '';
  let title = approved ? '듣고 확인한 목소리' : '청취 확인이 필요합니다';
  let explanation = approved ? '선택한 목소리와 이 강도는 청취 확인을 마쳤습니다.'
    : adapter?.listeningStatus === 'approved' ? '반영 강도를 바꿨습니다. 이 강도로 시험 음성을 만들어 들어 보세요.'
      : adapter ? '시험 음성을 들어 보고 본인의 목소리와 발음이 맞는지 확인하세요.'
        : '선택한 대표 녹음의 목소리로 읽습니다. 새 문장 만들기에서 먼저 들어 보세요.';
  if (adapter?.listeningStatus === 'rejected') {
    title = '사용을 보류한 목소리';
    explanation = '이전에 청취 후 사용을 보류했습니다. 새 시험 음성을 확인한 뒤 다시 적용할 수 있습니다.';
  }
  if (missing || adapter?.profileError) {
    title = '목소리를 사용할 수 없습니다';
    explanation = adapter?.profileError || '적용 중인 목소리 파일을 찾지 못했습니다. 사용 가능한 목소리를 다시 골라 주세요.';
  }
  return { adapter, missing, approved, previewMatches, label, title, explanation,
    description: `${label}${scaleLabel}`, canGeneratePreview: Boolean(adapter && !adapter.profileError),
    needsListening: Boolean(adapter && !approved),
    blocked: Boolean(missing || adapter?.profileError) };
}
