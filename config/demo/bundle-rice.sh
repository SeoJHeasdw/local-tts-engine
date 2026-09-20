#!/usr/bin/env bash
# RICE를 고치지 않고 띄우기 위한 준비(2026-09-18 측정에 쓴 방법). APP-DEMO-DESIGN 6절.
# 메인·preload를 rice 저장소 밖(인자로 준 폴더)에 묶는다. rice의 dist-electron은 건드리지 않는다.
set -euo pipefail
OUT="${1:?묶을 폴더}"
RICE_APP="${RICE_APP:-/Users/jaehoseo/Desktop/vswrk/bob/rice/rice-app}"
mkdir -p "$OUT"
cd "$RICE_APP"
node_modules/esbuild/bin/esbuild electron/main.ts --bundle --platform=node --format=esm --external:electron --outfile="$OUT/main.mjs" --log-level=warning
node_modules/esbuild/bin/esbuild electron/preload.ts --bundle --platform=node --format=cjs --external:electron --outfile="$OUT/preload.cjs" --log-level=warning
printf '{"name":"rice-demo","version":"0.0.0","type":"module","main":"main.mjs"}\n' > "$OUT/package.json"
# 렌더러는 main이 개발 모드에서 읽는 :5173에 띄운다.
#   cd "$RICE_APP" && env -u ELECTRON_RUN_AS_NODE npx vite --config vite.renderer.config.ts --port 5173 --strictPort
