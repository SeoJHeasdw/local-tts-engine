import path from "node:path";

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function makeJobName(now = new Date(), seconds = null) {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  const length = Number.isFinite(seconds)
    ? seconds >= 60 ? `${Math.round(seconds / 60)}m` : `${seconds}s`
    : "course";
  return `studio-${stamp}-${length}`;
}

// 파일 이름으로 쓸 수 없는 글자를 골라낸다. 남는 것이 없으면 빈 문자열이다.
// 무엇으로 대신할지는 부르는 쪽이 정한다 — 자동으로 짓는 이름과 사람이 직접
// 친 이름은 비었을 때 할 일이 다르다.
export function sanitizeFileStem(value) {
  const replacements = {
    "<": "＜",
    ">": "＞",
    ":": "：",
    '"': "＂",
    "/": "／",
    "\\": "＼",
    "|": "｜",
    "?": "？",
    "*": "＊",
  };
  return String(value ?? "")
    .normalize("NFC")
    .replace(/[<>:"/\\|?*]/g, (character) => replacements[character])
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 180)
    .trim();
}

export function displayVideoFileStem(value) {
  return sanitizeFileStem(String(value || "완성 영상").replace(/\.mp4$/i, "")) || "완성 영상";
}

// 이름 바꾸기는 사람이 친 글자를 그대로 받는다. 확장자까지 지울 수 있게 두면
// 그 파일은 다음에 열리지 않으므로, 원래 확장자는 무슨 일이 있어도 지킨다.
// 화면에는 확장자를 붙여 보여 주므로 그대로 두고 고친 경우도 받아 준다.
export function renamedFileName(currentName, rawName) {
  const extension = path.extname(String(currentName || ""));
  const typed = String(rawName ?? "").normalize("NFC").trim();
  const base = extension && typed.toLocaleLowerCase("ko-KR").endsWith(extension.toLocaleLowerCase("ko-KR"))
    ? typed.slice(0, -extension.length)
    : typed;
  const stem = sanitizeFileStem(base);
  if (!stem) throw new Error("파일 이름을 입력하세요.");
  return `${stem}${extension}`;
}

export function nextDisplayVideoFileName(title, existingNames = []) {
  const stem = displayVideoFileStem(title);
  const normalized = new Set(Array.from(existingNames, (name) => (
    String(name).normalize("NFC").toLocaleLowerCase("ko-KR")
  )));
  const available = (name) => !normalized.has(name.normalize("NFC").toLocaleLowerCase("ko-KR"));
  const first = `${stem}.mp4`;
  if (available(first)) return first;
  for (let sequence = 2; sequence < 10_000; sequence += 1) {
    const candidate = `${stem} (${sequence}).mp4`;
    if (available(candidate)) return candidate;
  }
  throw new Error("같은 이름의 영상이 너무 많아 새 파일명을 정하지 못했습니다.");
}

export function normalizeEditName(value) {
  const name = String(value ?? "").trim();
  if (!SLUG_PATTERN.test(name)) {
    throw new Error("결과 이름은 영문 소문자, 숫자, 하이픈만 사용할 수 있습니다.");
  }
  return name;
}
