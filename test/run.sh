#!/usr/bin/env bash
# End-to-end tests against a throwaway Chrome with a synthetic camera.
# The real Chrome profile is never touched.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="${TMPDIR:-/tmp}/camboi-test"
PORT_HTTP=8731
PORT_CDP=9222

cleanup() {
  pkill -f "remote-debugging-port=$PORT_CDP" 2>/dev/null || true
  pkill -f "http.server $PORT_HTTP" 2>/dev/null || true
}
trap cleanup EXIT

cd "$ROOT" && npm run build >/dev/null

cleanup; sleep 1
rm -rf "$TMP"; mkdir -p "$TMP/profile" "$TMP/www"
cp "$ROOT/test/harness.html" "$TMP/www/test.html"

(cd "$TMP/www" && python3 -m http.server $PORT_HTTP >/dev/null 2>&1 &)
sleep 1

# --load-extension was removed from Chrome in M136; CDP Extensions.loadUnpacked
# is the supported route, and it needs --enable-unsafe-extension-debugging.
# --use-fake-device-for-media-stream gives a deterministic synthetic camera.
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir="$TMP/profile" \
  --enable-unsafe-extension-debugging \
  --use-fake-ui-for-media-stream --use-fake-device-for-media-stream \
  --remote-debugging-port=$PORT_CDP \
  --no-first-run --no-default-browser-check --window-size=1200,900 \
  "http://localhost:$PORT_HTTP/test.html" >"$TMP/chrome.log" 2>&1 &
sleep 4

cd "$ROOT/test"
node -e "import('./cdp.mjs').then(async ({browser}) => {
  const b = await browser();
  await b.send('Extensions.loadUnpacked', { path: '$ROOT/dist' });
  b.close();
})"
sleep 1

echo "=== passthrough ==="
node passthrough.test.mjs | grep -E '^(PASS|FAIL)'
echo "=== record + loop ==="
node loop.test.mjs | grep -E '^(PASS|FAIL)'
