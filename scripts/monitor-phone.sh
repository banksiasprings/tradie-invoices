#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# monitor-phone.sh — Pair with, then live-monitor, Steven's phone over Tailscale
#
#   MODES
#     pair <PAIR_PORT> <CODE> [CONNECT_PORT]   one-time pairing over the tunnel
#     (no args)                                connect + mirror + log
#
#   • scrcpy → low-bandwidth screen mirror (no audio, 15fps — cellular friendly)
#   • logcat → live stream of the invoicing app's output, to screen + rolling log
#   • over   → Tailscale; the phone's 100.x IP is STABLE across WiFi ↔ LTE, so
#              pairing/connecting works even now that Steven is on cellular.
#
#   EXAMPLES
#     ./scripts/monitor-phone.sh pair 37123 482913        # pair (no connect port yet)
#     ./scripts/monitor-phone.sh pair 37123 482913 41555  # pair AND connect in one go
#     PHONE_PORT=41555 ./scripts/monitor-phone.sh         # monitor on a known port
#     ./scripts/monitor-phone.sh                          # monitor (5555 + fallbacks)
#
#   Phone-side setup: scripts/setup-tailscale-debug.md
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────────
PHONE_IP="${PHONE_IP:-100.122.43.30}"               # steven-phone (Tailscale) — stable on WiFi or LTE
PHONE_PORT="${PHONE_PORT:-5555}"                     # PINNED via 'adb tcpip 5555' (2026-06-19) — stable on
                                                     # LAN *and* Tailscale until the phone fully REBOOTS.
                                                     # After a reboot, re-pin (LAN): adb mdns services →
                                                     # adb connect 192.168.1.125:<new-port> → adb tcpip 5555
APP_PKG="${APP_PKG:-com.banksiasprings.invoices}"    # invoicing app — verified package name
ADB="${ADB:-$(command -v adb || echo /Users/openclaw/Library/Android/sdk/platform-tools/adb)}"
SCRCPY_EXTRA="${SCRCPY_EXTRA:-}"                      # extra scrcpy flags (optional)
FALLBACK_PORTS=(5555 43201 41767 44143 37000 39000)  # connect-port fallbacks

export ADB                                            # scrcpy locates adb via PATH or $ADB
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/../logs"; mkdir -p "$LOG_DIR"

# ── Shared helpers ───────────────────────────────────────────────────────────
require_tools() {
  [ -x "$ADB" ] || { echo "❌ adb not found ($ADB). Run: brew install --cask android-platform-tools"; exit 1; }
}
tunnel_up() {
  echo "📡 Pinging phone over Tailscale ($PHONE_IP) ..."
  if ping -c 1 -t 4 "$PHONE_IP" >/dev/null 2>&1; then
    echo "✅ Tunnel up (phone responds to ping)."; return 0
  fi
  echo "❌ Phone not reachable at $PHONE_IP."
  echo "   • Tailscale ON on BOTH phone (🔑 in status bar) and Mac?"
  echo "   • Phone awake (screen on / charging)? A dozing phone drops the tunnel."
  return 1
}

# ── MODE: pair ───────────────────────────────────────────────────────────────
# Android's wireless-debug pairing service binds all interfaces, so the pairing
# PORT shown on the phone is reachable via the Tailscale IP (the IP on the phone's
# dialog doesn't matter — we route through 100.x). The code+port EXPIRE when the
# popup closes, so the phone must keep it open until this succeeds.
do_pair() {
  local pair_port="${1:-}" code="${2:-}" connect_port="${3:-}"
  [ -n "$pair_port" ] && [ -n "$code" ] || {
    echo "Usage: $0 pair <PAIR_PORT> <CODE> [CONNECT_PORT]"; exit 2; }
  require_tools
  tunnel_up || exit 1

  echo "🤝 Pairing with $PHONE_IP:$pair_port (code $code) over Tailscale ..."
  local out
  if ! out="$("$ADB" pair "$PHONE_IP:$pair_port" "$code" 2>&1)"; then
    # Retry once piping the code via stdin (covers adb builds that ignore the inline arg)
    out="$(printf '%s\n' "$code" | "$ADB" pair "$PHONE_IP:$pair_port" 2>&1 || true)"
  fi
  echo "   ↳ $out"

  if ! echo "$out" | grep -qi "Successfully paired"; then
    echo ""
    echo "❌ Pairing failed. Most likely the code/port EXPIRED (the popup was closed or timed out),"
    echo "   or that wasn't the pairing port. On the phone:"
    echo "     Wireless debugging → 'Pair device with pairing code' → KEEP THE POPUP OPEN,"
    echo "     screenshot it, and send the new PORT + 6-digit CODE (both change each time)."
    exit 1
  fi
  echo "✅ Paired — this Mac is now trusted by the phone (persists across reboots)."

  if [ -n "$connect_port" ]; then
    PHONE_PORT="$connect_port"; PHONE_ADDR="$PHONE_IP:$PHONE_PORT"
    echo "🔌 Connecting on CONNECT port $connect_port ..."
    if "$ADB" connect "$PHONE_ADDR" 2>&1 | grep -qiE "connected|already" \
       && [ "$("$ADB" -s "$PHONE_ADDR" get-state 2>/dev/null | tr -d '\r')" = "device" ]; then
      echo "✅ Connected. Normalising to a stable port (adb tcpip 5555) ..."
      "$ADB" -s "$PHONE_ADDR" tcpip 5555 >/dev/null 2>&1 || true
      sleep 1
      echo "🎉 Ready. Start the live view with:  ./scripts/monitor-phone.sh"
    else
      echo "⚠️  Paired OK but couldn't connect on $connect_port. Send the CONNECT port from the"
      echo "    MAIN Wireless-debugging screen, then run: PHONE_PORT=<port> ./scripts/monitor-phone.sh"
    fi
  else
    echo ""
    echo "➡️  Next: send the CONNECT port (the IP:port on the MAIN Wireless-debugging screen),"
    echo "    then run:  PHONE_PORT=<connect-port> ./scripts/monitor-phone.sh"
  fi
}

