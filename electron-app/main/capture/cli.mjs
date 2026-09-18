// 촬영·자막 실행 진입점이 공유하는 인자 해석. `--키 값`과 `--키`(참)만 받는다.
export function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) throw new Error(`알 수 없는 인자: ${token}`);
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true;
    else { flags[key] = next; i++; }
  }
  return flags;
}

export function requireFlag(flags, key) {
  const value = flags[key];
  if (typeof value !== "string" || !value) throw new Error(`--${key} 값이 필요합니다.`);
  return value;
}
