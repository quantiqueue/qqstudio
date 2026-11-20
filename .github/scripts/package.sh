#!/usr/bin/env bash
# Builds dist/qqstudio.zip (Windows) and dist/qqstudio.tar.gz (macOS/Linux) from package.json's "files" list
# (npm pack, which adds package.json, README and LICENSE), then checks the unpacked copy starts and answers /api/ping.
# Used by CI (the install tests) and the release workflow (the release assets).
set -euo pipefail
cd "$(dirname "$0")/../.."
rm -rf dist && mkdir -p dist/stage
npm pack --silent --pack-destination dist >/dev/null
tar -xzf dist/qqstudio-*.tgz -C dist/stage --strip-components=1
rm dist/qqstudio-*.tgz
[ -f dist/stage/bin/qqstudio.js ] && [ -f dist/stage/install/uninstall.ps1 ] && [ ! -e dist/stage/dev.js ]
# Every local require() in the package must be in it.
missing=$(cd dist/stage && grep -ho 'require("\./[^"]*")' *.js bin/*.js | sed 's/require("\.\/\([^"]*\)")/\1/' | sort -u | while read -r m; do
  [ -e "$m" ] || [ -e "$m.js" ] || [ -e "bin/$m.js" ] || echo "$m"; done)
[ -z "$missing" ] || { echo "missing from the package: $missing"; exit 1; }
# Smoke test of the packaged copy.
home=$(mktemp -d)
QQSTUDIO_HOME="$home" QQSTUDIO_TRAY=0 node dist/stage/bin/qqstudio.js --port 8199 > dist/smoke.log 2>&1 &
pid=$!
ok=0
for i in $(seq 1 30); do body=$(curl -fsS http://127.0.0.1:8199/api/ping 2>/dev/null || true); [[ "$body" == *'"app":"qqstudio"'* ]] && { ok=1; break; }; sleep 1; done
kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
rm -rf "$home"
[ "$ok" = 1 ] || { echo "the packaged copy did not start:"; cat dist/smoke.log; exit 1; }
rm -f dist/smoke.log
(cd dist/stage && zip -qr ../qqstudio.zip . && tar -czf ../qqstudio.tar.gz .)
rm -rf dist/stage
ls -l dist