# ── MODE: monitor (connect → logcat → mirror) ────────────────────────────────
do_monitor() {
  require_tools
  command -v scrcpy >/dev/null 2>&1 || { echo "❌ scrcpy not installed — run: brew install scrcpy"; exit 1; }
  tunnel_up || exit 1

  PHONE_ADDR="$PHONE_IP:$PHONE_PORT"
  local connected=""
  echo "🔌 adb connect $PHONE_ADDR ..."
  if "$ADB" connect "$PHONE_ADDR" 2>&1 | grep -qiE "connected|already"; then connected=1; fi
  if [ -z "$connected" ]; then
    echo "   port $PHONE_PORT not open — trying fallbacks: ${FALLBACK_PORTS[*]}"
    for p in "${FALLBACK_PORTS[@]}"; do
      [ "$p" = "$PHONE_PORT" ] && continue
      if "$ADB" connect "$PHONE_IP:$p" 2>&1 | grep -qiE "connected|already"; then
        PHONE_ADDR="$PHONE_IP:$p"; connected=1; echo "   ✅ connected on fallback port $p"; break
      fi
    done
  fi
  if [ -z "$connected" ]; then
    echo ""
    echo "❌ No adb port open over Tailscale (tunnel is up — ping worked). Either Wireless"
    echo "   debugging is off, or this Mac isn't paired yet. If unpaired, pair first:"
    echo "     Wireless debugging → 'Pair device with pairing code' → send PORT + CODE, then:"
    echo "     ./scripts/monitor-phone.sh pair <PORT> <CODE>"
    exit 1
  fi

  local state; state="$("$ADB" -s "$PHONE_ADDR" get-state 2>/dev/null | tr -d '\r' || true)"
  if [ "$state" != "device" ]; then
    echo "❌ $PHONE_ADDR is '$state' (not 'device')."
    [ "$state" = "unauthorized" ] && echo "   Not paired — run: ./scripts/monitor-phone.sh pair <PORT> <CODE>"
    exit 1
  fi
  echo "✅ Phone online: $("$ADB" -s "$PHONE_ADDR" shell getprop ro.product.model 2>/dev/null | tr -d '\r')"

  # logcat → screen + rolling per-session log file
  local log_file="$LOG_DIR/invoice-app-$(date +%Y%m%d-%H%M%S).log"
  "$ADB" -s "$PHONE_ADDR" logcat -c 2>/dev/null || true
  local app_pid
  app_pid="$("$ADB" -s "$PHONE_ADDR" shell pidof "$APP_PKG" 2>/dev/null | tr -d '\r' | awk '{print $1}')" || app_pid=""
  echo "📝 Logging to: $log_file"
  if [ -n "$app_pid" ]; then
    echo "📜 Streaming $APP_PKG (pid $app_pid) — [GeoLog] / Capacitor/Console lines land here."
    "$ADB" -s "$PHONE_ADDR" logcat --pid="$app_pid" -v time 2>&1 | tee "$log_file" &
  else
    echo "⚠️  $APP_PKG not running — open the invoicing app. Logging system ERRORS until then."
    "$ADB" -s "$PHONE_ADDR" logcat "*:E" -v time 2>&1 | tee "$log_file" &
  fi
  LOGCAT_PID=$!
  trap 'kill "${LOGCAT_PID:-}" 2>/dev/null || true; echo; echo "🧹 Stopped. Log saved: '"$log_file"'"' EXIT INT TERM

  echo "🪞 Opening mirror — no audio, 15fps, capped bitrate for cellular. Close window to stop."
  # scrcpy v4: --video-bit-rate (old --bit-rate removed).
  # shellcheck disable=SC2086
  scrcpy -s "$PHONE_ADDR" --no-audio --max-fps 15 --max-size 1024 --video-bit-rate 2M $SCRCPY_EXTRA
}

# ── Dispatch ─────────────────────────────────────────────────────────────────
case "${1:-}" in
  pair)  shift; do_pair "$@";;
  ""|monitor) do_monitor;;
  *) echo "Usage: $0 [pair <PAIR_PORT> <CODE> [CONNECT_PORT]]"; exit 2;;
esac
