// 촬영 프레임을 MP4로 굳히는 인코딩 계약. 프레임이 어디서 왔는지(브라우저·창·
// 디스플레이)와 무관하게 같은 규격으로 내보내고 같은 기준으로 검사한다.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function captureEncodingArgs(profile) {
  return [
    // RGB 값을 변환하면서 결과 YUV 행렬 태그도 같이 맞춘다.
    "-vf", "scale=in_range=full:out_range=limited:out_color_matrix=bt709,format=yuv420p,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
    "-c:v", "libx264", "-preset", "slow", "-crf", String(profile.crf),
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
  ];
}

// 촬영 프레임을 음성과 합쳐 최종 MP4로 만드는 인자.
export function captureMuxArgs({ profile, totalFrames, audioFile, output }) {
  return [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "image2pipe", "-vcodec", "png", "-framerate", String(profile.fps), "-i", "pipe:0",
    "-i", audioFile,
    "-map", "0:v:0", "-map", "1:a:0",
    // 프레임 수는 마지막 음성 구간을 덮으려고 올림한다. 그래서 마지막 프레임은 음성
    // 끝보다 한 프레임에 못 미치는 만큼 더 길다. 길이 상한을 음성 길이로 주거나
    // -shortest를 두면 그 마지막 프레임이 통째로 잘려 나가 프레임 수가 하나 모자란다.
    // 음성 길이가 한 프레임의 배수가 아닌 강의는 전부 여기서 걸렸다.
    "-t", (totalFrames / profile.fps).toFixed(3),
    ...captureEncodingArgs(profile),
    ...(audioFile.endsWith(".m4a") ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k"]),
    // 확장자가 .part라 컨테이너를 스스로 못 고른다. 명시해준다.
    "-f", "mp4", "-movflags", "+faststart", output,
  ];
}

export function validateCaptureStream(probe, profile, totalFrames) {
  const stream = probe.streams?.find(s => s.codec_type === "video");
  if (!stream) throw new Error("촬영 규격 불일치: 완성 파일에 영상 스트림이 없습니다.");
  const [n, d] = String(stream.avg_frame_rate || "").split("/").map(Number);
  // 어느 항목이 어긋났는지 남긴다. 규격만 되풀이하면 원인을 다시 찾아야 한다.
  const wrong = [];
  if (stream.width !== profile.width || stream.height !== profile.height) {
    wrong.push(`크기 ${stream.width}×${stream.height} (${profile.width}×${profile.height} 필요)`);
  }
  if (stream.codec_name !== "h264") wrong.push(`코덱 ${stream.codec_name} (h264 필요)`);
  if (stream.pix_fmt !== "yuv420p") wrong.push(`픽셀 형식 ${stream.pix_fmt} (yuv420p 필요)`);
  if (!d || Math.abs(n / d - profile.fps) > 0.01) wrong.push(`프레임률 ${stream.avg_frame_rate} (${profile.fps} 필요)`);
  if (Number(stream.nb_frames) !== totalFrames) wrong.push(`프레임 수 ${stream.nb_frames} (${totalFrames} 필요)`);
  for (const [key, want, label] of [["color_space", "bt709", "색공간"], ["color_range", "tv", "색 범위"],
    ["color_primaries", "bt709", "색 원색"], ["color_transfer", "bt709", "전달함수"]]) {
    if (stream[key] !== want) wrong.push(`${label} ${stream[key] ?? "없음"} (${want} 필요)`);
  }
  if (wrong.length) throw new Error(`촬영 규격 불일치: ${wrong.join(", ")}`);
  return stream;
}

// 보고서는 완성본 옆과 결과 폴더 두 곳에 남는다. 중간에 끊긴 보고서가 완성본으로
// 읽히면 안 되므로 임시 파일에 쓰고 원자적으로 옮긴다.
export function writeCaptureReport(file, report) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(report, null, 2) + "\n");
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
