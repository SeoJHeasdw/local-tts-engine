#!/bin/zsh
set -e

APP_ROOT="${0:A:h}"
cd "$APP_ROOT"

if [[ ! -x "$APP_ROOT/node_modules/.bin/electron" ]]; then
  print "처음 한 번만 Electron 실행 환경을 준비합니다..."
  npm install --no-audit --no-fund
fi

exec "$APP_ROOT/node_modules/.bin/electron" "$APP_ROOT/electron-app/main.mjs"
