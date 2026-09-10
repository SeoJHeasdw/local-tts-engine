// Public capture CLI contract, verified against udemy-agent in video-quality.test.mjs.
export const VIDEO_QUALITIES = Object.freeze({
  standard: Object.freeze({ id: 'standard', label: '기존 해상도 · 1080p', width: 1920, height: 1080, fps: 25 }),
  high: Object.freeze({ id: 'high', label: '고화질 · 1440p', width: 2560, height: 1440, fps: 25 }),
  ultra: Object.freeze({ id: 'ultra', label: '초고화질 · 4K', width: 3840, height: 2160, fps: 25 }),
});
export const DEFAULT_VIDEO_QUALITY = 'high';

export function videoQuality(id = DEFAULT_VIDEO_QUALITY) {
  if (!Object.hasOwn(VIDEO_QUALITIES, id)) throw new Error('영상 화질을 다시 선택해 주세요.');
  return VIDEO_QUALITIES[id];
}

export function captureVideoFileName(name, { videoQuality: id = 'standard', burnCaptions = false } = {}) {
  videoQuality(id);
  return `${name}${id === 'standard' ? '' : `-${id}`}${burnCaptions ? '-captioned' : ''}.mp4`;
}

export function videoFrameRate(stream) {
  for (const value of [stream?.avg_frame_rate, stream?.r_frame_rate]) {
    const [n, d] = String(value || '').split('/').map(Number);
    if (Number.isFinite(n) && n > 0 && Number.isFinite(d) && d > 0) return n / d;
  }
  return NaN;
}
