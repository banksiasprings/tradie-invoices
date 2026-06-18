#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# monitor-phone.sh — Live remote monitoring of Steven's phone over Tailscale
#
#   • scrcpy   → real-time mirror of the phone screen
#   • logcat   → live stream of every log line the invoicing app emits
#   • over     → Tailscale's encrypted tunnel (works on home WiFi OR LTE)
#
# Usage:
#   ./scripts/monitor-phone.sh
#
# Override on the fly (env vars):
#   PHONE_IP=100.x.y.z PHONE_PORT=42385 ./scripts/monitor-phone.sh   # Tailscale
#   PHONE_IP=192.168.1.125 PHONE_PORT=5555 ./scripts/monitor-phone.sh # home WiFi
#   SCRCPY_EXTRA="--stay-awake --turn-screen-off" ./scripts/monitor-phone.sh
#
# Setup (phone side): see scripts/setup-tailscale-debug.md
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────────
# Filled in after Steven completes the phone-side Tailscale setup.
# PHONE_IP  = the phone's Tailscale IP (starts with 100.), shown in the Tailscale app.
# PHONE_PORT= the Wireless-debugging "connect" port shown at the top of
#             Settings → Developer options → Wireless debugging (CHANGES EACH REBOOT).
PHONE_IP="${PHONE_IP:-PHONE_TAILSCALE_IP_TBD}"     # e.g. 100.x.y.z   (TODO: fill in)
PHONE_PORT="${PHONE_PORT:-5555}"                    # e.g. 42385       (TODO: confirm)

APP_PKG="${APP_PKG:-com.banksiasprings.invoices}"   # invoicing app — verified package name
ADB="${ADB:-/Users/openclaw/Library/Android/sdk/platform-tools/adb}"
SCRCPY_EXTRA="${SCRCPY_EXTRA:-}"                     # extra scrcpy flags (optional)

# Fallback ports tried in order if the primary connect fails.
# 44143 = the dynamic port seen in an earlier pairing; 5555 = classic adb-tcpip.
FALLBACK_PORTS=(5555 44143 37000 39000)

PHONE_ADDR="$PHONE_IP:$PHONE_PORT"

# scrcpy locates adb via the ADB env var (adb is NOT on PATH on this Mac).
export ADB

# ── Sanity ───────────────────────────────────────────────────────────────────
[ -x "$ADB" ] || { echo "❌ adb not found at: $ADB  (set \$ADB)"; exit 1; }
command -v scrcpy >/dev/null 2>&1 || { echo "❌ scrcpy not installed — run: brew install scrcpy"; exit 1; }
if [ "$PHONE_IP" = "PHONE_TAILSCALE_IP_TBD" ]; then
  echo "❌ PHONE_IP not set yet. Either edit this script (PHONE_IP=...) once Steven"
  echo "   sends his phone's Tailscale IP, or run with it inline:"
  echo "     PHONE_IP=100.x.y.z PHONE_PORT=42385 $0"
  exit 1
fi

# ── Connect (with port fallback) ─────────────────────────────────────────────
connect_phone() {
  echo "🔌 Connecting to $PHONE_ADDR ..."
  if "$ADB" connect "$PHONE_ADDR" 2>&1 | grep -qiE "connected|already"; then
    return 0
  fi
  echo "   primary port failed — trying fallback ports: ${FALLBACK_PORTS[*]}"
  for p in "${FALLBACK_PORTS[@]}"; do
    [ "$p" = "$PHONE_PORT" ] && continue
    echo "   trying $PHONE_IP:$p ..."
    if "$ADB" connect "$PHONE_IP:$p" 2>&1 | grep -qiE "connected|already"; then
      PHONE_ADDR="$PHONE_IP:$p"
      echo "   ✅ connected on fallback port $p"
      return 0
    fi
  done
  return 1
}

if ! connect_phone; then
  echo ""
  echo "❌ ADB connection failed. Checklist:"
  echo "   • Tailscale ON on BOTH phone and Mac (key icon 🔑 on phone)"
  echo "   • Phone's Wireless Debugging is ON (Developer options)"
  echo "   • PHONE_PORT matches the port shown on the Wireless-debugging screen"
  echo "     (it changes every phone reboot)"
  echo "   • If never paired from this Mac: run 'adb pair $PHONE_IP:<pair-port>' first"
  exit 1
fi

# Confirm the device is actually online to adb.
if ! "$ADB" -s "$PHONE_ADDR" get-state 2>/dev/null | grep -q device; then
  echo "❌ $PHONE_ADDR connected but not in 'device' state. Check the phone for an"
  echo "   'Allow wireless debugging?' prompt and tap Allow."
  exit 1
fi
echo "✅ Phone online: $("$ADB" -s "$PHONE_ADDR" shell getprop ro.product.model 2>/dev/null | tr -d '\r')"

# ── Logcat (app-scoped, falls back to errors-only if app not running) ────────
"$ADB" -s "$PHONE_ADDR" logcat -c 2>/dev/null || true   # clear stale logs

# pidof exits non-zero when the app isn't running; the trailing || keeps set -e happy
# so we fall through to the errors-only branch instead of aborting the whole script.
APP_PID="$("$ADB" -s "$PHONE_ADDR" shell pidof "$APP_PKG" 2>/dev/null | tr -d '\r' | awk '{print $1}')" || APP_PID=""
LOGCAT_PID=""
if [ -n "$APP_PID" ]; then
  echo "📜 Streaming logcat for $APP_PKG (pid $APP_PID) — every line the app emits."
  "$ADB" -s "$PHONE_ADDR" logcat --pid="$APP_PID" -v time &
  LOGCAT_PID=$!
else
  echo "⚠️  $APP_PKG isn't running yet — open the invoicing app on the phone."
  echo "📜 Until then, streaming system-wide ERRORS only (re-run once the app is open"
  echo "    to get the full app-scoped stream)."
  "$ADB" -s "$PHONE_ADDR" logcat "*:E" -v time &
  LOGCAT_PID=$!
fi

# ── Cleanup on exit ──────────────────────────────────────────────────────────
cleanup() {
  [ -n "$LOGCAT_PID" ] && kill "$LOGCAT_PID" 2>/dev/null || true
  echo ""
  echo "🧹 Stopped logcat. (Phone stays connected to adb; run '$ADB disconnect' to drop it.)"
}
trap cleanup EXIT INT TERM

# ── Mirror (blocks until the scrcpy window is closed) ────────────────────────
echo "🪞 Opening scrcpy mirror ($PHONE_ADDR) — close the window to stop everything."
# NOTE: scrcpy v4 uses --video-bit-rate (the old --bit-rate was removed).
# shellcheck disable=SC2086
scrcpy -s "$PHONE_ADDR" --max-size 1080 --video-bit-rate 4M $SCRCPY_EXTRA

# scrcpy exited → trap fires → logcat is killed.
