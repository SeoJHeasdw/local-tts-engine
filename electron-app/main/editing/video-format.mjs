import { videoFrameRate } from '../../shared/video-quality.mjs';

export function assertVideoReencodeSafe(probe) {
  const video = probe.streams?.find(stream => stream.codec_type === 'video');
  if (!video) throw new Error('영상 트랙이 없습니다.');
  const known = (value, allowed) => !value || value === 'unknown' || allowed.includes(value);
  if (!['yuv420p', 'nv12'].includes(video.pix_fmt)
    || !known(video.color_space, ['bt709', 'bt470bg', 'smpte170m'])
    || !known(video.color_range, ['tv'])
    || !known(video.color_primaries, ['bt709'])
    || !known(video.color_transfer, ['bt709', 'smpte170m'])) {
    throw new Error('이 영상의 HDR·색심도·색 형식은 현재 재인코딩 편집에서 보존할 수 없습니다. 전체 MP4 복사 또는 원본 형식을 지원하는 편집 도구를 사용해 주세요.');
  }
  if (!(videoFrameRate(video) > 0)) throw new Error('영상의 프레임률을 읽을 수 없습니다.');
  return video;
}

export function videoFrameRateArg(video) {
  for (const value of [video?.avg_frame_rate, video?.r_frame_rate]) {
    if (/^\d+\/[1-9]\d*$/.test(String(value)) && Number(String(value).split('/')[0]) > 0) return String(value);
  }
  throw new Error('영상의 프레임률을 읽을 수 없습니다.');
}

export function videoColorFilter(video) {
  const pairs = [['range', video.color_range === 'tv' ? 'limited' : null],
    ['colorspace', video.color_space], ['color_primaries', video.color_primaries], ['color_trc', video.color_transfer]]
    .filter(([, value]) => value && value !== 'unknown');
  return 'format=yuv420p' + (pairs.length ? `,setparams=${pairs.map(([key, value]) => `${key}=${value}`).join(':')}` : '');
}

export function videoReencodeArgs(probe) {
  const video = assertVideoReencodeSafe(probe);
  const colors = [['-colorspace', video.color_space], ['-color_range', video.color_range],
    ['-color_primaries', video.color_primaries], ['-color_trc', video.color_transfer]]
    .filter(([, value]) => value && value !== 'unknown').flat();
  return ['-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', ...colors];
}
