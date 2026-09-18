// 녹화할 디스플레이와 입력 장치를 찾는다. ffmpeg avfoundation이 보여 주는 목록이
// 정본이다. 번호는 연결·깨우기 순서에 따라 바뀌므로 사람은 이름으로 고르고, 녹화
// 직전에 목록을 다시 읽어 그 이름의 번호를 얻는다.
import { spawn } from "node:child_process";

const SCREEN_NAME = /^Capture screen \d+$/;
const THUMBNAIL_WIDTH = 480;

// ffmpeg는 stdin을 키 입력으로 읽는다. 터미널 stdin을 물려받으면 SIGTTIN으로
// 멈추므로 항상 닫힌 stdin으로 띄운다.
function runFfmpeg(ffmpeg, args, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ["-nostdin", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() });
    });
  });
}

// 화면 입력을 열 때마다 macOS가 objc 경고를 찍는다. 원인을 알리는 줄이 아니므로
// 오류 설명에서 뺀다.
export function ffmpegErrorText(stderr, limit = 1200) {
  return String(stderr || "").split(/\r?\n/)
    .filter(line => line.trim() && !/^objc\[\d+\]: class `NSKVONotifying_/.test(line))
    .join("\n").slice(-limit);
}

export function parseAvfoundationDevices(text) {
  const devices = { video: [], audio: [] };
  let section = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (/AVFoundation video devices:/.test(line)) { section = "video"; continue; }
    if (/AVFoundation audio devices:/.test(line)) { section = "audio"; continue; }
    const match = line.match(/\]\s\[(\d+)\]\s(.+?)\s*$/);
    if (section && match) devices[section].push({ index: Number(match[1]), name: match[2] });
  }
  return devices;
}

export function screenDevices(devices) {
  return devices.video.filter(device => SCREEN_NAME.test(device.name));
}

export function resolveDevice(list, name, label) {
  const found = list.filter(device => device.name === name);
  if (found.length > 1) throw new Error(`같은 이름의 ${label}가 여럿입니다: ${name}`);
  if (!found.length) throw new Error(`${label} '${name}'을(를) 찾지 못했습니다. 연결을 확인하고 목록을 다시 찾아 주세요.`);
  return found[0].index;
}

export async function listCaptureDevices(ffmpeg) {
  // 목록만 찍고 입력을 여는 데는 실패하므로 종료 코드는 보지 않는다.
  const { stderr } = await runFfmpeg(ffmpeg, ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]);
  const devices = parseAvfoundationDevices(stderr);
  if (!devices.video.length && !devices.audio.length) {
    throw new Error(`화면·입력 장치 목록을 읽지 못했습니다.\n${ffmpegErrorText(stderr)}`);
  }
  return devices;
}

// 입력 스트림 줄에서 원본 크기를 읽는다. 출력 줄(축소한 썸네일)과 헷갈리지 않게
// rawvideo 입력만 본다.
export function parseDisplaySize(stderr) {
  const match = String(stderr || "").match(/Stream #0:0[^\n]*Video: rawvideo[^\n]*?, (\d+)x(\d+)/);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

// 한 프레임을 떠서 크기와 썸네일을 얻는다. 이름만으로는 어느 화면이 어느 모니터인지
// 알 수 없어 눈으로 고르게 한다. 이 촬영의 성패가 곧 화면 기록 권한의 판정이다.
export async function probeDisplay(ffmpeg, index) {
  const { code, stdout, stderr } = await runFfmpeg(ffmpeg, [
    "-hide_banner", "-loglevel", "info",
    "-f", "avfoundation", "-capture_cursor", "0", "-pixel_format", "bgr0", "-framerate", "25",
    "-i", `${index}:none`,
    "-frames:v", "1", "-vf", `scale=${THUMBNAIL_WIDTH}:-2`, "-c:v", "mjpeg", "-q:v", "4", "-f", "image2pipe", "pipe:1",
  ]);
  const size = parseDisplaySize(stderr);
  if (code !== 0 || !stdout.length || !size) {
    throw new Error(`화면을 찍지 못했습니다. 화면 기록 권한을 확인해 주세요.\n${ffmpegErrorText(stderr)}`);
  }
  return { ...size, thumbnail: `data:image/jpeg;base64,${stdout.toString("base64")}` };
}

// 화면마다 한 번씩 찍는다. 한 화면이 실패해도 나머지는 고를 수 있어야 하므로
// 실패는 그 화면의 사정으로 남긴다.
export async function listDisplays(ffmpeg) {
  const devices = await listCaptureDevices(ffmpeg);
  const displays = [];
  for (const screen of screenDevices(devices)) {
    try {
      displays.push({ name: screen.name, ...await probeDisplay(ffmpeg, screen.index) });
    } catch (error) {
      displays.push({ name: screen.name, error: error.message });
    }
  }
  return { displays, audioDevices: devices.audio.map(device => ({ name: device.name })) };
}
