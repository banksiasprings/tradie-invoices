#!/usr/bin/env bash
# test-geo-scenarios.sh — automated geofence scenario tests on the emulator.
#
# Tests the NATIVE pipeline end-to-end with zero UI/auth dependency:
#   seed sites into SharedPreferences → fire BOOT_COMPLETED → GeoRegistrar
#   re-registers fences → drive `adb emu geo fix` through arrive/leave
#   scenarios → assert on receiver logcat + the persisted event queue.
#
# Prereqs: emulator running with the debug APK installed (bash test-emulator.sh).
# Usage:   bash test-geo-scenarios.sh
#
# Scenarios:
#   1. REGISTER    — re-registration from persisted sites, triggered by
#                    MY_PACKAGE_REPLACED via `adb install -r` (BOOT_COMPLETED is a
#                    protected broadcast — not fakeable from shell on Play images;
#                    both actions run the same GeoRegistrar.registerFromPrefs path)
#   2. INJECT ENTER— TEST_GEO_EVENT (debug builds only) drives the receiver
#                    pipeline with a good-accuracy fix → enter persisted + enriched
#   3. INJECT REJECT— 400m-accuracy fix → rejected:true (the gate GMS/geo-fix
#                    can never exercise)
#   4. INJECT EXIT — good-accuracy fix 2km out → exit persisted, distM ≈ 2200
#   5. FIELDS      — queue carries evLat/evLng/acc/distM/rejected (v81 telemetry)
#   6. JS REPLAY   — app cold-open drains the queue; assert [GeoLog] lines incl.
#                    REJECTED handling (app has no sites → no timer side effects)
#   7. GMS LIVE    — non-fatal probe: real geo-fix drive-in, wait for DWELL.
#                    GMS transitions are flaky-to-dead on emulators (device is
#                    permanently "still"); production validation is the field
#                    telemetry + the web-GPS fallback. Reported as info, not fail.

set -uo pipefail

PKG="com.banksiasprings.invoices"
ADB="${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APK_PATH="${APK_PATH:-${PROJECT_DIR}/android/build/android/app/outputs/apk/debug/app-debug.apk}"

# Test site: Stanthorpe QLD. INSIDE = fence centre, OUTSIDE = ~2.2km north.
SITE_NAME="Geo Test Site"
SITE_LAT="-28.6532"
SITE_LNG="151.9282"
SITE_RADIUS="150"
OUT_LAT="-28.6732"

PASS=0; FAIL=0
ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
note() { echo "  · $1"; }

SERIAL="$("$ADB" devices | awk 'NR>1 && $2=="device" && $1 ~ /^emulator-/ {print $1; exit}')"
[[ -n "${SERIAL:-}" ]] || { echo "✗ No running emulator. Run: bash test-emulator.sh"; exit 1; }
A() { "$ADB" -s "$SERIAL" "$@"; }
echo "→ Using emulator $SERIAL"

# ---- preflight: app installed, hours guard satisfiable ---------------------
A shell pm path "$PKG" >/dev/null 2>&1 || { echo "✗ $PKG not installed. Run test-emulator.sh first."; exit 1; }

