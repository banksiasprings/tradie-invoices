#!/usr/bin/env bash
# test-geo-stop.sh — run the v89 auto-STOP hardening tests against the app
# running in the emulator (via Chrome DevTools Protocol).
#
# Prereq: emulator up with the (rebuilt v89) app installed + launched.
# Usage:  bash test-geo-stop.sh
set -uo pipefail

PKG="com.banksiasprings.invoices"
ADB="${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb"
PORT=9338
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_PATH_DIR="${WS_NODE_PATH:-/usr/local/lib/node_modules/openclaw/node_modules}"

SERIAL="$("$ADB" devices | awk 'NR>1 && $2=="device" && $1 ~ /^emulator-/ {print $1; exit}')"
[[ -n "${SERIAL:-}" ]] || { echo "✗ No running emulator. Run: bash test-emulator.sh"; exit 1; }

PID="$("$ADB" -s "$SERIAL" shell pidof "$PKG" | tr -d '\r')"
if [[ -z "$PID" ]]; then
  "$ADB" -s "$SERIAL" shell am start -n "$PKG/.MainActivity" >/dev/null 2>&1
  sleep 8
  PID="$("$ADB" -s "$SERIAL" shell pidof "$PKG" | tr -d '\r')"
fi
[[ -n "$PID" ]] || { echo "✗ app not running"; exit 1; }

"$ADB" -s "$SERIAL" forward --remove tcp:$PORT >/dev/null 2>&1 || true
"$ADB" -s "$SERIAL" forward tcp:$PORT "localabstract:webview_devtools_remote_$PID" >/dev/null 2>&1
sleep 1
WS="$(curl -s http://localhost:$PORT/json/list 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print([t['webSocketDebuggerUrl'] for t in d if t.get('type')=='page'][0])" 2>/dev/null)"
[[ -n "$WS" ]] || { echo "✗ could not find app devtools page"; exit 1; }

echo "── Auto-STOP hardening tests (v89, live app via CDP) ──"
NODE_PATH="$NODE_PATH_DIR" node "$HERE/test-geo-stop.js" "$WS"
RC=$?
"$ADB" -s "$SERIAL" forward --remove tcp:$PORT >/dev/null 2>&1 || true
exit $RC
