// 촬영 규격의 정본. 화면 선택지·촬영 CLI·완성본 검증이 모두 여기를 읽는다.
// 렌더러도 import하므로 Node 의존성을 두지 않는다. ffmpeg 인자와 스트림 검사는
// main/capture/encoding.mjs가 이 프로파일을 받아 만든다.
export const VIDEO_QUALITIES = Object.freeze({
  standard: Object.freeze({ id: 'standard', label: '기존 해상도 · 1080p', width: 1920, height: 1080, fps: 25, crf: 16 }),
  high: Object.freeze({ id: 'high', label: '고화질 · 1440p', width: 2560, height: 1440, fps: 25, crf: 16 }),
  ultra: Object.freeze({ id: 'ultra', label: '초고화질 · 4K', width: 3840, height: 2160, fps: 25, crf: 16 }),
});
export const DEFAULT_VIDEO_QUALITY = 'high';

export function videoQuality(id = DEFAULT_VIDEO_QUALITY) {
  if (!Object.hasOwn(VIDEO_QUALITIES, id)) throw new Error('영상 화질을 다시 선택해 주세요.');
  return VIDEO_QUALITIES[id];
}

export function captureVideoFileName(name, { videoQuality: id = 'standard', burnCaptions = false, durationSuffix = '' } = {}) {
  videoQuality(id);
  return `${name}${id === 'standard' ? '' : `-${id}`}${burnCaptions ? '-captioned' : ''}${durationSuffix}.mp4`;
}

export function videoFrameRate(stream) {
  for (const value of [stream?.avg_frame_rate, stream?.r_frame_rate]) {
    const [n, d] = String(value || '').split('/').map(Number);
    if (Number.isFinite(n) && n > 0 && Number.isFinite(d) && d > 0) return n / d;
  }
  return NaN;
}

export function captureFrameCount(durationMs, fps) {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(fps) || fps <= 0) {
    throw new Error('촬영 길이와 프레임률은 양수여야 합니다.');
  }
  // 마지막 음성 표본을 덮는다. 내림으로 최대 반 프레임을 버리지 않는다.
  return Math.max(1, Math.ceil(durationMs * fps / 1000 - 1e-9));
}