# The receiver ignores events outside 5am–9pm DEVICE-LOCAL time. Make sure the
# emulator clock lands inside the window (set Brisbane tz via root if needed).
HOUR="$(A shell date +%H | tr -d '\r')"
if (( 10#$HOUR < 5 || 10#$HOUR >= 21 )); then
  note "Device hour $HOUR outside 5–21 — setting timezone Australia/Brisbane"
  A root >/dev/null 2>&1; sleep 2
  A shell setprop persist.sys.timezone Australia/Brisbane
  sleep 2
  HOUR="$(A shell date +%H | tr -d '\r')"
  if (( 10#$HOUR < 5 || 10#$HOUR >= 21 )); then
    echo "✗ Still outside active hours (device hour $HOUR) — receiver would ignore all events. Aborting."
    exit 1
  fi
fi
note "Device local hour: $HOUR (inside 5–21 window)"

# Location on, permissions granted (idempotent re-grant).
A shell settings put secure location_mode 3 >/dev/null 2>&1 || true
for P in android.permission.ACCESS_FINE_LOCATION android.permission.ACCESS_COARSE_LOCATION \
         android.permission.ACCESS_BACKGROUND_LOCATION android.permission.POST_NOTIFICATIONS; do
  A shell pm grant "$PKG" "$P" 2>/dev/null || true
done

# ---- helpers ----------------------------------------------------------------
# Poll logcat (since last clear) for a pattern. poll_log <timeout_s> <grep-pattern>
poll_log() {
  local timeout="$1" pattern="$2" t=0
  while (( t < timeout )); do
    if A logcat -d 2>/dev/null | grep -qE "$pattern"; then return 0; fi
    sleep 5; t=$((t+5))
  done
  return 1
}

dump_events() {
  A shell "run-as $PKG cat shared_prefs/native_geo_prefs.xml" 2>/dev/null \
    | grep -o '<string name="pending_events">.*</string>' \
    | sed 's/<[^>]*>//g' \
    | python3 -c 'import sys,html,json; s=html.unescape(sys.stdin.read().strip());  print(json.dumps(json.loads(s or "[]"), indent=1))' 2>/dev/null
}

clear_events() {
  # Overwrite ONLY pending_events, preserving registered_sites.
  A shell "run-as $PKG sh -c 'cat > shared_prefs/native_geo_prefs.xml'" <<EOF
<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
  <string name="registered_sites">[{"name":"$SITE_NAME","lat":$SITE_LAT,"lng":$SITE_LNG,"radius":$SITE_RADIUS}]</string>
  <string name="pending_events">[]</string>
</map>
EOF
}

geo() { # geo <lat> <lng> — note: emu console wants LONGITUDE first
  A emu geo fix "$2" "$1" >/dev/null
}

# ============================================================================
echo ""
echo "── Scenario 1: REGISTER (BootReceiver → GeoRegistrar.registerFromPrefs) ──"
[[ -f "$APK_PATH" ]] || { echo "✗ APK not found at $APK_PATH — build first (bash build_apk.sh)"; exit 1; }
# Park the GPS well outside the fence BEFORE registering, so registration can't
# race an in-fence position. Seed the site list into SharedPreferences, then
# reinstall the APK: MY_PACKAGE_REPLACED fires BootReceiver → registerFromPrefs
# with no UI, no auth, and no protected-broadcast permission problems.
#
# CRITICAL: Android delivers NO broadcasts (not even MY_PACKAGE_REPLACED) to an
# app in "stopped state" — which `am force-stop` causes. Launch the activity
# once to clear stopped state, go Home, THEN reinstall. (Never an issue on a
# real phone — opening the app clears it — purely a harness concern.)
A shell am start -n "$PKG/.MainActivity" >/dev/null 2>&1; sleep 5
A shell input keyevent KEYCODE_HOME; sleep 2
geo "$OUT_LAT" "$SITE_LNG"; sleep 3
clear_events
A logcat -c
A install -r -g "$APK_PATH" >/dev/null 2>&1
# Reinstall wipes runtime grants on some images — re-grant.
for P in android.permission.ACCESS_FINE_LOCATION android.permission.ACCESS_COARSE_LOCATION \
         android.permission.ACCESS_BACKGROUND_LOCATION android.permission.POST_NOTIFICATIONS; do
  A shell pm grant "$PKG" "$P" 2>/dev/null || true
done
if poll_log 60 "GeoRegistrar.*Re-registered 1 geofences"; then
  ok "MY_PACKAGE_REPLACED → fences re-registered from persisted prefs (no app open needed)"
else
  bad "No 'Re-registered 1 geofences' in logcat — boot/update re-registration path broken"
  A logcat -d -s GeoRegistrar BootReceiver | tail -5
fi

# inject <type> <lat> <lng> <acc> — drive the receiver's debug TEST_GEO_EVENT path
inject() {
  A shell am broadcast -a com.banksiasprings.invoices.TEST_GEO_EVENT \
    -n "$PKG/.GeofenceBroadcastReceiver" \
    --es site "'$SITE_NAME'" --es type "$1" \
    --es lat "$2" --es lng "$3" --es acc "$4" >/dev/null 2>&1
}

echo ""
echo "── Scenario 2: INJECT ENTER (good fix, ~35m from centre, acc 12m) ──"
A logcat -c
inject enter "-28.6535" "$SITE_LNG" "12"
if poll_log 20 "GeofenceReceiver.*Saved geo event: enter @ $SITE_NAME.*acc=12m"; then
  ok "enter persisted with accuracy telemetry"
else
  bad "No enriched enter event"
  A logcat -d -s GeofenceReceiver | tail -5
fi

echo ""
echo "── Scenario 3: INJECT REJECT (garbage fix, acc 400m > 150m gate) ──"
A logcat -c
inject enter "$SITE_LAT" "$SITE_LNG" "400"
if poll_log 20 "GeofenceReceiver.*Saved geo event: enter @ $SITE_NAME.*REJECTED"; then
  ok "400m-accuracy fix rejected by the gate (logged, not actionable)"
else
  bad "Garbage-accuracy event was NOT rejected"
  A logcat -d -s GeofenceReceiver | tail -5
fi

echo ""
echo "── Scenario 4: INJECT EXIT (good fix, 2.2km out) ──"
A logcat -c
inject exit "$OUT_LAT" "$SITE_LNG" "15"
if poll_log 20 "GeofenceReceiver.*Saved geo event: exit @ $SITE_NAME"; then
  ok "exit persisted"
else
  bad "No exit event"
  A logcat -d -s GeofenceReceiver | tail -5
fi

echo ""
echo "── Scenario 5: FIELDS (v81 telemetry in the persisted queue) ──"
EVENTS="$(dump_events)"
echo "$EVENTS" | sed 's/^/    /'
if echo "$EVENTS" | grep -q '"acc"' && echo "$EVENTS" | grep -q '"evLat"'; then
  ok "Events carry acc + evLat/evLng (triggering location captured)"
else
  bad "Missing acc/evLat fields — telemetry enrichment not working"
fi
if echo "$EVENTS" | grep -q '"distM"'; then
  ok "Events carry distM (distance-to-site computed from persisted sites)"
else
  bad "Missing distM — site lookup in receiver failed"
fi
if echo "$EVENTS" | grep -qE '"rejected":\s*true'; then
  ok "Rejected event flagged rejected:true in queue"
else
  bad "rejected:true missing from queue"
fi

echo ""
echo "── Scenario 6: GMS LIVE (real fence transition through Google's pipeline) ──"
# Launch the app first: its watchPosition holds an active location request so
# the emulator's fused provider keeps computing fixes (idle FLP = napping
# geofencer). The cold open also drains the injected events through the JS
# replay path — inspected in scenario 7.
A shell am start -n "$PKG/.MainActivity" >/dev/null 2>&1; sleep 10
A logcat -c
geo "$OUT_LAT" "$SITE_LNG"; sleep 5
geo "$SITE_LAT" "$SITE_LNG"
note "Real GPS drive-in done — polling for a live DWELL (30s loiter + GMS latency)…"
for i in $(seq 1 6); do sleep 10; geo "$SITE_LAT" "$SITE_LNG"; done
if poll_log 120 "GeofenceReceiver.*Saved geo event: enter @ $SITE_NAME.*acc="; then
  ok "GMS live DWELL→enter fired through the real Google geofencing pipeline"
else
  note "⚠ GMS did not fire a live transition (emulator geofencer can nap when the"
  note "  device reports 'still' activity — transient; rerun, or rely on field"
  note "  telemetry via the Firestore GeoLog mirror). NOT counted as a failure."
fi

echo ""
echo "── Scenario 7: JS REPLAY (informational — needs a signed-in app session) ──"
# The cold open in scenario 6 drained pending events through processGeoEvent.
# This WebView doesn't bridge console.log to logcat, so inspect the GeoLog in
# the WebView's localStorage leveldb directly (force-stop flushes it). The
# emulator's auth state is uncontrolled (drain only runs once the app is past
# login), so this is informational — the JS layer's hard guarantees are the
# node syntax check + field telemetry from real workdays.
A shell am force-stop "$PKG"; sleep 2
# NOTE: macOS BSD `strings` has no -e flag; UTF-16-stored values are extracted
# crudely by stripping NUL bytes before the ASCII pass.
LDB="$(A shell "run-as $PKG sh -c 'cat app_webview/Default/Local\\ Storage/leveldb/*.log app_webview/Default/Local\\ Storage/leveldb/*.ldb 2>/dev/null'" 2>/dev/null | tr -d '\\000' | strings)"
if echo "$LDB" | grep -q "REJECTED enter @ $SITE_NAME"; then
  ok "JS GeoLog recorded the REJECTED event (accuracy gate verified end-to-end in JS)"
elif echo "$LDB" | grep -q "mcn_geoLog"; then
  note "⚠ GeoLog exists but no REJECTED entry — app likely not signed in on this"
  note "  emulator (drain runs post-login). Informational only."
else
  note "⚠ Could not read GeoLog from WebView storage — informational only."
fi

echo ""
echo "════════════════════════════════════════════"
echo "  RESULT: $PASS passed, $FAIL failed"
echo "════════════════════════════════════════════"
[[ $FAIL -eq 0 ]]
